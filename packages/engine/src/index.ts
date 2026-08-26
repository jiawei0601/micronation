import type { WorldState, GameEvent, Nation, Region, March, Treaty } from '@micronation/shared';
import { EVENT, createRng, MAX_BUILDING_LEVEL, ACTION_POINTS_PER_TICK, ACTION_POINTS_MAX } from '@micronation/shared';
import { computeProduction, projectProduction } from './production';
import { applyPopulationTick } from './population';
import { resolveBattle, previewBattle } from './battle';
import type { BattleOutcomeForScore } from './score';
import { computeScore } from './score';

export { projectProduction } from './production';
export { previewBattle } from './battle';

function regionOf(regions: Region[], regionId: string): Region | undefined {
  return regions.find((r) => r.id === regionId);
}

/**
 * 依 CONTRACT.md §engine 唯一入口:
 * 資源產出 → 人口/士氣 → 建設佇列完成 → 行軍推進與抵達戰鬥解算 → 條約到期 → 行動點發放 → 計分。
 * 純函式:同 (state, seed) 必得同輸出;所有隨機皆走 seeded rng。
 */
export function resolveTick(state: WorldState, seed: string): { state: WorldState; events: GameEvent[] } {
  const rng = createRng(seed);
  const tick = state.tick;
  const events: GameEvent[] = [];
  const battlesByNation = new Map<string, BattleOutcomeForScore[]>();

  // 1) 資源產出 + 2) 人口/士氣
  let nations: Nation[] = state.nations.map((nation) => {
    const region = regionOf(state.regions, nation.regionId);
    const produced = computeProduction(nation, region);
    const resourcesAfterProduction = {
      food: nation.resources.food + produced.food,
      ore: nation.resources.ore + produced.ore,
      fuel: nation.resources.fuel + produced.fuel,
      money: nation.resources.money + produced.money,
    };
    const pop = applyPopulationTick(nation, resourcesAfterProduction.food, tick);
    events.push({ tick, type: EVENT.PRODUCTION_TICK, nationIds: [nation.id], payload: { produced } });
    events.push(...pop.events);

    return {
      ...nation,
      resources: { ...resourcesAfterProduction, food: pop.food },
      population: pop.population,
      morale: pop.morale,
    };
  });

  // 3) 建設佇列完成
  nations = nations.map((nation) => {
    if (nation.buildQueue.length === 0) return nation;
    const remaining: Nation['buildQueue'] = [];
    const buildings = { ...nation.buildings };
    for (const item of nation.buildQueue) {
      if (item.completesAt <= tick) {
        buildings[item.building] = Math.min(MAX_BUILDING_LEVEL, buildings[item.building] + 1);
        events.push({
          tick,
          type: EVENT.BUILD_COMPLETED,
          nationIds: [nation.id],
          payload: { building: item.building, level: buildings[item.building] },
        });
      } else {
        remaining.push(item);
      }
    }
    return { ...nation, buildings, buildQueue: remaining };
  });

  // 4) 行軍推進與抵達戰鬥解算
  const nationById = new Map(nations.map((n) => [n.id, n]));
  const remainingMarches: March[] = [];
  for (const march of state.marches) {
    if (march.arrivesAt > tick) {
      remainingMarches.push(march);
      continue;
    }
    const attacker = nationById.get(march.attackerId);
    const defender = nationById.get(march.defenderId);
    events.push({ tick, type: EVENT.MARCH_ARRIVED, nationIds: [march.attackerId, march.defenderId], payload: { marchId: march.id } });
    if (!attacker || !defender) continue; // 資料不一致時安全跳過,不阻斷其他 nation 結算

    const attackerForBattle: Nation = { ...attacker, army: { size: march.size } };
    const result = resolveBattle(attackerForBattle, defender, rng, tick);
    events.push(...result.events);

    // 攻方回國:把行軍出去的兵力戰損結果併回原本國家軍隊(未出征兵力 + 行軍存活兵力)
    const homeArmySize = attacker.army.size - march.size;
    const mergedAttacker: Nation = {
      ...result.attacker,
      army: { size: Math.max(0, homeArmySize) + result.attacker.army.size },
    };

    nationById.set(attacker.id, mergedAttacker);
    nationById.set(defender.id, result.defender);

    const battleForScore = (isAttacker: boolean): BattleOutcomeForScore => ({
      won: isAttacker ? result.attackerWins : !result.attackerWins,
      ownPower: isAttacker ? attackerForBattle.army.size || 1 : defender.army.size || 1,
      opponentPower: isAttacker ? defender.army.size || 1 : attackerForBattle.army.size || 1,
      opponentIsNpc: isAttacker ? defender.ownerId === null : attacker.ownerId === null,
    });
    battlesByNation.set(attacker.id, [...(battlesByNation.get(attacker.id) ?? []), battleForScore(true)]);
    battlesByNation.set(defender.id, [...(battlesByNation.get(defender.id) ?? []), battleForScore(false)]);
  }
  nations = nations.map((n) => nationById.get(n.id) ?? n);

  // 5) 條約到期
  const treaties: Treaty[] = state.treaties.map((treaty) => {
    if (treaty.status !== 'active') return treaty;
    if (treaty.createdAt + treaty.terms.duration > tick) return treaty;
    events.push({ tick, type: EVENT.TREATY_EXPIRED, nationIds: [treaty.aId, treaty.bId], payload: { treatyId: treaty.id } });
    return { ...treaty, status: 'expired' as const };
  });

  // 6) 行動點發放(有上限)
  nations = nations.map((nation) => {
    const next = Math.min(ACTION_POINTS_MAX, nation.actionPoints + ACTION_POINTS_PER_TICK);
    if (next === nation.actionPoints) return nation;
    events.push({ tick, type: EVENT.ACTION_POINTS_GRANTED, nationIds: [nation.id], payload: { delta: next - nation.actionPoints } });
    return { ...nation, actionPoints: next };
  });

  // 7) 計分
  nations = nations.map((nation) => {
    const score = computeScore(nation, treaties, battlesByNation.get(nation.id) ?? []);
    events.push({ tick, type: EVENT.SCORE_UPDATED, nationIds: [nation.id], payload: { score } });
    return { ...nation, score };
  });

  const newState: WorldState = {
    ...state,
    nations,
    marches: remainingMarches,
    treaties,
  };

  return { state: newState, events };
}
