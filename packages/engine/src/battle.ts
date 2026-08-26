import type { Nation, GameEvent, Tick, BuildingKind } from '@micronation/shared';
import {
  EVENT,
  createRng,
  rngRange,
  BATTLE_LOSS_RATE_MIN,
  BATTLE_LOSS_RATE_MAX,
  TECH_MOD_PER_LEVEL,
  MORALE_MOD_BASE,
  MORALE_MOD_SCALE,
  WAREHOUSE_PROTECTION_PER_LEVEL,
  FUEL_COST_PER_ARMY,
  ATTACKER_LOSS_RATE_WIN,
  ATTACKER_LOSS_RATE_LOSE,
  MIN_ARMY_AFTER_BATTLE,
} from '@micronation/shared';
import type { Rng } from '@micronation/shared';
import { RESOURCE_KINDS, cloneResources } from './resources';

export function techMod(nation: Nation): number {
  return 1 + nation.tech * TECH_MOD_PER_LEVEL;
}

export function moraleMod(nation: Nation): number {
  return MORALE_MOD_BASE + (nation.morale / 100) * MORALE_MOD_SCALE;
}

/** power = army.size × techMod × moraleMod × rng(0.9~1.1) */
export function computePower(nation: Nation, rngFactor: number): number {
  return nation.army.size * techMod(nation) * moraleMod(nation) * rngFactor;
}

export interface BattlePreview {
  attackerPower: number;
  defenderPower: number;
  attackerWins: boolean;
}

/** 前端預覽用純函式:給 seed 走真隨機,不給則用中位數 1.0(無隨機)估算。 */
export function previewBattle(attacker: Nation, defender: Nation, seed?: string): BattlePreview {
  const rng = seed ? createRng(seed) : undefined;
  const fA = rng ? rngRange(rng, 0.9, 1.1) : 1;
  const fD = rng ? rngRange(rng, 0.9, 1.1) : 1;
  const attackerPower = computePower(attacker, fA);
  const defenderPower = computePower(defender, fD);
  return { attackerPower, defenderPower, attackerWins: attackerPower > defenderPower };
}

function highestDamageableBuilding(nation: Nation): BuildingKind | null {
  let best: BuildingKind | null = null;
  let bestLevel = 0;
  for (const kind of Object.keys(nation.buildings) as BuildingKind[]) {
    const level = nation.buildings[kind];
    if (level > bestLevel) {
      best = kind;
      bestLevel = level;
    }
  }
  return best;
}

export interface BattleResolution {
  attacker: Nation;
  defender: Nation;
  events: GameEvent[];
  attackerWins: boolean;
}

/**
 * 抵達後戰鬥解算(engine 內部,行軍合法性已由 military 在出征時檢查)。
 * 不可滅國:人口不受戰鬥影響;建築只降耐久(等級-1,不消失,level=1 為下限);
 * 攻方兵損與燃料成本必計。
 */
export function resolveBattle(attacker: Nation, defender: Nation, rng: Rng, tick: Tick): BattleResolution {
  const fA = rngRange(rng, 0.9, 1.1);
  const fD = rngRange(rng, 0.9, 1.1);
  const attackerPower = computePower(attacker, fA);
  const defenderPower = computePower(defender, fD);
  const attackerWins = attackerPower > defenderPower;
  const loser = attackerWins ? defender : attacker;
  const winner = attackerWins ? attacker : defender;

  // 敗方資源損失(倉庫保護額度外)
  const lossRate = rngRange(rng, BATTLE_LOSS_RATE_MIN, BATTLE_LOSS_RATE_MAX);
  const loserResources = cloneResources(loser.resources);
  const protectedAmt = (loser.buildings.warehouse ?? 0) * WAREHOUSE_PROTECTION_PER_LEVEL;
  for (const k of RESOURCE_KINDS) {
    const exposed = Math.max(0, loserResources[k] - protectedAmt);
    const lost = Math.round(exposed * lossRate);
    loserResources[k] -= lost;
  }

  // 攻方燃料成本(先套用戰敗損失,若攻方就是敗方)
  const newAttackerResources = cloneResources(attacker === loser ? loserResources : attacker.resources);
  const fuelCost = Math.round(attacker.army.size * FUEL_COST_PER_ARMY);
  newAttackerResources.fuel = Math.max(0, newAttackerResources.fuel - fuelCost);

  const newDefenderResources = cloneResources(defender === loser ? loserResources : defender.resources);

  // 兵損
  const attackerArmyLossRate = attackerWins ? ATTACKER_LOSS_RATE_WIN : ATTACKER_LOSS_RATE_LOSE;
  const defenderArmyLossRate = attackerWins ? ATTACKER_LOSS_RATE_LOSE : ATTACKER_LOSS_RATE_WIN;
  const newAttackerArmy = Math.max(MIN_ARMY_AFTER_BATTLE, Math.round(attacker.army.size * (1 - attackerArmyLossRate)));
  const newDefenderArmy = Math.max(MIN_ARMY_AFTER_BATTLE, Math.round(defender.army.size * (1 - defenderArmyLossRate)));

  // 建築耐久(敗方):等級-1,下限 1,不消失
  const newLoserBuildings = { ...loser.buildings };
  const damagedKind = highestDamageableBuilding(loser);
  let buildingBlocked = false;
  if (damagedKind) {
    if (newLoserBuildings[damagedKind] > 1) {
      newLoserBuildings[damagedKind] = newLoserBuildings[damagedKind] - 1;
    } else {
      buildingBlocked = true; // 已在下限,無法再降
    }
  }

  const newAttacker: Nation = {
    ...attacker,
    resources: newAttackerResources,
    army: { size: newAttackerArmy },
    buildings: attacker === loser ? newLoserBuildings : attacker.buildings,
  };
  const newDefender: Nation = {
    ...defender,
    resources: newDefenderResources,
    army: { size: newDefenderArmy },
    buildings: defender === loser ? newLoserBuildings : defender.buildings,
  };

  const events: GameEvent[] = [
    {
      tick,
      type: EVENT.BATTLE_RESOLVED,
      nationIds: [attacker.id, defender.id],
      payload: {
        attackerId: attacker.id,
        defenderId: defender.id,
        attackerPower,
        defenderPower,
        winnerId: winner.id,
        loserId: loser.id,
        lossRate,
        fuelCost,
        damagedBuilding: damagedKind,
        buildingDamageBlocked: buildingBlocked,
      },
    },
  ];

  return { attacker: newAttacker, defender: newDefender, events, attackerWins };
}
