import type { Treaty, Id, GameEvent } from '@micronation/shared';
import { ok } from '@micronation/shared';
import type { Result } from '@micronation/shared';

// TODO(M1): 實作依 CONTRACT.md §diplomacy——純狀態轉移函式。

export function propose(treaties: Treaty[], _aId: Id, _bId: Id): Result<{ treaties: Treaty[]; events: GameEvent[] }> {
  return ok({ treaties, events: [] });
}

export function respond(treaties: Treaty[], _treatyId: Id): Result<{ treaties: Treaty[]; events: GameEvent[] }> {
  return ok({ treaties, events: [] });
}

export function breach(treaties: Treaty[], _treatyId: Id): Result<{ treaties: Treaty[]; events: GameEvent[] }> {
  return ok({ treaties, events: [] });
}

export function expire(treaties: Treaty[], _tick: number): Result<{ treaties: Treaty[]; events: GameEvent[] }> {
  return ok({ treaties, events: [] });
}

export function canAttack(
  _treaties: Treaty[],
  _attackerId: Id,
  _defenderId: Id
): { allowed: boolean; reason?: 'NAP' | 'ALLIANCE' } {
  return { allowed: true };
}

export function breachPenalty(_treaty: Treaty): { compensation: number; reputationDelta: number } {
  return { compensation: 0, reputationDelta: 0 };
}
