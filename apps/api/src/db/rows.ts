// D1 <-> shared 型別的 row 轉換。複雜欄位(flag/buildings/build_queue/policies/
// policy_changed_at/score/terms/bonuses/nation_ids/payload)一律 JSON.stringify/parse。

import type {
  Nation,
  Region,
  March,
  Treaty,
  MarketOrder,
  GameEvent,
} from '@micronation/shared';

export interface NationRow {
  id: string;
  season_id: string;
  owner_id: string | null;
  name: string;
  flag: string;
  region_id: string;
  resource_food: number;
  resource_ore: number;
  resource_fuel: number;
  resource_money: number;
  tech: number;
  action_points: number;
  population: number;
  morale: number;
  buildings: string;
  build_queue: string;
  army_size: number;
  policies: string;
  policy_changed_at: string;
  reputation_breaches: number;
  protected_until: number;
  score: string;
  created_at: number;
  last_attacked_at: number | null;
}

export function nationToRow(seasonId: string, n: Nation): NationRow {
  return {
    id: n.id,
    season_id: seasonId,
    owner_id: n.ownerId,
    name: n.name,
    flag: JSON.stringify(n.flag),
    region_id: n.regionId,
    resource_food: n.resources.food,
    resource_ore: n.resources.ore,
    resource_fuel: n.resources.fuel,
    resource_money: n.resources.money,
    tech: n.tech,
    action_points: n.actionPoints,
    population: n.population,
    morale: n.morale,
    buildings: JSON.stringify(n.buildings),
    build_queue: JSON.stringify(n.buildQueue),
    army_size: n.army.size,
    policies: JSON.stringify(n.policies),
    policy_changed_at: JSON.stringify(n.policyChangedAt),
    reputation_breaches: n.reputation.breaches,
    protected_until: n.protectedUntil,
    score: JSON.stringify(n.score),
    created_at: n.createdAt,
    last_attacked_at: n.lastAttackedAt ?? null,
  };
}

export function rowToNation(r: NationRow): Nation {
  const nation: Nation = {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    flag: JSON.parse(r.flag),
    regionId: r.region_id,
    resources: {
      food: r.resource_food,
      ore: r.resource_ore,
      fuel: r.resource_fuel,
      money: r.resource_money,
    },
    tech: r.tech,
    actionPoints: r.action_points,
    population: r.population,
    morale: r.morale,
    buildings: JSON.parse(r.buildings),
    buildQueue: JSON.parse(r.build_queue),
    army: { size: r.army_size },
    policies: JSON.parse(r.policies),
    policyChangedAt: JSON.parse(r.policy_changed_at),
    reputation: { breaches: r.reputation_breaches },
    protectedUntil: r.protected_until,
    score: JSON.parse(r.score),
    createdAt: r.created_at,
  };
  if (r.last_attacked_at !== null) nation.lastAttackedAt = r.last_attacked_at;
  return nation;
}

export interface RegionRow {
  id: string;
  season_id: string;
  region_index: number;
  name: string;
  bonuses: string;
}

export function regionToRow(seasonId: string, index: number, r: Region): RegionRow {
  return { id: r.id, season_id: seasonId, region_index: index, name: r.name, bonuses: JSON.stringify(r.bonuses) };
}

export function rowToRegion(r: RegionRow): Region {
  return { id: r.id, name: r.name, bonuses: JSON.parse(r.bonuses) };
}

export interface MarchRow {
  id: string;
  season_id: string;
  attacker_id: string;
  defender_id: string;
  size: number;
  departed_at: number;
  arrives_at: number;
}

export function marchToRow(seasonId: string, m: March): MarchRow {
  return {
    id: m.id,
    season_id: seasonId,
    attacker_id: m.attackerId,
    defender_id: m.defenderId,
    size: m.size,
    departed_at: m.departedAt,
    arrives_at: m.arrivesAt,
  };
}

export function rowToMarch(r: MarchRow): March {
  return {
    id: r.id,
    attackerId: r.attacker_id,
    defenderId: r.defender_id,
    size: r.size,
    departedAt: r.departed_at,
    arrivesAt: r.arrives_at,
  };
}

export interface TreatyRow {
  id: string;
  season_id: string;
  kind: string;
  a_id: string;
  b_id: string;
  status: string;
  terms: string;
  created_at: number;
}

export function treatyToRow(seasonId: string, t: Treaty): TreatyRow {
  return {
    id: t.id,
    season_id: seasonId,
    kind: t.kind,
    a_id: t.aId,
    b_id: t.bId,
    status: t.status,
    terms: JSON.stringify(t.terms),
    created_at: t.createdAt,
  };
}

export function rowToTreaty(r: TreatyRow): Treaty {
  return {
    id: r.id,
    kind: r.kind as Treaty['kind'],
    aId: r.a_id,
    bId: r.b_id,
    status: r.status as Treaty['status'],
    terms: JSON.parse(r.terms),
    createdAt: r.created_at,
  };
}

export interface OrderRow {
  id: string;
  season_id: string;
  nation_id: string;
  kind: string;
  side: string;
  qty: number;
  price: number;
  created_at: number;
}

export function orderToRow(seasonId: string, o: MarketOrder): OrderRow {
  return {
    id: o.id,
    season_id: seasonId,
    nation_id: o.nationId,
    kind: o.kind,
    side: o.side,
    qty: o.qty,
    price: o.price,
    created_at: o.createdAt,
  };
}

export function rowToOrder(r: OrderRow): MarketOrder {
  return {
    id: r.id,
    nationId: r.nation_id,
    kind: r.kind as MarketOrder['kind'],
    side: r.side as MarketOrder['side'],
    qty: r.qty,
    price: r.price,
    createdAt: r.created_at,
  };
}

export interface EventRow {
  id: string;
  season_id: string;
  tick: number;
  type: string;
  nation_ids: string;
  payload: string;
  created_at: number;
}

export function eventToRow(seasonId: string, id: string, e: GameEvent, createdAt: number): EventRow {
  return {
    id,
    season_id: seasonId,
    tick: e.tick,
    type: e.type,
    nation_ids: JSON.stringify(e.nationIds),
    payload: JSON.stringify(e.payload),
    created_at: createdAt,
  };
}

export function rowToEvent(r: EventRow): GameEvent {
  return {
    tick: r.tick,
    type: r.type as GameEvent['type'],
    nationIds: JSON.parse(r.nation_ids),
    payload: JSON.parse(r.payload),
  };
}
