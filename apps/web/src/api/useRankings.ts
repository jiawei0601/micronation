// GET /api/rankings——綜合 + 4 分項排行(匿名可讀)。與 useWorld 分開拉,避免每頁都要重算排序。

import { useEffect, useState } from 'react';
import type { PublicNation } from '@micronation/shared';
import { apiFetch } from './client';
import { mockRankings } from './mock';
import { useWorldContext } from './WorldProvider';
import { USE_MOCK } from './useWorld';

export interface RankingsResponse {
  overall: PublicNation[];
  economy: PublicNation[];
  warfare: PublicNation[];
  tech: PublicNation[];
  diplomacy: PublicNation[];
}

const EMPTY: RankingsResponse = { overall: [], economy: [], warfare: [], tech: [], diplomacy: [] };

export interface UseRankingsResult {
  rankings: RankingsResponse;
  loading: boolean;
  error: string | null;
}

/** mock 模式下沒有獨立的排行資料源,直接用目前 world.nations 現算(與真 API rankings.ts 同排序邏輯)。 */
export function useRankings(): UseRankingsResult {
  const { world } = useWorldContext();
  const [rankings, setRankings] = useState<RankingsResponse>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (USE_MOCK) {
      if (world) setRankings(mockRankings(world));
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    apiFetch<RankingsResponse>('/rankings', { signal: controller.signal })
      .then((res) => {
        if (!cancelled) {
          setRankings(res);
          setError(null);
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world?.tick]);

  return { rankings, loading, error };
}
