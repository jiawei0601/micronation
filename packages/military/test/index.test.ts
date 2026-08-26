import { describe, it, expect } from 'vitest';
import type { Nation, Region, WorldState } from '@micronation/shared';
import { marchTime, regionDistanceByIndex } from '@micronation/shared';
import { declareAttack, regionDistance, recallMarch } from '../src/index';

function makeNation(overrides: Partial<Nation> = {}): Nation {
  return {
    id: 'n1',
    ownerId: 'u1',
    name: '測試國',
    flag: { layout: 'stripes', colors: ['#fff'], emblem: 'star' },
    regionId: 'r0',
    resources: { food: 100, ore: 100, fuel: 100, money: 100 },
    tech: 1,
    actionPoints: 10,
    population: 100,
    morale: 50,
    buildings: {
      farm: 0,
      mine: 0,
      refinery: 0,
      market: 0,
      barracks: 0,
      warehouse: 0,
      university: 0,
      wall: 0,
    },
    buildQueue: [],
    army: { size: 100 },
    policies: { tax: 'mid', economy: 'agri', conscription: 'volunteer', openness: 'neutral' },
    policyChangedAt: {},
    reputation: { breaches: 0 },
    protectedUntil: 0,
    score: { economy: 50, warfare: 50, tech: 50, diplomacy: 50, total: 200 },
    createdAt: 0,
    ...overrides,
  };
}

function makeRegion(id: string): Region {
  return { id, name: id, bonuses: {} };
}

function makeState(nations: Nation[], overrides: Partial<WorldState> = {}): WorldState {
  return {
    seasonId: 's1',
    tick: 0,
    regions: [makeRegion('r0'), makeRegion('r1'), makeRegion('r2')],
    nations,
    marches: [],
    treaties: [],
    orders: [],
    nextMarchSeq: 0,
    ...overrides,
  };
}

describe('declareAttack', () => {
  it('rejects attacking oneself', () => {
    const attacker = makeNation({ id: 'a' });
    const state = makeState([attacker]);
    const result = declareAttack(state, 'a', 'a', 10, 0);
    expect(result).toEqual({ ok: false, error: 'SELF_ATTACK' });
  });

  it('rejects when attacker not found', () => {
    const defender = makeNation({ id: 'b' });
    const state = makeState([defender]);
    const result = declareAttack(state, 'ghost', 'b', 10, 0);
    expect(result).toEqual({ ok: false, error: 'ATTACKER_NOT_FOUND' });
  });

  it('rejects when defender not found', () => {
    const attacker = makeNation({ id: 'a' });
    const state = makeState([attacker]);
    const result = declareAttack(state, 'a', 'ghost', 10, 0);
    expect(result).toEqual({ ok: false, error: 'DEFENDER_NOT_FOUND' });
  });

  it('rejects when defender still in protection period', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0' });
    const defender = makeNation({ id: 'b', regionId: 'r1', protectedUntil: 50 });
    const state = makeState([attacker, defender], { tick: 10 });
    const result = declareAttack(state, 'a', 'b', 10, 10);
    expect(result).toEqual({ ok: false, error: 'PROTECTED' });
  });

  it('rejects zero army size', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0', army: { size: 100 } });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender]);
    const result = declareAttack(state, 'a', 'b', 0, 0);
    expect(result).toEqual({ ok: false, error: 'INSUFFICIENT_ARMY' });
  });

  it('rejects army size larger than attacker has', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0', army: { size: 50 } });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender]);
    const result = declareAttack(state, 'a', 'b', 51, 0);
    expect(result).toEqual({ ok: false, error: 'INSUFFICIENT_ARMY' });
  });

  it('rejects farming a much weaker nation', () => {
    const attacker = makeNation({
      id: 'a',
      regionId: 'r0',
      score: { economy: 100, warfare: 100, tech: 100, diplomacy: 100, total: 1000 },
    });
    const defender = makeNation({
      id: 'b',
      regionId: 'r1',
      score: { economy: 10, warfare: 10, tech: 10, diplomacy: 10, total: 100 },
    });
    const state = makeState([attacker, defender]);
    // ratio = 100/1000 = 0.1 < FARM_RATIO(0.5)
    const result = declareAttack(state, 'a', 'b', 10, 0);
    expect(result).toEqual({ ok: false, error: 'FARMING' });
  });

  it('allows attacking a comparable nation (ratio above FARM_RATIO)', () => {
    const attacker = makeNation({
      id: 'a',
      regionId: 'r0',
      score: { economy: 100, warfare: 100, tech: 100, diplomacy: 100, total: 200 },
    });
    const defender = makeNation({
      id: 'b',
      regionId: 'r1',
      score: { economy: 100, warfare: 100, tech: 100, diplomacy: 100, total: 200 },
    });
    const state = makeState([attacker, defender]);
    const result = declareAttack(state, 'a', 'b', 10, 0);
    expect(result.ok).toBe(true);
  });

  it('rejects when a NAP treaty blocks the attack (via diplomacy.canAttack)', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0' });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender], {
      treaties: [
        {
          id: 't1',
          kind: 'nap',
          aId: 'a',
          bId: 'b',
          status: 'active',
          terms: { duration: 100 },
          createdAt: 0,
        },
      ],
    });
    const result = declareAttack(state, 'a', 'b', 10, 0);
    expect(result).toEqual({ ok: false, error: 'NAP' });
  });

  it('rejects when attacker lacks action points', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0', actionPoints: 0 });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender]);
    const result = declareAttack(state, 'a', 'b', 10, 0);
    expect(result).toEqual({ ok: false, error: 'INSUFFICIENT_ACTION_POINTS' });
  });

  it('computes arrivesAt using marchTime(regionDistance) on success', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0' });
    const defender = makeNation({ id: 'b', regionId: 'r2' });
    const tick = 5;
    const state = makeState([attacker, defender], { tick });
    const result = declareAttack(state, 'a', 'b', 10, tick);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const distance = regionDistanceByIndex(0, 2);
      expect(result.value.march.arrivesAt).toBe(tick + marchTime(distance));
      expect(result.value.march.departedAt).toBe(tick);
      expect(result.value.march.size).toBe(10);
      expect(result.value.nextMarchSeq).toBe(1);
    }
  });

  it('rejects when the passed tick does not match stateView.tick', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0' });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender], { tick: 3 });
    const result = declareAttack(state, 'a', 'b', 10, 4);
    expect(result).toEqual({ ok: false, error: 'TICK_MISMATCH' });
  });

  it('rejects when attacker regionId is not found in stateView.regions', () => {
    const attacker = makeNation({ id: 'a', regionId: 'ghost-region' });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender]);
    const result = declareAttack(state, 'a', 'b', 10, 0);
    expect(result).toEqual({ ok: false, error: 'REGION_NOT_FOUND' });
  });

  it('rejects when defender regionId is not found in stateView.regions', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0' });
    const defender = makeNation({ id: 'b', regionId: 'ghost-region' });
    const state = makeState([attacker, defender]);
    const result = declareAttack(state, 'a', 'b', 10, 0);
    expect(result).toEqual({ ok: false, error: 'REGION_NOT_FOUND' });
  });

  it('rejects non-integer or NaN army size', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0', army: { size: 100 } });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender]);
    expect(declareAttack(state, 'a', 'b', 10.5, 0)).toEqual({ ok: false, error: 'INSUFFICIENT_ARMY' });
    expect(declareAttack(state, 'a', 'b', NaN, 0)).toEqual({ ok: false, error: 'INSUFFICIENT_ARMY' });
    expect(declareAttack(state, 'a', 'b', Infinity, 0)).toEqual({ ok: false, error: 'INSUFFICIENT_ARMY' });
  });

  it('deducts in-flight (not-yet-arrived) marches from available army before checking sufficiency', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0', army: { size: 100 } });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender], {
      marches: [{ id: 'm-existing', attackerId: 'a', defenderId: 'b', size: 60, departedAt: 0, arrivesAt: 5 }],
    });
    // only 40 available (100 - 60 in-flight); asking for 50 should fail
    expect(declareAttack(state, 'a', 'b', 50, 0)).toEqual({ ok: false, error: 'INSUFFICIENT_ARMY' });
    // 40 should succeed
    expect(declareAttack(state, 'a', 'b', 40, 0).ok).toBe(true);
  });

  it('does not count already-arrived marches (arrivesAt <= tick) as occupying army', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0', army: { size: 100 } });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender], {
      tick: 10,
      marches: [{ id: 'm-arrived', attackerId: 'a', defenderId: 'b', size: 60, departedAt: 0, arrivesAt: 10 }],
    });
    expect(declareAttack(state, 'a', 'b', 90, 10).ok).toBe(true);
  });

  it('march ids use the monotonic nextMarchSeq so two marches departing the same tick never collide (regression for Codex finding #4/#8/#12)', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0', army: { size: 100 } });
    const other = makeNation({ id: 'c', regionId: 'r0', army: { size: 100 } });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, other, defender]);
    const r1 = declareAttack(state, 'a', 'b', 5, 0);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.nextMarchSeq).toBe(1);

    // 呼叫端持久化 nextMarchSeq 並帶入下一次呼叫
    const stateWithMarch = { ...state, marches: [r1.value.march], nextMarchSeq: r1.value.nextMarchSeq };
    const r2 = declareAttack(stateWithMarch, 'c', 'b', 5, 0);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r1.value.march.id).not.toBe(r2.value.march.id);
    expect(r2.value.nextMarchSeq).toBe(2);
  });

  it('撤回第一筆行軍後同 tick 再宣戰,新 march id 仍與歷來所有 id 不同(nextMarchSeq 不因筆數減少而倒退)', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0', army: { size: 100 } });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender]);

    const r1 = declareAttack(state, 'a', 'b', 5, 0);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const firstMarchId = r1.value.march.id;

    // 撤回:marches 變回空陣列(若序號跟著「現存筆數」走,會誤以為又能從 0 開始編號),
    // 但 nextMarchSeq 是呼叫端持久化的獨立計數器,不受 marches 陣列筆數影響。
    const recalled = recallMarch([r1.value.march], firstMarchId, 'a', 0);
    expect(recalled.ok).toBe(true);
    if (!recalled.ok) return;

    const stateAfterRecall = { ...state, marches: recalled.value.marches, nextMarchSeq: r1.value.nextMarchSeq };
    const r2 = declareAttack(stateAfterRecall, 'a', 'b', 5, 0);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.value.march.id).not.toBe(firstMarchId);
  });

  it('拒絕 stateView.tick 為非負安全整數以外的值(regression for Codex finding #7)', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0' });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    expect(declareAttack(makeState([attacker, defender], { tick: -1 }), 'a', 'b', 10, -1)).toEqual({
      ok: false,
      error: 'INVALID_TICK',
    });
    expect(declareAttack(makeState([attacker, defender], { tick: NaN }), 'a', 'b', 10, NaN)).toEqual({
      ok: false,
      error: 'INVALID_TICK',
    });
    expect(declareAttack(makeState([attacker, defender], { tick: 1.5 }), 'a', 'b', 10, 1.5)).toEqual({
      ok: false,
      error: 'INVALID_TICK',
    });
  });

  it('拒絕非負安全整數以外的 nextMarchSeq(損壞資料)', () => {
    const attacker = makeNation({ id: 'a', regionId: 'r0' });
    const defender = makeNation({ id: 'b', regionId: 'r1' });
    const state = makeState([attacker, defender], { nextMarchSeq: -1 });
    expect(declareAttack(state, 'a', 'b', 10, 0)).toEqual({ ok: false, error: 'INVALID_MARCH_SEQ' });
  });
});

describe('marchTime / regionDistance', () => {
  it('regionDistance matches shared regionDistanceByIndex', () => {
    expect(regionDistance(0, 3)).toBe(regionDistanceByIndex(0, 3));
    expect(regionDistance(2, 2)).toBe(0);
  });

  it('marchTime grows with distance', () => {
    expect(marchTime(0)).toBeLessThan(marchTime(5));
  });
});

describe('recallMarch', () => {
  const march = {
    id: 'm1',
    attackerId: 'a',
    defenderId: 'b',
    size: 10,
    departedAt: 0,
    arrivesAt: 10,
  };

  it('allows recall before arrival', () => {
    const result = recallMarch([march], 'm1', 'a', 5);
    expect(result).toEqual({ ok: true, value: { marches: [] } });
  });

  it('rejects recall exactly at arrival tick (boundary)', () => {
    const result = recallMarch([march], 'm1', 'a', 10);
    expect(result).toEqual({ ok: false, error: 'ALREADY_ARRIVED' });
  });

  it('rejects recall after arrival', () => {
    const result = recallMarch([march], 'm1', 'a', 11);
    expect(result).toEqual({ ok: false, error: 'ALREADY_ARRIVED' });
  });

  it('rejects recall by a non-owner nation', () => {
    const result = recallMarch([march], 'm1', 'c', 5);
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('rejects recall of unknown march id', () => {
    const result = recallMarch([march], 'nope', 'a', 5);
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});
