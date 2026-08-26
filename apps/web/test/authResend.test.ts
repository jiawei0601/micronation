// 回歸測試(Codex 三審 finding):/auth/resend 後端統一回 202 {ok:true},不帶 mailSent 欄位
// (見 apps/api/src/index.ts POST /api/auth/resend)。前端 authFn.resend() 只要沒有 throw
// 就代表送出成功,不可再假設回應裡有 mailSent。

import { describe, it, expect, vi, afterEach } from 'vitest';

describe('authFn.resend — 對齊後端 202 {ok:true} 契約', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('resolves without throwing when the backend returns 202 {ok:true} (no mailSent field)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 202, json: async () => ({ ok: true }) }))
    );
    const { authFn } = await import('../src/api/auth');

    await expect(authFn.resend('user@example.com')).resolves.toBeUndefined();
  });

  it('still throws ApiError when the backend responds with an error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: 'RATE_LIMITED' }) }))
    );
    const { authFn, ApiError } = await import('../src/api/auth').then(async (auth) => ({
      authFn: auth.authFn,
      ApiError: (await import('../src/api/client')).ApiError,
    }));

    await expect(authFn.resend('user@example.com')).rejects.toBeInstanceOf(ApiError);
  });
});
