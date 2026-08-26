import type { WorldState, GameEvent } from '@micronation/shared';

// TODO(M1): 實作 resolveTick 依 CONTRACT.md §engine——
// 資源產出 → 人口/士氣 → 建設佇列完成 → 行軍推進與抵達戰鬥解算 → 條約到期 → 行動點發放 → 計分。
export function resolveTick(state: WorldState, _seed: string): { state: WorldState; events: GameEvent[] } {
  return { state, events: [] };
}

// TODO(M1): 前端預覽用純函式
export function projectProduction(): void {
  throw new Error('not implemented');
}

export function previewBattle(): void {
  throw new Error('not implemented');
}
