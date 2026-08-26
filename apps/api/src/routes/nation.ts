// /api/nation — GET 自己完整國家、GET /:id 公開視圖、POST 開國。

import { Hono } from 'hono';
import type { Nation } from '@micronation/shared';
import { toPublicWorldView, PROTECTION_TICKS, makeId } from '@micronation/shared';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation } from '../game/state';
import { isNameAllowed, isValidFlagSpec } from '../game/constants';
import {
  PLAYER_INITIAL_RESOURCES,
  PLAYER_INITIAL_BUILDINGS,
  PLAYER_INITIAL_POLICIES,
  PLAYER_INITIAL_ACTION_POINTS,
  PLAYER_INITIAL_POPULATION,
  PLAYER_INITIAL_MORALE,
  PLAYER_INITIAL_ARMY_SIZE,
} from '../game/constants';
import { safeCompleteTask, insertNewNation, NationAlreadyFoundedError } from '../db/repository';
import { parseJsonBody, asTrimmedString } from '../lib/parseBody';

const nationRoutes = new Hono<{ Bindings: Env }>();

nationRoutes.get('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const nation = findOwnNation(world.state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);
  return c.json({ nation });
});

nationRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const view = toPublicWorldView(world.state, null);
  const nation = view.nations.find((n) => n.id === id);
  if (!nation) return c.json({ error: 'NOT_FOUND' }, 404);
  return c.json({ nation });
});

nationRoutes.post('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = (await parseJsonBody<{ name?: string; flag?: unknown; regionId?: string }>(c.req)) ?? {};

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  if (world.tickRunning) return c.json({ error: 'TICK_IN_PROGRESS' }, 503);
  const { state } = world;

  // finding #18:這裡的記憶體檢查只是提早失敗、省一次 DB 寫入——真正的一國一владелец把關在
  // insertNewNation 的 DB 唯一索引(下方 catch NationAlreadyFoundedError)。
  if (findOwnNation(state, user.id)) return c.json({ error: 'ALREADY_HAS_NATION' }, 400);
  // ②-3/②-8/②-18:body.name 先過 asTrimmedString(typeof 檢查+trim)——原本 `!body.name` 對
  // truthy 的非字串值(例如數字)放行,isNameAllowed 內部呼叫 `.trim()` 會直接丟未預期例外。
  const name = asTrimmedString(body.name, 60);
  if (!name || !isNameAllowed(name)) return c.json({ error: 'INVALID_NAME' }, 400);
  if (!isValidFlagSpec(body.flag)) return c.json({ error: 'INVALID_FLAG' }, 400);

  let regionId = body.regionId;
  if (regionId) {
    if (!state.regions.some((r) => r.id === regionId)) return c.json({ error: 'REGION_NOT_FOUND' }, 400);
  } else {
    // 自動分配:選目前國家數最少的區域(平均分散),同票取陣列序第一個。
    const counts = new Map<string, number>(state.regions.map((r) => [r.id, 0]));
    for (const n of state.nations) counts.set(n.regionId, (counts.get(n.regionId) ?? 0) + 1);
    let best = state.regions[0];
    let bestCount = Infinity;
    for (const r of state.regions) {
      const count = counts.get(r.id) ?? 0;
      if (count < bestCount) {
        best = r;
        bestCount = count;
      }
    }
    regionId = best.id;
  }

  const now = Date.now();
  const nation: Nation = {
    id: makeId('nation', user.id, now),
    ownerId: user.id,
    name,
    flag: body.flag as Nation['flag'],
    regionId,
    resources: { ...PLAYER_INITIAL_RESOURCES },
    tech: 0,
    actionPoints: PLAYER_INITIAL_ACTION_POINTS,
    population: PLAYER_INITIAL_POPULATION,
    morale: PLAYER_INITIAL_MORALE,
    buildings: { ...PLAYER_INITIAL_BUILDINGS },
    buildQueue: [],
    army: { size: PLAYER_INITIAL_ARMY_SIZE },
    policies: { ...PLAYER_INITIAL_POLICIES },
    policyChangedAt: {},
    reputation: { breaches: 0 },
    protectedUntil: state.tick + PROTECTION_TICKS,
    score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 },
    createdAt: state.tick,
  };

  try {
    await insertNewNation(c.env.DB, world.seasonId, nation);
  } catch (e) {
    if (e instanceof NationAlreadyFoundedError) return c.json({ error: 'ALREADY_HAS_NATION' }, 400);
    throw e;
  }
  await safeCompleteTask(c.env.DB, user.id, 'found_nation', now);

  return c.json({ nation }, 201);
});

export default nationRoutes;
