// POST /api/admin/season — 開新賽季(M8)。簡單 bearer token 保護(env.ADMIN_TOKEN),
// 不走玩家 session 系統。同時只允許一個 active 賽季——上一季須先由 runTick 到期結算
// (標記 ended)才能開下一季,避免兩個 active 賽季並存讓 getActiveSeasonId 語意混亂。

import { Hono } from 'hono';
import type { WorldState } from '@micronation/shared';
import { makeId } from '@micronation/shared';
import { generateNpcNations } from '@micronation/npc';
import type { Env } from '../db/types';
import { createSeason, getActiveSeasonId } from '../db/repository';
import { DEFAULT_REGIONS, DEFAULT_NPC_COUNT } from '../game/constants';

const adminRoutes = new Hono<{ Bindings: Env }>();

function isAuthorized(c: { env: Env; req: { header(name: string): string | undefined } }): boolean {
  if (!c.env.ADMIN_TOKEN) return false; // 未設定 token → 一律拒絕,不可能「沒設定就開放」
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  return token === c.env.ADMIN_TOKEN;
}

adminRoutes.post('/season', async (c) => {
  if (!isAuthorized(c)) return c.json({ error: 'UNAUTHORIZED' }, 401);

  const existing = await getActiveSeasonId(c.env.DB);
  if (existing) return c.json({ error: 'SEASON_ALREADY_ACTIVE' }, 409);

  const body = await c.req.json<{ name?: string; npcCount?: number }>().catch(() => ({}) as never);
  const npcCount = Number.isSafeInteger(body.npcCount) && (body.npcCount as number) >= 0 ? (body.npcCount as number) : DEFAULT_NPC_COUNT;

  const now = Date.now();
  const npcResult = generateNpcNations(npcCount, DEFAULT_REGIONS, `season-npc:${now}`);
  if (!npcResult.ok) return c.json({ error: npcResult.error }, 400);

  const seasonId = makeId('season', now);
  const state: WorldState = {
    seasonId,
    tick: 0,
    regions: DEFAULT_REGIONS,
    nations: npcResult.value,
    marches: [],
    treaties: [],
    orders: [],
    nextMarchSeq: 0,
  };

  await createSeason(c.env.DB, body.name ?? `Season ${now}`, state, now);

  return c.json({ seasonId }, 201);
});

export default adminRoutes;
