// POST /api/build — 排入建設佇列。驗資源/佇列容量,依 CONTRACT §api「薄殼」流程:
// 讀 WorldState → 驗證(api 層常數:BUILDING_LEVELS/BUILD_QUEUE_CAPACITY/MAX_BUILDING_LEVEL)
// → 差異寫回。

import { Hono } from 'hono';
import type { BuildingKind } from '@micronation/shared';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, persistWorld } from '../game/state';
import { applyBuild } from '../game/actions';
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
  if (world.tickRunning) return c.json({ error: 'TICK_IN_PROGRESS' }, 503);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const result = applyBuild(state, nation, building);
  if (!result.ok) return c.json({ error: result.error }, 400);
  const next = result.value.state;
  const updatedNation = findOwnNation(next, user.id)!;

  const now = Date.now();
  await persistWorld(c.env.DB, state, next, [], now);
  await completeTask(c.env.DB, user.id, 'build_first', now);

  return c.json({ nation: updatedNation });
});

export default buildRoutes;
