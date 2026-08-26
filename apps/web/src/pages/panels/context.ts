import { useOutletContext } from 'react-router-dom';
import type { PublicNation, PublicWorldView } from '@micronation/shared';

export interface PanelContext {
  world: PublicWorldView | null;
  player: PublicNation | null;
}

export function usePanelContext(): PanelContext {
  return useOutletContext<PanelContext>();
}
