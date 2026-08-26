// POST /api/policy — 48(依 shared.POLICY_CHANGE_COOLDOWN)tick 冷卻 + 固定成本。
// ⚠️CONTRACT 派工文字寫「48 tick 冷卻」,但 shared/src/constants.ts 正本
// POLICY_CHANGE_COOLDOWN = 24——packages/** 依交辦鐵則不可更動,故以 shared 正本(24)為準,
// 此為口頭數字與已鎖定常數的落差,非「CONTRACT 變動」,予以回報。

import { Hono } from 'hono';
import type { PolicyAxis, Policies } from '@micronation/shared';
import { POLICY_CHANGE_COOLDOWN } from '@micronation/shared';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, persistWorld } from '../game/state';
import { POLICY_CHANGE_COST } from '../game/constants';
import { completeTask } from '../db/repository';

const AXIS_TIERS: Record<PolicyAxis, string[]> = {
  tax: ['low', 'mid', 'high'],
  economy: ['agri', 'industry', 'commerce'],
  conscription: ['volunteer', 'draft'],
  openness: ['closed', 'neutral', 'free'],
};

const policyRoutes = new Hono<{ Bindings: Env }>();

policyRoutes.post('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await c.req.json<{ axis?: string; tier?: string }>().catch(() => ({}) as never);
  const axis = body.axis as PolicyAxis | undefined;
  if (!axis || !AXIS_TIERS[axis] || !body.tier || !AXIS_TIERS[axis].includes(body.tier)) {
    return c.json({ error: 'INVALID_POLICY' }, 400);
  }

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  if (world.tickRunning) return c.json({ error: 'TICK_IN_PROGRESS' }, 503);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const lastChanged = nation.policyChangedAt[axis];
  if (lastChanged !== undefined && state.tick - lastChanged < POLICY_CHANGE_COOLDOWN) {
    return c.json({ error: 'POLICY_COOLDOWN' }, 400);
  }

  for (const [k, v] of Object.entries(POLICY_CHANGE_COST)) {
    if (nation.resources[k as keyof typeof nation.resources] < (v as number)) {
      return c.json({ error: 'INSUFFICIENT_RESOURCES' }, 400);
    }
  }

  const resources = { ...nation.resources };
  for (const [k, v] of Object.entries(POLICY_CHANGE_COST)) {
    resources[k as keyof typeof resources] -= v as number;
  }

  const policies: Policies = { ...nation.policies, [axis]: body.tier } as Policies;
  const updatedNation = {
    ...nation,
    resources,
    policies,
    policyChangedAt: { ...nation.policyChangedAt, [axis]: state.tick },
  };
  const next = { ...state, nations: state.nations.map((n) => (n.id === nation.id ? updatedNation : n)) };

  const now = Date.now();
  await persistWorld(c.env.DB, state, next, [], now);
  await completeTask(c.env.DB, user.id, 'set_policy', now);

  return c.json({ nation: updatedNation });
});

export default policyRoutes;
