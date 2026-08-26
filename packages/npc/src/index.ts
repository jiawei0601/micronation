import type { Nation, PublicWorldView, NpcAction } from '@micronation/shared';

// TODO(M1): 實作依 CONTRACT.md §npc——糧食缺→買/蓋農場;盈餘→掛賣單;被打過→練兵;不主動攻擊玩家。

export function decideActions(_nation: Nation, _view: PublicWorldView, _seed: string): NpcAction[] {
  return [];
}
