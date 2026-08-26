import type { Treaty, TreatyKind, TreatyTerms, Id, Tick, GameEvent, EventType } from '@micronation/shared';
import { ok, err, EVENT } from '@micronation/shared';
import type { Result } from '@micronation/shared';

export type { TreatyTerms } from '@micronation/shared';

function getTerms(t: Treaty): TreatyTerms {
  return t.terms;
}

function withTerms(t: Treaty, terms: TreatyTerms): Treaty {
  return { ...t, terms };
}

function replaceAt(treaties: Treaty[], idx: number, updated: Treaty): Treaty[] {
  const next = treaties.slice();
  next[idx] = updated;
  return next;
}

function mkEvent(type: EventType, tick: Tick, nationIds: Id[], payload: unknown): GameEvent {
  return { tick, type, nationIds, payload };
}

function involvesPair(t: Treaty, x: Id, y: Id): boolean {
  return (t.aId === x && t.bId === y) || (t.aId === y && t.bId === x);
}

/** duration 必為正整數;compensation 若提供須 >=0;tariffDiscount 若提供須落在 0~1。 */
function invalidTerms(terms: Partial<TreatyTerms>): boolean {
  if (terms.duration !== undefined && (!Number.isSafeInteger(terms.duration) || terms.duration <= 0)) return true;
  if (terms.compensation !== undefined && (!Number.isFinite(terms.compensation) || terms.compensation < 0)) return true;
  if (
    terms.tariffDiscount !== undefined &&
    (!Number.isFinite(terms.tariffDiscount) || terms.tariffDiscount < 0 || terms.tariffDiscount > 1)
  ) {
    return true;
  }
  return false;
}

// ---- propose ----

export function propose(
  treaties: Treaty[],
  id: Id,
  kind: TreatyKind,
  aId: Id,
  bId: Id,
  terms: TreatyTerms,
  tick: Tick
): Result<{ treaties: Treaty[]; events: GameEvent[] }> {
  if (aId === bId) return err('SELF_TREATY');
  if (invalidTerms(terms)) return err('INVALID_TERMS');
  if (treaties.some((t) => t.id === id)) return err('DUPLICATE_ID');

  const duplicate = treaties.some(
    (t) =>
      t.kind === kind &&
      involvesPair(t, aId, bId) &&
      (t.status === 'active' || t.status === 'proposed' || t.status === 'countered')
  );
  if (duplicate) return err('DUPLICATE_TREATY');

  const treaty = withTerms(
    {
      id,
      kind,
      aId,
      bId,
      status: 'proposed',
      terms,
      createdAt: tick,
    },
    { ...terms, pendingResponderId: bId }
  );

  return ok({
    treaties: [...treaties, treaty],
    events: [mkEvent(EVENT.TREATY_PROPOSED, tick, [aId, bId], { treatyId: id })],
  });
}

// ---- respond ----

export type RespondAction = 'accept' | 'reject' | 'counter';

export function respond(
  treaties: Treaty[],
  treatyId: Id,
  responderId: Id,
  action: RespondAction,
  tick: Tick,
  counterTerms?: Partial<TreatyTerms>
): Result<{ treaties: Treaty[]; events: GameEvent[] }> {
  if (action !== 'accept' && action !== 'reject' && action !== 'counter') return err('INVALID_ACTION');

  const idx = treaties.findIndex((t) => t.id === treatyId);
  if (idx === -1) return err('NOT_FOUND');
  const treaty = treaties[idx];

  if (treaty.status !== 'proposed' && treaty.status !== 'countered') return err('INVALID_STATUS');
  if (responderId !== treaty.aId && responderId !== treaty.bId) return err('NOT_PARTY');

  const terms = getTerms(treaty);
  const pending = terms.pendingResponderId ?? treaty.bId;
  if (responderId !== pending) return err('NOT_PENDING_PARTY');

  if (action === 'counter' && counterTerms && invalidTerms(counterTerms)) return err('INVALID_TERMS');

  if (action === 'accept') {
    const updated = withTerms(
      { ...treaty, status: 'active' },
      { ...terms, pendingResponderId: undefined, activatedAt: tick }
    );
    return ok({
      treaties: replaceAt(treaties, idx, updated),
      events: [mkEvent(EVENT.TREATY_ACTIVATED, tick, [treaty.aId, treaty.bId], { treatyId })],
    });
  }

  if (action === 'reject') {
    const updated = { ...treaty, status: 'rejected' as const };
    return ok({
      treaties: replaceAt(treaties, idx, updated),
      events: [mkEvent(EVENT.TREATY_REJECTED, tick, [treaty.aId, treaty.bId], { treatyId })],
    });
  }

  // counter — 換由對方回應
  const otherParty = responderId === treaty.aId ? treaty.bId : treaty.aId;
  const updated = withTerms(
    { ...treaty, status: 'countered' },
    { ...terms, ...counterTerms, pendingResponderId: otherParty }
  );
  return ok({
    treaties: replaceAt(treaties, idx, updated),
    events: [mkEvent(EVENT.TREATY_COUNTERED, tick, [treaty.aId, treaty.bId], { treatyId })],
  });
}

// ---- breach ----

export function breach(
  treaties: Treaty[],
  treatyId: Id,
  breachingId: Id,
  tick: Tick
): Result<{ treaties: Treaty[]; events: GameEvent[] }> {
  const idx = treaties.findIndex((t) => t.id === treatyId);
  if (idx === -1) return err('NOT_FOUND');
  const treaty = treaties[idx];

  if (treaty.status !== 'active') return err('INVALID_STATUS');
  if (breachingId !== treaty.aId && breachingId !== treaty.bId) return err('NOT_PARTY');

  const penalty = breachPenalty(treaty);
  const updated = { ...treaty, status: 'breached' as const };

  return ok({
    treaties: replaceAt(treaties, idx, updated),
    events: [
      mkEvent(EVENT.TREATY_BREACHED, tick, [treaty.aId, treaty.bId], {
        treatyId,
        breachingId,
        ...penalty,
      }),
    ],
  });
}

// ---- expire ----

export function expire(treaties: Treaty[], tick: Tick): Result<{ treaties: Treaty[]; events: GameEvent[] }> {
  // 不變量:status === 'active' 的條約必有 terms.activatedAt(respond(accept) 必寫入)。
  // 若缺失代表資料損壞,expire 整批回 Err,而非用 createdAt 猜測(那會讓條約提早/延遲到期)。
  for (const t of treaties) {
    if (t.status === 'active' && t.terms.activatedAt === undefined) {
      return err('CORRUPTED_TREATY');
    }
  }

  const events: GameEvent[] = [];
  const next = treaties.map((t) => {
    if (t.status !== 'active') return t;
    const terms = getTerms(t);
    const activatedAt = terms.activatedAt as Tick;
    if (activatedAt + terms.duration > tick) return t;
    events.push(mkEvent(EVENT.TREATY_EXPIRED, tick, [t.aId, t.bId], { treatyId: t.id }));
    return { ...t, status: 'expired' as const };
  });
  return ok({ treaties: next, events });
}

// ---- queries ----

export function canAttack(
  treaties: Treaty[],
  attackerId: Id,
  defenderId: Id
): { allowed: boolean; reason?: 'NAP' | 'ALLIANCE' } {
  const blocking = treaties.find(
    (t) =>
      t.status === 'active' &&
      (t.kind === 'nap' || t.kind === 'alliance') &&
      involvesPair(t, attackerId, defenderId)
  );
  if (!blocking) return { allowed: true };
  return { allowed: false, reason: blocking.kind === 'nap' ? 'NAP' : 'ALLIANCE' };
}

export function tradeDiscount(treaties: Treaty[], aId: Id, bId: Id): number {
  const treaty = treaties.find(
    (t) => t.status === 'active' && t.kind === 'trade' && involvesPair(t, aId, bId)
  );
  if (!treaty) return 0;
  return getTerms(treaty).tariffDiscount ?? 0;
}

export function breachPenalty(treaty: Treaty): { compensation: number; reputationDelta: number } {
  const terms = getTerms(treaty);
  const compensation = terms.compensation ?? 50;
  return { compensation, reputationDelta: -10 };
}
