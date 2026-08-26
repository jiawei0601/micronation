// /api/world 輪詢 hook——每 45s 拉一次世界快照,累積事件供警報流用紅點提示。
// 真 API 尚未實作,預設走 mock(見 buildMockWorld/buildMockEvents);設定
// VITE_USE_MOCK=false 才會呼叫真正的 apiFetch。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameEvent, PublicWorldView } from '@micronation/shared';
import { apiFetch } from './client';
import { MOCK_VIEWER_ID, buildMockEvents, buildMockWorld } from './mock';

export const WORLD_POLL_INTERVAL_MS = 45_000;

const USE_MOCK = (import.meta.env.VITE_USE_MOCK as string | undefined) !== 'false';

export interface WorldFetcher {
  fetchWorld(): Promise<PublicWorldView>;
}

/** 真 API 版本:GET /api/world,回傳 PublicWorldView。 */
const realFetcher: WorldFetcher = {
  fetchWorld: () => apiFetch<PublicWorldView>('/world'),
};

/** mock 版本:tick 隨呼叫次數遞增,模擬世界持續在走。 */
function createMockFetcher(): WorldFetcher {
  let tick = 214;
  return {
    fetchWorld: async () => {
      tick += 1;
      return buildMockWorld(tick);
    },
  };
}

export interface UseWorldOptions {
  intervalMs?: number;
  fetcher?: WorldFetcher;
  /** 事件供給函式,預設走 mock;真 API 版本可改接 /api/world 回應中的 events 欄位。 */
  eventsFor?: (world: PublicWorldView) => GameEvent[];
  /** 是否立即在掛載時拉第一次(測試可關閉以精準控制計時)。預設 true。 */
  immediate?: boolean;
}

export interface UseWorldResult {
  world: PublicWorldView | null;
  events: GameEvent[];
  /** 尚未讀過的事件數(供 UI 紅點)。呼叫 markEventsSeen() 歸零。 */
  unseenCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  markEventsSeen: () => void;
}

export function useWorld(options: UseWorldOptions = {}): UseWorldResult {
  const {
    intervalMs = WORLD_POLL_INTERVAL_MS,
    fetcher = USE_MOCK ? createMockFetcher() : realFetcher,
    eventsFor = (world) => buildMockEvents(world.tick),
    immediate = true,
  } = options;

  const [world, setWorld] = useState<PublicWorldView | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenTick, setSeenTick] = useState(-Infinity);
  const lastEventTickRef = useRef(-Infinity);

  const poll = useCallback(async () => {
    setLoading(true);
    try {
      const nextWorld = await fetcher.fetchWorld();
      setWorld(nextWorld);
      const nextEvents = eventsFor(nextWorld);
      const fresh = nextEvents.filter((e) => e.tick > lastEventTickRef.current);
      if (fresh.length > 0) {
        lastEventTickRef.current = Math.max(...nextEvents.map((e) => e.tick));
        setEvents((prev) => [...prev, ...fresh]);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetcher, eventsFor]);

  useEffect(() => {
    if (immediate) void poll();
    const id = setInterval(() => {
      void poll();
    }, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  const refresh = useCallback(() => {
    void poll();
  }, [poll]);

  const markEventsSeen = useCallback(() => {
    setSeenTick(world?.tick ?? -Infinity);
  }, [world]);

  const unseenCount = events.filter((e) => e.tick > seenTick).length;

  return { world, events, unseenCount, loading, error, refresh, markEventsSeen };
}

export const mockViewerId = MOCK_VIEWER_ID;
