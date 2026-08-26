// Dev 用假世界——介面與真正的 /api/world 回應相同(PublicWorldView + 增量事件),
// 讓整個 UI 在後端 API 尚未實作前也能跑起來看。是否啟用由 useWorld.ts 依環境變數切換。

import type {
  ArmySizeTier,
  FlagSpec,
  GameEvent,
  Nation,
  PublicNation,
  PublicWorldView,
  Policies,
  Treaty,
  TreatyTerms,
} from '@micronation/shared';
import { EVENT } from '@micronation/shared';

const REGIONS: PublicWorldView['regions'] = [
  { id: 'region-1', name: '北境高地', bonuses: { ore: 0.15 } },
  { id: 'region-2', name: '中原平野', bonuses: { food: 0.15 } },
  { id: 'region-3', name: '東方群島', bonuses: { fuel: 0.1, money: 0.05 } },
  { id: 'region-4', name: '西漠礦區', bonuses: { ore: 0.25, food: -0.1 } },
  { id: 'region-5', name: '南方沃土', bonuses: { food: 0.25 } },
  { id: 'region-6', name: '遠洋列嶼', bonuses: { money: 0.15 } },
];

const DEFAULT_POLICIES: Policies = { tax: 'mid', economy: 'commerce', conscription: 'volunteer', openness: 'neutral' };

function flag(layout: string, colors: string[], emblem: string): FlagSpec {
  return { layout, colors, emblem };
}

const NPC_NAMES = ['鐵砧帝國', '翡翠聯邦', '北海公國', '赤炎汗國', '雲頂共和', '深藍艦隊', '黃沙商盟', '松鴉自治領'];

function npcNation(i: number): PublicNation {
  const armyTiers: ArmySizeTier[] = ['small', 'medium', 'large', 'none', 'huge'];
  return {
    id: `npc-${i}`,
    ownerId: null,
    name: NPC_NAMES[i % NPC_NAMES.length],
    flag: flag(i % 2 === 0 ? 'stripes-h-2' : 'quarters', ['#1f4e79', '#0b1d2a', '#c9a227'], 'star-5'),
    regionId: REGIONS[i % REGIONS.length].id,
    score: { economy: 40 + i * 5, warfare: 20 + i * 3, tech: 10 + i, diplomacy: 15, total: 85 + i * 8 },
    reputation: { breaches: i % 3 },
    armySizeTier: armyTiers[i % armyTiers.length],
    protectedUntil: 0,
    policies: DEFAULT_POLICIES,
  };
}

const PLAYER_NATION: PublicNation = {
  id: 'player-1',
  ownerId: 'user-1',
  name: '晨曦共和國',
  flag: flag('border-frame', ['#1f4e79', '#c9a227', '#f2e8c9'], 'star-5'),
  regionId: 'region-3',
  score: { economy: 120, warfare: 45, tech: 60, diplomacy: 20, total: 245 },
  reputation: { breaches: 0 },
  armySizeTier: 'medium',
  protectedUntil: 0,
  policies: DEFAULT_POLICIES,
};

export const MOCK_VIEWER_ID = PLAYER_NATION.id;

/** GET /api/nation 的假回應——與真 Nation 同形狀(含 resources/population/morale 等私密欄位),
 *  供 useNation 的 mock fetcher 使用,和 PLAYER_NATION(PublicNation,放進 world.nations)分開維護。 */
export function mockOwnNation(): Nation {
  return {
    id: PLAYER_NATION.id,
    ownerId: PLAYER_NATION.ownerId,
    name: PLAYER_NATION.name,
    flag: PLAYER_NATION.flag,
    regionId: PLAYER_NATION.regionId,
    resources: { food: 12480, ore: 6102, fuel: 1845, money: 28930 },
    tech: 742,
    actionPoints: 4,
    population: 45210,
    morale: 72,
    buildings: { farm: 3, mine: 2, refinery: 1, market: 1, barracks: 5, warehouse: 3, university: 4, wall: 0 },
    buildQueue: [],
    army: { size: 480 },
    policies: PLAYER_NATION.policies,
    policyChangedAt: {},
    reputation: PLAYER_NATION.reputation,
    protectedUntil: 0,
    score: PLAYER_NATION.score,
    createdAt: 0,
  };
}

/** 造一個含 NPC 的假 PublicWorldView。tick 讓輪詢畫面看得出時間在走。 */
export function buildMockWorld(tick: number): PublicWorldView {
  const nations = [PLAYER_NATION, ...NPC_NAMES.map((_, i) => npcNation(i))];
  return {
    seasonId: 'season-mock-1',
    tick,
    regions: REGIONS,
    nations,
    marches: [
      {
        id: 'march-mock-1',
        attackerId: 'npc-0',
        defenderId: PLAYER_NATION.id,
        departedAt: Math.max(0, tick - 3),
        arrivesAt: tick + 6,
        size: 320,
      },
    ],
    treaties: [
      {
        id: 'treaty-mock-1',
        kind: 'nap',
        aId: PLAYER_NATION.id,
        bId: 'npc-1',
        status: 'proposed',
        terms: { duration: 168 },
        createdAt: Math.max(0, tick - 1),
      },
      {
        id: 'treaty-mock-2',
        kind: 'alliance',
        aId: PLAYER_NATION.id,
        bId: 'npc-4',
        status: 'active',
        terms: { duration: 336, activatedAt: Math.max(0, tick - 40), allianceDefense: true },
        createdAt: Math.max(0, tick - 40),
      },
    ],
    orders: [
      { id: 'order-mock-1', nationId: 'npc-2', kind: 'food', side: 'sell', qty: 400, price: 3, createdAt: tick },
      { id: 'order-mock-2', nationId: 'npc-3', kind: 'ore', side: 'buy', qty: 150, price: 5, createdAt: tick },
    ],
  };
}

/** 造一批假事件,供警報流/事件卡使用。與真事件同型別(GameEvent)。 */
export function buildMockEvents(tick: number): GameEvent[] {
  return [
    { tick, type: EVENT.MARCH_DEPARTED, nationIds: ['npc-0', PLAYER_NATION.id], payload: { arrivesAt: tick + 6 } },
    { tick: Math.max(0, tick - 1), type: EVENT.TREATY_PROPOSED, nationIds: [PLAYER_NATION.id, 'npc-1'], payload: { kind: 'nap' } },
    { tick: Math.max(0, tick - 2), type: EVENT.BUILD_COMPLETED, nationIds: [PLAYER_NATION.id], payload: { building: 'barracks', level: 5 } },
  ];
}

/** GET /api/rankings 的假回應——與真回應同形狀(見 apps/api/src/routes/rankings.ts)。 */
export function mockRankings(world: PublicWorldView): {
  overall: PublicNation[];
  economy: PublicNation[];
  warfare: PublicNation[];
  tech: PublicNation[];
  diplomacy: PublicNation[];
} {
  const topBy = (key: keyof PublicNation['score']) => [...world.nations].sort((a, b) => b.score[key] - a.score[key]).slice(0, 20);
  return {
    overall: topBy('total'),
    economy: topBy('economy'),
    warfare: topBy('warfare'),
    tech: topBy('tech'),
    diplomacy: topBy('diplomacy'),
  };
}

/** POST /api/diplomacy/respond 的假回應——回傳更新後(本地推算)的條約清單,不落地持久化。
 *  action==='counter' 時,counterTerms(例:{duration})併入 terms,模擬後端還價行為。 */
export function mockRespondToTreaty(
  treaties: readonly Treaty[],
  treatyId: string,
  action: 'accept' | 'reject' | 'counter',
  counterTerms?: Partial<TreatyTerms>
): Treaty[] {
  const nextStatus = action === 'accept' ? 'active' : action === 'reject' ? 'rejected' : 'countered';
  return treaties.map((tr) =>
    tr.id === treatyId
      ? { ...tr, status: nextStatus, terms: action === 'counter' && counterTerms ? { ...tr.terms, ...counterTerms } : tr.terms }
      : tr
  );
}
