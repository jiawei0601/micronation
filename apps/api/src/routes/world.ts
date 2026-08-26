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

  // finding #9:`since` 的語意從「tick」改成 getEventsSince 回傳的 events.seq(events 表
  // rowid,單調遞增)——見 db/repository.ts getEventsSince 註解。型別仍是 number,呼叫端
  // (web)只需要把上次回應裡每筆事件的 `seq` 取最大值,原封不動帶回下次的 `since` 即可,不需要
  // 自己再去湊 tick。首次輪詢帶 0(或省略 since 直接不帶 events)。
  const sinceParam = c.req.query('since');
  let events: { seq: number }[] = [];
  let nextCursor: number | null = null;
  if (sinceParam !== undefined && viewerId) {
    const since = Number(sinceParam);
    // ②-19:since 是 events 表 rowid cursor(見 getEventsSince 註解),語意上不可能是負數/小數—
    // 原本只驗「是有限數字」,`?since=-1` 或 `?since=1.5` 會原封不動傳進 SQL 的 `rowid > ?`
    // 比較(SQLite 對這類值有隱含轉型行為,不乾淨)。改驗證非負安全整數。
    if (!Number.isSafeInteger(since) || since < 0) return c.json({ error: 'INVALID_SINCE' }, 400);
    // ①-12/②-17:getEventsSince 現在回傳 { events, scannedUpTo }——scannedUpTo 是「本批掃描到
    // 的最大 seq」,即使掃到的事件裡沒有任何一筆跟自己有關也會前進,呼叫端不會被一長串跟自己
    // 無關的事件卡住、永遠停在同一個 since 重複輪詢同一批資料。
    const result = await getEventsSince(c.env.DB, world.seasonId, since, viewerId);
    events = result.events;
    nextCursor = result.scannedUpTo;
  }

  return c.json({
    view,
    nextTickAt: nextTickAt(Date.now()),
    events,
    nextCursor,
  });
});

export default worldRoutes;
