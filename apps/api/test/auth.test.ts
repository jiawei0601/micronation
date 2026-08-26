import { describe, it, expect } from 'vitest';
import { createTestD1 } from './support/sqliteD1Adapter';
import { register, login, logout, verifyEmail, resolveSession } from '../src/auth/service';
import { ConsoleMailSender } from '../src/auth/mail';
import { hashPassword, verifyPassword, PBKDF2_ITERATIONS, normalizeEmail } from '../src/auth/password';
import { findUserByEmail } from '../src/db/repository';

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
    const row = await findUserByEmail(db, 'verify@example.com');
    expect(row?.verified).toBe(0);
    expect(row?.verify_token).toBeTruthy();

    const badToken = await verifyEmail(db, 'not-the-real-token', now + 1);
    expect(badToken).toEqual({ ok: false, error: 'INVALID_TOKEN' });

    const expired = await verifyEmail(db, row!.verify_token!, now + 999_999_999);
    expect(expired).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });

    const ok = await verifyEmail(db, row!.verify_token!, now + 1);
    expect(ok.ok).toBe(true);

    const afterVerify = await findUserByEmail(db, 'verify@example.com');
    expect(afterVerify?.verified).toBe(1);
    expect(afterVerify?.verify_token).toBeNull();
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
