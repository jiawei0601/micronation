// M7 api 層共用讀寫輔助——「讀 WorldState(repository)→ 呼叫純模塊 → saveWorldState 差異寫回,
// 單一 batch」的固定流程收攏在此,避免每個路由重複組裝。

import type { WorldState, Nation, Id, GameEvent, Trade } from '@micronation/shared';
import type { D1Database } from '../db/types';
import { loadWorldStateVersioned, saveWorldState, getActiveSeasonId, getSeasonTickRunning } from '../db/repository';

export interface ActiveWorld {
  seasonId: Id;
  state: WorldState;
  /** true = tick-cron(M8 runTick)正在跑本賽季。寫入路由須在套用變更前檢查,進行中回 503。 */
  tickRunning: boolean;
  /** ①-6:讀取當下的 seasons.version——寫回時(persistWorld)須帶著這個值做樂觀鎖檢查。 */
  version: number;
}

/**
 * 載入目前 active 賽季的完整 WorldState。null = 尚無 active 賽季(單賽季由 M8 admin 端點
 * /api/admin/season 開季)。
 */
export async function loadActiveWorld(db: D1Database): Promise<ActiveWorld | null> {
  const seasonId = await getActiveSeasonId(db);
  if (!seasonId) return null;
  // ③-1/③-8:state 與 version 出自同一次 season row 讀取(loadWorldStateVersioned),不再另外
  // 呼叫 getSeasonVersion 讀第二次——見 db/repository.ts 該函式的註解。
  const loaded = await loadWorldStateVersioned(db, seasonId);
  if (!loaded) return null;
  const tickRunning = await getSeasonTickRunning(db, seasonId);
  return { seasonId, state: loaded.state, tickRunning, version: loaded.version };
}

export function findOwnNation(state: WorldState, userId: Id): Nation | null {
  return state.nations.find((n) => n.ownerId === userId) ?? null;
}

export function findNationById(state: WorldState, nationId: Id): Nation | null {
  return state.nations.find((n) => n.id === nationId) ?? null;
}

/**
 * 「重讀-套用-寫回」的差異寫回:prev 為讀取時的快照,next 為套用純模塊結果後的新狀態。
 * D1 batch 非完整 transaction(見 saveWorldState 註解與 sqliteD1Adapter 說明)——本函式
 * 不做樂觀鎖版本檢查,單 Worker 執行模型下同一使用者連續請求已大致安全,但兩個不同使用者
 * 同時對同一 nation 集合寫入時仍可能互相覆蓋彼此差異(例如兩個玩家同時對局勢做出改動,
 * 各自的 prev 快照都是舊值)。tick-cron(M8)與請求並發的競態同理,留待 M8 視需要補
 * version 欄位或 D1 原生 transaction API。
 */
export async function persistWorld(
  db: D1Database,
  prev: WorldState,
  next: WorldState,
  events: GameEvent[],
  now: number,
  trades: Trade[] = [],
  expectedVersion?: number
): Promise<void> {
  // finding #3:trades 與 nations/orders/events 一併交給 saveWorldState 的同一個 D1 batch,
  // 不再由 applyPlaceOrder 各自獨立呼叫 insertTrades——避免「trades 已落地但 nations/orders
  // 的差異寫回失敗」這種半吊子中間狀態。
  // ①-6:expectedVersion 帶入時(所有玩家寫入路由都應該帶,見 loadActiveWorld().version)做
  // 樂觀鎖檢查——版本不符時 saveWorldState 丟 ConflictError,呼叫端(routes)不吞這個例外,
  // 讓 index.ts onError 統一轉譯成 409 { error: 'CONFLICT', retry: true }。
  await saveWorldState(db, prev, next, events, now, trades, expectedVersion);
}
