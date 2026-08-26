// M7 api 層局部常數——不屬於 packages/shared 的「平衡常數」(不影響純模塊計算結果),
// 只影響 api 層驗證/派生規則,故放這裡而非 packages/shared/src/constants.ts
// (CONTRACT 要求平衡常數集中在 shared,但這些是 api 的註冊/政策手續費/市場查詢參數)。

import type { FlagSpec, ResourceKind } from '@micronation/shared';

// 國名極簡黑名單示意(過濾明顯不當內容),非完整敏感詞庫。
export const NAME_BLACKLIST = ['幹你', '三小', '習近平', '共產黨', 'fuck', 'nazi', 'admin', 'system'];

export function isNameAllowed(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 20) return false;
  const lower = trimmed.toLowerCase();
  return !NAME_BLACKLIST.some((w) => lower.includes(w.toLowerCase()));
}

export function isValidFlagSpec(flag: unknown): flag is FlagSpec {
  if (!flag || typeof flag !== 'object') return false;
  const f = flag as Record<string, unknown>;
  if (typeof f.layout !== 'string' || f.layout.length === 0 || f.layout.length > 40) return false;
  if (typeof f.emblem !== 'string' || f.emblem.length === 0 || f.emblem.length > 40) return false;
  if (!Array.isArray(f.colors) || f.colors.length < 1 || f.colors.length > 4) return false;
  return f.colors.every((c) => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c));
}

// 跨區貿易關稅基準率——市場路由用 openness 政策修正 + diplomacy.tradeDiscount 算最終 tariffRate,
// 詳見 CONTRACT §api「/api/market」。純示意基準值,非戰鬥/生產類平衡常數。
export const BASE_TARIFF_RATE = 0.1;

// 政策變更手續費(固定資源成本)——CONTRACT 只定義冷卻(shared.POLICY_CHANGE_COOLDOWN),
// 手續費本身是 api 層驗收規則,不在 shared 常數表。
export const POLICY_CHANGE_COST: Partial<Record<ResourceKind, number>> = { money: 30 };

// /api/market PriceRef 近期均價取樣筆數
export const MARKET_PRICE_LOOKBACK = 20;

// /api/world tick 倒數——對齊 tick-cron 的 `0 * * * *`(每小時整點),下一次整點時間即倒數終點。
export const TICK_INTERVAL_MS = 60 * 60 * 1000;

export function nextTickAt(now: number): number {
  return Math.ceil((now + 1) / TICK_INTERVAL_MS) * TICK_INTERVAL_MS;
}
