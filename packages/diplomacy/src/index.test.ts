import { describe, it, expect } from 'vitest';
import type { Treaty } from '@micronation/shared';
import {
  propose,
  respond,
  breach,
  expire,
  canAttack,
  tradeDiscount,
  breachPenalty,
  type TreatyTerms,
} from './index';

const A = 'nation-a';
const B = 'nation-b';
const C = 'nation-c';

function terms(t: Partial<TreatyTerms> = {}): TreatyTerms {
  return { duration: 10, ...t };
}

describe('propose', () => {
  it('creates a proposed treaty', () => {
    const res = propose([], 't1', 'nap', A, B, terms(), 0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.treaties).toHaveLength(1);
    expect(res.value.treaties[0].status).toBe('proposed');
    expect(res.value.events[0].type).toBe('treaty_proposed');
  });

  it('rejects self-treaty', () => {
    const res = propose([], 't1', 'nap', A, A, terms(), 0);
    expect(res.ok).toBe(false);
  });

  it('rejects duplicate active treaty of same kind between same pair', () => {
    const first = propose([], 't1', 'nap', A, B, terms(), 0);
    if (!first.ok) throw new Error('setup failed');
    const accepted = respond(first.value.treaties, 't1', B, 'accept', 1);
    if (!accepted.ok) throw new Error('setup failed');
    const res = propose(accepted.value.treaties, 't2', 'nap', A, B, terms(), 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('DUPLICATE_TREATY');
  });

  it('rejects duplicate proposed treaty of same kind between same pair (direction-agnostic)', () => {
    const first = propose([], 't1', 'nap', A, B, terms(), 0);
    if (!first.ok) throw new Error('setup failed');
    const res = propose(first.value.treaties, 't2', 'nap', B, A, terms(), 1);
    expect(res.ok).toBe(false);
  });

  it('allows different kind between the same pair', () => {
    const first = propose([], 't1', 'nap', A, B, terms(), 0);
    if (!first.ok) throw new Error('setup failed');
    const res = propose(first.value.treaties, 't2', 'trade', A, B, terms({ tariffDiscount: 0.2 }), 0);
    expect(res.ok).toBe(true);
  });
});

describe('respond', () => {
  function proposed(): Treaty[] {
    const res = propose([], 't1', 'nap', A, B, terms(), 0);
    if (!res.ok) throw new Error('setup failed');
    return res.value.treaties;
  }

  it('accept activates the treaty', () => {
    const res = respond(proposed(), 't1', B, 'accept', 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.treaties[0].status).toBe('active');
    expect(res.value.events[0].type).toBe('treaty_activated');
  });

  it('reject sets status rejected', () => {
    const res = respond(proposed(), 't1', B, 'reject', 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.treaties[0].status).toBe('rejected');
  });

  it('counter sets status countered and flips pending responder to original proposer', () => {
    const res = respond(proposed(), 't1', B, 'counter', 1, { duration: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.treaties[0].status).toBe('countered');
    expect(res.value.events[0].type).toBe('treaty_countered');

    // now only A (original proposer) may respond
    const byB = respond(res.value.treaties, 't1', B, 'accept', 2);
    expect(byB.ok).toBe(false);

    const byA = respond(res.value.treaties, 't1', A, 'accept', 2);
    expect(byA.ok).toBe(true);
    if (byA.ok) expect(byA.value.treaties[0].status).toBe('active');
  });

  it('supports a multi-round counter chain', () => {
    const r1 = respond(proposed(), 't1', B, 'counter', 1, { duration: 20 });
    if (!r1.ok) throw new Error('setup failed');
    const r2 = respond(r1.value.treaties, 't1', A, 'counter', 2, { duration: 15 });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.treaties[0].status).toBe('countered');
    // turn is back on B
    const rejectByA = respond(r2.value.treaties, 't1', A, 'accept', 3);
    expect(rejectByA.ok).toBe(false);
    const acceptByB = respond(r2.value.treaties, 't1', B, 'accept', 3);
    expect(acceptByB.ok).toBe(true);
  });

  it('rejects respond from a non-party nation', () => {
    const res = respond(proposed(), 't1', C, 'accept', 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('NOT_PARTY');
  });

  it('rejects respond when it is not the responder turn', () => {
    // A proposed to B; A itself cannot accept/reject/counter before B responds
    const res = respond(proposed(), 't1', A, 'accept', 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('NOT_PENDING_PARTY');
  });

  it('rejects respond on unknown treaty id', () => {
    const res = respond(proposed(), 'nope', B, 'accept', 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('NOT_FOUND');
  });

  it('rejects responding twice on an already-active treaty', () => {
    const accepted = respond(proposed(), 't1', B, 'accept', 1);
    if (!accepted.ok) throw new Error('setup failed');
    const res = respond(accepted.value.treaties, 't1', A, 'accept', 2);
    expect(res.ok).toBe(false);
  });
});

describe('breach', () => {
  function active(): Treaty[] {
    const p = propose([], 't1', 'alliance', A, B, terms({ allianceDefense: true }), 0);
    if (!p.ok) throw new Error('setup failed');
    const a = respond(p.value.treaties, 't1', B, 'accept', 1);
    if (!a.ok) throw new Error('setup failed');
    return a.value.treaties;
  }

  it('a party can breach an active treaty and it computes penalty', () => {
    const res = breach(active(), 't1', A, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.treaties[0].status).toBe('breached');
    const payload = res.value.events[0].payload as { compensation: number; reputationDelta: number };
    expect(payload.compensation).toBeGreaterThan(0);
    expect(payload.reputationDelta).toBeLessThan(0);
    expect(res.value.events[0].type).toBe('treaty_breached');
  });

  it('a non-party cannot breach', () => {
    const res = breach(active(), 't1', C, 5);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('NOT_PARTY');
  });

  it('cannot breach a non-active treaty', () => {
    const p = propose([], 't1', 'nap', A, B, terms(), 0);
    if (!p.ok) throw new Error('setup failed');
    const res = breach(p.value.treaties, 't1', A, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('INVALID_STATUS');
  });

  it('breachPenalty uses terms.compensation when provided', () => {
    const treaty: Treaty = {
      id: 't2',
      kind: 'nap',
      aId: A,
      bId: B,
      status: 'active',
      terms: { duration: 10, compensation: 200 },
      createdAt: 0,
    };
    expect(breachPenalty(treaty)).toEqual({ compensation: 200, reputationDelta: -10 });
  });
});

describe('expire', () => {
  it('expires an active treaty once activatedAt + duration <= tick', () => {
    const p = propose([], 't1', 'nap', A, B, terms({ duration: 5 }), 0);
    if (!p.ok) throw new Error('setup failed');
    const a = respond(p.value.treaties, 't1', B, 'accept', 2);
    if (!a.ok) throw new Error('setup failed');

    const notYet = expire(a.value.treaties, 6);
    expect(notYet.ok).toBe(true);
    if (notYet.ok) expect(notYet.value.treaties[0].status).toBe('active');

    const now = expire(a.value.treaties, 7);
    expect(now.ok).toBe(true);
    if (!now.ok) return;
    expect(now.value.treaties[0].status).toBe('expired');
    expect(now.value.events[0].type).toBe('treaty_expired');
  });

  it('leaves non-active treaties untouched', () => {
    const p = propose([], 't1', 'nap', A, B, terms({ duration: 5 }), 0);
    if (!p.ok) throw new Error('setup failed');
    const res = expire(p.value.treaties, 999);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.treaties[0].status).toBe('proposed');
    expect(res.value.events).toHaveLength(0);
  });
});

describe('validateTerms — 非法 terms table-driven(regression for Codex finding #5/#2)', () => {
  const cases: { name: string; kind: Parameters<typeof propose>[2]; terms: Record<string, unknown> }[] = [
    { name: 'duration 缺失', kind: 'nap', terms: {} },
    { name: 'duration 為 0', kind: 'nap', terms: { duration: 0 } },
    { name: 'duration 為小數', kind: 'nap', terms: { duration: 1.5 } },
    { name: 'duration 為 NaN', kind: 'nap', terms: { duration: NaN } },
    { name: 'duration 為 Infinity', kind: 'nap', terms: { duration: Infinity } },
    { name: 'duration 非安全整數(超出 MAX_SAFE_INTEGER)', kind: 'nap', terms: { duration: Number.MAX_SAFE_INTEGER + 10 } },
    { name: 'compensation 為負', kind: 'nap', terms: { duration: 10, compensation: -1 } },
    { name: 'compensation 非有限(Infinity)', kind: 'nap', terms: { duration: 10, compensation: Infinity } },
    { name: 'compensation 非有限(NaN)', kind: 'nap', terms: { duration: 10, compensation: NaN } },
    { name: 'tariffDiscount 超出上界', kind: 'trade', terms: { duration: 10, tariffDiscount: 1.1 } },
    { name: 'tariffDiscount 低於下界', kind: 'trade', terms: { duration: 10, tariffDiscount: -0.1 } },
    { name: 'tariffDiscount 用在非 trade(kind 不相容)', kind: 'nap', terms: { duration: 10, tariffDiscount: 0.5 } },
    { name: 'allianceDefense 用在非 alliance(kind 不相容)', kind: 'nap', terms: { duration: 10, allianceDefense: true } },
    { name: 'allianceDefense 非 boolean', kind: 'alliance', terms: { duration: 10, allianceDefense: 'yes' } },
  ];

  for (const c of cases) {
    it(`propose 拒絕:${c.name}`, () => {
      const before: Treaty[] = [];
      const res = propose(before, 't1', c.kind, A, B, c.terms as never, 0);
      expect(res).toEqual({ ok: false, error: 'INVALID_TERMS' });
      // 輸入未被改動
      expect(before).toEqual([]);
    });
  }

  it('respond(counter) 把既有合法 duration 蓋成 undefined → INVALID_TERMS,且原條約不變', () => {
    const p = propose([], 't1', 'nap', A, B, terms({ duration: 10 }), 0);
    if (!p.ok) throw new Error('setup failed');
    const before = p.value.treaties;
    const res = respond(before, 't1', B, 'counter', 1, { duration: undefined as unknown as number });
    expect(res).toEqual({ ok: false, error: 'INVALID_TERMS' });
    expect(before[0].terms.duration).toBe(10);
  });

  it('respond(counter) compensation 為負 → INVALID_TERMS', () => {
    const p = propose([], 't1', 'nap', A, B, terms(), 0);
    if (!p.ok) throw new Error('setup failed');
    const res = respond(p.value.treaties, 't1', B, 'counter', 1, { compensation: -5 });
    expect(res).toEqual({ ok: false, error: 'INVALID_TERMS' });
  });
});

describe('propose/respond/breach/expire — tick 驗證(regression for Codex finding #3)', () => {
  it('propose 拒絕負數/小數/NaN/Infinity 的 tick', () => {
    expect(propose([], 't1', 'nap', A, B, terms(), -1)).toEqual({ ok: false, error: 'INVALID_TICK' });
    expect(propose([], 't1', 'nap', A, B, terms(), 1.5)).toEqual({ ok: false, error: 'INVALID_TICK' });
    expect(propose([], 't1', 'nap', A, B, terms(), NaN)).toEqual({ ok: false, error: 'INVALID_TICK' });
    expect(propose([], 't1', 'nap', A, B, terms(), Infinity)).toEqual({ ok: false, error: 'INVALID_TICK' });
  });

  it('respond 拒絕非法 tick', () => {
    const p = propose([], 't1', 'nap', A, B, terms(), 0);
    if (!p.ok) throw new Error('setup failed');
    expect(respond(p.value.treaties, 't1', B, 'accept', -1)).toEqual({ ok: false, error: 'INVALID_TICK' });
  });

  it('breach 拒絕非法 tick', () => {
    const p = propose([], 't1', 'alliance', A, B, terms({ allianceDefense: true }), 0);
    if (!p.ok) throw new Error('setup failed');
    const a = respond(p.value.treaties, 't1', B, 'accept', 1);
    if (!a.ok) throw new Error('setup failed');
    expect(breach(a.value.treaties, 't1', A, NaN)).toEqual({ ok: false, error: 'INVALID_TICK' });
  });

  it('expire 拒絕非法 tick', () => {
    expect(expire([], -1)).toEqual({ ok: false, error: 'INVALID_TICK' });
    expect(expire([], 1.5)).toEqual({ ok: false, error: 'INVALID_TICK' });
  });

  it('expire 對 activatedAt/duration 相加會溢出安全整數範圍的損壞資料回 CORRUPTED_TREATY', () => {
    const corrupted: Treaty[] = [
      {
        id: 't1',
        kind: 'nap',
        aId: A,
        bId: B,
        status: 'active',
        terms: { duration: Number.MAX_SAFE_INTEGER, activatedAt: Number.MAX_SAFE_INTEGER },
        createdAt: 0,
      },
    ];
    expect(expire(corrupted, 10)).toEqual({ ok: false, error: 'CORRUPTED_TREATY' });
  });

  it('expire 對 activatedAt 為負的損壞資料回 CORRUPTED_TREATY', () => {
    const corrupted: Treaty[] = [
      { id: 't1', kind: 'nap', aId: A, bId: B, status: 'active', terms: { duration: 5, activatedAt: -1 }, createdAt: 0 },
    ];
    expect(expire(corrupted, 10)).toEqual({ ok: false, error: 'CORRUPTED_TREATY' });
  });

  it('expire 對 duration 為 0 的損壞資料回 CORRUPTED_TREATY(regression for Codex 三審 finding #1——0 代表資料損壞而非「立即到期」)', () => {
    const corrupted: Treaty[] = [
      { id: 't1', kind: 'nap', aId: A, bId: B, status: 'active', terms: { duration: 0, activatedAt: 5 }, createdAt: 0 },
    ];
    expect(expire(corrupted, 10)).toEqual({ ok: false, error: 'CORRUPTED_TREATY' });
  });
});

describe('canAttack', () => {
  it('allows attack when no treaty exists', () => {
    expect(canAttack([], A, B)).toEqual({ allowed: true });
  });

  it('blocks attack under an active NAP with reason NAP', () => {
    const p = propose([], 't1', 'nap', A, B, terms(), 0);
    if (!p.ok) throw new Error('setup failed');
    const a = respond(p.value.treaties, 't1', B, 'accept', 1);
    if (!a.ok) throw new Error('setup failed');
    expect(canAttack(a.value.treaties, A, B)).toEqual({ allowed: false, reason: 'NAP' });
    // symmetric direction
    expect(canAttack(a.value.treaties, B, A)).toEqual({ allowed: false, reason: 'NAP' });
  });

  it('blocks attack under an active alliance with reason ALLIANCE', () => {
    const p = propose([], 't1', 'alliance', A, B, terms({ allianceDefense: true }), 0);
    if (!p.ok) throw new Error('setup failed');
    const a = respond(p.value.treaties, 't1', B, 'accept', 1);
    if (!a.ok) throw new Error('setup failed');
    expect(canAttack(a.value.treaties, A, B)).toEqual({ allowed: false, reason: 'ALLIANCE' });
  });

  it('does not block when the treaty is only proposed, not active', () => {
    const p = propose([], 't1', 'nap', A, B, terms(), 0);
    if (!p.ok) throw new Error('setup failed');
    expect(canAttack(p.value.treaties, A, B)).toEqual({ allowed: true });
  });

  it('does not block unrelated nations', () => {
    const p = propose([], 't1', 'nap', A, B, terms(), 0);
    if (!p.ok) throw new Error('setup failed');
    const a = respond(p.value.treaties, 't1', B, 'accept', 1);
    if (!a.ok) throw new Error('setup failed');
    expect(canAttack(a.value.treaties, A, C)).toEqual({ allowed: true });
  });
});

describe('tradeDiscount', () => {
  it('returns 0 when no active trade treaty', () => {
    expect(tradeDiscount([], A, B)).toBe(0);
  });

  it('returns tariffDiscount from active trade treaty', () => {
    const p = propose([], 't1', 'trade', A, B, terms({ tariffDiscount: 0.3 }), 0);
    if (!p.ok) throw new Error('setup failed');
    const a = respond(p.value.treaties, 't1', B, 'accept', 1);
    if (!a.ok) throw new Error('setup failed');
    expect(tradeDiscount(a.value.treaties, A, B)).toBe(0.3);
    expect(tradeDiscount(a.value.treaties, B, A)).toBe(0.3);
  });

  it('ignores a proposed (not yet active) trade treaty', () => {
    const p = propose([], 't1', 'trade', A, B, terms({ tariffDiscount: 0.3 }), 0);
    if (!p.ok) throw new Error('setup failed');
    expect(tradeDiscount(p.value.treaties, A, B)).toBe(0);
  });
});
