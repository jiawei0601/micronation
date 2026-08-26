import type { Nation, ScoreBreakdown, Treaty } from '@micronation/shared';
import {
  OPENNESS_MODIFIERS,
  FARM_RATIO,
  ECONOMY_SCORE_WEIGHT,
  ECONOMY_SCORE_PER_BUILDING_LEVEL,
  TECH_SCORE_PER_LEVEL,
  DIPLOMACY_SCORE_PER_ACTIVE_TREATY,
  WARFARE_WIN_BASE,
  WARFARE_NPC_MULT,
} from '@micronation/shared';
import { RESOURCE_KINDS } from './resources';

export interface BattleOutcomeForScore {
  won: boolean;
  ownPower: number;
  opponentPower: number;
  opponentIsNpc: boolean;
}

/** 單場戰鬥的戰功增量:勝強敵多(比值越高分越高)、打農(比值 < FARM_RATIO)趨零、NPC 五折。 */
export function warfareGainForBattle(outcome: BattleOutcomeForScore): number {
  if (!outcome.won || outcome.ownPower <= 0) return 0;
  const ratio = Math.max(0, outcome.opponentPower / outcome.ownPower);
  // 勝強敵多:戰功與敵我戰力比成正比。
  // 打農(比值 < FARM_RATIO,對手明顯弱於自己):再乘一次 ratio/FARM_RATIO,使戰功趨零。
  const farmingPenalty = ratio < FARM_RATIO ? ratio / FARM_RATIO : 1;
  let gain = WARFARE_WIN_BASE * ratio * farmingPenalty;
  if (outcome.opponentIsNpc) gain *= WARFARE_NPC_MULT;
  return gain;
}

function economyScore(nation: Nation): number {
  let s = 0;
  for (const k of RESOURCE_KINDS) {
    s += nation.resources[k] * ECONOMY_SCORE_WEIGHT[k];
  }
  for (const level of Object.values(nation.buildings)) {
    s += level * ECONOMY_SCORE_PER_BUILDING_LEVEL;
  }
  return Math.round(s);
}

function techScore(nation: Nation): number {
  return Math.round(nation.tech * TECH_SCORE_PER_LEVEL);
}

function diplomacyScore(nation: Nation, treaties: Treaty[]): number {
  const activeCount = treaties.filter(
    (t) => t.status === 'active' && (t.aId === nation.id || t.bId === nation.id)
  ).length;
  const opennessTier = nation.policies.openness as keyof typeof OPENNESS_MODIFIERS | undefined;
  const mult = opennessTier ? OPENNESS_MODIFIERS[opennessTier].diplomacyScoreMult : 1;
  return Math.round(activeCount * DIPLOMACY_SCORE_PER_ACTIVE_TREATY * mult);
}

/**
 * 重新計算 ScoreBreakdown。economy/tech/diplomacy 是當前狀態快照;
 * warfare 是累積戰功,本 tick 的增量由呼叫端傳入(battlesThisTick)後加總到既有值上。
 */
export function computeScore(nation: Nation, treaties: Treaty[], battlesThisTick: BattleOutcomeForScore[]): ScoreBreakdown {
  const economy = economyScore(nation);
  const tech = techScore(nation);
  const diplomacy = diplomacyScore(nation, treaties);
  const warfareGain = battlesThisTick.reduce((sum, b) => sum + warfareGainForBattle(b), 0);
  const warfare = nation.score.warfare + Math.round(warfareGain);
  return { economy, tech, diplomacy, warfare, total: economy + tech + diplomacy + warfare };
}
