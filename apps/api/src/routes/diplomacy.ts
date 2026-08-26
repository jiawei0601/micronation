// /api/diplomacy — GET 條約(自己涉入的)、POST propose/respond/breach。

import { Hono } from 'hono';
import type { TreatyKind, TreatyTerms } from '@micronation/shared';
import { makeId } from '@micronation/shared';
import { propose, respond, breach, type RespondAction } from '@micronation/diplomacy';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, persistWorld } from '../game/state';
import { completeTask } from '../db/repository';

const TREATY_KINDS: TreatyKind[] = ['nap', 'alliance', 'trade'];
const RESPOND_ACTIONS: RespondAction[] = ['accept', 'reject', 'counter'];

const diplomacyRoutes = new Hono<{ Bindings: Env }>();

diplomacyRoutes.get('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const nation = findOwnNation(world.state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);
  const treaties = world.state.treaties.filter((t) => t.aId === nation.id || t.bId === nation.id);
  return c.json({ treaties });
});

diplomacyRoutes.post('/propose', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await c.req.json<{ kind?: TreatyKind; counterpartyId?: string; terms?: TreatyTerms }>().catch(
    () => ({}) as never
  );
  if (!body.kind || !TREATY_KINDS.includes(body.kind) || !body.counterpartyId || !body.terms) {
    return c.json({ error: 'INVALID_BODY' }, 400);
  }

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const id = makeId('treaty', nation.id, body.counterpartyId, Date.now());
  const result = propose(state.treaties, id, body.kind, nation.id, body.counterpartyId, body.terms, state.tick);
  if (!result.ok) return c.json({ error: result.error }, 400);

  const next = { ...state, treaties: result.value.treaties };
  const now = Date.now();
  await persistWorld(c.env.DB, state, next, result.value.events, now);
  await completeTask(c.env.DB, user.id, 'propose_treaty', now);

  return c.json({ treaties: result.value.treaties }, 201);
});

diplomacyRoutes.post('/respond', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await c
    .req.json<{ treatyId?: string; action?: RespondAction; counterTerms?: Partial<TreatyTerms> }>()
    .catch(() => ({}) as never);
  if (!body.treatyId || !body.action || !RESPOND_ACTIONS.includes(body.action)) {
    return c.json({ error: 'INVALID_BODY' }, 400);
  }

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const result = respond(state.treaties, body.treatyId, nation.id, body.action, state.tick, body.counterTerms);
  if (!result.ok) return c.json({ error: result.error }, 400);

  const next = { ...state, treaties: result.value.treaties };
  const now = Date.now();
  await persistWorld(c.env.DB, state, next, result.value.events, now);
  if (body.action === 'accept') await completeTask(c.env.DB, user.id, 'accept_treaty', now);

  return c.json({ treaties: result.value.treaties });
});

diplomacyRoutes.post('/breach', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await c.req.json<{ treatyId?: string }>().catch(() => ({}) as never);
  if (!body.treatyId) return c.json({ error: 'INVALID_BODY' }, 400);

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const result = breach(state.treaties, body.treatyId, nation.id, state.tick);
  if (!result.ok) return c.json({ error: result.error }, 400);

  const next = { ...state, treaties: result.value.treaties };
  await persistWorld(c.env.DB, state, next, result.value.events, Date.now());

  return c.json({ treaties: result.value.treaties });
});

export default diplomacyRoutes;
