// GET /api/nation——已登入者的完整(私密)國家資料。與 useWorld 的 PublicWorldView 不同,
// 這裡含 resources/actionPoints/buildQueue 等只有自己看得到的欄位(見 packages/shared/src/types.ts Nation)。

import { useEffect, useState } from 'react';
import type { Nation } from '@micronation/shared';
import { apiFetch, ApiError } from './client';
import { mockOwnNation } from './mock';
import { USE_MOCK } from './useWorld';

/** finding #6/#12:三種「沒有 nation」的狀態不可合併成同一個 null——呼叫端要能分開處理:
 *  - unauthenticated(401):應導向 /login,不是「尚未建國」。
 *  - no-nation(404):合法狀態,導向建國流程。
 *  - ok:附帶完整 Nation。網路/伺服器錯誤(非 401/404)一律 throw,由呼叫端的 error 顯示。 */
export type NationFetchResult = { kind: 'ok'; nation: Nation } | { kind: 'unauthenticated' } | { kind: 'no-nation' };

export interface NationFetcher {
  fetchNation(signal?: AbortSignal): Promise<NationFetchResult>;
}

const realNationFetcher: NationFetcher = {
  fetchNation: async (signal) => {
    try {
      const res = await apiFetch<{ nation: Nation }>('/nation', { signal });
      return { kind: 'ok', nation: res.nation };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return { kind: 'unauthenticated' };
      if (err instanceof ApiError && err.status === 404) return { kind: 'no-nation' };
      throw err;
    }
  },
};

function createMockNationFetcher(): NationFetcher {
  return { fetchNation: async () => ({ kind: 'ok', nation: mockOwnNation() }) };
}

const defaultNationFetcher: NationFetcher = USE_MOCK ? createMockNationFetcher() : realNationFetcher;

export type NationStatus = 'loading' | 'unauthenticated' | 'no-nation' | 'error' | 'ready';

export interface UseNationResult {
  nation: Nation | null;
  loading: boolean;
  error: string | null;
  /** loading 完成後,nation !== null 才算「已建國」;loading 中不可用此欄位下判斷(見 MapShell/PanelLayout)。 */
  hasNation: boolean;
  /** 三態(以上)+ loading/ready 的完整狀態——呼叫端依此分流導向 /login、顯示錯誤重試、或未建國 CTA。 */
  status: NationStatus;
  refresh: () => void;
}

export function useNation(fetcher: NationFetcher = defaultNationFetcher): UseNationResult {
  const [nation, setNation] = useState<Nation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<NationStatus>('loading');
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setStatus('loading');
    fetcher
      .fetchNation(controller.signal)
      .then((res) => {
        if (cancelled) return;
        if (res.kind === 'ok') {
          setNation(res.nation);
          setStatus('ready');
        } else {
          setNation(null);
          setStatus(res.kind);
        }
        setError(null);
      })
      .catch((err) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setNation(null);
        setStatus('error');
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

  return { nation, loading, error, hasNation: status === 'ready', status, refresh: () => setReloadSeq((s) => s + 1) };
}
