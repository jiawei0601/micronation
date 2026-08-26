// 玩家 API 與 tick-cron(NPC 決策)共用的動作處理邏輯——「驗證→算新狀態(→必要時 DB 讀寫)」,
// 原本各自寫在 routes/build.ts、routes/market.ts;M8 抽出成可複用函式,兩邊呼叫同一套邏輯,
// 避免 tick.ts 複製貼上一份走鐘的分身。
//
// 純狀態轉換(applyBuild/applyTrain)不碰 DB;applyPlaceOrder 需要近期均價/序號等 DB 讀寫,
// 因此是 async——這與 packages/market 本身的純函式 `placeOrder` 不衝突,IO 只發生在這一層。

import type { Nation, NewOrder, ResourceKind, Result, Trade, Treaty, WorldState, Id, BuildingKind } from '@micronation/shared';
import {
  ok,
  err,
  BUILDING_LEVELS,
  BUILD_QUEUE_CAPACITY,
  MAX_BUILDING_LEVEL,
  TRAIN_COST_PER_UNIT,
  ARMY_POPULATION_RATIO_CAP,
  OPENNESS_MODIFIERS,
} from '@micronation/shared';
import { placeOrder } from '@micronation/market';
import { tradeDiscount } from '@micronation/diplomacy';
import type { D1Database } from '../db/types';
import { BASE_TARIFF_RATE, MARKET_PRICE_LOOKBACK } from './constants';
import { getRecentAvgPrices, claimNextOrderSeq, insertTrades } from '../db/repository';

function replaceNation(state: WorldState, nation: Nation): WorldState {
  return { ...state, nations: state.nations.map((n) => (n.id === nation.id ? nation : n)) };
}

/** 排入建設佇列——沿用 routes/build.ts 原邏輯(佇列容量/最高等級/資源足額)。 */
export function applyBuild(state: WorldState, nation: Nation, building: BuildingKind): Result<{ state: WorldState }> {
  if (nation.buildQueue.length >= BUILD_QUEUE_CAPACITY) return err('QUEUE_FULL');

  const level = nation.buildings[building] ?? 0;
  if (level >= MAX_BUILDING_LEVEL) return err('MAX_LEVEL');

  const spec = BUILDING_LEVELS[building][level];
  for (const [k, v] of Object.entries(spec.cost)) {
    if (nation.resources[k as ResourceKind] < (v as number)) return err('INSUFFICIENT_RESOURCES');
  }

  const resources = { ...nation.resources };
  for (const [k, v] of Object.entries(spec.cost)) {
    resources[k as ResourceKind] -= v as number;
  }

  const updatedNation: Nation = {
    ...nation,
    resources,
    buildQueue: [...nation.buildQueue, { building, completesAt: state.tick + spec.timeTicks }],
  };

  return ok({ state: replaceNation(state, updatedNation) });
}

/** 練兵——TRAIN_COST_PER_UNIT × size 扣資源、army.size 增加,army.size 不得超過
 * population × ARMY_POPULATION_RATIO_CAP(shared 常數,與 npc 決策共用同一份上限)。
 * NPC 決策與玩家 POST /api/military/train 共用此函式(M8 補遺,CONTRACT §military)。
 * 行動點:比照 /api/build,練兵不消耗行動點(僅出征 declareAttack 依 CONTRACT 消耗
 * ATTACK_ACTION_POINT_COST,build/train 皆為排隊/即時資源交換類動作)。 */
export function applyTrain(state: WorldState, nation: Nation, size: number): Result<{ state: WorldState }> {
  if (!Number.isSafeInteger(size) || size <= 0) return err('INVALID_SIZE');

  const affordable = Object.entries(TRAIN_COST_PER_UNIT).every(
    ([k, perUnit]) => nation.resources[k as ResourceKind] >= (perUnit as number) * size
  );
  if (!affordable) return err('INSUFFICIENT_RESOURCES');

  const cap = Math.floor(nation.population * ARMY_POPULATION_RATIO_CAP);
  if (nation.army.size + size > cap) return err('ARMY_CAP');

  const resources = { ...nation.resources };
  for (const [k, perUnit] of Object.entries(TRAIN_COST_PER_UNIT)) {
    resources[k as ResourceKind] -= (perUnit as number) * size;
  }

  const updatedNation: Nation = { ...nation, resources, army: { size: nation.army.size + size } };
  return ok({ state: replaceNation(state, updatedNation) });
}

/**
 * 近似估算 taker 這筆單的跨區關稅率——搬自 routes/market.ts pickCounterpart 的原註解:
 * market.placeOrder 單次呼叫只吃一個 tariffRate,這裡取 book 上對 taker 最有利的候選對手單
 * 代表「這筆單」的關稅情境,屬 M7 已知簡化。
 */
function pickCounterpart(book: WorldState['orders'], o: NewOrder, nations: Nation[]): Nation | null {
  const opposite = book.filter((b) => b.kind === o.kind && b.side !== o.side && b.nationId !== o.nationId);
  if (opposite.length === 0) return null;
  const sorted = [...opposite].sort((a, b) => (o.side === 'buy' ? a.price - b.price : b.price - a.price));
  return nations.find((n) => n.id === sorted[0].nationId) ?? null;
}

function computeTariffRate(nation: Nation, counterpart: Nation | null, treaties: Treaty[]): number {
  if (!counterpart || counterpart.regionId === nation.regionId) return 0;
  const base = BASE_TARIFF_RATE * OPENNESS_MODIFIERS[nation.policies.openness].tariffMult;
  const discount = tradeDiscount(treaties, nation.id, counterpart.id);
  const rate = base * (1 - discount);
  return Math.min(0.99, Math.max(0, rate));
}

/** 掛市場單——沿用 routes/market.ts 原邏輯(組 tariffRate/PriceRef/seq → market.placeOrder →
 * 遞增 seq、寫入成交紀錄)。DB 讀寫(均價/序號/成交)搬進來一併處理,呼叫端只管 state 差異。 */
export async function applyPlaceOrder(
  db: D1Database,
  state: WorldState,
  seasonId: Id,
  nation: Nation,
  order: NewOrder,
  verified: boolean
): Promise<Result<{ state: WorldState; trades: Trade[]; unbanded: boolean }>> {
  const counterpart = pickCounterpart(state.orders, order, state.nations);
  const tariffRate = computeTariffRate(nation, counterpart, state.treaties);

  const avgPrice = await getRecentAvgPrices(db, seasonId, MARKET_PRICE_LOOKBACK);
  // finding #8:seq 改由 claimNextOrderSeq 一次原子認領(UPDATE...RETURNING),取代舊的
  // 「先讀現值、驗證通過後才另外遞增」兩步式——後者在驗證失敗時不會遞增,seq 沒有真的被消耗,
  // 但也代表兩個並發請求可能讀到同一個值。新版每次呼叫必定拿到獨一無二的 seq(即使該筆單
  // 之後驗證失敗、这個 seq 就作廢不用,換來的是「已認領的 seq 一定不重複」這個較強的保證。
  const seq = await claimNextOrderSeq(db, seasonId);

  const result = placeOrder(
    state.orders,
    order,
    { avgPrice },
    { verified, protectedUntil: nation.protectedUntil, tick: state.tick },
    tariffRate,
    seq
  );
  if (!result.ok) return result;

  if (result.value.trades.length > 0) await insertTrades(db, seasonId, result.value.trades);

  const next = { ...state, orders: result.value.book };
  return ok({ state: next, trades: result.value.trades, unbanded: result.value.unbanded });
}
