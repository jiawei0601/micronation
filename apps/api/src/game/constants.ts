// M7 api 層局部常數——不屬於 packages/shared 的「平衡常數」(不影響純模塊計算結果),
// 只影響 api 層驗證/派生規則,故放這裡而非 packages/shared/src/constants.ts
// (CONTRACT 要求平衡常數集中在 shared,但這些是 api 的註冊/政策手續費/市場查詢參數)。

import type { FlagSpec, Region, ResourceKind, Policies, Id } from '@micronation/shared';
import { makeId } from '@micronation/shared';

// 國名極簡黑名單示意(過濾明顯不當內容),非完整敏感詞庫。
export const NAME_BLACKLIST = ['幹你', '三小', '習近平', '共產黨', 'fuck', 'nazi', 'admin', 'system'];

// finding #7:國名長度上限原本只算 JS string.length(UTF-16 code unit 數),中文字元佔 1、
// emoji/罕見字可能佔 2,對「顯示寬度/儲存位元組數」沒有實質上限意義。改加 UTF-8 byte 上限
// (60 bytes,約可容納 20 個中文字或更多英數字),用 TextEncoder 精確量測。
const NAME_MAX_BYTES = 60;

export function isNameAllowed(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 20) return false;
  if (new TextEncoder().encode(trimmed).length > NAME_MAX_BYTES) return false;
  const lower = trimmed.toLowerCase();
  return !NAME_BLACKLIST.some((w) => lower.includes(w.toLowerCase()));
}

// finding #8:原本 `{3,8}` 位十六進位字元含糊放行了 4/5/7/8 位這些 CSS/SVG 都不承認的怪異長度
// (含 8 位帶 alpha 的 #RRGGBBAA 這種前端 <Flag> SVG 元件未必支援的格式)。收緊為僅 3 或 6 位,
// 對應標準 CSS hex color(#RGB / #RRGGBB)。
// Codex 四審⑤:唯一的 FlagSpec 驗證函式——db/rows.ts 原本另外維護一份 isFlagSpec,規則明顯更
// 寬鬆(colors 不限數量/不驗 hex 格式、layout/emblem 無長度上限),兩處各自為政、允許的形狀不
// 一致:手改 DB 或未來 migration bug 寫入的 flag,可能通得過 rows.ts 讀取時的驗證(不算
// CorruptRowError),卻是這裡(api 層開國/改旗)永遠不會接受的形狀——同一個「合不合法」的問題
// 有兩個答案。rows.ts 改為 import 這裡的函式,不再自己重複定義一份會走鐘的驗證邏輯。
export function isValidFlagSpec(flag: unknown): flag is FlagSpec {
  if (!flag || typeof flag !== 'object') return false;
  const f = flag as Record<string, unknown>;
  if (typeof f.layout !== 'string' || f.layout.length === 0 || f.layout.length > 40) return false;
  if (typeof f.emblem !== 'string' || f.emblem.length === 0 || f.emblem.length > 40) return false;
  if (!Array.isArray(f.colors) || f.colors.length < 1 || f.colors.length > 4) return false;
  return f.colors.every((c) => typeof c === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c));
}

// finding #19:玩家開國初始值——原散落在 routes/nation.ts,現搬進 api 層 constants.ts 單一
// 出處(CONTRACT §db/auth/api 註明:玩家初始值屬 api 層 constants,非 packages/shared 平衡常數,
// 因為只影響「玩家開國那一刻」的一次性初值,不影響任何純模塊計算規則)。
export const PLAYER_INITIAL_RESOURCES = { food: 300, ore: 200, fuel: 100, money: 500 };
export const PLAYER_INITIAL_BUILDINGS = {
  farm: 1,
  mine: 1,
  refinery: 0,
  market: 0,
  barracks: 0,
  warehouse: 0,
  university: 0,
  wall: 0,
} as const;
export const PLAYER_INITIAL_POLICIES: Policies = { tax: 'mid', economy: 'agri', conscription: 'volunteer', openness: 'neutral' };
export const PLAYER_INITIAL_ACTION_POINTS = 5;
export const PLAYER_INITIAL_POPULATION = 100;
export const PLAYER_INITIAL_MORALE = 60;
export const PLAYER_INITIAL_ARMY_SIZE = 10;

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

// 賽季長度(tick)——8 週 × 7 天 × 24 小時(每小時一 tick)。到期由 tick-cron(runTick)
// 檢查 resolveTick 後的 state.tick,達到即結算名人堂+標記 season ended。CONTRACT 未把此值
// 列入 packages/shared 平衡常數表(不影響任何純模塊計算結果,純粹是 api 層賽季生命週期參數),
// 故放這裡而非 shared/src/constants.ts,呼應本檔開頭的既有慣例。
export const SEASON_LENGTH_TICKS = 8 * 7 * 24; // 1344

// 開新賽季用的固定地圖(admin 端點 POST /api/admin/season)——沿用 apps/web/src/api/mock.ts
// 既有 REGIONS 命名與加成,保持前後端展示一致;不屬於「平衡常數」(不影響任何純模塊計算,
// 純粹是賽季初始資料),故放這裡而非 shared/src/constants.ts。
// finding #6:原本固定的 region id(如 'region-1')在第二季開季時會與第一季殘留(未刪除,
// 只是 status='ended')的 region row 撞主鍵(regions.id 全域 PRIMARY KEY,非 per-season)。
// 改成依 seasonId 組出前綴,同一季內仍是固定/可預期的清單,但跨季不再撞號。
const DEFAULT_REGION_DEFS: { name: string; bonuses: Region['bonuses'] }[] = [
  { name: '北境高地', bonuses: { ore: 0.15 } },
  { name: '中原平野', bonuses: { food: 0.15 } },
  { name: '東方群島', bonuses: { fuel: 0.1, money: 0.05 } },
  { name: '西漠礦區', bonuses: { ore: 0.25, food: -0.1 } },
  { name: '南方沃土', bonuses: { food: 0.25 } },
];

export function buildDefaultRegions(seasonId: Id): Region[] {
  return DEFAULT_REGION_DEFS.map((def, i) => ({
    id: makeId('region', seasonId, i),
    name: def.name,
    bonuses: def.bonuses,
  }));
}

export const DEFAULT_NPC_COUNT = 8;

