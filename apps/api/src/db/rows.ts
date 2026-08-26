// D1 <-> shared 型別的 row 轉換。複雜欄位(flag/buildings/build_queue/policies/
// policy_changed_at/score/terms/bonuses/nation_ids/payload)一律 JSON.stringify/parse。
//
// finding #4:JSON.parse 對壞資料(手改 DB/未來 migration bug/其他 process 寫壞)會丟未分類的
// SyntaxError,呼叫端(repository → routes)拿到的錯誤看不出是哪張表哪一筆壞掉。這裡統一包
// try/catch 成 CorruptRowError(附 table/rowId/field),並對已知只允許固定字面值的欄位
// (treaty.kind/status、order.kind/side、event.type)加白名單驗證——不合法值不是「解析失敗」
// 而是「解析成功但語意不對」,一樣視為壞資料 fail fast,不讓後續業務邏輯拿一個型別上宣稱
// 合法、實際是垃圾字串的值繼續跑。

import type {
  Nation,
  Region,
  March,
  Treaty,
  TreatyKind,
  TreatyStatus,
  MarketOrder,
  ResourceKind,
  OrderSide,
  GameEvent,
} from '@micronation/shared';
import { EVENT, type EventType } from '@micronation/shared';

/** rows.ts 專用錯誤——repository/routes 層對它 fail fast(500 附 table/rowId/field),
 * 不當一般 SyntaxError 吞掉繼續跑。 */
export class CorruptRowError extends Error {
  readonly table: string;
  readonly rowId: string;
  readonly field: string;

  constructor(table: string, rowId: string, field: string, cause?: unknown) {
    super(`CORRUPT_ROW: ${table}(id=${rowId}).${field} 解析失敗或不合法`);
    this.name = 'CorruptRowError';
    this.table = table;
    this.rowId = rowId;
    this.field = field;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function parseJson<T>(table: string, rowId: string, field: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new CorruptRowError(table, rowId, field, e);
  }
}

/** ①-14:parseJson 只保證「是合法 JSON」,不保證形狀對——手改 DB/未來 migration bug 可能寫入
 * 語法合法但結構錯誤的值(例如 buildings 存成陣列、score 缺欄位),下游業務邏輯拿到型別上宣稱
 * 是 `Record<BuildingKind, number>` 實際上是別的東西的值,會在很後面才因為 undefined 運算炸掉、
 * 錯誤訊息與這裡的壞資料完全對不上。加一層淺層 shape 驗證(頂層型別 + 必要鍵),不合就視同
 * CorruptRowError,在最靠近資料來源的地方 fail fast。 */
function parseJsonShaped<T>(
  table: string,
  rowId: string,
  field: string,
  raw: string,
  validate: (value: unknown) => boolean
): T {
  const value = parseJson<unknown>(table, rowId, field, raw);
  if (!validate(value)) throw new CorruptRowError(table, rowId, field);
  return value as T;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isRecordOfNumbers = (v: unknown): boolean => isPlainObject(v) && Object.values(v).every((x) => typeof x === 'number');
const isRecordOfStrings = (v: unknown): boolean => isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string');

const isBuildQueue = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.every((item) => isPlainObject(item) && typeof item.building === 'string' && typeof item.completesAt === 'number');

const SCORE_KEYS = ['economy', 'warfare', 'tech', 'diplomacy', 'total'] as const;
const isScore = (v: unknown): boolean =>
  isPlainObject(v) && SCORE_KEYS.every((k) => typeof v[k] === 'number');

function assertEnum<T extends string>(
  table: string,
  rowId: string,
  field: string,
  value: string,
  allowed: readonly T[]
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CorruptRowError(table, rowId, field);
  }
  return value as T;
}

const TREATY_KINDS: readonly TreatyKind[] = ['nap', 'alliance', 'trade'];
const TREATY_STATUSES: readonly TreatyStatus[] = [
  'proposed',
  'countered',
  'active',
  'expired',
  'breached',
  'rejected',
];
const RESOURCE_KINDS: readonly ResourceKind[] = ['food', 'ore', 'fuel', 'money'];
const ORDER_SIDES: readonly OrderSide[] = ['buy', 'sell'];
const EVENT_TYPES: readonly EventType[] = Object.values(EVENT);

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
    flag: parseJson('nations', r.id, 'flag', r.flag),
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
    buildings: parseJsonShaped('nations', r.id, 'buildings', r.buildings, isRecordOfNumbers),
    buildQueue: parseJsonShaped('nations', r.id, 'build_queue', r.build_queue, isBuildQueue),
    army: { size: r.army_size },
    policies: parseJsonShaped('nations', r.id, 'policies', r.policies, isRecordOfStrings),
    policyChangedAt: parseJsonShaped('nations', r.id, 'policy_changed_at', r.policy_changed_at, isRecordOfNumbers),
    reputation: { breaches: r.reputation_breaches },
    protectedUntil: r.protected_until,
    score: parseJsonShaped('nations', r.id, 'score', r.score, isScore),
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
  return { id: r.id, name: r.name, bonuses: parseJson('regions', r.id, 'bonuses', r.bonuses) };
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
    kind: assertEnum('treaties', r.id, 'kind', r.kind, TREATY_KINDS),
    aId: r.a_id,
    bId: r.b_id,
    status: assertEnum('treaties', r.id, 'status', r.status, TREATY_STATUSES),
    terms: parseJson('treaties', r.id, 'terms', r.terms),
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
    kind: assertEnum('market_orders', r.id, 'kind', r.kind, RESOURCE_KINDS),
    side: assertEnum('market_orders', r.id, 'side', r.side, ORDER_SIDES),
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
    // finding #5:e.payload 為 undefined 時 JSON.stringify(undefined) === undefined(不是字串
    // "undefined"),bind() 會拿到 undefined 值——D1/better-sqlite3 對此的行為不可靠(常是丟錯
    // 或存成 NULL,NULL 又違反 payload TEXT NOT NULL)。統一存 JSON 'null' 字面量。
    payload: JSON.stringify(e.payload) ?? 'null',
    created_at: createdAt,
  };
}

export function rowToEvent(r: EventRow): GameEvent {
  return {
    tick: r.tick,
    type: assertEnum('events', r.id, 'type', r.type, EVENT_TYPES),
    nationIds: parseJson('events', r.id, 'nation_ids', r.nation_ids),
    payload: parseJson('events', r.id, 'payload', r.payload),
  };
}
