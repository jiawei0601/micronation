// 共用基礎型別——正本。與 docs/CONTRACT.md 不一致時以 CONTRACT.md 為準並回報。

import type { EventType } from './events';

export type Id = string; // ulid
export type Tick = number; // 賽季內第 N tick,從 0 起

export type ResourceKind = 'food' | 'ore' | 'fuel' | 'money';
export type Resources = Record<ResourceKind, number>; // 整數

export type BuildingKind =
  | 'farm'
  | 'mine'
  | 'refinery'
  | 'market'
  | 'barracks'
  | 'warehouse'
  | 'university'
  | 'wall';

export type PolicyAxis = 'tax' | 'economy' | 'conscription' | 'openness';

export type TaxTier = 'low' | 'mid' | 'high';
export type EconomyTier = 'agri' | 'industry' | 'commerce';
export type ConscriptionTier = 'volunteer' | 'draft';
export type OpennessTier = 'closed' | 'neutral' | 'free';

/** Nation.policies 精確型別——每軸只允許該軸自己的檔位聯集,取代裸 Record<PolicyAxis, string>。 */
export interface Policies {
  tax: TaxTier;
  economy: EconomyTier;
  conscription: ConscriptionTier;
  openness: OpennessTier;
}

export interface FlagSpec {
  layout: string;
  colors: string[];
  emblem: string;
}

export interface ScoreBreakdown {
  economy: number;
  warfare: number;
  tech: number;
  diplomacy: number;
  total: number;
}

export interface Nation {
  id: Id;
  ownerId: Id | null; // null = NPC
  name: string;
  flag: FlagSpec;
  regionId: Id;
  resources: Resources;
  tech: number;
  actionPoints: number;
  population: number;
  morale: number; // 0-100
  buildings: Record<BuildingKind, number>; // 等級,0=未建
  buildQueue: { building: BuildingKind; completesAt: Tick }[];
  army: { size: number };
  policies: Policies;
  policyChangedAt: Partial<Record<PolicyAxis, Tick>>;
  reputation: { breaches: number };
  protectedUntil: Tick; // 新手保護
  score: ScoreBreakdown;
  createdAt: Tick;
  /** 最近一次被攻擊(以本國為 defender 的戰鬥解算)發生的 tick,供 npc 判斷是否需練兵。engine 於 resolveBattle 後寫入。 */
  lastAttackedAt?: Tick;
}

export interface Region {
  id: Id;
  name: string;
  bonuses: Partial<Record<ResourceKind, number>>; // ±百分比
}

export interface March {
  id: Id;
  attackerId: Id;
  defenderId: Id;
  size: number;
  departedAt: Tick;
  arrivesAt: Tick;
}

export type TreatyKind = 'nap' | 'alliance' | 'trade';
export type TreatyStatus =
  | 'proposed'
  | 'countered'
  | 'active'
  | 'expired'
  | 'breached'
  | 'rejected';

export interface TreatyTerms {
  duration: Tick;
  compensation?: number;
  /** kind==='alliance' 專屬:協防旗標 */
  allianceDefense?: boolean;
  /** kind==='trade' 專屬:關稅減免率,0~1 */
  tariffDiscount?: number;
  /** propose/counter 後,下一次 respond 應由誰發起 */
  pendingResponderId?: Id;
  /** 進入 active 的 tick,expire 以此 + duration 判定到期(createdAt 是提案時間,非生效時間) */
  activatedAt?: Tick;
}

export interface Treaty {
  id: Id;
  kind: TreatyKind;
  aId: Id;
  bId: Id;
  status: TreatyStatus;
  terms: TreatyTerms;
  createdAt: Tick;
}

export type OrderSide = 'buy' | 'sell';

export interface MarketOrder {
  id: Id;
  nationId: Id;
  kind: ResourceKind;
  side: OrderSide;
  qty: number;
  price: number;
  createdAt: Tick;
}

export interface NewOrder {
  nationId: Id;
  kind: ResourceKind;
  side: OrderSide;
  qty: number;
  price: number;
}

export interface Trade {
  id: Id;
  buyOrderId: Id;
  sellOrderId: Id;
  buyerId: Id;
  sellerId: Id;
  kind: ResourceKind;
  qty: number;
  price: number;
  tariff: number; // 跨區關稅,呼叫端算好傳入
  tick: Tick;
}

export interface PriceRef {
  // 近期成交均價表
  avgPrice: Partial<Record<ResourceKind, number>>;
}

export interface NationCtx {
  verified: boolean;
  protectedUntil: Tick;
  tick: Tick;
}

export interface WorldState {
  seasonId: Id;
  tick: Tick;
  regions: Region[];
  nations: Nation[];
  marches: March[];
  treaties: Treaty[];
  orders: MarketOrder[];
  /**
   * 呼叫端維護的單調遞增行軍序號,供 military.declareAttack 組 March id 用(finding #4/#8)。
   * 不可用 marches.filter(...).length 之類「現存筆數」推算——行軍抵達/撤回後筆數會下降,
   * 重新出征時可能拿到用過的序號,和歷史(含已從 marches 移除但仍存在 D1/事件紀錄裡)的
   * March id 撞號。declareAttack 純函式回傳遞增後的下一個值,由呼叫端(api 層)負責持久化。
   */
  nextMarchSeq: number;
}

export interface GameEvent {
  tick: Tick;
  type: EventType; // 常數表在 shared/events.ts
  nationIds: Id[];
  payload: unknown;
}

/** 他國兵力只暴露概略級距,不洩漏精確數字。 */
export type ArmySizeTier = 'none' | 'small' | 'medium' | 'large' | 'huge';

/**
 * PublicWorldView — 供 npc 與 web 使用的受限視角。
 * 只暴露公開欄位:id/ownerId/name/flag/regionId/score/reputation/army 規模概略(armySizeTier)/
 * protectedUntil/policies(政策依 PRD 為公開資訊,故保留)。不含 resources/actionPoints/
 * buildQueue/lastAttackedAt 等私密細節。透過 `toPublicWorldView(state, viewerId)` 產生。
 * 巢狀可變結構(flag/colors/score/reputation/policies)一律 readonly,防止呼叫端誤改。
 */
export interface PublicNation {
  readonly id: Id;
  readonly ownerId: Id | null;
  readonly name: string;
  readonly flag: Readonly<FlagSpec> & { readonly colors: readonly string[] };
  readonly regionId: Id;
  readonly score: Readonly<ScoreBreakdown>;
  readonly reputation: { readonly breaches: number };
  readonly armySizeTier: ArmySizeTier;
  readonly protectedUntil: Tick;
  readonly policies: Readonly<Policies>;
}

interface PublicMarchBase {
  readonly id: Id;
  readonly attackerId: Id;
  readonly defenderId: Id;
  readonly departedAt: Tick;
  readonly arrivesAt: Tick;
}

/**
 * March 的受限投影(finding #15)——只有出征雙方(viewer 為 attackerId 或 defenderId)
 * 才看得到精確 size,其餘 viewer 只拿到概略級距 sizeTier,不洩漏他國精確兵力。
 * 用 union 強制兩者互斥(三審 finding #2/#5)——舊版把 size?/sizeTier? 都設成 optional,
 * 型別上allow「兩者同時有值」或「兩者都缺」這種語意錯誤的狀態,編譯器攔不住;
 * 改成 union 後,取得 size 的分支型別上就不可能同時帶 sizeTier,反之亦然。
 */
export type PublicMarch = PublicMarchBase &
  (
    | { readonly size: number; readonly sizeTier?: never }
    | { readonly size?: never; readonly sizeTier: ArmySizeTier }
  );

/**
 * Region 的唯讀投影(三審 finding #6)——`Readonly<Region>` 只讓頂層欄位唯讀,
 * `bonuses` 本身仍是可變的 `Partial<Record<ResourceKind, number>>` 物件,呼叫端拿到
 * view 後仍可 `view.regions[0].bonuses.food = 999` 改到投影內部;巢狀欄位需另外標記唯讀。
 */
export type PublicRegion = Readonly<Omit<Region, 'bonuses'>> & {
  readonly bonuses: Readonly<Partial<Record<ResourceKind, number>>>;
};

/**
 * Treaty 的唯讀投影(三審 finding #6)——同上,`terms` 是巢狀可變物件,`Readonly<Treaty>`
 * 頂層唯讀擋不住 `view.treaties[0].terms.duration = 0` 這類改動。
 */
export type PublicTreaty = Readonly<Omit<Treaty, 'terms'>> & {
  readonly terms: Readonly<TreatyTerms>;
};

export interface PublicWorldView {
  readonly seasonId: Id;
  readonly tick: Tick;
  readonly regions: readonly PublicRegion[];
  readonly nations: readonly PublicNation[];
  readonly marches: readonly PublicMarch[];
  readonly treaties: readonly PublicTreaty[];
  readonly orders: readonly Readonly<MarketOrder>[];
}

// NpcAction — 與玩家 API 同語意的指令聯集
export type NpcAction =
  | { type: 'build'; nationId: Id; building: BuildingKind }
  | { type: 'placeOrder'; order: NewOrder }
  | { type: 'train'; nationId: Id; size: number }
  | { type: 'setPolicy'; nationId: Id; axis: PolicyAxis; tier: string };
