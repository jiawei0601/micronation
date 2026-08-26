import type { BuildingKind, Nation, Region, WorldState, Policies, Treaty, March, MarketOrder } from '@micronation/shared';

export const emptyBuildings = (): Record<BuildingKind, number> => ({
  farm: 0,
  mine: 0,
  refinery: 0,
  market: 0,
  barracks: 0,
  warehouse: 0,
  university: 0,
  wall: 0,
});

const defaultPolicies = (): Policies => ({
  tax: 'mid',
  economy: 'agri',
  conscription: 'volunteer',
  openness: 'neutral',
});

export function makeNation(overrides: Partial<Nation> = {}): Nation {
  return {
    id: 'nation-1',
    ownerId: 'user-1',
    name: 'Test Nation',
    flag: { layout: 'stripes', colors: ['#fff', '#000'], emblem: 'star' },
    regionId: 'region-0',
    resources: { food: 10, ore: 20, fuel: 30, money: 40 },
    tech: 2,
    actionPoints: 5,
    population: 100,
    morale: 50,
    buildings: { ...emptyBuildings(), farm: 2 },
    buildQueue: [{ building: 'mine', completesAt: 10 }],
    army: { size: 15 },
    policies: defaultPolicies(),
    policyChangedAt: { tax: 3 },
    reputation: { breaches: 1 },
    protectedUntil: 168,
    score: { economy: 5, warfare: 2, tech: 1, diplomacy: 0, total: 8 },
    createdAt: 0,
    lastAttackedAt: 4,
    ...overrides,
  };
}

export function makeRegion(overrides: Partial<Region> = {}): Region {
  return { id: 'region-0', name: 'Region 0', bonuses: { food: 10 }, ...overrides };
}

export function makeTreaty(overrides: Partial<Treaty> = {}): Treaty {
  return {
    id: 'treaty-1',
    kind: 'nap',
    aId: 'nation-1',
    bId: 'nation-2',
    status: 'active',
    terms: { duration: 100, activatedAt: 5 },
    createdAt: 0,
    ...overrides,
  };
}

export function makeMarch(overrides: Partial<March> = {}): March {
  return {
    id: 'march-1',
    attackerId: 'nation-1',
    defenderId: 'nation-2',
    size: 10,
    departedAt: 1,
    arrivesAt: 3,
    ...overrides,
  };
}

export function makeOrder(overrides: Partial<MarketOrder> = {}): MarketOrder {
  return {
    id: 'order-1',
    nationId: 'nation-1',
    kind: 'food',
    side: 'sell',
    qty: 5,
    price: 10,
    createdAt: 0,
    ...overrides,
  };
}

export function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    seasonId: 'season-1',
    tick: 0,
    regions: [makeRegion()],
    nations: [],
    marches: [],
    treaties: [],
    orders: [],
    nextMarchSeq: 0,
    ...overrides,
  };
}
