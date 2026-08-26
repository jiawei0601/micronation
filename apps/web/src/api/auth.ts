// POST /api/auth/login、/api/auth/register——mock 模式不落地,只 console log 並直接放行
// (呼應 founding.ts 的既有模式)。真 API 模式呼叫後端,失敗時把 ApiError.message(即後端
// { error }欄位)原樣往上拋,由呼叫端(LoginPage/RegisterPage)決定怎麼顯示。

import { apiFetch, ApiError } from './client';
import { USE_MOCK } from './useWorld';

export interface AuthFn {
  login(email: string, password: string): Promise<void>;
  /** finding #4:回傳 mailSent——後端 register 寄信失敗不擋註冊(帳號仍建立成功),
   *  呼叫端(RegisterPage)需依此提示「驗證信寄送失敗,可補寄」。 */
  register(email: string, password: string): Promise<{ mailSent: boolean }>;
  resend(email: string): Promise<{ mailSent: boolean }>;
}

const realAuth: AuthFn = {
  login: async (email, password) => {
    await apiFetch<{ userId: string }>('/auth/login', { method: 'POST', body: { email, password } });
  },
  register: async (email, password) => {
    const res = await apiFetch<{ userId: string; mailSent: boolean }>('/auth/register', {
      method: 'POST',
      body: { email, password },
    });
    return { mailSent: res.mailSent };
  },
  resend: async (email) => {
    const res = await apiFetch<{ mailSent: boolean }>('/auth/resend', { method: 'POST', body: { email } });
    return { mailSent: res.mailSent };
  },
};

const mockAuth: AuthFn = {
  login: async (email) => {
    // eslint-disable-next-line no-console
    console.log('[mock] POST /api/auth/login', email);
  },
  register: async (email) => {
    // eslint-disable-next-line no-console
    console.log('[mock] POST /api/auth/register', email);
    return { mailSent: true };
  },
  resend: async (email) => {
    // eslint-disable-next-line no-console
    console.log('[mock] POST /api/auth/resend', email);
    return { mailSent: true };
  },
};

export const authFn: AuthFn = USE_MOCK ? mockAuth : realAuth;

export function authErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'UNKNOWN_ERROR';
}
