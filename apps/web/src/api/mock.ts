// Dev 用假世界——介面與真正的 /api/world 回應相同(PublicWorldView + 增量事件),
// 讓整個 UI 在後端 API 尚未實作前也能跑起來看。是否啟用由 useWorld.ts 依環境變數切換。

import type {
  ArmySizeTier,
  FlagSpec,
  GameEvent,
  PublicNation,
  PublicWorldView,
  Policies,
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
