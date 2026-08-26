import type { Nation, GameEvent, Tick } from '@micronation/shared';
import {
  EVENT,
  FOOD_PER_POP,
  POP_GROWTH_RATE,
  POP_DECLINE_RATE,
  MIN_POPULATION,
  MORALE_SURPLUS_DELTA,
  MORALE_DEFICIT_DELTA,
} from '@micronation/shared';

export interface PopulationResult {
  food: number;
  population: number;
  morale: number;
  events: GameEvent[];
}

/**
 * 糧食盈餘/短缺 → 人口成長/衰退與士氣變動。
 * `foodAfterProduction` = 本 tick 產出加總後的糧食庫存(呼叫端先把 computeProduction 的
 * food 加進 nation.resources.food 再傳進來)。
 */
export function applyPopulationTick(nation: Nation, foodAfterProduction: number, tick: Tick): PopulationResult {
  const upkeep = Math.ceil(nation.population * FOOD_PER_POP);
  const net = foodAfterProduction - upkeep;
  const events: GameEvent[] = [];

  let population = nation.population;
  let morale = nation.morale;
  let food: number;

  if (net >= 0) {
    food = net;
    const growth = Math.floor(nation.population * POP_GROWTH_RATE * (morale / 100));
    if (growth > 0) {
      population = nation.population + growth;
      events.push({ tick, type: EVENT.POPULATION_CHANGE, nationIds: [nation.id], payload: { delta: growth, reason: 'surplus' } });
    }
    if (morale < 100) {
      morale = Math.min(100, morale + MORALE_SURPLUS_DELTA);
      events.push({ tick, type: EVENT.MORALE_CHANGE, nationIds: [nation.id], payload: { delta: MORALE_SURPLUS_DELTA, reason: 'surplus' } });
    }
  } else {
    food = 0; // 糧食庫存不可為負,短缺直接清零
    const decline = Math.ceil(nation.population * POP_DECLINE_RATE);
    population = Math.max(MIN_POPULATION, nation.population - decline);
    if (population !== nation.population) {
      events.push({ tick, type: EVENT.POPULATION_CHANGE, nationIds: [nation.id], payload: { delta: population - nation.population, reason: 'shortage' } });
    }
    morale = Math.max(0, morale + MORALE_DEFICIT_DELTA);
    events.push({ tick, type: EVENT.MORALE_CHANGE, nationIds: [nation.id], payload: { delta: MORALE_DEFICIT_DELTA, reason: 'shortage' } });
  }

  return { food, population, morale, events };
}
