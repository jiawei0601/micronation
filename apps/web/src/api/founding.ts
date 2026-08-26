// POST /api/nation——開國。mock 模式不落地(mock 世界本來就已經有一個固定玩家國家),只 console log。

import type { FlagSpec, Nation } from '@micronation/shared';
import { apiFetch } from './client';
import { USE_MOCK } from './useWorld';

export interface FoundNationInput {
  name: string;
  flag: FlagSpec;
  regionId: string;
}

export interface FoundFn {
  found(input: FoundNationInput): Promise<void>;
}

const realFound: FoundFn = {
  found: async (input) => {
    await apiFetch<{ nation: Nation }>('/nation', { method: 'POST', body: input });
  },
};

const mockFound: FoundFn = {
  found: async (input) => {
    // eslint-disable-next-line no-console
    console.log('[mock] POST /api/nation', input);
  },
};

export const foundFn: FoundFn = USE_MOCK ? mockFound : realFound;
