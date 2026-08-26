import type { WorldState, PublicWorldView, PublicNation, Nation, Id, ArmySizeTier } from './types';

// 兵力概略級距門檻——級距本身不是遊戲平衡常數(不影響任何計算結果,只影響對外顯示的精細度),
// 因此放在 view.ts 而非 constants.ts。
const ARMY_TIER_SMALL_MAX = 50;
const ARMY_TIER_MEDIUM_MAX = 200;
const ARMY_TIER_LARGE_MAX = 500;

export function armySizeTier(size: number): ArmySizeTier {
  if (size <= 0) return 'none';
  if (size < ARMY_TIER_SMALL_MAX) return 'small';
  if (size < ARMY_TIER_MEDIUM_MAX) return 'medium';
  if (size < ARMY_TIER_LARGE_MAX) return 'large';
  return 'huge';
}

function toPublicNation(n: Nation): PublicNation {
  return {
    id: n.id,
    ownerId: n.ownerId,
    name: n.name,
    flag: n.flag,
    regionId: n.regionId,
    score: n.score,
    reputation: n.reputation,
    armySizeTier: armySizeTier(n.army.size),
    protectedUntil: n.protectedUntil,
    policies: n.policies,
  };
}

/**
 * 將完整 WorldState 過濾為 PublicWorldView。純函式。
 * viewerId 保留供未來「對自己顯示更多資訊」等擴充使用;目前輸出對所有 viewer 一致
 * (呼叫端如需自己國家的完整資料,應另外直接讀取 state.nations 中對應項,不透過此函式)。
 */
export function toPublicWorldView(state: WorldState, viewerId: Id | null): PublicWorldView {
  void viewerId;
  return {
    seasonId: state.seasonId,
    tick: state.tick,
    regions: state.regions,
    nations: state.nations.map(toPublicNation),
    marches: state.marches,
    treaties: state.treaties,
    orders: state.orders,
  };
}
