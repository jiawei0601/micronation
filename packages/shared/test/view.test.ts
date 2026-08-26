import { describe, it, expect } from 'vitest';
import { toPublicWorldView, armySizeTier } from '../src/view';
import type { Nation, WorldState } from '../src/types';

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

  it('preserves regions/marches/treaties/orders/tick/seasonId unchanged', () => {
    const state = makeWorld({
      marches: [{ id: 'm1', attackerId: 'n1', defenderId: 'n2', size: 5, departedAt: 1, arrivesAt: 3 }],
    });
    const view = toPublicWorldView(state, null);
    expect(view.tick).toBe(state.tick);
    expect(view.seasonId).toBe(state.seasonId);
    expect(view.regions).toEqual(state.regions);
    expect(view.marches).toEqual(state.marches);
  });

  it('is a pure function: same input yields deep-equal output regardless of viewerId', () => {
    const state = makeWorld();
    const a = toPublicWorldView(state, 'viewer-a');
    const b = toPublicWorldView(state, 'viewer-b');
    expect(a).toEqual(b);
  });
});
