// /api/market — GET book、POST 掛單(組 PriceRef + tariffRate + seq)、DELETE :id 撤單。

import { Hono } from 'hono';
import type { NewOrder, ResourceKind, OrderSide } from '@micronation/shared';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, persistWorld } from '../game/state';
import { applyPlaceOrder, applyCancelOrder } from '../game/actions';
import { safeCompleteTask } from '../db/repository';
import { parseJsonBody } from '../lib/parseBody';

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
  const body = await parseJsonBody<Partial<NewOrder>>(c.req);
  if (
    !body ||
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
  // finding #1/#3:成交後的資源結算已在 applyPlaceOrder 內完成(next.nations 已含最新餘額),
  // trades 隨同 nations/orders 差異一起交給 persistWorld,同一 batch 原子寫入。
  await persistWorld(c.env.DB, state, next, [], now, result.value.trades, world.version);
  await safeCompleteTask(c.env.DB, user.id, 'place_order', now);

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

  // finding #1:撤單走 applyCancelOrder(game/actions.ts)——除了原本的 market.cancelOrder
  // 合法性檢查,還會把掛單時鎖定(escrow)的資源/金錢退回。
  const result = applyCancelOrder(state, nation.id, orderId);
  if (!result.ok) {
    // ③-6:cancelOrder 的合法性錯誤(NOT_FOUND/FORBIDDEN)之外,applyCancelOrder 現在還可能因
    // 退款金額安全整數檢查失敗回傳 RESOURCE_OVERFLOW——這不是「找不到/沒權限」,語意上是
    // 400(請求本身在目前狀態下無法安全處理),不該落進原本 404 的預設分支。
    const status = result.error === 'FORBIDDEN' ? 403 : result.error === 'RESOURCE_OVERFLOW' ? 400 : 404;
    return c.json({ error: result.error }, status);
  }

  const next = result.value.state;
  const now = Date.now();
  await persistWorld(c.env.DB, state, next, [], now, [], world.version);
  await safeCompleteTask(c.env.DB, user.id, 'cancel_order', now);

  return c.json({ book: next.orders });
});

export default marketRoutes;
