// /api/messages — 一對一站內訊息(國與國之間)。

import { Hono } from 'hono';
import { makeId } from '@micronation/shared';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, findNationById } from '../game/state';
import {
  insertMessage,
  listMessagesForNation,
  safeCompleteTask,
  claimNextMessageSeq,
  countMessagesSentInTick,
} from '../db/repository';
import { parseJsonBody } from '../lib/parseBody';

// finding #20:每國每 tick 最多送出的訊息則數,簡單速率限制,擋洗版/濫用。
const MESSAGE_RATE_LIMIT_PER_TICK = 10;

const messagesRoutes = new Hono<{ Bindings: Env }>();

messagesRoutes.get('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const nation = findOwnNation(world.state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const boxParam = c.req.query('box');
  const box = boxParam === 'sent' ? 'sent' : 'inbox';

  // finding #20:`?before=` 游標分頁(rowid-based,見 repository.listMessagesForNation),
  // limit 上限 100。
  const beforeParam = c.req.query('before');
  const before = beforeParam !== undefined ? Number(beforeParam) : undefined;
  if (before !== undefined && !Number.isFinite(before)) return c.json({ error: 'INVALID_BEFORE' }, 400);
  const limitParam = c.req.query('limit');
  const limit = limitParam !== undefined && Number.isFinite(Number(limitParam)) ? Number(limitParam) : undefined;

  const { messages, nextCursor } = await listMessagesForNation(c.env.DB, nation.id, box, { before, limit });
  return c.json({ messages, nextCursor });
});

messagesRoutes.post('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await parseJsonBody<{ toNationId?: string; body?: string }>(c.req);
  if (!body || !body.toNationId || !body.body || body.body.trim().length === 0 || body.body.length > 2000) {
    return c.json({ error: 'INVALID_BODY' }, 400);
  }

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const nation = findOwnNation(world.state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);
  if (nation.id === body.toNationId) return c.json({ error: 'SELF_MESSAGE' }, 400);
  if (!findNationById(world.state, body.toNationId)) return c.json({ error: 'RECIPIENT_NOT_FOUND' }, 404);

  const sentThisTick = await countMessagesSentInTick(c.env.DB, nation.id, world.state.tick);
  if (sentThisTick >= MESSAGE_RATE_LIMIT_PER_TICK) return c.json({ error: 'RATE_LIMITED' }, 429);

  const now = Date.now();
  const seq = await claimNextMessageSeq(c.env.DB, world.seasonId);
  const id = makeId('msg', world.seasonId, seq);
  await insertMessage(c.env.DB, {
    id,
    season_id: world.seasonId,
    from_nation_id: nation.id,
    to_nation_id: body.toNationId,
    body: body.body,
    created_at: now,
    read_at: null,
    tick: world.state.tick,
  });
  await safeCompleteTask(c.env.DB, user.id, 'send_message', now);

  return c.json({ id }, 201);
});

export default messagesRoutes;
