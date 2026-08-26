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

export interface DeclareAttackResult {
  march: March;
  /** 呼叫端下次呼叫 declareAttack 時應存回 stateView.nextMarchSeq 的新值(finding #4/#8)。 */
  nextMarchSeq: number;
}

export function declareAttack(
  stateView: WorldState,
  attackerId: Id,
  defenderId: Id,
  army: number,
  tick: Tick
): Result<DeclareAttackResult> {
  // stateView.tick 才是唯一可信的當前 tick(純函式輸入,呼叫端不可能竄改 stateView 本身而只改 tick 參數
  // 卻不同步 stateView——但仍可能誤傳不一致的 tick,故顯式校驗、不信任外部傳入值)。
  // stateView.tick 本身也須是非負安全整數(finding #7)——corrupted tick 不該被當成合法值放行。
  if (!Number.isSafeInteger(stateView.tick) || stateView.tick < 0) {
    return err('INVALID_TICK');
  }
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
  if (!Number.isSafeInteger(arrivesAt) || arrivesAt < 0) {
    return err('INVALID_ARRIVAL');
  }

  // march id 序號一律吃呼叫端維護的 stateView.nextMarchSeq(單調遞增),不可用
  // marches.filter(...).length 之類「現存筆數」推算——那會在行軍抵達/撤回後被重複使用,
  // 和歷史(已從 marches 移除但仍存在 D1/事件紀錄裡)的 March id 撞號(finding #4/#8)。
  if (!Number.isSafeInteger(stateView.nextMarchSeq) || stateView.nextMarchSeq < 0) {
    return err('INVALID_MARCH_SEQ');
  }
  const seq = stateView.nextMarchSeq;
  // seq+1 本身也須落在安全整數範圍內(三審 finding #4)——seq === MAX_SAFE_INTEGER 時
  // seq+1 會溢位成不精確值,回傳的 nextMarchSeq 存回 WorldState 後會產生垃圾序號,
  // 之後所有 march id 都可能撞號。先算好再驗證,不安全就直接拒絕本次宣戰。
  const nextSeq = seq + 1;
  if (!Number.isSafeInteger(nextSeq)) {
    return err('INVALID_MARCH_SEQ');
  }
  const march: March = {
    id: makeId('march', attackerId, defenderId, tick, seq),
    attackerId,
    defenderId,
    size: army,
    departedAt: tick,
    arrivesAt,
  };

  return ok({ march, nextMarchSeq: nextSeq });
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
