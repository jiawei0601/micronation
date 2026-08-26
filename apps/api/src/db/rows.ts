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
// Codex 四審⑤:FlagSpec 驗證改共用 game/constants.ts 的 isValidFlagSpec——原本這裡自己另外
// 定義一份寬鬆許多的 isFlagSpec(見下方刪除的舊定義註解),與 api 層的驗證規則不一致。
import { isValidFlagSpec } from '../game/constants';

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
const isBuildQueue = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.every((item) => isPlainObject(item) && typeof item.building === 'string' && typeof item.completesAt === 'number');

const SCORE_KEYS = ['economy', 'warfare', 'tech', 'diplomacy', 'total'] as const;
// ③-6:score 每項改用 Number.isFinite——原本 `typeof v[k] === 'number'` 對 NaN/Infinity 一樣放行
// (兩者的 typeof 都是 'number'),下游排名/顯示邏輯拿到 NaN 會靜默壞掉(例如排序永遠把它排在
// 奇怪的位置、前端顯示 "NaN"),不是「解析失敗」該有的 fail-fast 行為。
const isScore = (v: unknown): boolean =>
  isPlainObject(v) && SCORE_KEYS.every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));

// ③-6:buildings 全鍵存在(不多不少)+ 每個等級為非負整數——原本 isRecordOfNumbers 只檢查
// 「有出現的鍵其值是 number」,缺鍵(某個 building 種類整個沒寫入,下游 `buildings[k] ?? 0`
// 的 fallback 會悄悄接手,掩蓋掉本該視為壞資料的殘缺列)、負數等級、非整數等級(手改 DB 或
// 序列化 bug)都會被放行,直到很後面的建築等級查表才因為查不到而炸開。
const BUILDING_KINDS = ['farm', 'mine', 'refinery', 'market', 'barracks', 'warehouse', 'university', 'wall'] as const;
const isBuildings = (v: unknown): boolean =>
  isPlainObject(v) &&
  Object.keys(v).length === BUILDING_KINDS.length &&
  BUILDING_KINDS.every((k) => Number.isInteger(v[k]) && (v[k] as number) >= 0);

// ③-6:policies 四軸各自套自己的合法檔位白名單(取代原本寬鬆的「值是字串就好」)——手改 DB/
// 未來 bug 若寫入不存在的檔位字串(例如 tax 軸誤植成 'medium'),下游 TAX_MODIFIERS[tier] 之類
// 查表會拿到 undefined,在很後面的資源結算才因為 undefined 運算炸開,錯誤訊息與這裡的壞資料
// 對不上。
const TAX_TIERS = ['low', 'mid', 'high'] as const;
const ECONOMY_TIERS = ['agri', 'industry', 'commerce'] as const;
const CONSCRIPTION_TIERS = ['volunteer', 'draft'] as const;
const OPENNESS_TIERS = ['closed', 'neutral', 'free'] as const;
const POLICY_AXES = ['tax', 'economy', 'conscription', 'openness'] as const;
const isPolicies = (v: unknown): boolean =>
  isPlainObject(v) &&
  Object.keys(v).length === POLICY_AXES.length &&
  (TAX_TIERS as readonly string[]).includes(v.tax as string) &&
  (ECONOMY_TIERS as readonly string[]).includes(v.economy as string) &&
  (CONSCRIPTION_TIERS as readonly string[]).includes(v.conscription as string) &&
  (OPENNESS_TIERS as readonly string[]).includes(v.openness as string);

// ③-6:policyChangedAt 的鍵須是合法的 PolicyAxis 子集(Partial<Record<PolicyAxis, Tick>>),
// 值須為有限數——原本 isRecordOfNumbers 對任意字串鍵都放行。
const isPolicyChangedAt = (v: unknown): boolean =>
  isPlainObject(v) &&
  Object.entries(v).every(
    ([k, val]) => (POLICY_AXES as readonly string[]).includes(k) && typeof val === 'number' && Number.isFinite(val)
  );

// ③-6:Region.bonuses——鍵須為合法 ResourceKind、值須為有限數(±百分比)。
const isBonuses = (v: unknown): boolean =>
  isPlainObject(v) &&
  Object.entries(v).every(
    ([k, val]) => (RESOURCE_KINDS as readonly string[]).includes(k) && typeof val === 'number' && Number.isFinite(val)
  );

// Codex 四審⑥:TreatyTerms 驗證收緊——原本 duration/compensation/activatedAt 只檢查
// Number.isFinite,放行負數、小數、極端浮點值(這三個欄位語意上都該是「安全整數」的 tick 數/
// 金額,負的 duration 或帶小數的 compensation 都是壞資料該 fail fast 而非悄悄放行)。
// pendingResponderId 原本只檢查 typeof === 'string',任意字串都放行——它的語意是「等待哪一方
// 回應」,必須是這筆條約的 aId 或 bId 其中之一,不然下游 respond() 邏輯拿到一個誰都不是的
// id,永遠等不到對得上的回應方。這裡需要呼叫端(rowToTreaty)傳入該筆條約的 aId/bId 當上下文。
function isTreatyTerms(v: unknown, ctx: { aId: string; bId: string }): boolean {
  if (!isPlainObject(v)) return false;
  if (typeof v.duration !== 'number' || !Number.isSafeInteger(v.duration) || v.duration <= 0) return false;
  if (
    v.compensation !== undefined &&
    (typeof v.compensation !== 'number' || !Number.isSafeInteger(v.compensation) || v.compensation < 0)
  )
    return false;
  if (v.allianceDefense !== undefined && typeof v.allianceDefense !== 'boolean') return false;
  if (
    v.tariffDiscount !== undefined &&
    (typeof v.tariffDiscount !== 'number' || !Number.isFinite(v.tariffDiscount) || v.tariffDiscount < 0 || v.tariffDiscount > 1)
  )
    return false;
  if (v.pendingResponderId !== undefined && v.pendingResponderId !== ctx.aId && v.pendingResponderId !== ctx.bId) return false;
  if (
    v.activatedAt !== undefined &&
    (typeof v.activatedAt !== 'number' || !Number.isSafeInteger(v.activatedAt) || v.activatedAt < 0)
  )
    return false;
  return true;
}

// ③-6:events.nation_ids——字串陣列。
const isNationIds = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');

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
    flag: parseJsonShaped('nations', r.id, 'flag', r.flag, isValidFlagSpec),
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
    buildings: parseJsonShaped('nations', r.id, 'buildings', r.buildings, isBuildings),
    buildQueue: parseJsonShaped('nations', r.id, 'build_queue', r.build_queue, isBuildQueue),
    army: { size: r.army_size },
    policies: parseJsonShaped('nations', r.id, 'policies', r.policies, isPolicies),
    policyChangedAt: parseJsonShaped('nations', r.id, 'policy_changed_at', r.policy_changed_at, isPolicyChangedAt),
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
  return { id: r.id, name: r.name, bonuses: parseJsonShaped('regions', r.id, 'bonuses', r.bonuses, isBonuses) };
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
    terms: parseJsonShaped('treaties', r.id, 'terms', r.terms, (v) => isTreatyTerms(v, { aId: r.a_id, bId: r.b_id })),
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
    nationIds: parseJsonShaped('events', r.id, 'nation_ids', r.nation_ids, isNationIds),
    payload: parseJson('events', r.id, 'payload', r.payload),
  };
}
