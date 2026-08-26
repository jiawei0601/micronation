import { useOutletContext } from 'react-router-dom';
import type { Nation, PublicNation, PublicWorldView } from '@micronation/shared';

export interface PanelContext {
  world: PublicWorldView | null;
  /** 自己國家的公開投影(來自 world.nations,armySizeTier 等公開欄位)。 */
  player: PublicNation | null;
  /** 自己國家的完整私密資料(resources/actionPoints 等,來自 GET /api/nation)。 */
  nation: Nation | null;
}

export function usePanelContext(): PanelContext {
  return useOutletContext<PanelContext>();
}
