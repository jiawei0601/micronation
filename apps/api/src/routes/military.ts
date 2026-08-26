// /api/military/attack|recall — 接 military.declareAttack/recallMarch,持久化回傳的
// nextMarchSeq(CONTRACT 強調:呼叫端須把 nextMarchSeq 存回 WorldState.nextMarchSeq)。
// 行動點扣除在 api 層(declareAttack 只檢查不扣除)。

import { Hono } from 'hono';
import { ATTACK_ACTION_POINT_COST } from '@micronation/shared';
import { declareAttack, recallMarch } from '@micronation/military';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, persistWorld } from '../game/state';
import { completeTask } from '../db/repository';

const militaryRoutes = new Hono<{ Bindings: Env }>();

militaryRoutes.post('/attack', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await c.req.json<{ defenderId?: string; army?: number }>().catch(() => ({}) as never);
  if (!body.defenderId || typeof body.army !== 'number') return c.json({ error: 'INVALID_BODY' }, 400);

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const { state } = world;
  const attacker = findOwnNation(state, user.id);
  if (!attacker) return c.json({ error: 'NO_NATION' }, 404);

  const result = declareAttack(state, attacker.id, body.defenderId, body.army, state.tick);
  if (!result.ok) return c.json({ error: result.error }, 400);

  // military.declareAttack 只檢查行動點是否足夠,扣除由呼叫端(此處)進行。
  const updatedAttacker = { ...attacker, actionPoints: attacker.actionPoints - ATTACK_ACTION_POINT_COST };
  const next = {
    ...state,
    nations: state.nations.map((n) => (n.id === attacker.id ? updatedAttacker : n)),
    marches: [...state.marches, result.value.march],
    nextMarchSeq: result.value.nextMarchSeq,
  };

  const now = Date.now();
  await persistWorld(c.env.DB, state, next, [], now);
  await completeTask(c.env.DB, user.id, 'declare_attack', now);

  return c.json({ march: result.value.march }, 201);
});

militaryRoutes.post('/recall', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await c.req.json<{ marchId?: string }>().catch(() => ({}) as never);
  if (!body.marchId) return c.json({ error: 'INVALID_BODY' }, 400);

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const result = recallMarch(state.marches, body.marchId, nation.id, state.tick);
  if (!result.ok) return c.json({ error: result.error }, 400);

  const next = { ...state, marches: result.value.marches };
  await persistWorld(c.env.DB, state, next, [], Date.now());

  return c.json({ marches: result.value.marches });
});

export default militaryRoutes;
