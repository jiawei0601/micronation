// /api/market — GET book、POST 掛單(組 PriceRef + tariffRate + seq)、DELETE :id 撤單。

import { Hono } from 'hono';
import type { MarketOrder, NewOrder, ResourceKind, OrderSide, Nation, Treaty } from '@micronation/shared';
import { OPENNESS_MODIFIERS } from '@micronation/shared';
import { placeOrder, cancelOrder } from '@micronation/market';
import { tradeDiscount } from '@micronation/diplomacy';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, persistWorld } from '../game/state';
import { BASE_TARIFF_RATE, MARKET_PRICE_LOOKBACK } from '../game/constants';
import { getRecentAvgPrices, getSeasonOrderSeq, incrementSeasonOrderSeq, insertTrades, completeTask } from '../db/repository';

const RESOURCE_KINDS: ResourceKind[] = ['food', 'ore', 'fuel', 'money'];
const ORDER_SIDES: OrderSide[] = ['buy', 'sell'];

const marketRoutes = new Hono<{ Bindings: Env }>();

marketRoutes.get('/', async (c) => {
  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  return c.json({ book: world.state.orders });
});

/**
 * 近似估算 taker 這筆單的跨區關稅率(CONTRACT:「tariffRate 由 diplomacy.tradeDiscount+跨區判定」)。
 * market.placeOrder 單次呼叫只吃一個 tariffRate,但撮合可能同時對到多個不同國家的對手單——
 * 這裡取 book 上對 taker 最有利的候選對手單(排序邏輯呼應 market 內部撮合的價格優先)來代表
 * 「這筆單」的關稅情境,而非逐筆結算各自不同的稅率。屬 M7 已知簡化,若之後要精確到每筆
 * trade 各自稅率,需改 market.placeOrder 簽名支援多稅率輸入。
 */
function pickCounterpart(book: MarketOrder[], o: NewOrder, nations: Nation[]): Nation | null {
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

marketRoutes.post('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await c.req.json<Partial<NewOrder>>().catch(() => ({}) as never);
  if (
    !body.kind ||
    !RESOURCE_KINDS.includes(body.kind) ||
    !body.side ||
    !ORDER_SIDES.includes(body.side) ||
    typeof body.qty !== 'number' ||
    typeof body.price !== 'number'
  ) {
    return c.json({ error: 'INVALID_BODY' }, 400);
  }

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const { state, seasonId } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const newOrder: NewOrder = { nationId: nation.id, kind: body.kind, side: body.side, qty: body.qty, price: body.price };
  const counterpart = pickCounterpart(state.orders, newOrder, state.nations);
  const tariffRate = computeTariffRate(nation, counterpart, state.treaties);

  const avgPrice = await getRecentAvgPrices(c.env.DB, seasonId, MARKET_PRICE_LOOKBACK);
  const seq = await getSeasonOrderSeq(c.env.DB, seasonId);

  const result = placeOrder(
    state.orders,
    newOrder,
    { avgPrice },
    { verified: !!user.verified, protectedUntil: nation.protectedUntil, tick: state.tick },
    tariffRate,
    seq
  );
  if (!result.ok) return c.json({ error: result.error }, 400);

  const next = { ...state, orders: result.value.book };
  const now = Date.now();
  await persistWorld(c.env.DB, state, next, [], now);
  await incrementSeasonOrderSeq(c.env.DB, seasonId);
  if (result.value.trades.length > 0) await insertTrades(c.env.DB, seasonId, result.value.trades);
  await completeTask(c.env.DB, user.id, 'place_order', now);

  return c.json({ book: result.value.book, trades: result.value.trades, unbanded: result.value.unbanded }, 201);
});

marketRoutes.delete('/:id', requireSession, async (c) => {
  const { user } = c.get('session');
  const orderId = c.req.param('id');

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const result = cancelOrder(state.orders, orderId, nation.id);
  if (!result.ok) return c.json({ error: result.error }, result.error === 'FORBIDDEN' ? 403 : 404);

  const next = { ...state, orders: result.value.book };
  const now = Date.now();
  await persistWorld(c.env.DB, state, next, [], now);
  await completeTask(c.env.DB, user.id, 'cancel_order', now);

  return c.json({ book: result.value.book });
});

export default marketRoutes;
