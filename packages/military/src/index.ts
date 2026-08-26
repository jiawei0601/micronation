import type { March, Id, WorldState, Tick } from '@micronation/shared';
import {
  ok,
  err,
  FARM_RATIO,
  marchTime,
  regionDistanceByIndex,
  ATTACK_ACTION_POINT_COST,
} from '@micronation/shared';
import type { Result } from '@micronation/shared';
import { canAttack } from '@micronation/diplomacy';

// 實作依 CONTRACT.md §military——純合法性檢查 + 行軍排程,零 IO。
// 戰鬥解算不在此,由 engine.resolveTick 於抵達時處理。

function regionIndex(state: WorldState, regionId: Id): number {
  return state.regions.findIndex((r) => r.id === regionId);
}

export function declareAttack(
  stateView: WorldState,
  attackerId: Id,
  defenderId: Id,
  army: number,
  tick: Tick
): Result<March> {
  if (attackerId === defenderId) {
    return err('SELF_ATTACK');
  }

  const attacker = stateView.nations.find((n) => n.id === attackerId);
  const defender = stateView.nations.find((n) => n.id === defenderId);
  if (!attacker) return err('ATTACKER_NOT_FOUND');
  if (!defender) return err('DEFENDER_NOT_FOUND');

  if (defender.protectedUntil > tick) {
    return err('PROTECTED');
  }

  if (army <= 0 || army > attacker.army.size) {
    return err('INSUFFICIENT_ARMY');
  }

  const attackerPower = attacker.score.total;
  if (attackerPower > 0) {
    const powerRatio = defender.score.total / attackerPower;
    if (powerRatio < FARM_RATIO) {
      return err('FARMING');
    }
  }

  const diplomacyCheck = canAttack(stateView.treaties, attackerId, defenderId);
  if (!diplomacyCheck.allowed) {
    return err(diplomacyCheck.reason ?? 'DIPLOMACY_BLOCKED');
  }

  if (attacker.actionPoints < ATTACK_ACTION_POINT_COST) {
    return err('INSUFFICIENT_ACTION_POINTS');
  }

  const aIdx = regionIndex(stateView, attacker.regionId);
  const bIdx = regionIndex(stateView, defender.regionId);
  const distance = regionDistanceByIndex(aIdx, bIdx);
  const arrivesAt = tick + marchTime(distance);

  const march: March = {
    id: `${attackerId}-${defenderId}-${tick}-march`,
    attackerId,
    defenderId,
    size: army,
    departedAt: tick,
    arrivesAt,
  };

  return ok(march);
}

export function regionDistance(a: number, b: number): number {
  return regionDistanceByIndex(a, b);
}

export function recallMarch(
  marches: March[],
  marchId: Id,
  nationId: Id,
  tick: Tick
): Result<{ marches: March[] }> {
  const march = marches.find((m) => m.id === marchId);
  if (!march) return err('NOT_FOUND');
  if (march.attackerId !== nationId) return err('NOT_FOUND');
  if (tick >= march.arrivesAt) return err('ALREADY_ARRIVED');

  return ok({ marches: marches.filter((m) => m.id !== marchId) });
}
