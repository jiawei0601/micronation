// M7 api 層共用讀寫輔助——「讀 WorldState(repository)→ 呼叫純模塊 → saveWorldState 差異寫回,
// 單一 batch」的固定流程收攏在此,避免每個路由重複組裝。

import type { WorldState, Nation, Id, GameEvent } from '@micronation/shared';
import type { D1Database } from '../db/types';
import { loadWorldState, saveWorldState, getActiveSeasonId } from '../db/repository';

export interface ActiveWorld {
  seasonId: Id;
  state: WorldState;
}

/**
 * 載入目前 active 賽季的完整 WorldState。null = 尚無 active 賽季(M7 範圍:賽季由外部
 * 種子腳本/M8 建立,api 層不負責開季)。
 */
export async function loadActiveWorld(db: D1Database): Promise<ActiveWorld | null> {
  const seasonId = await getActiveSeasonId(db);
  if (!seasonId) return null;
  const state = await loadWorldState(db, seasonId);
  if (!state) return null;
  return { seasonId, state };
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
  now: number
): Promise<void> {
  await saveWorldState(db, prev, next, events, now);
}
