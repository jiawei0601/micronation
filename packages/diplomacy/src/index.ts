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

function isValidTick(tick: unknown): tick is Tick {
  return typeof tick === 'number' && Number.isSafeInteger(tick) && tick >= 0;
}

/**
 * 驗證 terms(finding #2/#15):
 * - duration:requireDuration 為 true,或 terms.duration 有提供時,必為正安全整數(NaN/Infinity/0/負/小數/缺值皆非法)。
 * - compensation(若提供):須為有限數且 >=0。
 * - allianceDefense(若提供):kind 必為 'alliance' 且型別為 boolean,否則視為不相容欄位。
 * - tariffDiscount(若提供):kind 必為 'trade' 且為有限數、落在 [0,1],否則視為不相容欄位。
 */
function validateTerms(kind: TreatyKind, terms: Partial<TreatyTerms>, requireDuration: boolean): boolean {
  if (requireDuration || terms.duration !== undefined) {
    if (!Number.isSafeInteger(terms.duration) || (terms.duration as number) <= 0) return true;
  }
  if (terms.compensation !== undefined) {
    if (!Number.isFinite(terms.compensation) || terms.compensation < 0) return true;
  }
  if (terms.allianceDefense !== undefined) {
    if (kind !== 'alliance' || typeof terms.allianceDefense !== 'boolean') return true;
  }
  if (terms.tariffDiscount !== undefined) {
    if (
      kind !== 'trade' ||
      !Number.isFinite(terms.tariffDiscount) ||
      terms.tariffDiscount < 0 ||
      terms.tariffDiscount > 1
    ) {
      return true;
    }
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
  if (!isValidTick(tick)) return err('INVALID_TICK');
  if (aId === bId) return err('SELF_TREATY');
  if (validateTerms(kind, terms, true)) return err('INVALID_TERMS');
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
  if (!isValidTick(tick)) return err('INVALID_TICK');
  if (action !== 'accept' && action !== 'reject' && action !== 'counter') return err('INVALID_ACTION');

  const idx = treaties.findIndex((t) => t.id === treatyId);
  if (idx === -1) return err('NOT_FOUND');
  const treaty = treaties[idx];

  if (treaty.status !== 'proposed' && treaty.status !== 'countered') return err('INVALID_STATUS');
  if (responderId !== treaty.aId && responderId !== treaty.bId) return err('NOT_PARTY');

  const terms = getTerms(treaty);
  const pending = terms.pendingResponderId ?? treaty.bId;
  if (responderId !== pending) return err('NOT_PENDING_PARTY');

  // counter 的合法性須以「既有 terms 與 counterTerms 合併後」的結果驗證(finding #2/#5)——
  // 只驗 counterTerms 本身會漏掉「counter 把 duration 蓋成 undefined」這種案例(spread 後
  // merged.duration 變 undefined,但 counterTerms 單獨看可能沒有 duration 欄位、不會被擋下)。
  if (action === 'counter') {
    const merged = { ...terms, ...counterTerms };
    if (validateTerms(treaty.kind, merged, true)) return err('INVALID_TERMS');
  }

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
  if (!isValidTick(tick)) return err('INVALID_TICK');

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
  if (!isValidTick(tick)) return err('INVALID_TICK');

  // 不變量:status === 'active' 的條約必有 terms.activatedAt(respond(accept) 必寫入),
  // 且 activatedAt/duration 皆須是非負安全整數、兩者相加不可溢位安全整數範圍——否則到期時間
  // 算出來會是垃圾值(finding #3)。任一被破壞,expire 整批回 Err,而非用 createdAt 猜測。
  for (const t of treaties) {
    if (t.status !== 'active') continue;
    const { activatedAt, duration } = t.terms;
    if (
      !Number.isSafeInteger(activatedAt) ||
      (activatedAt as number) < 0 ||
      !Number.isSafeInteger(duration) ||
      duration < 0 ||
      !Number.isSafeInteger((activatedAt as number) + duration)
    ) {
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
