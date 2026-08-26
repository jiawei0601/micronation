// /api/nation — GET 自己完整國家、GET /:id 公開視圖、POST 開國。

import { Hono } from 'hono';
import type { Nation, Policies } from '@micronation/shared';
import { toPublicWorldView, PROTECTION_TICKS, makeId } from '@micronation/shared';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, persistWorld } from '../game/state';
import { isNameAllowed, isValidFlagSpec } from '../game/constants';
import { completeTask } from '../db/repository';

const NPC_LIKE_INITIAL_RESOURCES = { food: 300, ore: 200, fuel: 100, money: 500 };
const NPC_LIKE_INITIAL_BUILDINGS = {
  farm: 1,
  mine: 1,
  refinery: 0,
  market: 0,
  barracks: 0,
  warehouse: 0,
  university: 0,
  wall: 0,
} as const;
const PLAYER_INITIAL_POLICIES: Policies = { tax: 'mid', economy: 'agri', conscription: 'volunteer', openness: 'neutral' };
const PLAYER_INITIAL_ACTION_POINTS = 5;
const PLAYER_INITIAL_POPULATION = 100;
const PLAYER_INITIAL_MORALE = 60;
const PLAYER_INITIAL_ARMY_SIZE = 10;

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
  const body = await c.req.json<{ name?: string; flag?: unknown; regionId?: string }>().catch(() => ({}) as never);

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const { state } = world;

  if (findOwnNation(state, user.id)) return c.json({ error: 'ALREADY_HAS_NATION' }, 400);
  if (!body.name || !isNameAllowed(body.name)) return c.json({ error: 'INVALID_NAME' }, 400);
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
    name: body.name.trim(),
    flag: body.flag as Nation['flag'],
    regionId,
    resources: { ...NPC_LIKE_INITIAL_RESOURCES },
    tech: 0,
    actionPoints: PLAYER_INITIAL_ACTION_POINTS,
    population: PLAYER_INITIAL_POPULATION,
    morale: PLAYER_INITIAL_MORALE,
    buildings: { ...NPC_LIKE_INITIAL_BUILDINGS },
    buildQueue: [],
    army: { size: PLAYER_INITIAL_ARMY_SIZE },
    policies: { ...PLAYER_INITIAL_POLICIES },
    policyChangedAt: {},
    reputation: { breaches: 0 },
    protectedUntil: state.tick + PROTECTION_TICKS,
    score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 },
    createdAt: state.tick,
  };

  const next = { ...state, nations: [...state.nations, nation] };
  await persistWorld(c.env.DB, state, next, [], now);
  await completeTask(c.env.DB, user.id, 'found_nation', now);

  return c.json({ nation }, 201);
});

export default nationRoutes;
