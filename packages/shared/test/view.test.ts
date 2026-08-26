import { describe, it, expect } from 'vitest';
import { toPublicWorldView, armySizeTier } from '../src/view';
import type { Nation, WorldState, March } from '../src/types';

function makeNation(overrides: Partial<Nation> = {}): Nation {
  return {
    id: 'n1',
    ownerId: 'u1',
    name: 'Test Nation',
    flag: { layout: 'stripes', colors: ['#fff'], emblem: 'star' },
    regionId: 'r0',
    resources: { food: 111, ore: 222, fuel: 333, money: 444 },
    tech: 2,
    actionPoints: 7,
    population: 100,
    morale: 50,
    buildings: { farm: 0, mine: 0, refinery: 0, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
    buildQueue: [{ building: 'farm', completesAt: 10 }],
    army: { size: 30 },
    policies: { tax: 'mid', economy: 'agri', conscription: 'volunteer', openness: 'neutral' },
    policyChangedAt: {},
    reputation: { breaches: 1 },
    protectedUntil: 5,
    score: { economy: 1, warfare: 2, tech: 3, diplomacy: 4, total: 10 },
    createdAt: 0,
    ...overrides,
  };
}

function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    seasonId: 's1',
    tick: 5,
    regions: [{ id: 'r0', name: 'Region 0', bonuses: {} }],
    nations: [makeNation()],
    marches: [],
    treaties: [],
    orders: [],
    nextMarchSeq: 0,
    ...overrides,
  };
}

describe('armySizeTier', () => {
  it('buckets army size into approximate tiers, not exact numbers', () => {
    expect(armySizeTier(0)).toBe('none');
    expect(armySizeTier(1)).toBe('small');
    expect(armySizeTier(49)).toBe('small');
    expect(armySizeTier(50)).toBe('medium');
    expect(armySizeTier(199)).toBe('medium');
    expect(armySizeTier(200)).toBe('large');
    expect(armySizeTier(499)).toBe('large');
    expect(armySizeTier(500)).toBe('huge');
  });

  it('rejects illegal input(NaN/Infinity/negative/non-integer) → none(regression for Codex finding #16)', () => {
    expect(armySizeTier(NaN)).toBe('none');
    expect(armySizeTier(Infinity)).toBe('none');
    expect(armySizeTier(-Infinity)).toBe('none');
    expect(armySizeTier(-1)).toBe('none');
    expect(armySizeTier(-100)).toBe('none');
    expect(armySizeTier(30.5)).toBe('none');
    expect(armySizeTier(Number.MAX_SAFE_INTEGER + 10)).toBe('none');
  });
});

describe('toPublicWorldView', () => {
  it('strips private fields (resources/actionPoints/buildQueue/lastAttackedAt) from every nation', () => {
    const state = makeWorld();
    const view = toPublicWorldView(state, 'someone-else');
    const pub = view.nations[0] as unknown as Record<string, unknown>;
    expect(pub.resources).toBeUndefined();
    expect(pub.actionPoints).toBeUndefined();
    expect(pub.buildQueue).toBeUndefined();
    expect(pub.lastAttackedAt).toBeUndefined();
  });

  it('keeps public fields: id/ownerId/name/flag/regionId/score/reputation/protectedUntil/policies', () => {
    const state = makeWorld();
    const view = toPublicWorldView(state, null);
    const pub = view.nations[0];
    expect(pub.id).toBe('n1');
    expect(pub.ownerId).toBe('u1');
    expect(pub.name).toBe('Test Nation');
    expect(pub.regionId).toBe('r0');
    expect(pub.score).toEqual({ economy: 1, warfare: 2, tech: 3, diplomacy: 4, total: 10 });
    expect(pub.reputation).toEqual({ breaches: 1 });
    expect(pub.protectedUntil).toBe(5);
    expect(pub.policies).toEqual({ tax: 'mid', economy: 'agri', conscription: 'volunteer', openness: 'neutral' });
  });

  it('exposes army only as an approximate tier, not the exact size', () => {
    const state = makeWorld({ nations: [makeNation({ army: { size: 30 } })] });
    const view = toPublicWorldView(state, null);
    expect(view.nations[0].armySizeTier).toBe('small');
  });

  it('preserves regions/treaties/orders/tick/seasonId content(deep-equal,non-party march projected to sizeTier)', () => {
    const state = makeWorld({
      marches: [{ id: 'm1', attackerId: 'n1', defenderId: 'n2', size: 5, departedAt: 1, arrivesAt: 3 }],
    });
    const view = toPublicWorldView(state, null); // viewer null,非當事方
    expect(view.tick).toBe(state.tick);
    expect(view.seasonId).toBe(state.seasonId);
    expect(view.regions).toEqual(state.regions);
    expect(view.marches).toEqual([{ id: 'm1', attackerId: 'n1', defenderId: 'n2', departedAt: 1, arrivesAt: 3, sizeTier: 'small' }]);
  });

  it('is a pure function: same input yields deep-equal output for viewers with no party-specific data', () => {
    const state = makeWorld();
    const a = toPublicWorldView(state, 'viewer-a');
    const b = toPublicWorldView(state, 'viewer-b');
    expect(a).toEqual(b);
  });
});

describe('toPublicWorldView — deep clone(regression for Codex finding #14)', () => {
  it('mutating the returned view never mutates the original WorldState', () => {
    const state = makeWorld({
      marches: [{ id: 'm1', attackerId: 'n1', defenderId: 'n2', size: 5, departedAt: 1, arrivesAt: 3 }],
      treaties: [
        { id: 't1', kind: 'nap', aId: 'n1', bId: 'n2', status: 'active', terms: { duration: 10, activatedAt: 0 }, createdAt: 0 },
      ],
      orders: [{ id: 'o1', nationId: 'n1', kind: 'food', side: 'buy', qty: 1, price: 1, createdAt: 0 }],
    });
    const snapshot = JSON.parse(JSON.stringify(state));
    const view = toPublicWorldView(state, 'n1');

    // 逐層改動 view 的可變結構
    (view.nations[0].flag.colors as string[]).push('#000');
    (view.nations[0].score as { total: number }).total = 9999;
    (view.nations[0].reputation as { breaches: number }).breaches = 9999;
    (view.nations[0].policies as { tax: string }).tax = 'high';
    (view.regions[0].bonuses as Record<string, number>).food = 9999;
    (view.treaties[0].terms as { duration: number }).duration = 9999;
    (view.orders[0] as { qty: number }).qty = 9999;

    expect(state).toEqual(snapshot);
  });
});

describe('toPublicWorldView — March 投影(regression for Codex finding #15)', () => {
  function marchFixture(): March {
    return { id: 'm1', attackerId: 'n1', defenderId: 'n2', size: 42, departedAt: 1, arrivesAt: 3 };
  }

  it('viewer 為 attacker 時看得到精確 size,沒有 sizeTier', () => {
    const state = makeWorld({ marches: [marchFixture()] });
    const view = toPublicWorldView(state, 'n1');
    expect(view.marches[0].size).toBe(42);
    expect(view.marches[0].sizeTier).toBeUndefined();
  });

  it('viewer 為 defender 時看得到精確 size', () => {
    const state = makeWorld({ marches: [marchFixture()] });
    const view = toPublicWorldView(state, 'n2');
    expect(view.marches[0].size).toBe(42);
  });

  it('viewer 為第三方時只看到 sizeTier,拿不到精確 size', () => {
    const state = makeWorld({ marches: [marchFixture()] });
    const view = toPublicWorldView(state, 'n3');
    expect(view.marches[0].size).toBeUndefined();
    expect(view.marches[0].sizeTier).toBe('small');
  });

  it('viewer 為 null(匿名)時也只看到 sizeTier', () => {
    const state = makeWorld({ marches: [marchFixture()] });
    const view = toPublicWorldView(state, null);
    expect(view.marches[0].size).toBeUndefined();
    expect(view.marches[0].sizeTier).toBe('small');
  });
});
