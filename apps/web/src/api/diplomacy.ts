// POST /api/diplomacy/respond——對條約提案回應(接受/拒絕/還價)。mock 模式不落地持久化,
// 只在呼叫端(TreatyPage)本地推算顯示用的新狀態,並印出 console log 方便 dev 追蹤。

import type { Treaty, TreatyTerms } from '@micronation/shared';
import { apiFetch } from './client';
import { mockRespondToTreaty } from './mock';
import { USE_MOCK } from './useWorld';

// 與 packages/diplomacy/src/index.ts 的 RespondAction 同值——apps/web 目前未依賴該內部套件,
// 故在此就地宣告同義型別,避免新增 workspace 依賴。
export type RespondAction = 'accept' | 'reject' | 'counter';

export interface RespondFn {
  /** counterTerms:action==='counter' 時的還價條款(見 apps/api/src/routes/diplomacy.ts
   *  POST /diplomacy/respond body.counterTerms:Partial<TreatyTerms>)。accept/reject 不需要。 */
  respond(
    treatyId: string,
    action: RespondAction,
    treaties: readonly Treaty[],
    counterTerms?: Partial<TreatyTerms>
  ): Promise<Treaty[]>;
}

const realRespond: RespondFn = {
  respond: async (treatyId, action, _treaties, counterTerms) => {
    const res = await apiFetch<{ treaties: Treaty[] }>('/diplomacy/respond', {
      method: 'POST',
      body: { treatyId, action, counterTerms },
    });
    return res.treaties;
  },
};

const mockRespond: RespondFn = {
  respond: async (treatyId, action, treaties, counterTerms) => {
    // eslint-disable-next-line no-console
    console.log('[mock] POST /api/diplomacy/respond', { treatyId, action, counterTerms });
    return mockRespondToTreaty(treaties, treatyId, action, counterTerms);
  },
};

export const respondFn: RespondFn = USE_MOCK ? mockRespond : realRespond;
