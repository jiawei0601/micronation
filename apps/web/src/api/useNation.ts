// GET /api/nation——已登入者的完整(私密)國家資料。與 useWorld 的 PublicWorldView 不同,
// 這裡含 resources/actionPoints/buildQueue 等只有自己看得到的欄位(見 packages/shared/src/types.ts Nation)。

import { useEffect, useState } from 'react';
import type { Nation } from '@micronation/shared';
import { apiFetch, ApiError } from './client';
import { mockOwnNation } from './mock';
import { USE_MOCK } from './useWorld';

export interface NationFetcher {
  /** 回傳 null 代表尚未建國(真 API 404 NO_NATION,或未登入 401)——不是錯誤,是合法狀態。 */
  fetchNation(signal?: AbortSignal): Promise<Nation | null>;
}

const realNationFetcher: NationFetcher = {
  fetchNation: async (signal) => {
    try {
      const res = await apiFetch<{ nation: Nation }>('/nation', { signal });
      return res.nation;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 401)) return null;
      throw err;
    }
  },
};

function createMockNationFetcher(): NationFetcher {
  return { fetchNation: async () => mockOwnNation() };
}

const defaultNationFetcher: NationFetcher = USE_MOCK ? createMockNationFetcher() : realNationFetcher;

export interface UseNationResult {
  nation: Nation | null;
  loading: boolean;
  error: string | null;
  /** loading 完成後,nation !== null 才算「已建國」;loading 中不可用此欄位下判斷(見 MapShell/PanelLayout)。 */
  hasNation: boolean;
  refresh: () => void;
}

export function useNation(fetcher: NationFetcher = defaultNationFetcher): UseNationResult {
  const [nation, setNation] = useState<Nation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    fetcher
      .fetchNation(controller.signal)
      .then((n) => {
        if (cancelled) return;
        setNation(n);
        setError(null);
      })
      .catch((err) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetcher, reloadSeq]);

  return { nation, loading, error, hasNation: nation !== null, refresh: () => setReloadSeq((s) => s + 1) };
}
