// PBKDF2-SHA256 密碼雜湊,經 WebCrypto(Workers 與 Node 18+ 皆內建 globalThis.crypto.subtle)。
// 不用第三方雜湊庫,避免 Workers 環境相容性問題。

export const PBKDF2_ITERATIONS = 120_000; // >= 100k(規格下限),留餘裕
const HASH_BITS = 256;
const SALT_BYTES = 16;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt.slice().buffer, iterations, hash: 'SHA-256' },
    keyMaterial,
    HASH_BITS
  );
}

export interface PasswordHash {
  hash: string; // hex
  salt: string; // hex
  iterations: number;
}

export async function hashPassword(password: string, iterations: number = PBKDF2_ITERATIONS): Promise<PasswordHash> {
  const saltBytes = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(saltBytes);
  const bits = await deriveBits(password, saltBytes, iterations);
  return { hash: toHex(bits), salt: toHex(saltBytes.buffer), iterations };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const saltBytes = fromHex(stored.salt);
  const bits = await deriveBits(password, saltBytes, stored.iterations);
  const computedHex = toHex(bits);
  return timingSafeEqual(computedHex, stored.hash);
}

/** 常數時間比較,避免時序攻擊洩漏雜湊前綴。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
