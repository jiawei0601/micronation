import type { Treaty, TreatyKind, TreatyTerms, Id, Tick, GameEvent } from '@micronation/shared';
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

function mkEvent(type: string, tick: Tick, nationIds: Id[], payload: unknown): GameEvent {
  return { tick, type, nationIds, payload };
}

function involvesPair(t: Treaty, x: Id, y: Id): boolean {
  return (t.aId === x && t.bId === y) || (t.aId === y && t.bId === x);
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

  const duplicate = treaties.some(
    (t) =>
      t.kind === kind &&
      involvesPair(t, aId, bId) &&
      (t.status === 'active' || t.status === 'proposed')
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
  const idx = treaties.findIndex((t) => t.id === treatyId);
  if (idx === -1) return err('NOT_FOUND');
  const treaty = treaties[idx];

  if (treaty.status !== 'proposed' && treaty.status !== 'countered') return err('INVALID_STATUS');
  if (responderId !== treaty.aId && responderId !== treaty.bId) return err('NOT_PARTY');

  const terms = getTerms(treaty);
  const pending = terms.pendingResponderId ?? treaty.bId;
  if (responderId !== pending) return err('NOT_PENDING_PARTY');

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
  const events: GameEvent[] = [];
  const next = treaties.map((t) => {
    if (t.status !== 'active') return t;
    const terms = getTerms(t);
    const activatedAt = terms.activatedAt ?? t.createdAt;
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
