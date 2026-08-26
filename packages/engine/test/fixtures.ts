import type { BuildingKind, Nation, Region, WorldState, Policies } from '@micronation/shared';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

const emptyBuildings = (): Record<BuildingKind, number> => ({
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
    id: nextId('nation'),
    ownerId: nextId('user'),
    name: 'Test Nation',
    flag: { layout: 'stripes', colors: ['#fff'], emblem: 'star' },
    regionId: 'region-0',
    resources: { food: 0, ore: 0, fuel: 0, money: 0 },
    tech: 0,
    actionPoints: 0,
    population: 100,
    morale: 50,
    buildings: emptyBuildings(),
    buildQueue: [],
    army: { size: 0 },
    policies: defaultPolicies(),
    policyChangedAt: {},
    reputation: { breaches: 0 },
    protectedUntil: 0,
    score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 },
    createdAt: 0,
    ...overrides,
  };
}

export function makeRegion(overrides: Partial<Region> = {}): Region {
  return { id: 'region-0', name: 'Region 0', bonuses: {}, ...overrides };
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
