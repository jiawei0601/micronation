// POST /api/build — 排入建設佇列。驗資源/佇列容量,依 CONTRACT §api「薄殼」流程:
// 讀 WorldState → 驗證(api 層常數:BUILDING_LEVELS/BUILD_QUEUE_CAPACITY/MAX_BUILDING_LEVEL)
// → 差異寫回。

import { Hono } from 'hono';
import type { BuildingKind } from '@micronation/shared';
import { BUILDING_LEVELS, BUILD_QUEUE_CAPACITY, MAX_BUILDING_LEVEL } from '@micronation/shared';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, persistWorld } from '../game/state';
import { completeTask } from '../db/repository';

const BUILDING_KINDS: BuildingKind[] = ['farm', 'mine', 'refinery', 'market', 'barracks', 'warehouse', 'university', 'wall'];

const buildRoutes = new Hono<{ Bindings: Env }>();

buildRoutes.post('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await c.req.json<{ building?: string }>().catch(() => ({}) as never);
  const building = body.building as BuildingKind | undefined;
  if (!building || !BUILDING_KINDS.includes(building)) return c.json({ error: 'INVALID_BUILDING' }, 400);

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  if (nation.buildQueue.length >= BUILD_QUEUE_CAPACITY) return c.json({ error: 'QUEUE_FULL' }, 400);

  const level = nation.buildings[building] ?? 0;
  if (level >= MAX_BUILDING_LEVEL) return c.json({ error: 'MAX_LEVEL' }, 400);

  const spec = BUILDING_LEVELS[building][level];
  for (const [k, v] of Object.entries(spec.cost)) {
    if (nation.resources[k as keyof typeof nation.resources] < (v as number)) {
      return c.json({ error: 'INSUFFICIENT_RESOURCES' }, 400);
    }
  }

  const resources = { ...nation.resources };
  for (const [k, v] of Object.entries(spec.cost)) {
    resources[k as keyof typeof resources] -= v as number;
  }

  const updatedNation = {
    ...nation,
    resources,
    buildQueue: [...nation.buildQueue, { building, completesAt: state.tick + spec.timeTicks }],
  };
  const next = { ...state, nations: state.nations.map((n) => (n.id === nation.id ? updatedNation : n)) };

  const now = Date.now();
  await persistWorld(c.env.DB, state, next, [], now);
  await completeTask(c.env.DB, user.id, 'build_first', now);

  return c.json({ nation: updatedNation });
});

export default buildRoutes;
