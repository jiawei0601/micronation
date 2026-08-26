// /api/world — 地圖輪詢:PublicWorldView + tick 倒數 + `?since=` 之後的涉己 events。
// 匿名可讀(不含涉己 events);已登入且已建國者可帶 since 拿自己國家相關的事件。

import { Hono } from 'hono';
import { toPublicWorldView } from '@micronation/shared';
import type { Env } from '../db/types';
import { parseSessionTokenFromCookieHeader } from '../auth/session';
import { resolveSession } from '../auth/service';
import { loadActiveWorld, findOwnNation } from '../game/state';
import { getEventsSince } from '../db/repository';
import { nextTickAt } from '../game/constants';

const worldRoutes = new Hono<{ Bindings: Env }>();

worldRoutes.get('/', async (c) => {
  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);

  const token = parseSessionTokenFromCookieHeader(c.req.header('Cookie'));
  const sessionCtx = await resolveSession(c.env.DB, token, Date.now());
  const viewerNation = sessionCtx ? findOwnNation(world.state, sessionCtx.user.id) : null;
  const viewerId = viewerNation?.id ?? null;

  const view = toPublicWorldView(world.state, viewerId);

  const sinceParam = c.req.query('since');
  let events: unknown[] = [];
  if (sinceParam !== undefined && viewerId) {
    const since = Number(sinceParam);
    if (!Number.isFinite(since)) return c.json({ error: 'INVALID_SINCE' }, 400);
    events = await getEventsSince(c.env.DB, world.seasonId, since, viewerId);
  }

  return c.json({
    view,
    nextTickAt: nextTickAt(Date.now()),
    events,
  });
});

export default worldRoutes;
