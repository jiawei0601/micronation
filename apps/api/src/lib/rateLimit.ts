// finding #22:auth 端點(register/login/verify/resend)簡單的每 IP 速率限制。
//
// 實作用記憶體 Map(固定視窗計數),**不是**分散式/持久化限流——Cloudflare Workers 每個
// isolate 是獨立實例,同一使用者的請求在高流量下可能被路由到不同 isolate,各自有各自的
// Map,實際限流上限會比設定值寬鬆(等同「單實例內」才準確)。正式環境若流量夠大需要更嚴格
// 保證,應改用 Cloudflare Rate Limiting binding 或 D1/KV 計數,這裡先用最低成本的版本擋
// 明顯的暴力嘗試/濫用,非資安等級的保證(已在此註明,不宣稱比實際更強)。

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

/** true = 允許放行;false = 超過限制,呼叫端應回 429。 */
export function checkRateLimit(key: string, opts: RateLimitOptions, now: number = Date.now()): boolean {
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= opts.windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (existing.count >= opts.max) return false;
  existing.count += 1;
  return true;
}

/** 測試/長跑 process 用:清空計數(避免測試之間互相污染同一個 key)。 */
export function resetRateLimits(): void {
  buckets.clear();
}

export function clientIp(header: (name: string) => string | undefined): string {
  return header('CF-Connecting-IP') ?? header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
}
