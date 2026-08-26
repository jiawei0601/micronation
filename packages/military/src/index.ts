import type { March, Id, WorldState, Tick } from '@micronation/shared';
import { ok } from '@micronation/shared';
import type { Result } from '@micronation/shared';

// TODO(M1): 實作依 CONTRACT.md §military——檢查保護期/打農(FARM_RATIO)/NAP(呼叫 diplomacy.canAttack)/行動點;
// 抵達後戰鬥由 engine.resolveTick 解算,military 只管合法性與排程。

export function declareAttack(
  _stateView: WorldState,
  _attackerId: Id,
  _defenderId: Id,
  _army: number,
  _tick: Tick
): Result<March> {
  return ok({ id: '', attackerId: _attackerId, defenderId: _defenderId, size: _army, departedAt: _tick, arrivesAt: _tick });
}

export function regionDistance(_a: number, _b: number): number {
  return Math.abs(_a - _b);
}
