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

// ①-15:buckets 是一個 process 生命週期內只增不減的 Map——每個新的 key(不同 IP × action 組合)
// 都會留下一筆記錄,即使該 IP 早已過了限流視窗、之後再也不會出現,Bucket 也不會被回收,長時間
// 運行下記憶體隨獨立 IP 數量無上限成長(在 Cloudflare Workers isolate 有記憶體上限的環境下,
// 這是實際的 DoS/OOM 風險面)。加兩道防線:(1) 每次呼叫時,若已超過清理間隔,順手淘汰所有已過
// 視窗的舊 key;(2) 即使清理跟不上(大量一次性 IP 湧入),硬上限 10k key,超過時整個 Map 清空
// 重新開始(寧可短暫誤放行,不要無界成長)。
const MAX_BUCKETS = 10_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastCleanupAt = 0;

function cleanupBuckets(now: number, windowMs: number): void {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs) buckets.delete(key);
  }
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

/** true = 允許放行;false = 超過限制,呼叫端應回 429。 */
export function checkRateLimit(key: string, opts: RateLimitOptions, now: number = Date.now()): boolean {
  cleanupBuckets(now, opts.windowMs);
  if (buckets.size >= MAX_BUCKETS && !buckets.has(key)) {
    buckets.clear(); // 硬上限保護——寧可短暫誤放行,不要無界成長吃光 isolate 記憶體。
  }
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
  lastCleanupAt = 0;
}

export function clientIp(header: (name: string) => string | undefined): string {
  return header('CF-Connecting-IP') ?? header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
}
