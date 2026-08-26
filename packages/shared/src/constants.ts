// 平衡常數——集中單檔,不得散落到各模塊。數值為 M0 拍板初值,後續依測試調整。

import type { BuildingKind, ResourceKind, TaxTier, EconomyTier, ConscriptionTier, OpennessTier, Tick } from './types';

// ---- 建築:各級產出/成本/升級時間 ----
// cost 為升到「下一級」所需資源;time 為該次升級耗費 tick 數。index 0 = 從 0→1 級。

export interface BuildingLevelSpec {
  cost: Partial<Record<ResourceKind, number>>;
  timeTicks: number;
  output: Partial<Record<ResourceKind, number>>; // 該級每 tick 產出(尚未套用區域/政策加成)
}

export const MAX_BUILDING_LEVEL = 5;

function levelSeries(
  baseCost: Partial<Record<ResourceKind, number>>,
  baseTime: number,
  baseOutput: Partial<Record<ResourceKind, number>>
): BuildingLevelSpec[] {
  return Array.from({ length: MAX_BUILDING_LEVEL }, (_, i) => {
    const mult = i + 1;
    const scale = (r: Partial<Record<ResourceKind, number>>, f: number) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round((v as number) * f)]));
    return {
      cost: scale(baseCost, mult),
      timeTicks: baseTime * mult,
      output: scale(baseOutput, mult),
    };
  });
}

export const BUILDING_LEVELS: Record<BuildingKind, BuildingLevelSpec[]> = {
  farm: levelSeries({ money: 100, ore: 10 }, 4, { food: 20 }),
  mine: levelSeries({ money: 120, food: 10 }, 4, { ore: 18 }),
  refinery: levelSeries({ money: 150, ore: 20 }, 5, { fuel: 12 }),
  market: levelSeries({ money: 100 }, 3, {}),
  barracks: levelSeries({ money: 150, ore: 15 }, 5, {}),
  warehouse: levelSeries({ money: 120 }, 4, {}),
  university: levelSeries({ money: 200, fuel: 10 }, 6, {}),
  wall: levelSeries({ money: 180, ore: 25 }, 6, {}),
};

// ---- 政策:各軸各檔位修正值(乘數,1 = 無修正) ----

export const TAX_MODIFIERS: Record<TaxTier, { moneyMult: number; moraleDelta: number }> = {
  low: { moneyMult: 0.8, moraleDelta: 2 },
  mid: { moneyMult: 1.0, moraleDelta: 0 },
  high: { moneyMult: 1.3, moraleDelta: -3 },
};

export const ECONOMY_MODIFIERS: Record<EconomyTier, Partial<Record<ResourceKind, number>>> = {
  agri: { food: 1.25, ore: 0.9, fuel: 0.9 },
  industry: { ore: 1.25, fuel: 1.15, food: 0.9 },
  commerce: { money: 1.25, food: 0.95, ore: 0.95 },
};

export const CONSCRIPTION_MODIFIERS: Record<ConscriptionTier, { armyGrowthMult: number; moraleDelta: number }> = {
  volunteer: { armyGrowthMult: 0.7, moraleDelta: 1 },
  draft: { armyGrowthMult: 1.5, moraleDelta: -2 },
};

export const OPENNESS_MODIFIERS: Record<OpennessTier, { tariffMult: number; diplomacyScoreMult: number }> = {
  closed: { tariffMult: 1.5, diplomacyScoreMult: 0.8 },
  neutral: { tariffMult: 1.0, diplomacyScoreMult: 1.0 },
  free: { tariffMult: 0.5, diplomacyScoreMult: 1.2 },
};

// 政策變更冷卻(tick)——避免頻繁切換套利
export const POLICY_CHANGE_COOLDOWN: Tick = 24;

// ---- 軍事 ----

export const FARM_RATIO = 0.5; // 國力比低於此值視為「打農」,無收益
export const BATTLE_POWER_RNG_MIN = 0.9;
export const BATTLE_POWER_RNG_MAX = 1.1;
export const BATTLE_LOSS_RATE_MIN = 0.2; // 敗方未受保護資源損失下限
export const BATTLE_LOSS_RATE_MAX = 0.25; // 損失上限(warehouse 保護額度外)
export const MARCH_SPEED = 1; // 距離單位 / tick
export const MARCH_TIME_BASE = 2; // 最短出征耗時(tick),即使距離為 0

// 區域距離表——以區域在 WorldState.regions 陣列中的 index 作鍵,對稱矩陣。
// M0 用簡單網格假設(| i - j |),之後可依實際地圖覆蓋此表或改用座標公式。
export function regionDistanceByIndex(indexA: number, indexB: number): number {
  return Math.abs(indexA - indexB);
}

export function marchTime(distance: number): number {
  return MARCH_TIME_BASE + Math.ceil(distance / MARCH_SPEED);
}

// ---- 市場 ----

export const PRICE_BAND = 0.3; // 撮合價偏離近期均價 ±30% → Err('PRICE_BAND')
export const UNVERIFIED_ORDER_QTY_CAP = 50; // 未驗證帳號單筆掛單上限
export const PROTECTED_ORDER_QTY_CAP = 50; // 保護期內大額掛單上限

// ---- 新手保護 / tick 節奏 ----

export const PROTECTION_TICKS = 168; // 新手保護期(tick),對應 168 小時(一週,每小時一 tick)
export const ACTION_POINTS_PER_TICK = 1;
export const ACTION_POINTS_MAX = 24;
