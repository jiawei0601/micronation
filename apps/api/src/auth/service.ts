import type { Result } from '@micronation/shared';
import { ok, err } from '@micronation/shared';
import type { D1Database } from '../db/types';
import {
  findUserByEmail,
  findUserById,
  insertUser,
  markUserVerified,
  setVerifyToken,
  insertSession,
  findSession,
  deleteSession,
  type UserRow,
  type SessionRow,
} from '../db/repository';
import { hashPassword, verifyPassword, normalizeEmail, randomHex, PBKDF2_ITERATIONS } from './password';
import { createSessionToken, sessionExpiryFrom } from './session';
import type { MailSender } from './mail';

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MIN_PASSWORD_LENGTH = 8;

export interface RegisterResult {
  userId: string;
}

export async function register(
  db: D1Database,
  mail: MailSender,
  email: string,
  password: string,
  now: number
): Promise<Result<RegisterResult>> {
  const normalized = normalizeEmail(email);
  if (!normalized.includes('@') || normalized.length < 3) return err('INVALID_EMAIL');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return err('WEAK_PASSWORD');

  const existing = await findUserByEmail(db, normalized);
  if (existing) return err('EMAIL_TAKEN');

  const { hash, salt, iterations } = await hashPassword(password, PBKDF2_ITERATIONS);
  const userId = `user-${randomHex(16)}`;
  const verifyToken = randomHex(16);

  const row: UserRow = {
    id: userId,
    email: normalized,
    password_hash: hash,
    password_salt: salt,
    password_iterations: iterations,
    verified: 0,
    verify_token: verifyToken,
    verify_token_expires_at: now + VERIFY_TOKEN_TTL_MS,
    created_at: now,
  };
  await insertUser(db, row);
  await mail.sendVerificationEmail(normalized, verifyToken);

  return ok({ userId });
}

export interface LoginResult {
  userId: string;
  sessionToken: string;
  expiresAt: number;
}

export async function login(db: D1Database, email: string, password: string, now: number): Promise<Result<LoginResult>> {
  const normalized = normalizeEmail(email);
  const user = await findUserByEmail(db, normalized);
  if (!user) return err('INVALID_CREDENTIALS');

  const valid = await verifyPassword(password, {
    hash: user.password_hash,
    salt: user.password_salt,
    iterations: user.password_iterations,
  });
  if (!valid) return err('INVALID_CREDENTIALS');

  const sessionToken = createSessionToken();
  const expiresAt = sessionExpiryFrom(now);
  const sessionRow: SessionRow = { id: sessionToken, user_id: user.id, created_at: now, expires_at: expiresAt };
  await insertSession(db, sessionRow);

  return ok({ userId: user.id, sessionToken, expiresAt });
}

export async function logout(db: D1Database, sessionToken: string): Promise<void> {
  await deleteSession(db, sessionToken);
}

export async function verifyEmail(db: D1Database, token: string, now: number): Promise<Result<{ userId: string }>> {
  if (!token) return err('INVALID_TOKEN');
  // M6 範圍:token 非索引欄位,採全表 email 反查——待 M7 若流量增長可補 verify_token 索引。
  // 這裡改走 findUserById 不適用(token 不是 id),故用 repository 尚未提供的查詢時退而求其次:
  // 直接掃描由呼叫端傳入 userId 亦可,但為符合「確認端點只吃 token」介面,補一個輕量查法。
  const user = await findUserByToken(db, token);
  if (!user) return err('INVALID_TOKEN');
  if (user.verify_token_expires_at === null || user.verify_token_expires_at < now) return err('TOKEN_EXPIRED');
  await markUserVerified(db, user.id);
  return ok({ userId: user.id });
}

async function findUserByToken(db: D1Database, token: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE verify_token = ?').bind(token).first<UserRow>();
}

export interface SessionContext {
  session: SessionRow;
  user: UserRow;
}

/** requireSession 核心邏輯——查 session、驗過期、查 user。過期視同不存在(不主動刪除,交給排程)。 */
export async function resolveSession(db: D1Database, token: string | null, now: number): Promise<SessionContext | null> {
  if (!token) return null;
  const session = await findSession(db, token);
  if (!session) return null;
  if (session.expires_at < now) return null;
  const user = await findUserById(db, session.user_id);
  if (!user) return null;
  return { session, user };
}
