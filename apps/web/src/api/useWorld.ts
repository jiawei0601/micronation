// /api/world 輪詢 hook——每 45s 拉一次世界快照,累積事件供警報流用紅點提示。
//
// dev 用法:預設走真 API(realFetcher)。要在後端未起/未實作時用假資料開發,
// 在 apps/web/.env(.local) 設 `VITE_USE_MOCK=1` 再啟動 `npm run dev`。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameEvent, PublicWorldView } from '@micronation/shared';
import { apiFetch } from './client';
import { MOCK_VIEWER_ID, buildMockEvents, buildMockWorld } from './mock';

export const WORLD_POLL_INTERVAL_MS = 45_000;

/** 事件列表上限——超過時淘汰最舊的事件,連帶清掉 seenSeqs 記錄,避免無界成長(finding #3)。 */
export const EVENTS_CAP = 200;

/** 唯獨 VITE_USE_MOCK==='1' 才切到 mock 世界;其餘(含未設定)一律走真 API。 */
export const USE_MOCK = (import.meta.env.VITE_USE_MOCK as string | undefined) === '1';

/** 事件帶後端 events 表 rowid 當唯一序號(見 apps/api/src/db/repository.ts getEventsSince)。 */
export interface EventWithSeq extends GameEvent {
  seq: number;
}

/** 與真正的 GET /api/world 回應同形狀(見 apps/api/src/routes/world.ts):
 *  {view,nextTickAt,events,nextCursor}。nextCursor 是下次 `?since=` 該帶的值——
 *  有拿到新事件時是最後一筆的 seq,沒有新事件時維持呼叫端原本帶的 since(不倒退);
 *  未登入/未建國/沒帶 since 時一律是 null。 */
export interface WorldResponse {
  view: PublicWorldView;
  nextTickAt: number;
  events: EventWithSeq[];
  nextCursor: number | null;
}

export interface WorldFetcher {
  /** sinceSeq:上一次拿到的事件游標(events.seq,不是 tick),對齊真 API 的 `?since=<seq>`
   *  查詢參數——只回傳 seq 更新且與本國有關的事件。首次輪詢帶 0。 */
  fetchWorld(opts?: { sinceSeq?: number; signal?: AbortSignal }): Promise<WorldResponse>;
}

/** 真 API 版本:GET /api/world?since=seq,回傳形狀與 mock 版一致。 */
const realFetcher: WorldFetcher = {
  fetchWorld: ({ sinceSeq = 0, signal } = {}) => apiFetch<WorldResponse>(`/world?since=${sinceSeq}`, { signal }),
};

/** mock 版本:tick 隨呼叫次數遞增,模擬世界持續在走;events 帶遞增 seq,依 sinceSeq 過濾,
 *  對齊真 API 的增量語意(seq 為單調遞增的全域序號,不是 tick)。 */
function createMockFetcher(): WorldFetcher {
  let tick = 214;
  let seqCounter = 0;
  return {
    fetchWorld: async ({ sinceSeq = 0 } = {}) => {
      tick += 1;
      const view = buildMockWorld(tick);
      const events: EventWithSeq[] = buildMockEvents(tick).map((e) => ({ ...e, seq: ++seqCounter }));
      const fresh = events.filter((e) => e.seq > sinceSeq);
      const nextCursor = fresh.length > 0 ? fresh[fresh.length - 1].seq : sinceSeq;
      return { view, nextTickAt: Date.now() + WORLD_POLL_INTERVAL_MS, events: fresh, nextCursor };
    },
  };
}

/** 模組常數:整個 app 共用同一個 fetcher 實例(mock 模式下 tick/seq 才會連續遞增),
 *  不在每次 useWorld() 呼叫時重建。 */
const defaultFetcher: WorldFetcher = USE_MOCK ? createMockFetcher() : realFetcher;

export interface IdentifiedEvent extends EventWithSeq {
  /** 字串化的 seq,供 React key 與 markEventsSeen 已讀游標使用。 */
  id: string;
}

export interface UseWorldOptions {
  intervalMs?: number;
  fetcher?: WorldFetcher;
  /** 是否立即在掛載時拉第一次(測試可關閉以精準控制計時)。預設 true。 */
  immediate?: boolean;
  /** 身分 key(例如 useNation() 的 nation id,或登入狀態字串)——變化時自動呼叫 resetWorld()
   *  並重新拉取,防止換帳號後沿用前一個身分累積的 events/游標(跨帳號事件外洩)。首次掛載
   *  不視為「變化」,不會多打一次。未提供時不啟用自動偵測,由呼叫端自行在登入/登出/建國成功
   *  時手動呼叫 resetWorld()。 */
  identityKey?: string | null;
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
  /** 清空累積的 world/events/游標/已讀記錄,回到初始狀態(含 loading——見下方 Codex 四審⑫
   *  註解)。用於登出等「不需要立刻重拉」的身分切換時機,避免沿用前一個身分的事件
   *  (finding:跨帳號事件外洩)。 */
  resetWorld: () => void;
  /** Codex 四審⑫:resetWorld() 之後緊接著立刻 poll() 一次——用於登入成功、建國成功這類
   *  「身分切換後應立刻顯示新身分世界狀態」的時機,不用等下一次輪詢間隔(最長 45s)。
   *  登出不該用這個(登出後通常導頁離開,沒有下一個身分需要立刻拉),純用 resetWorld()。 */
  resetAndRefresh: () => void;
}

export function useWorld(options: UseWorldOptions = {}): UseWorldResult {
  const { intervalMs = WORLD_POLL_INTERVAL_MS, fetcher = defaultFetcher, immediate = true, identityKey } = options;

  const [world, setWorld] = useState<PublicWorldView | null>(null);
  const [events, setEvents] = useState<IdentifiedEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenEventId, setSeenEventId] = useState<string | null>(null);

  // 事件游標:對齊後端 events.seq(見 WorldResponse.nextCursor 註解),不是 tick。
  const sinceSeqRef = useRef<number>(0);
  const seenSeqsRef = useRef<Set<number>>(new Set());
  // 遞增序號 + AbortController:輪詢/refresh() 可能重疊,只有「最後發出的請求」的回應可以生效,
  // 較舊的回應(不論是被 abort 還是單純比較晚 resolve)一律丟棄,避免畫面被過期資料蓋掉。
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // finding #5:掛載期間發出、卸載後才 resolve 的請求不可再 setState(避免 React 警告/記憶體洩漏)。
  const unmountedRef = useRef(false);

  const poll = useCallback(async () => {
    const mySeq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const resp = await fetcher.fetchWorld({ sinceSeq: sinceSeqRef.current, signal: controller.signal });
      if (unmountedRef.current || mySeq !== seqRef.current) return; // 已卸載,或已被更新的請求取代,丟棄這筆回應

      if (resp.nextCursor !== null) sinceSeqRef.current = resp.nextCursor;
      setWorld(resp.view);

      const fresh = resp.events
        .filter((e) => !seenSeqsRef.current.has(e.seq))
        .map((e) => ({ ...e, id: String(e.seq) }));
      if (fresh.length > 0) {
        for (const e of fresh) seenSeqsRef.current.add(e.seq);
        setEvents((prev) => {
          const next = [...prev, ...fresh];
          const overflow = next.length - EVENTS_CAP;
          if (overflow > 0) {
            const evicted = next.splice(0, overflow);
            for (const e of evicted) seenSeqsRef.current.delete(e.seq);
          }
          return next;
        });
      }
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // 被自己 abort,不算錯誤
      if (unmountedRef.current || mySeq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!unmountedRef.current && mySeq === seqRef.current) setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    unmountedRef.current = false;
    if (immediate) void poll();
    const id = setInterval(() => {
      void poll();
    }, intervalMs);
    return () => {
      unmountedRef.current = true;
      clearInterval(id);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, poll]);

  const refresh = useCallback(() => {
    void poll();
  }, [poll]);

  const resetWorld = useCallback(() => {
    // 讓任何仍在飛行中的舊請求(前一個身分發出的)回來後被丟棄,不會覆蓋重置後的狀態。
    seqRef.current += 1;
    abortRef.current?.abort();
    sinceSeqRef.current = 0;
    seenSeqsRef.current = new Set();
    setWorld(null);
    setEvents([]);
    setError(null);
    setSeenEventId(null);
    // Codex 四審⑫:一併清 loading——resetWorld 呼叫時若剛好有一個 poll() 還在飛行中,上面的
    // `seqRef.current += 1` 讓那個 poll() 的 finally 判斷 `mySeq === seqRef.current` 不成立,
    // 不會執行 setLoading(false),loading 就此卡在 true、永遠不會自然清除(除非剛好有下一輪
    // setInterval 的 poll() 覆蓋過去)——resetWorld 本身就代表「不再關心那個舊請求的結果」,
    // 理應把 loading 一併歸零,不留下這個卡住的視覺狀態。
    setLoading(false);
  }, []);

  // Codex 四審⑫:resetWorld() + 立即 poll() 一次——供登入/建國成功時使用(見 UseWorldResult
  // 型別註解)。
  const resetAndRefresh = useCallback(() => {
    resetWorld();
    void poll();
  }, [resetWorld, poll]);

  // identityKey 變化(例如換帳號登入、登出、建國成功後拿到新 nation id)時自動重置——
  // 不會在首次掛載時觸發(prevIdentityKeyRef 初始值就是當下的 identityKey)。
  const prevIdentityKeyRef = useRef<string | null | undefined>(identityKey);
  useEffect(() => {
    if (prevIdentityKeyRef.current === identityKey) return;
    prevIdentityKeyRef.current = identityKey;
    resetWorld();
    void poll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  const markEventsSeen = useCallback(() => {
    setSeenEventId(events.length > 0 ? events[events.length - 1].id : null);
  }, [events]);

  const unseenCount = useMemo(() => {
    if (!seenEventId) return events.length;
    const idx = events.findIndex((e) => e.id === seenEventId);
    return idx === -1 ? events.length : events.length - 1 - idx;
  }, [events, seenEventId]);

  return { world, events, unseenCount, loading, error, refresh, markEventsSeen, resetWorld, resetAndRefresh };
}

export const mockViewerId = MOCK_VIEWER_ID;
