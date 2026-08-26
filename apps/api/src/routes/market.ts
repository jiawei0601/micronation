// /api/market — GET book、POST 掛單(組 PriceRef + tariffRate + seq)、DELETE :id 撤單。

import { Hono } from 'hono';
import type { NewOrder, ResourceKind, OrderSide } from '@micronation/shared';
import { cancelOrder } from '@micronation/market';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, persistWorld } from '../game/state';
import { applyPlaceOrder } from '../game/actions';
import { completeTask } from '../db/repository';

const RESOURCE_KINDS: ResourceKind[] = ['food', 'ore', 'fuel', 'money'];
const ORDER_SIDES: OrderSide[] = ['buy', 'sell'];

const marketRoutes = new Hono<{ Bindings: Env }>();

marketRoutes.get('/', async (c) => {
  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  return c.json({ book: world.state.orders });
});

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
  if (world.tickRunning) return c.json({ error: 'TICK_IN_PROGRESS' }, 503);
  const { state, seasonId } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const newOrder: NewOrder = { nationId: nation.id, kind: body.kind, side: body.side, qty: body.qty, price: body.price };
  const result = await applyPlaceOrder(c.env.DB, state, seasonId, nation, newOrder, !!user.verified);
  if (!result.ok) return c.json({ error: result.error }, 400);

  const next = result.value.state;
  const now = Date.now();
  await persistWorld(c.env.DB, state, next, [], now);
  await completeTask(c.env.DB, user.id, 'place_order', now);

  return c.json({ book: next.orders, trades: result.value.trades, unbanded: result.value.unbanded }, 201);
});

marketRoutes.delete('/:id', requireSession, async (c) => {
  const { user } = c.get('session');
  const orderId = c.req.param('id');

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  if (world.tickRunning) return c.json({ error: 'TICK_IN_PROGRESS' }, 503);
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
