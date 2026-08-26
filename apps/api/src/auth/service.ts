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
import { hashPassword, verifyPassword, normalizeEmail, randomHex, sha256Hex, PBKDF2_ITERATIONS } from './password';
import { createSessionToken, sessionExpiryFrom } from './session';
import type { MailSender } from './mail';

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256; // finding #19:上限,避免超長輸入餵給 PBKDF2(CPU 放大攻擊)

export interface RegisterResult {
  userId: string;
  /** finding #16:寄信失敗不擋註冊——false 時前端應提示使用者改走 /api/auth/resend。 */
  mailSent: boolean;
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
  if (password.length > MAX_PASSWORD_LENGTH) return err('PASSWORD_TOO_LONG');

  const { hash, salt, iterations } = await hashPassword(password, PBKDF2_ITERATIONS);
  const userId = `user-${randomHex(16)}`;
  const verifyToken = randomHex(16);
  const verifyTokenHash = await sha256Hex(verifyToken);

  const row: UserRow = {
    id: userId,
    email: normalized,
    password_hash: hash,
    password_salt: salt,
    password_iterations: iterations,
    verified: 0,
    verify_token: verifyTokenHash,
    verify_token_expires_at: now + VERIFY_TOKEN_TTL_MS,
    created_at: now,
  };

  // finding #15:改靠 users.email 的 UNIQUE 約束擋重複,而非「先 SELECT 再 INSERT」——
  // 後者在兩個並發請求間有 TOCTOU 窗口,兩者都通過 SELECT 檢查後各自 INSERT,其中一個才會
  // 撞唯一鍵,但撞鍵之前的檢查等於白做,不能真正防止重複帳號。
  try {
    await insertUser(db, row);
  } catch (e) {
    // ①-5:只有撞到 idx_users_email(users.email 唯一鍵)才轉譯成 EMAIL_TAKEN——其他 unique
    // 違規(理論上不該在 insertUser 這個單一 INSERT 發生,但保守起見不要一律吞成 EMAIL_TAKEN)
    // 原樣往上拋,讓 index.ts onError 走 500,不要用一個語意不符的 400 錯誤蓋過去。
    if (isUniqueConstraintErrorOn(e, 'users.email')) return err('EMAIL_TAKEN');
    throw e;
  }

  // finding #16:寄信失敗(例如 mail provider 暫時不可用)不該讓整個註冊失敗——使用者已經
  // 寫入 DB,之後可用 /api/auth/resend 補寄。
  let mailSent = true;
  try {
    await mail.sendVerificationEmail(normalized, verifyToken);
  } catch {
    mailSent = false;
  }

  return ok({ userId, mailSent });
}

/** finding #16 補充:idempotent 的重寄驗證信端點——找不到帳號或已驗證就直接回應,不重試寫入。 */
export async function resendVerification(
  db: D1Database,
  mail: MailSender,
  email: string,
  now: number
): Promise<Result<{ mailSent: boolean }>> {
  const normalized = normalizeEmail(email);
  const user = await findUserByEmail(db, normalized);
  if (!user) return err('USER_NOT_FOUND');
  if (user.verified) return ok({ mailSent: false });

  // ①-3:原本先把新 token 寫進 DB 再寄信——寄信若失敗(mail provider 暫時不可用),DB 裡的
  // verify_token 已經被新 token 覆蓋掉,但使用者信箱裡最後一封能收到的其實是「上一次」的舊
  // token(如果有的話),兩者對不上、使用者手上沒有任何一個當下有效的 token 可用。改成先產生
  // 新 token、寄信成功之後才寫 DB——寄信失敗時舊 token(若存在且未過期)維持有效,使用者至少
  // 還能用先前收到的信驗證,不會因為這次重寄失敗反而把原本能用的路徑弄壞。
  const verifyToken = randomHex(16);
  const verifyTokenHash = await sha256Hex(verifyToken);

  let mailSent = true;
  try {
    await mail.sendVerificationEmail(normalized, verifyToken);
  } catch {
    mailSent = false;
  }
  if (mailSent) {
    await setVerifyToken(db, user.id, verifyTokenHash, now + VERIFY_TOKEN_TTL_MS);
  }
  return ok({ mailSent });
}

/** better-sqlite3 丟 SqliteError(code SQLITE_CONSTRAINT_UNIQUE),真正 D1 的錯誤訊息含
 * "UNIQUE constraint failed"——兩種都用訊息關鍵字判斷,不依賴特定 driver 的 error class。 */
/** ①-5:同 db/repository.ts 的 isUniqueConstraintOn——要求訊息包含目標 `table.column` 簽章,
 * 不是任何 unique 違規都當作同一種錯誤轉譯。 */
function isUniqueConstraintErrorOn(e: unknown, signature: string): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /unique/i.test(message) && message.includes(signature);
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

  // ①-2:專案尚未部署、無任何線上 session 資料——squash migration 已把「只存雜湊」定案在唯一
  // 的一份乾淨 schema,不存在「既有 session 明文殘留」的相容性問題。
  // finding #1/#13:session token 明文只回給 client(走 cookie),DB 只落地雜湊——即使 DB
  // 外洩,攻擊者拿到的 hash 反推不出可用的 session token。
  const sessionToken = createSessionToken();
  const sessionTokenHash = await sha256Hex(sessionToken);
  const expiresAt = sessionExpiryFrom(now);
  const sessionRow: SessionRow = { id: sessionTokenHash, user_id: user.id, created_at: now, expires_at: expiresAt };
  await insertSession(db, sessionRow);

  return ok({ userId: user.id, sessionToken, expiresAt });
}

export async function logout(db: D1Database, sessionToken: string): Promise<void> {
  await deleteSession(db, await sha256Hex(sessionToken));
}

export async function verifyEmail(db: D1Database, token: string, now: number): Promise<Result<{ userId: string }>> {
  if (!token) return err('INVALID_TOKEN');
  // finding #17:verify_token(雜湊後)已加索引(migration 0004 idx_users_verify_token),
  // 全表反查的舊註解不再適用。
  const user = await findUserByToken(db, await sha256Hex(token));
  if (!user) return err('INVALID_TOKEN');
  // ①-4:過期判斷改用 <=,呼應 resolveSession 已有的同一原則(finding #20)——expires_at===now
  // 這個邊界時刻視為已過期,不因為「剛好卡在那一毫秒」而放行。
  if (user.verify_token_expires_at === null || user.verify_token_expires_at <= now) return err('TOKEN_EXPIRED');
  await markUserVerified(db, user.id);
  return ok({ userId: user.id });
}

async function findUserByToken(db: D1Database, tokenHash: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE verify_token = ?').bind(tokenHash).first<UserRow>();
}

export interface SessionContext {
  session: SessionRow;
  user: UserRow;
}

/** requireSession 核心邏輯——查 session、驗過期、查 user。過期視同不存在(不主動刪除,交給排程)。 */
export async function resolveSession(db: D1Database, token: string | null, now: number): Promise<SessionContext | null> {
  if (!token) return null;
  const session = await findSession(db, await sha256Hex(token));
  if (!session) return null;
  if (session.expires_at <= now) return null; // finding #20:過期判斷用 <=,expires_at===now 視為已過期
  const user = await findUserById(db, session.user_id);
  if (!user) return null;
  return { session, user };
}
