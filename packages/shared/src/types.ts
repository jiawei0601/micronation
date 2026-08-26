// 共用基礎型別——正本。與 docs/CONTRACT.md 不一致時以 CONTRACT.md 為準並回報。

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
  policies: Record<PolicyAxis, string>;
  policyChangedAt: Partial<Record<PolicyAxis, Tick>>;
  reputation: { breaches: number };
  protectedUntil: Tick; // 新手保護
  score: ScoreBreakdown;
  createdAt: Tick;
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

export interface Treaty {
  id: Id;
  kind: TreatyKind;
  aId: Id;
  bId: Id;
  status: TreatyStatus;
  terms: { duration: number; compensation?: number };
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
}

export interface GameEvent {
  tick: Tick;
  type: string; // type 常數表在 shared/events.ts
  nationIds: Id[];
  payload: unknown;
}

// PublicWorldView — 供 npc 與 web 使用的受限視角(不含其他玩家私密欄位時可延伸過濾)
export type PublicWorldView = WorldState;

// NpcAction — 與玩家 API 同語意的指令聯集
export type NpcAction =
  | { type: 'build'; nationId: Id; building: BuildingKind }
  | { type: 'placeOrder'; order: NewOrder }
  | { type: 'train'; nationId: Id; size: number }
  | { type: 'setPolicy'; nationId: Id; axis: PolicyAxis; tier: string };
