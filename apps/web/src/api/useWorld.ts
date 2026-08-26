// /api/world 輪詢 hook——每 45s 拉一次世界快照,累積事件供警報流用紅點提示。
//
// dev 用法:預設走真 API(realFetcher)。要在後端未起/未實作時用假資料開發,
// 在 apps/web/.env(.local) 設 `VITE_USE_MOCK=1` 再啟動 `npm run dev`。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameEvent, PublicWorldView } from '@micronation/shared';
import { apiFetch } from './client';
import { MOCK_VIEWER_ID, buildMockEvents, buildMockWorld } from './mock';

export const WORLD_POLL_INTERVAL_MS = 45_000;

/** 唯獨 VITE_USE_MOCK==='1' 才切到 mock 世界;其餘(含未設定)一律走真 API。 */
export const USE_MOCK = (import.meta.env.VITE_USE_MOCK as string | undefined) === '1';

/** 與真正的 GET /api/world 回應同形狀(見 apps/api/src/routes/world.ts):{view,nextTickAt,events}。 */
export interface WorldResponse {
  view: PublicWorldView;
  nextTickAt: number;
  events: GameEvent[];
}

export interface WorldFetcher {
  /** sinceTick:上一次拿到的 world.tick,對齊真 API 的 `?since=<tick>` 查詢參數
   *  (只回傳 tick 更新且與本國有關的事件)。第一次呼叫不帶,不拿歷史事件。 */
  fetchWorld(opts?: { sinceTick?: number; signal?: AbortSignal }): Promise<WorldResponse>;
}

/** 真 API 版本:GET /api/world[?since=tick],回傳形狀與 mock 版一致。 */
const realFetcher: WorldFetcher = {
  fetchWorld: ({ sinceTick, signal } = {}) =>
    apiFetch<WorldResponse>(`/world${sinceTick !== undefined ? `?since=${sinceTick}` : ''}`, { signal }),
};

/** mock 版本:tick 隨呼叫次數遞增,模擬世界持續在走;events 依 sinceTick 過濾,對齊真 API 的增量語意。 */
function createMockFetcher(): WorldFetcher {
  let tick = 214;
  return {
    fetchWorld: async ({ sinceTick } = {}) => {
      tick += 1;
      const view = buildMockWorld(tick);
      const events = buildMockEvents(tick).filter((e) => sinceTick === undefined || e.tick > sinceTick);
      return { view, nextTickAt: Date.now() + WORLD_POLL_INTERVAL_MS, events };
    },
  };
}

/** 模組常數:整個 app 共用同一個 fetcher 實例(mock 模式下 tick 才會連續遞增),
 *  不在每次 useWorld() 呼叫時重建。 */
const defaultFetcher: WorldFetcher = USE_MOCK ? createMockFetcher() : realFetcher;

export interface IdentifiedEvent extends GameEvent {
  /** GameEvent(packages/shared/src/types.ts)目前沒有 id 欄位;這裡用內容雜湊組出穩定 key,
   *  供本地去重與「已讀游標存最後 event id」使用(不會送回伺服器)。 */
  id: string;
}

export function eventKey(e: GameEvent): string {
  return `${e.tick}:${e.type}:${JSON.stringify(e.nationIds)}:${JSON.stringify(e.payload)}`;
}

export interface UseWorldOptions {
  intervalMs?: number;
  fetcher?: WorldFetcher;
  /** 是否立即在掛載時拉第一次(測試可關閉以精準控制計時)。預設 true。 */
  immediate?: boolean;
}

export interface UseWorldResult {
  world: PublicWorldView | null;
  events: IdentifiedEvent[];
  /** 尚未讀過的事件數(供 UI 紅點)。呼叫 markEventsSeen() 歸零。 */
  unseenCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  markEventsSeen: () => void;
}

export function useWorld(options: UseWorldOptions = {}): UseWorldResult {
  const { intervalMs = WORLD_POLL_INTERVAL_MS, fetcher = defaultFetcher, immediate = true } = options;

  const [world, setWorld] = useState<PublicWorldView | null>(null);
  const [events, setEvents] = useState<IdentifiedEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenEventId, setSeenEventId] = useState<string | null>(null);

  const sinceTickRef = useRef<number | undefined>(undefined);
  const seenKeysRef = useRef<Set<string>>(new Set());
  // 遞增序號 + AbortController:輪詢/refresh() 可能重疊,只有「最後發出的請求」的回應可以生效,
  // 較舊的回應(不論是被 abort 還是單純比較晚 resolve)一律丟棄,避免畫面被過期資料蓋掉。
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const poll = useCallback(async () => {
    const mySeq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const resp = await fetcher.fetchWorld({ sinceTick: sinceTickRef.current, signal: controller.signal });
      if (mySeq !== seqRef.current) return; // 已被更新的請求取代,丟棄這筆舊回應

      sinceTickRef.current = resp.view.tick;
      setWorld(resp.view);

      const fresh = resp.events.map((e) => ({ ...e, id: eventKey(e) })).filter((e) => !seenKeysRef.current.has(e.id));
      if (fresh.length > 0) {
        for (const e of fresh) seenKeysRef.current.add(e.id);
        setEvents((prev) => [...prev, ...fresh]);
      }
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // 被自己 abort,不算錯誤
      if (mySeq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mySeq === seqRef.current) setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    if (immediate) void poll();
    const id = setInterval(() => {
      void poll();
    }, intervalMs);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, poll]);

  const refresh = useCallback(() => {
    void poll();
  }, [poll]);

  const markEventsSeen = useCallback(() => {
    setSeenEventId(events.length > 0 ? events[events.length - 1].id : null);
  }, [events]);

  const unseenCount = useMemo(() => {
    if (!seenEventId) return events.length;
    const idx = events.findIndex((e) => e.id === seenEventId);
    return idx === -1 ? events.length : events.length - 1 - idx;
  }, [events, seenEventId]);

  return { world, events, unseenCount, loading, error, refresh, markEventsSeen };
}

export const mockViewerId = MOCK_VIEWER_ID;
