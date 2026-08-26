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
  await persistWorld(c.env.DB, state, next, result.value.events, now, [], world.version);
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
  await persistWorld(c.env.DB, state, next, result.value.events, now, [], world.version);
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
  // ②-7:原本毀約方付款端用 Math.max(0, ...) 讓自己不倒扣為負,但對方收款端仍固定收
  // 「合約載明的 compensation」全額——毀約方餘額不夠付全額時(例如只剩 10 但 compensation 是
  // 40),付款方只扣了 10,收款方卻憑空多了 40,等於系統無中生有印出 30 塊錢。改成先算出
  // 「毀約方實際付得起的金額」(min(現有餘額, compensation)),付款方與收款方用同一個數字,
  // 一分不多也不少。
  const otherPartyId = treatyBefore!.aId === nation.id ? treatyBefore!.bId : treatyBefore!.aId;
  const penalty = breachPenalty(treatyBefore!);
  const actualCompensation = Math.max(0, Math.min(nation.resources.money, penalty.compensation));
  const otherParty = state.nations.find((n) => n.id === otherPartyId);
  // ③-5:收款方溢位檢查——otherParty.resources.money + actualCompensation 理論上可能超出
  // Number.MAX_SAFE_INTEGER(極端情境,例如長期累積毀約賠償的巨額帳戶),超出後浮點數不再精確,
  // 後續任何餘額比較/扣款都可能算錯,和 market.ts applyPlaceOrder 的 ②-2 同一原則。收款方若已
  // 逼近安全整數上限,把這次賠償金額 clamp 到「不會讓收款方溢位」的最大可能值,不整筆拒絕
  // (毀約本身合法,不該因為對方帳戶巨大就讓毀約失敗),但也不允許算出不精確的餘額。
  const receiverRoom =
    otherParty !== undefined ? Math.max(0, Number.MAX_SAFE_INTEGER - otherParty.resources.money) : actualCompensation;
  const safeCompensation = Math.min(actualCompensation, receiverRoom);
  // ③-5:reputationDelta 由 shared breachPenalty() 實際算出並套用,不再是路由自己硬寫死的字面
  // 常數——原本 `+ 1` 完全忽略 breachPenalty 回傳的 reputationDelta(只用了 compensation 那一半
  // 的回傳值),等於這個欄位算了但沒人用。改成 `breaches += Math.abs(penalty.reputationDelta)`
  // (breachPenalty 目前回傳固定 -10,語意是「這次毀約的信譽扣分幅度」,取絕對值疊加到只增不減
  // 的 breaches 計數器上),且同樣 clamp 在安全整數範圍內。
  const reputationIncrement = Math.abs(penalty.reputationDelta);
  const nations = state.nations.map((n) => {
    if (n.id === nation.id) {
      return {
        ...n,
        resources: { ...n.resources, money: n.resources.money - safeCompensation },
        reputation: {
          ...n.reputation,
          breaches: Math.min(Number.MAX_SAFE_INTEGER, n.reputation.breaches + reputationIncrement),
        },
      };
    }
    if (n.id === otherPartyId) {
      return { ...n, resources: { ...n.resources, money: n.resources.money + safeCompensation } };
    }
    return n;
  });

  const next = { ...state, treaties: result.value.treaties, nations };
  await persistWorld(c.env.DB, state, next, result.value.events, Date.now(), [], world.version);

  return c.json({ treaties: result.value.treaties });
});

export default diplomacyRoutes;
