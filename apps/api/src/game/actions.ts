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
import { placeOrder, cancelOrder } from '@micronation/market';
import { tradeDiscount } from '@micronation/diplomacy';
import type { D1Database } from '../db/types';
import { BASE_TARIFF_RATE, MARKET_PRICE_LOOKBACK } from './constants';
import { getRecentAvgPrices, claimNextOrderSeq } from '../db/repository';

function replaceNation(state: WorldState, nation: Nation): WorldState {
  return { ...state, nations: state.nations.map((n) => (n.id === nation.id ? nation : n)) };
}

function updateNationResources(
  nations: Nation[],
  nationId: Id,
  mutate: (resources: Nation['resources']) => Nation['resources']
): Nation[] {
  return nations.map((n) => (n.id === nationId ? { ...n, resources: mutate({ ...n.resources }) } : n));
}

/** 排入建設佇列——沿用 routes/build.ts 原邏輯(佇列容量/最高等級/資源足額)。
 * finding #5:building/level 邊界檢查——BUILDING_LEVELS 表若查無該 building(理論上不該發生,
 * 呼叫端已有白名單,但 actions.ts 也被 tick-cron 內部呼叫,防禦性補一層)或 level 超出該
 * building 定義的等級表長度(spec 會是 undefined),不可讓 undefined.cost 直接炸掉整個請求。 */
export function applyBuild(state: WorldState, nation: Nation, building: BuildingKind): Result<{ state: WorldState }> {
  if (nation.buildQueue.length >= BUILD_QUEUE_CAPACITY) return err('QUEUE_FULL');

  const levels = BUILDING_LEVELS[building];
  if (!levels) return err('INVALID_BUILDING');

  const level = nation.buildings[building] ?? 0;
  if (level >= MAX_BUILDING_LEVEL) return err('MAX_LEVEL');

  const spec = levels[level];
  if (!spec) return err('MAX_LEVEL');

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

function computeTariffRate(nation: Nation, counterpart: Nation, treaties: Treaty[]): number {
  if (counterpart.regionId === nation.regionId) return 0;
  const base = BASE_TARIFF_RATE * OPENNESS_MODIFIERS[nation.policies.openness].tariffMult;
  const discount = tradeDiscount(treaties, nation.id, counterpart.id);
  const rate = base * (1 - discount);
  return Math.min(0.99, Math.max(0, rate));
}

/**
 * finding #2:market.placeOrder 單次呼叫只吃一個 tariffRate,但撮合可能吃進多個不同區域的
 * 對手單,各自的正確關稅率不同——逐筆分開呼叫 market.placeOrder(讓每筆對手單各自撮合)
 * 需要大改 market 撮合迴圈(packages/** 依交辦鐵則不可更動)。改採保守方案:取本筆單所有候選
 * 對手(對邊、同 kind、不同國家)之中最高的關稅率作為本次估算——高估傾向(部分成交可能被
 * 課到比實際更高的關稅),但不會低估、不會讓玩家少繳關稅規避新制,對系統財政較安全。
 * 已在 CONTRACT.md 標註此簡化與取捨。
 */
function computeConservativeTariffRate(state: WorldState, nation: Nation, order: NewOrder): number {
  const opposite = state.orders.filter(
    (b) => b.kind === order.kind && b.side !== order.side && b.nationId !== order.nationId
  );
  if (opposite.length === 0) return 0;

  const counterpartIds = new Set(opposite.map((o) => o.nationId));
  let maxRate = 0;
  for (const id of counterpartIds) {
    const counterpart = state.nations.find((n) => n.id === id);
    if (!counterpart) continue;
    const rate = computeTariffRate(nation, counterpart, state.treaties);
    if (rate > maxRate) maxRate = rate;
  }
  return maxRate;
}

/** finding #1:市場成交後的資源結算——packages/market 只算「誰跟誰成交多少」,不碰任何
 * Nation.resources(維持純函式、零 IO)。這一層負責把 Trade[] 換算成雙方餘額變動:
 *
 * - 掛賣單時已鎖定(escrow)qty 的 `kind` 資源(見 applyPlaceOrder 下方);成交時賣方
 *   在 `kind` 這邊已經扣過,不再重複扣,只需入帳成交所得(qty×成交價 − 關稅)。
 * - 掛買單時已鎖定 qty×限價 的 money;成交時買方在 money 這邊已經扣過,只需入帳收到的
 *   `kind` 資源。買方若是本次下單的 taker,實際成交價可能優於(低於)限價——見
 *   `refundTakerBuyOverEscrow` 的差額退款。
 * - 關稅(Trade.tariff)去向:採「系統回收=直接消失」——不記入任何國家帳上,直接從賣方
 *   應得款項中扣除,不轉給任何第三方(此為保守/最簡實作,CONTRACT 已註明)。
 */
function settleTrades(nations: Nation[], trades: Trade[]): Nation[] {
  let next = nations;
  for (const trade of trades) {
    next = updateNationResources(next, trade.buyerId, (r) => {
      r[trade.kind] += trade.qty;
      return r;
    });
    next = updateNationResources(next, trade.sellerId, (r) => {
      r.money += trade.qty * trade.price - trade.tariff;
      return r;
    });
  }
  return next;
}

/** taker 若為買方,原始 escrow 是用「限價」全額鎖定(qty × o.price);實際成交價
 * (= maker 的掛單價)可能更低,把每筆成交的價差退還給 taker。resting 單(maker)一律成交於
 * 自己當初掛單時鎖定的價格,沒有價差、不需退款(見上方 settleTrades 註解)。 */
function refundTakerBuyOverEscrow(nations: Nation[], takerNationId: Id, limitPrice: number, trades: Trade[]): Nation[] {
  let refund = 0;
  for (const trade of trades) {
    if (trade.buyerId === takerNationId) {
      refund += (limitPrice - trade.price) * trade.qty;
    }
  }
  if (refund === 0) return nations;
  return updateNationResources(nations, takerNationId, (r) => {
    r.money += refund;
    return r;
  });
}

/** 掛市場單——沿用 routes/market.ts 原邏輯(組 tariffRate/PriceRef/seq → market.placeOrder →
 * 遞增 seq、遞增資源結算)。DB 讀寫(均價/序號)搬進來一併處理,呼叫端只管 state 差異;
 * finding #3:trades 本身不在此處寫入 DB——改由呼叫端(routes/market.ts、tick/run.ts)把回傳
 * 的 trades 一併交給 persistWorld/saveWorldState,和該次 batch 一起原子寫入,不再各自獨立
 * insertTrades。
 * finding #4:order.nationId 必須等於呼叫端已驗證身分的 nation.id,且本次操作所在的
 * seasonId 須與 state.seasonId 一致——防止呼叫端傳錯 nation/seasonId 卻沒被攔下。 */
export async function applyPlaceOrder(
  db: D1Database,
  state: WorldState,
  seasonId: Id,
  nation: Nation,
  order: NewOrder,
  verified: boolean
): Promise<Result<{ state: WorldState; trades: Trade[]; unbanded: boolean }>> {
  if (order.nationId !== nation.id) return err('NATION_MISMATCH');
  if (state.seasonId !== seasonId) return err('SEASON_MISMATCH');

  // 順序刻意如此:先讓 packages/market.placeOrder 跑完它原本的合法性檢查(qty/price/
  // PRICE_BAND/UNVERIFIED/PROTECTED_LIMIT...),escrow 的資源足額檢查放在「market 判定這筆單
  // 本身合法」之後才做——如果先擋資源不足,像「超過保護期量上限」這種原本該回
  // PROTECTED_LIMIT 的案例會被 INSUFFICIENT_RESOURCES 蓋過去,對呼叫端(前端錯誤訊息)是
  // 語意倒退。這裡的呼叫在 placeOrder 拒絕時不會有任何副作用(escrow 還沒發生),安全。
  const tariffRate = computeConservativeTariffRate(state, nation, order);
  const avgPrice = await getRecentAvgPrices(db, seasonId, MARKET_PRICE_LOOKBACK);
  // finding #8(既有,沿用):seq 改由 claimNextOrderSeq 一次原子認領(UPDATE...RETURNING)。
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

  // ---- escrow:market 已判定合法,才真正鎖定資源 ----
  // ②-1:專案尚未部署、無任何線上掛單資料——squash migration(0001_init.sql)已把 escrow 相關
  // 欄位/約束定案在唯一的一份乾淨 schema 裡,不存在「既有掛單沒鎖定資源」的相容性問題。
  let escrowedNation: Nation;
  if (order.side === 'sell') {
    if (nation.resources[order.kind] < order.qty) return err('INSUFFICIENT_RESOURCES');
    escrowedNation = { ...nation, resources: { ...nation.resources, [order.kind]: nation.resources[order.kind] - order.qty } };
  } else {
    const notional = order.qty * order.price;
    if (!Number.isSafeInteger(notional)) return err('UNSAFE_NOTIONAL');
    if (nation.resources.money < notional) return err('INSUFFICIENT_RESOURCES');
    escrowedNation = { ...nation, resources: { ...nation.resources, money: nation.resources.money - notional } };
  }

  let nations = state.nations.map((n) => (n.id === nation.id ? escrowedNation : n));
  nations = settleTrades(nations, result.value.trades);
  if (order.side === 'buy') {
    nations = refundTakerBuyOverEscrow(nations, nation.id, order.price, result.value.trades);
  }

  // ②-2:市場撮合可能一次吃進多筆對手單,結算的 `+=` 理論上可能讓資源/金錢超出
  // Number.MAX_SAFE_INTEGER(極端情況,例如長期掛巨額單、engine 允許的價格/數量上限夠寬鬆時)。
  // 溢位後的浮點數不再精確,後續任何「餘額比較/扣款」都可能算錯。這裡結算完成後驗證所有受
  // 影響的欄位仍是安全整數,任一欄位溢位就整筆拒絕(不 ok,呼叫端不會 persist 這次的 state
  // 變更,orders/trades 都不落地),不讓髒資料進 DB。
  const touchedNationIds = new Set(result.value.trades.flatMap((t) => [t.buyerId, t.sellerId]));
  for (const n of nations) {
    if (!touchedNationIds.has(n.id)) continue;
    const unsafe = (Object.values(n.resources) as number[]).some((v) => !Number.isSafeInteger(v));
    if (unsafe) return err('RESOURCE_OVERFLOW');
  }

  const next = { ...state, orders: result.value.book, nations };
  return ok({ state: next, trades: result.value.trades, unbanded: result.value.unbanded });
}

/** 撤單——沿用 packages/market.cancelOrder 的合法性檢查,額外退回 applyPlaceOrder 掛單時
 * 鎖定(escrow)的資源:sell 單退回剩餘 qty 的 `kind` 資源,buy 單退回剩餘 qty × 限價的 money
 * (finding #1)。 */
export function applyCancelOrder(state: WorldState, nationId: Id, orderId: Id): Result<{ state: WorldState }> {
  const target = state.orders.find((o) => o.id === orderId);
  const result = cancelOrder(state.orders, orderId, nationId);
  if (!result.ok) return result;

  // cancelOrder 已驗證 target 存在且屬於 nationId(否則會回 Err),这里的 target 必定非 undefined。
  const order = target!;
  const nations = updateNationResources(state.nations, nationId, (r) => {
    if (order.side === 'sell') {
      r[order.kind] += order.qty;
    } else {
      r.money += order.qty * order.price;
    }
    return r;
  });

  return ok({ state: { ...state, orders: result.value.book, nations } });
}
