// /api/messages — 一對一站內訊息(國與國之間)。

import { Hono } from 'hono';
import { makeId } from '@micronation/shared';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, findNationById } from '../game/state';
import { insertMessage, listMessagesForNation, completeTask } from '../db/repository';

const messagesRoutes = new Hono<{ Bindings: Env }>();

messagesRoutes.get('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const nation = findOwnNation(world.state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const boxParam = c.req.query('box');
  const box = boxParam === 'sent' ? 'sent' : 'inbox';
  const messages = await listMessagesForNation(c.env.DB, nation.id, box);
  return c.json({ messages });
});

messagesRoutes.post('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await c.req.json<{ toNationId?: string; body?: string }>().catch(() => ({}) as never);
  if (!body.toNationId || !body.body || body.body.trim().length === 0 || body.body.length > 2000) {
    return c.json({ error: 'INVALID_BODY' }, 400);
  }

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const nation = findOwnNation(world.state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);
  if (nation.id === body.toNationId) return c.json({ error: 'SELF_MESSAGE' }, 400);
  if (!findNationById(world.state, body.toNationId)) return c.json({ error: 'RECIPIENT_NOT_FOUND' }, 404);

  const now = Date.now();
  const id = makeId('msg', nation.id, body.toNationId, now);
  await insertMessage(c.env.DB, {
    id,
    season_id: world.seasonId,
    from_nation_id: nation.id,
    to_nation_id: body.toNationId,
    body: body.body,
    created_at: now,
    read_at: null,
  });
  await completeTask(c.env.DB, user.id, 'send_message', now);

  return c.json({ id }, 201);
});

export default messagesRoutes;
