import type { March, Id, WorldState, Tick } from '@micronation/shared';
import {
  ok,
  err,
  makeId,
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
  // stateView.tick 才是唯一可信的當前 tick(純函式輸入,呼叫端不可能竄改 stateView 本身而只改 tick 參數
  // 卻不同步 stateView——但仍可能誤傳不一致的 tick,故顯式校驗、不信任外部傳入值)。
  if (tick !== stateView.tick) {
    return err('TICK_MISMATCH');
  }

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

  // 在途行軍(尚未抵達)占用的兵力不可再次出征;army 必為正的安全整數(拒絕 NaN/小數/Infinity)。
  const inFlight = stateView.marches
    .filter((m) => m.attackerId === attackerId && m.arrivesAt > tick)
    .reduce((sum, m) => sum + m.size, 0);
  const availableArmy = attacker.army.size - inFlight;

  if (!Number.isSafeInteger(army) || army <= 0 || army > availableArmy) {
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
  if (aIdx === -1 || bIdx === -1) {
    return err('REGION_NOT_FOUND');
  }
  const distance = regionDistanceByIndex(aIdx, bIdx);
  const arrivesAt = tick + marchTime(distance);

  // 同 attacker/defender/tick 理論上只會有一筆(受行動點與規則限制),但仍加上序號成分保底,
  // 避免罕見的同 tick 多筆(例如未來規則放寬)撞號——同 market 的 seq 策略。
  const seq = stateView.marches.filter((m) => m.departedAt === tick).length;
  const march: March = {
    id: makeId('march', attackerId, defenderId, tick, seq),
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
