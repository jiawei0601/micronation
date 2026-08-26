import type { Result } from '@micronation/shared';
import { ok, err } from '@micronation/shared';
import type { D1Database } from '../db/types';
import {
  findUserByEmail,
  findUserById,
  insertUser,
  markUserVerified,
  insertVerificationToken,
  findVerificationToken,
  deleteVerificationTokensForUser,
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

  // ③-1:verification_tokens 是多列表(見 db/repository.ts 註解)——插入一列新 token 不會覆寫
  // 或刪除任何既有列,所以「先寫 token、才寄信」與「先寄信、才寫 token」不再有並發覆蓋的風險
  // 差異(不像原本 users.verify_token 單欄位那樣覆寫即代表舊 token 失效)。這裡先寫入 token
  // 列,再嘗試寄信——寄信失敗不影響已寫入的 token(finding #16:使用者已經寫入 DB,之後可用
  // /api/auth/resend 補寄;那次 resend 會再新增一列,兩列都合法有效)。
  await insertVerificationToken(db, {
    token_hash: verifyTokenHash,
    user_id: userId,
    expires_at: now + VERIFY_TOKEN_TTL_MS,
    created_at: now,
  });

  let mailSent = true;
  try {
    await mail.sendVerificationEmail(normalized, verifyToken);
  } catch {
    mailSent = false;
  }

  return ok({ userId, mailSent });
}

/** finding #16 補充:idempotent 的重寄驗證信端點——找不到帳號或已驗證就直接回應,不重試寫入。
 * ③-1:改走 verification_tokens 多列表——每次呼叫都是新增一列,不覆寫任何既有列,兩個幾乎
 * 同時的 resend 請求(或 register 剛寄信失敗、使用者手動點兩次「重寄」)不會互相覆蓋彼此產生
 * 的 token,原本單欄位版本「較晚寫入覆蓋較早寫入,較早那次寄出的信裡的 token 就此失效」的
 * 競態不存在了——不論寄信成功與否都直接插入新列(寄信失敗不影響既有 token,因為天生就不會
 * 覆蓋)。 */
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

  const verifyToken = randomHex(16);
  const verifyTokenHash = await sha256Hex(verifyToken);

  await insertVerificationToken(db, {
    token_hash: verifyTokenHash,
    user_id: user.id,
    expires_at: now + VERIFY_TOKEN_TTL_MS,
    created_at: now,
  });

  let mailSent = true;
  try {
    await mail.sendVerificationEmail(normalized, verifyToken);
  } catch {
    mailSent = false;
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
  // ③-3:login 補上 MAX_PASSWORD_LENGTH 檢查——register 已有這道防線(finding #19,PBKDF2 對
  // 超長輸入的 CPU 放大攻擊),但 login 原本沒有,任何人不需要先註冊過一個超長密碼帳號,
  // 就能對 login 端點送出巨大的 password 字串,一樣會讓 verifyPassword 內部的 PBKDF2 對超長
  // 輸入做昂貴的雜湊運算(即使帳號不存在,若 email 存在但密碼超長,仍會先跑到這裡才失敗)。
  // 在查資料庫、算雜湊之前就先擋掉,不給攻擊者用超長字串消耗運算資源的機會。
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return err('INVALID_CREDENTIALS');

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

/** ③-1:改查 verification_tokens 多列表(token_hash 為主鍵,天生只會查到最多一列)——找到、
 * 未過期就標記使用者已驗證,並刪掉該 user 名下所有 verification_tokens 列(不論驗證時用的是
 * 哪一個,同一 user 可能因多次 resend 而並存多個仍然有效的 token,驗證成功後全部一次清空,
 * 避免用剩的 token 繼續可用)。 */
export async function verifyEmail(db: D1Database, token: string, now: number): Promise<Result<{ userId: string }>> {
  if (!token) return err('INVALID_TOKEN');
  const tokenRow = await findVerificationToken(db, await sha256Hex(token));
  if (!tokenRow) return err('INVALID_TOKEN');
  // ①-4:過期判斷改用 <=,呼應 resolveSession 已有的同一原則(finding #20)——expires_at===now
  // 這個邊界時刻視為已過期,不因為「剛好卡在那一毫秒」而放行。
  if (tokenRow.expires_at <= now) return err('TOKEN_EXPIRED');
  await markUserVerified(db, tokenRow.user_id);
  await deleteVerificationTokensForUser(db, tokenRow.user_id);
  return ok({ userId: tokenRow.user_id });
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
