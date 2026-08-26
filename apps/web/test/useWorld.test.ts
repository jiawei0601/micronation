import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWorld, WORLD_POLL_INTERVAL_MS, EVENTS_CAP, type WorldFetcher, type WorldResponse, type EventWithSeq } from '../src/api/useWorld';
import type { PublicWorldView } from '@micronation/shared';

function fakeWorld(tick: number): PublicWorldView {
  return { seasonId: 's1', tick, regions: [], nations: [], marches: [], treaties: [], orders: [] };
}

function fakeEvent(seq: number, tick = seq): EventWithSeq {
  return { tick, type: 'production_tick', nationIds: [], payload: null, seq };
}

// fake timers 搭配 async 輪詢:用 vi.advanceTimersByTimeAsync 讓計時器推進的同時,也把
// 期間產生的微任務(fetchWorld 的 Promise 鏈)一併沖掉,取代 @testing-library/waitFor
// (waitFor 內部靠真實 setTimeout 輪詢,fake timers 下不會自動前進)。
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useWorld — 輪詢邏輯', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches immediately on mount', async () => {
    let calls = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(
        async (): Promise<WorldResponse> => ({ view: fakeWorld(++calls), nextTickAt: 0, events: [], nextCursor: null })
      ),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));

    await flushMicrotasks();

    expect(fetcher.fetchWorld).toHaveBeenCalledTimes(1);
    expect(result.current.world?.tick).toBe(1);
  });

  it('polls again after the interval elapses, not before', async () => {
    let calls = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(
        async (): Promise<WorldResponse> => ({ view: fakeWorld(++calls), nextTickAt: 0, events: [], nextCursor: null })
      ),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS - 1000);
    });
    expect(fetcher.fetchWorld).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher.fetchWorld).toHaveBeenCalledTimes(2);
    expect(result.current.world?.tick).toBe(2);
  });

  it('advances the since cursor forward using nextCursor from each response', async () => {
    const sinceSeqSeen: (number | undefined)[] = [];
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async ({ sinceSeq } = {}): Promise<WorldResponse> => {
        sinceSeqSeen.push(sinceSeq);
        // 第一次回 nextCursor=5,第二次(帶 since=5)沒有新事件,nextCursor 維持呼叫端的 since(不倒退)。
        const nextCursor = sinceSeqSeen.length === 1 ? 5 : (sinceSeq ?? 0);
        return { view: fakeWorld(1), nextTickAt: 0, events: [], nextCursor };
      }),
    };
    renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();
    expect(sinceSeqSeen[0]).toBe(0); // 首次輪詢帶 0

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS);
    });
    expect(sinceSeqSeen[1]).toBe(5); // 游標已前進到上次的 nextCursor

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS);
    });
    expect(sinceSeqSeen[2]).toBe(5); // 沒有新事件時不倒退
  });

  it('keeps the cursor at 0 when nextCursor is null (e.g. unauthenticated)', async () => {
    const sinceSeqSeen: (number | undefined)[] = [];
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async ({ sinceSeq } = {}): Promise<WorldResponse> => {
        sinceSeqSeen.push(sinceSeq);
        return { view: fakeWorld(1), nextTickAt: 0, events: [], nextCursor: null };
      }),
    };
    renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS);
    });
    expect(sinceSeqSeen).toEqual([0, 0]);
  });

  it('accumulates events returned by the fetcher and assigns each a stable id from seq', async () => {
    let tick = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async (): Promise<WorldResponse> => {
        tick += 1;
        const ev = fakeEvent(tick);
        return { view: fakeWorld(tick), nextTickAt: 0, events: [ev], nextCursor: ev.seq };
      }),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();
    expect(result.current.events.length).toBe(1);
    expect(result.current.events[0].id).toBe('1');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS);
    });
    expect(result.current.events.length).toBe(2);
  });

  it('dedupes events with the same seq across polls instead of re-appending them', async () => {
    const repeated = fakeEvent(5);
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(
        async (): Promise<WorldResponse> => ({ view: fakeWorld(5), nextTickAt: 0, events: [repeated], nextCursor: 5 })
      ),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();
    expect(result.current.events.length).toBe(1);

    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.events.length).toBe(1);
  });

  it('caps accumulated events at EVENTS_CAP, evicting the oldest first', async () => {
    let tick = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async (): Promise<WorldResponse> => {
        tick += 1;
        const ev = fakeEvent(tick);
        return { view: fakeWorld(tick), nextTickAt: 0, events: [ev], nextCursor: ev.seq };
      }),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();

    for (let i = 0; i < EVENTS_CAP + 10; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS);
      });
    }

    expect(result.current.events.length).toBe(EVENTS_CAP);
    // 總共產生 EVENTS_CAP+11 筆(掛載時 1 筆 + 之後 EVENTS_CAP+10 次輪詢各 1 筆),
    // 最舊的事件(seq=1)應已被淘汰,只留最近 EVENTS_CAP 筆(seq 12 起)。
    expect(result.current.events[0].id).toBe(String(EVENTS_CAP + 11 - EVENTS_CAP + 1));
    expect(result.current.events.find((e) => e.id === '1')).toBeUndefined();
  });

  it('does not re-append an evicted (already-seen) seq if the backend somehow resends it', async () => {
    let tick = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async (): Promise<WorldResponse> => {
        tick += 1;
        const ev = fakeEvent(tick);
        return { view: fakeWorld(tick), nextTickAt: 0, events: [ev], nextCursor: ev.seq };
      }),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();
    for (let i = 0; i < EVENTS_CAP + 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS);
      });
    }
    const lengthBefore = result.current.events.length;
    expect(lengthBefore).toBe(EVENTS_CAP);
    expect(result.current.events.length).toBe(EVENTS_CAP);
  });

  it('markEventsSeen clears unseenCount down to zero, new events after that count again', async () => {
    let tick = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async (): Promise<WorldResponse> => {
        tick += 1;
        const ev = fakeEvent(tick);
        return { view: fakeWorld(tick), nextTickAt: 0, events: [ev], nextCursor: ev.seq };
      }),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();
    expect(result.current.unseenCount).toBe(1);

    act(() => result.current.markEventsSeen());
    expect(result.current.unseenCount).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS);
    });
    expect(result.current.unseenCount).toBe(1);
  });

  it('sets error message when fetchWorld rejects, without throwing', async () => {
    const fetcher: WorldFetcher = { fetchWorld: vi.fn(async () => Promise.reject(new Error('network down'))) };
    const { result } = renderHook(() => useWorld({ fetcher }));

    await flushMicrotasks();

    expect(result.current.error).toBe('network down');
    expect(result.current.world).toBeNull();
  });

  it('refresh() triggers an immediate extra fetch', async () => {
    let calls = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(
        async (): Promise<WorldResponse> => ({ view: fakeWorld(++calls), nextTickAt: 0, events: [], nextCursor: null })
      ),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();
    expect(fetcher.fetchWorld).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher.fetchWorld).toHaveBeenCalledTimes(2);
  });

  it('discards a stale response that resolves after a newer request has already landed (race condition)', async () => {
    // 第一次 fetch 故意慢(晚 resolve),第二次(refresh 觸發)快。結果應以「後發出」的第二次為準,
    // 不能被「先發出但晚到」的第一次蓋掉。
    let call = 0;
    const resolvers: Array<(r: WorldResponse) => void> = [];
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(
        () =>
          new Promise<WorldResponse>((resolve) => {
            call += 1;
            resolvers.push((r) => resolve(r));
          })
      ),
    };
    const { result } = renderHook(() => useWorld({ fetcher, immediate: true }));
    await flushMicrotasks(); // 第一次 fetch 已發出,尚未 resolve

    act(() => {
      result.current.refresh(); // 第二次 fetch 發出(更新的請求)
    });
    await flushMicrotasks();
    expect(call).toBe(2);

    // 後發出的第二次先 resolve
    await act(async () => {
      resolvers[1]({ view: fakeWorld(99), nextTickAt: 0, events: [], nextCursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.world?.tick).toBe(99);

    // 先發出但慢的第一次才 resolve,應被丟棄,不覆蓋畫面上的 tick 99
    await act(async () => {
      resolvers[0]({ view: fakeWorld(1), nextTickAt: 0, events: [], nextCursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.world?.tick).toBe(99);
  });

  it('resetWorld() clears events/world/error and rewinds the since cursor to 0', async () => {
    const sinceSeqSeen: (number | undefined)[] = [];
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async ({ sinceSeq } = {}): Promise<WorldResponse> => {
        sinceSeqSeen.push(sinceSeq);
        const ev = fakeEvent(sinceSeqSeen.length);
        return { view: fakeWorld(sinceSeqSeen.length), nextTickAt: 0, events: [ev], nextCursor: ev.seq };
      }),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();
    expect(result.current.world).not.toBeNull();
    expect(result.current.events.length).toBe(1);
    expect(sinceSeqSeen[0]).toBe(0);

    act(() => result.current.resetWorld());

    expect(result.current.world).toBeNull();
    expect(result.current.events.length).toBe(0);
    expect(result.current.error).toBeNull();

    // 下一次輪詢應重新從 since=0 拉,不沿用重置前的游標(finding:跨帳號事件外洩)。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS);
    });
    expect(sinceSeqSeen.at(-1)).toBe(0);
  });

  it('resetWorld() clears loading even when called while a poll is still in-flight (Codex 四審⑫)', async () => {
    // 修復前:resetWorld() 只 bump seqRef、不清 loading——若呼叫當下正好有一個 poll() 還在飛行中
    // (loading=true),那個 poll() 的 finally 判斷 mySeq !== seqRef.current 而跳過
    // setLoading(false),loading 永遠卡在 true。
    let resolveFn: ((r: WorldResponse) => void) | null = null;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(
        () =>
          new Promise<WorldResponse>((resolve) => {
            resolveFn = resolve;
          })
      ),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();
    expect(result.current.loading).toBe(true); // 第一次 poll 還沒 resolve

    act(() => result.current.resetWorld());
    expect(result.current.loading).toBe(false); // 修復後:resetWorld 立刻清 loading

    // 稍後那個被丟棄的舊 poll 真的 resolve 了,也不該讓 loading 又跳回奇怪的狀態。
    await act(async () => {
      resolveFn?.({ view: fakeWorld(1), nextTickAt: 0, events: [], nextCursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
  });

  it('resetAndRefresh() resets then immediately triggers a new fetch (Codex 四審⑫)', async () => {
    let calls = 0;
    const sinceSeqSeen: (number | undefined)[] = [];
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async ({ sinceSeq } = {}): Promise<WorldResponse> => {
        calls += 1;
        sinceSeqSeen.push(sinceSeq);
        const ev = fakeEvent(calls);
        return { view: fakeWorld(calls), nextTickAt: 0, events: [ev], nextCursor: ev.seq };
      }),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(result.current.events.length).toBe(1);

    await act(async () => {
      result.current.resetAndRefresh();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 立刻多打了一次(不用等下一輪 45s 間隔),且游標已重置回 0 才發出這次請求。
    expect(calls).toBe(2);
    expect(sinceSeqSeen.at(-1)).toBe(0);
    // 重置後只剩新的這一筆,不是累積成 2 筆。
    expect(result.current.events.length).toBe(1);
  });

  it('changing identityKey auto-resets and refetches, but not on initial mount', async () => {
    const sinceSeqSeen: (number | undefined)[] = [];
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async ({ sinceSeq } = {}): Promise<WorldResponse> => {
        sinceSeqSeen.push(sinceSeq);
        const ev = fakeEvent(sinceSeqSeen.length);
        return { view: fakeWorld(sinceSeqSeen.length), nextTickAt: 0, events: [ev], nextCursor: ev.seq };
      }),
    };
    const { result, rerender } = renderHook(({ identityKey }) => useWorld({ fetcher, identityKey }), {
      initialProps: { identityKey: 'user-a' as string | null },
    });
    await flushMicrotasks();
    // 首次掛載不算「身分變化」,不該多打一次(仍只有 mount 的那 1 次)。
    expect(fetcher.fetchWorld).toHaveBeenCalledTimes(1);
    expect(result.current.events.length).toBe(1);

    // 模擬換帳號登入:identityKey 從 'user-a' 變成 'user-b'。
    rerender({ identityKey: 'user-b' });
    await flushMicrotasks();

    // 換帳號後應自動重置(events/游標歸零)並重新拉一次。
    expect(sinceSeqSeen.at(-1)).toBe(0);
    expect(result.current.events.length).toBe(1); // 只剩新身分那筆,不是累積成 2 筆
    expect(result.current.world?.tick).toBe(sinceSeqSeen.length);
  });

  it('does not setState after unmount when a poll resolves late', async () => {
    let resolveFn: ((r: WorldResponse) => void) | null = null;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(
        () =>
          new Promise<WorldResponse>((resolve) => {
            resolveFn = resolve;
          })
      ),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();

    unmount();

    await act(async () => {
      resolveFn?.({ view: fakeWorld(1), nextTickAt: 0, events: [], nextCursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    // React 若真的在卸載後 setState 會 console.error 警告——這裡斷言沒有觸發。
    const gotSetStateWarning = errorSpy.mock.calls.some((args) => String(args[0]).includes("Can't perform a React state update"));
    expect(gotSetStateWarning).toBe(false);
    errorSpy.mockRestore();
  });
});
