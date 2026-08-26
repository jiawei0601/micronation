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
import { parseJsonBody, asTrimmedString, asString } from '../lib/parseBody';

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
  if (before !== undefined && !Number.isSafeInteger(before)) return c.json({ error: 'INVALID_BEFORE' }, 400);
  // ②-9:limit 原本只驗「是有限數字」,像 `?limit=1.5` 或 `?limit=-3` 會原封不動傳進
  // listMessagesForNation——repository 那邊雖然用 Math.min/Math.max 夾住範圍,但夾出來的仍是
  // 非整數(SQL LIMIT 1.5 依 driver 行為不一定等於「1 筆」),語意不乾淨。改成明確驗證安全整數,
  // 不合法直接 400,不留給下游猜。
  const limitParam = c.req.query('limit');
  const limit = limitParam !== undefined ? Number(limitParam) : undefined;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) return c.json({ error: 'INVALID_LIMIT' }, 400);

  const { messages, nextCursor } = await listMessagesForNation(c.env.DB, nation.id, box, { before, limit });
  return c.json({ messages, nextCursor });
});

messagesRoutes.post('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await parseJsonBody<{ toNationId?: string; body?: string }>(c.req);
  // ②-3/②-8/②-18:toNationId/body 先過 typeof 檢查(asString/asTrimmedString)才使用——原本
  // `!body.body || body.body.trim()...` 對 truthy 的非字串值(例如數字)會在 `.trim()` 這行
  // 丟未預期例外,而不是乾淨地回 400。
  const toNationId = body ? asString(body.toNationId) : undefined;
  const messageBody = body ? asTrimmedString(body.body, 2000) : undefined;
  if (!toNationId || !messageBody) return c.json({ error: 'INVALID_BODY' }, 400);

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const nation = findOwnNation(world.state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);
  if (nation.id === toNationId) return c.json({ error: 'SELF_MESSAGE' }, 400);
  if (!findNationById(world.state, toNationId)) return c.json({ error: 'RECIPIENT_NOT_FOUND' }, 404);

  const sentThisTick = await countMessagesSentInTick(c.env.DB, nation.id, world.state.tick);
  if (sentThisTick >= MESSAGE_RATE_LIMIT_PER_TICK) return c.json({ error: 'RATE_LIMITED' }, 429);

  const now = Date.now();
  const seq = await claimNextMessageSeq(c.env.DB, world.seasonId);
  const id = makeId('msg', world.seasonId, seq);
  await insertMessage(c.env.DB, {
    id,
    season_id: world.seasonId,
    from_nation_id: nation.id,
    to_nation_id: toNationId,
    body: messageBody,
    created_at: now,
    read_at: null,
    tick: world.state.tick,
  });
  await safeCompleteTask(c.env.DB, user.id, 'send_message', now);

  return c.json({ id }, 201);
});

export default messagesRoutes;
