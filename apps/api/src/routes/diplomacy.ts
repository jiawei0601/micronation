// /api/diplomacy — GET 條約(自己涉入的)、POST propose/respond/breach。

import { Hono } from 'hono';
import type { TreatyKind, TreatyTerms } from '@micronation/shared';
import { makeId } from '@micronation/shared';
import { propose, respond, breach, breachPenalty, type RespondAction } from '@micronation/diplomacy';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { loadActiveWorld, findOwnNation, findNationById, persistWorld } from '../game/state';
import { safeCompleteTask } from '../db/repository';
import { parseJsonBody } from '../lib/parseBody';

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
  const body = await parseJsonBody<{ kind?: TreatyKind; counterpartyId?: string; terms?: TreatyTerms }>(c.req);
  if (!body || !body.kind || !TREATY_KINDS.includes(body.kind) || !body.counterpartyId || !body.terms) {
    return c.json({ error: 'INVALID_BODY' }, 400);
  }

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  if (world.tickRunning) return c.json({ error: 'TICK_IN_PROGRESS' }, 503);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  // finding #12:counterpartyId 須是本賽季確實存在的國家,否則會提出一份永遠沒有對象能回應的
  // 條約(佔用 propose 的「同 kind+同 pair」重複檢查名額,且前端會顯示一筆指向不存在國家的紀錄)。
  if (!findNationById(state, body.counterpartyId)) return c.json({ error: 'COUNTERPARTY_NOT_FOUND' }, 404);

  const id = makeId('treaty', nation.id, body.counterpartyId, Date.now());
  const result = propose(state.treaties, id, body.kind, nation.id, body.counterpartyId, body.terms, state.tick);
  if (!result.ok) return c.json({ error: result.error }, 400);

  const next = { ...state, treaties: result.value.treaties };
  const now = Date.now();
  await persistWorld(c.env.DB, state, next, result.value.events, now);
  await safeCompleteTask(c.env.DB, user.id, 'propose_treaty', now);

  return c.json({ treaties: result.value.treaties }, 201);
});

diplomacyRoutes.post('/respond', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await parseJsonBody<{ treatyId?: string; action?: RespondAction; counterTerms?: Partial<TreatyTerms> }>(
    c.req
  );
  if (!body || !body.treatyId || !body.action || !RESPOND_ACTIONS.includes(body.action)) {
    return c.json({ error: 'INVALID_BODY' }, 400);
  }

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  if (world.tickRunning) return c.json({ error: 'TICK_IN_PROGRESS' }, 503);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const result = respond(state.treaties, body.treatyId, nation.id, body.action, state.tick, body.counterTerms);
  if (!result.ok) return c.json({ error: result.error }, 400);

  const next = { ...state, treaties: result.value.treaties };
  const now = Date.now();
  await persistWorld(c.env.DB, state, next, result.value.events, now);
  if (body.action === 'accept') await safeCompleteTask(c.env.DB, user.id, 'accept_treaty', now);

  return c.json({ treaties: result.value.treaties });
});

diplomacyRoutes.post('/breach', requireSession, async (c) => {
  const { user } = c.get('session');
  const body = await parseJsonBody<{ treatyId?: string }>(c.req);
  if (!body || !body.treatyId) return c.json({ error: 'INVALID_BODY' }, 400);

  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  if (world.tickRunning) return c.json({ error: 'TICK_IN_PROGRESS' }, 503);
  const { state } = world;
  const nation = findOwnNation(state, user.id);
  if (!nation) return c.json({ error: 'NO_NATION' }, 404);

  const treatyBefore = state.treaties.find((t) => t.id === body.treatyId);
  const result = breach(state.treaties, body.treatyId, nation.id, state.tick);
  if (!result.ok) return c.json({ error: result.error }, 400);

  // finding #13:breach() 本身只把 Treaty.status 標成 'breached' 並丟出事件,不碰任何
  // Nation 欄位(同 market 的「純模塊不碰 resources」原則)。這裡依 breachPenalty() 算出的
  // 賠償金額,實際從毀約方轉給對方,並把毀約方 reputation.breaches +1(公開信譽標記,
  // 呼應 CONTRACT §外交「毀約=賠償+全服背信標記」)。
  const otherPartyId = treatyBefore!.aId === nation.id ? treatyBefore!.bId : treatyBefore!.aId;
  const penalty = breachPenalty(treatyBefore!);
  const nations = state.nations.map((n) => {
    if (n.id === nation.id) {
      return {
        ...n,
        resources: { ...n.resources, money: Math.max(0, n.resources.money - penalty.compensation) },
        reputation: { ...n.reputation, breaches: n.reputation.breaches + 1 },
      };
    }
    if (n.id === otherPartyId) {
      return { ...n, resources: { ...n.resources, money: n.resources.money + penalty.compensation } };
    }
    return n;
  });

  const next = { ...state, treaties: result.value.treaties, nations };
  await persistWorld(c.env.DB, state, next, result.value.events, Date.now());

  return c.json({ treaties: result.value.treaties });
});

export default diplomacyRoutes;
