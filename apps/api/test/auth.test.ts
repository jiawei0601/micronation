import { describe, it, expect } from 'vitest';
import { createTestD1 } from './support/sqliteD1Adapter';
import { register, login, logout, verifyEmail, resolveSession, resendVerification } from '../src/auth/service';
import { ConsoleMailSender } from '../src/auth/mail';
import { hashPassword, verifyPassword, sha256Hex, PBKDF2_ITERATIONS, normalizeEmail } from '../src/auth/password';
import { findUserByEmail, findSession, findVerificationToken } from '../src/db/repository';

// finding #1/#13:DB 只存 session/verify_token 的 SHA-256 雜湊,測試沒有真的信箱可以收信,
// 用 ConsoleMailSender 的 lastToken 取得註冊當下寄出的明文 token。
const mail = new ConsoleMailSender();

describe('auth — register → login → session → logout 全流程', () => {
  it('happy path', async () => {
    const db = createTestD1();
    const now = 1_000_000;

    const regResult = await register(db, mail, 'Test@Example.com', 'correct-horse', now);
    expect(regResult.ok).toBe(true);

    const loginResult = await login(db, 'test@example.com', 'correct-horse', now + 1);
    expect(loginResult.ok).toBe(true);
    if (!loginResult.ok) return;

    const sessionCtx = await resolveSession(db, loginResult.value.sessionToken, now + 2);
    expect(sessionCtx).not.toBeNull();
    expect(sessionCtx?.user.email).toBe('test@example.com');

    await logout(db, loginResult.value.sessionToken);
    const afterLogout = await resolveSession(db, loginResult.value.sessionToken, now + 3);
    expect(afterLogout).toBeNull();
  });

  it('重複 email 註冊 → EMAIL_TAKEN', async () => {
    const db = createTestD1();
    await register(db, mail, 'dup@example.com', 'password123', 0);
    const second = await register(db, mail, 'dup@example.com', 'another-pass', 0);
    expect(second).toEqual({ ok: false, error: 'EMAIL_TAKEN' });
  });

  it('email 大小寫/空白正規化後視為同一帳號', async () => {
    const db = createTestD1();
    await register(db, mail, '  Dup2@Example.com  ', 'password123', 0);
    const second = await register(db, mail, 'dup2@example.com', 'another-pass', 0);
    expect(second.ok).toBe(false);

    const row = await findUserByEmail(db, normalizeEmail('  Dup2@Example.com  '));
    expect(row?.email).toBe('dup2@example.com');
  });

  it('錯密碼登入 → INVALID_CREDENTIALS,不洩漏帳號是否存在', async () => {
    const db = createTestD1();
    await register(db, mail, 'user@example.com', 'right-password', 0);

    const wrongPassword = await login(db, 'user@example.com', 'wrong-password', 1);
    expect(wrongPassword).toEqual({ ok: false, error: 'INVALID_CREDENTIALS' });

    const noSuchUser = await login(db, 'nobody@example.com', 'whatever', 1);
    expect(noSuchUser).toEqual({ ok: false, error: 'INVALID_CREDENTIALS' });
  });

  it('弱密碼 → WEAK_PASSWORD', async () => {
    const db = createTestD1();
    const result = await register(db, mail, 'weak@example.com', 'short', 0);
    expect(result).toEqual({ ok: false, error: 'WEAK_PASSWORD' });
  });

  it('email 驗證流程:register 產生的 verify token 可用來驗證,過期/錯誤 token 被拒', async () => {
    const db = createTestD1();
    const now = 0;
    await register(db, mail, 'verify@example.com', 'password123', now);
    const rawToken = mail.lastToken!;
    const row = await findUserByEmail(db, 'verify@example.com');
    expect(row?.verified).toBe(0);
    expect(await findVerificationToken(db, await sha256Hex(rawToken))).not.toBeNull();

    const badToken = await verifyEmail(db, 'not-the-real-token', now + 1);
    expect(badToken).toEqual({ ok: false, error: 'INVALID_TOKEN' });

    const expired = await verifyEmail(db, rawToken, now + 999_999_999);
    expect(expired).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });

    const ok = await verifyEmail(db, rawToken, now + 1);
    expect(ok.ok).toBe(true);

    const afterVerify = await findUserByEmail(db, 'verify@example.com');
    expect(afterVerify?.verified).toBe(1);
    // ③-1:驗證成功後,該 user 名下所有 verification_tokens 列都被刪除(見 service.ts verifyEmail)。
    expect(await findVerificationToken(db, await sha256Hex(rawToken))).toBeNull();
  });

  it('密碼超過 256 字元 → PASSWORD_TOO_LONG(finding #19)', async () => {
    const db = createTestD1();
    const result = await register(db, mail, 'toolong@example.com', 'a'.repeat(257), 0);
    expect(result).toEqual({ ok: false, error: 'PASSWORD_TOO_LONG' });
  });

  it('寄信失敗仍註冊成功但 mailSent:false(finding #16),/api/auth/resend 可重寄且冪等', async () => {
    const db = createTestD1();
    const failingMail = { sendVerificationEmail: async () => { throw new Error('smtp down'); } };
    const result = await register(db, failingMail, 'resend@example.com', 'password123', 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mailSent).toBe(false);

    // 帳號確實已建立(寄信失敗不擋註冊)
    const row = await findUserByEmail(db, 'resend@example.com');
    expect(row).not.toBeNull();

    // resend 用會成功的 mail sender,兩次呼叫都要成功且不報錯(冪等)
    const first = await resendVerification(db, mail, 'resend@example.com', 1);
    expect(first).toEqual({ ok: true, value: { mailSent: true } });
    const firstToken = mail.lastToken!;

    const second = await resendVerification(db, mail, 'resend@example.com', 2);
    expect(second).toEqual({ ok: true, value: { mailSent: true } });
    const secondToken = mail.lastToken!;

    // ③-1:verification_tokens 是多列表,每次 resend 都新增一列、不覆寫既有列——firstToken 與
    // secondToken 皆同時有效(不像原本單欄位版本那樣「較晚寫入覆蓋較早寫入」)。用 firstToken
    // 驗證成功後,該 user 名下所有列(含 secondToken)一併被刪除,secondToken 隨之失效。
    expect((await verifyEmail(db, firstToken, 3)).ok).toBe(true);
    expect(await verifyEmail(db, secondToken, 4)).toEqual({ ok: false, error: 'INVALID_TOKEN' });
  });

  it('resend 對不存在的帳號 → USER_NOT_FOUND;對已驗證帳號 → mailSent:false 不重寄', async () => {
    const db = createTestD1();
    const notFound = await resendVerification(db, mail, 'nobody@example.com', 0);
    expect(notFound).toEqual({ ok: false, error: 'USER_NOT_FOUND' });

    await register(db, mail, 'already@example.com', 'password123', 0);
    const token = mail.lastToken!;
    await verifyEmail(db, token, 1);

    const result = await resendVerification(db, mail, 'already@example.com', 2);
    expect(result).toEqual({ ok: true, value: { mailSent: false } });
  });
});

describe('token 雜湊化(finding #1/#13)', () => {
  it('session token 落地時存的是 SHA-256(token),不是明文', async () => {
    const db = createTestD1();
    await register(db, mail, 'hash-session@example.com', 'password123', 0);
    const loginResult = await login(db, 'hash-session@example.com', 'password123', 1);
    expect(loginResult.ok).toBe(true);
    if (!loginResult.ok) return;

    const rawToken = loginResult.value.sessionToken;
    // 明文 token 在 DB 裡查不到(因為存的是雜湊)
    expect(await findSession(db, rawToken)).toBeNull();
    // 雜湊過的值查得到
    const hashed = await sha256Hex(rawToken);
    const session = await findSession(db, hashed);
    expect(session).not.toBeNull();
  });

  it('verification_tokens.token_hash 落地時存的是 SHA-256(token),不是明文', async () => {
    const db = createTestD1();
    await register(db, mail, 'hash-verify@example.com', 'password123', 0);
    const rawToken = mail.lastToken!;
    // 明文 token 本身查不到(因為主鍵存的是雜湊)
    expect(await findVerificationToken(db, rawToken)).toBeNull();
    const hashed = await sha256Hex(rawToken);
    const tokenRow = await findVerificationToken(db, hashed);
    expect(tokenRow).not.toBeNull();
    expect(tokenRow?.token_hash).toBe(hashed);
  });
});

describe('PBKDF2 密碼雜湊', () => {
  it('可雜湊、可驗證,錯密碼驗證失敗', async () => {
    const hashed = await hashPassword('my-secret-password');
    expect(hashed.iterations).toBeGreaterThanOrEqual(100_000);
    expect(hashed.iterations).toBe(PBKDF2_ITERATIONS);
    expect(hashed.salt).toHaveLength(32); // 16 bytes hex
    expect(hashed.hash).toHaveLength(64); // 256bit hex

    expect(await verifyPassword('my-secret-password', hashed)).toBe(true);
    expect(await verifyPassword('wrong-password', hashed)).toBe(false);
  });

  it('相同密碼每次雜湊的 salt 不同(不可預測)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});
