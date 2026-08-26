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

/** Set-Cookie header 值——HttpOnly + Secure + SameSite=Lax,期限 30 天。 */
export function buildSessionCookie(token: string, expiresAtMs: number): string {
  const maxAgeSec = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
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

export function parseSessionTokenFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq);
    if (name === SESSION_COOKIE_NAME) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}
