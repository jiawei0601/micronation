import type {
  WorldState,
  PublicWorldView,
  PublicNation,
  PublicMarch,
  Nation,
  Region,
  Treaty,
  MarketOrder,
  March,
  Id,
  ArmySizeTier,
} from './types';

// 兵力概略級距門檻——級距本身不是遊戲平衡常數(不影響任何計算結果,只影響對外顯示的精細度),
// 因此放在 view.ts 而非 constants.ts。
const ARMY_TIER_SMALL_MAX = 50;
const ARMY_TIER_MEDIUM_MAX = 200;
const ARMY_TIER_LARGE_MAX = 500;

/**
 * size 必為非負安全整數,否則(NaN/Infinity/負數/小數等損壞資料)一律回傳 'none',
 * 不落入任何比較分支意外算出 'huge' 這種語意錯誤的結果(finding #16)。
 */
export function armySizeTier(size: number): ArmySizeTier {
  if (!Number.isSafeInteger(size) || size <= 0) return 'none';
  if (size < ARMY_TIER_SMALL_MAX) return 'small';
  if (size < ARMY_TIER_MEDIUM_MAX) return 'medium';
  if (size < ARMY_TIER_LARGE_MAX) return 'large';
  return 'huge';
}

// ---- 深拷貝投影(finding #14):PublicWorldView 的每一層可變結構都必須是全新物件,
// 呼叫端(例如 web 前端)拿到 view 後改動它,絕不能反過來污染純函式輸入的原始 WorldState。

function toPublicNation(n: Nation): PublicNation {
  return {
    id: n.id,
    ownerId: n.ownerId,
    name: n.name,
    flag: { layout: n.flag.layout, colors: [...n.flag.colors], emblem: n.flag.emblem },
    regionId: n.regionId,
    score: { ...n.score },
    reputation: { ...n.reputation },
    armySizeTier: armySizeTier(n.army.size),
    protectedUntil: n.protectedUntil,
    policies: { ...n.policies },
  };
}

function toPublicRegion(r: Region): Region {
  return { id: r.id, name: r.name, bonuses: { ...r.bonuses } };
}

function toPublicTreaty(t: Treaty): Treaty {
  return { ...t, terms: { ...t.terms } };
}

function toPublicOrder(o: MarketOrder): MarketOrder {
  return { ...o };
}

/**
 * March 投影(finding #15):精確 size 只給出征雙方(viewer 為 attackerId 或 defenderId)看,
 * 其餘 viewer 只拿到概略級距 sizeTier,不洩漏他國精確兵力。
 */
function toPublicMarch(m: March, viewerId: Id | null): PublicMarch {
  const base = { id: m.id, attackerId: m.attackerId, defenderId: m.defenderId, departedAt: m.departedAt, arrivesAt: m.arrivesAt };
  const isParty = viewerId !== null && (viewerId === m.attackerId || viewerId === m.defenderId);
  if (isParty) {
    return { ...base, size: m.size };
  }
  return { ...base, sizeTier: armySizeTier(m.size) };
}

/**
 * 將完整 WorldState 過濾為 PublicWorldView。純函式,且每一層輸出都是深拷貝——不與輸入
 * WorldState 共享任何可變參照(finding #14)。
 * viewerId 用於 March 的 size/sizeTier 投影(finding #15);null 代表匿名/無身分 viewer,
 * 一律拿不到任何 march 的精確 size。
 */
export function toPublicWorldView(state: WorldState, viewerId: Id | null): PublicWorldView {
  return {
    seasonId: state.seasonId,
    tick: state.tick,
    regions: state.regions.map(toPublicRegion),
    nations: state.nations.map(toPublicNation),
    marches: state.marches.map((m) => toPublicMarch(m, viewerId)),
    treaties: state.treaties.map(toPublicTreaty),
    orders: state.orders.map(toPublicOrder),
  };
}
