import { randomHex } from './password';

export const SESSION_COOKIE_NAME = 'mn_session';
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const SESSION_TOKEN_BYTES = 32; // 256bit

export function createSessionToken(): string {
  return randomHex(SESSION_TOKEN_BYTES);
}

export function sessionExpiryFrom(nowMs: number): number {
  return nowMs + SESSION_DURATION_MS;
}

/** Set-Cookie header 值——HttpOnly + Secure + SameSite=Lax,期限 30 天。
 * finding #20:maxAgeSec 須用「建立 session 時的同一個 now」計算,不可另外呼叫 Date.now()
 * ——否則 expiresAtMs(=now+SESSION_DURATION_MS)與這裡重新取的 now 之間有請求處理耗時的落差,
 * 兩處對「現在」的認知不一致。 */
export function buildSessionCookie(token: string, expiresAtMs: number, now: number): string {
  const maxAgeSec = Math.max(0, Math.floor((expiresAtMs - now) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ].join('; ');
}

/** 登出用的清除 cookie(Max-Age=0)。 */
export function buildClearSessionCookie(): string {
  return [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=0'].join('; ');
}

/** finding #14:decodeURIComponent 對格式不良的 %escape 會丟例外;cookie 是不可信輸入,
 * 壞值視同「沒帶 cookie」(未登入),不可讓整個 middleware/route 500。 */
export function parseSessionTokenFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq);
    if (name === SESSION_COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(eq + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
