import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWorld, WORLD_POLL_INTERVAL_MS, eventKey, type WorldFetcher, type WorldResponse } from '../src/api/useWorld';
import type { GameEvent, PublicWorldView } from '@micronation/shared';

function fakeWorld(tick: number): PublicWorldView {
  return { seasonId: 's1', tick, regions: [], nations: [], marches: [], treaties: [], orders: [] };
}

function fakeEvent(tick: number, suffix = ''): GameEvent {
  return { tick, type: 'production_tick', nationIds: [], payload: suffix || null };
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
      fetchWorld: vi.fn(async (): Promise<WorldResponse> => ({ view: fakeWorld(++calls), nextTickAt: 0, events: [] })),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));

    await flushMicrotasks();

    expect(fetcher.fetchWorld).toHaveBeenCalledTimes(1);
    expect(result.current.world?.tick).toBe(1);
  });

  it('polls again after the interval elapses, not before', async () => {
    let calls = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async (): Promise<WorldResponse> => ({ view: fakeWorld(++calls), nextTickAt: 0, events: [] })),
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

  it('accumulates events returned by the fetcher and assigns each a stable id', async () => {
    let tick = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async (): Promise<WorldResponse> => {
        tick += 1;
        return { view: fakeWorld(tick), nextTickAt: 0, events: [fakeEvent(tick)] };
      }),
    };
    const { result } = renderHook(() => useWorld({ fetcher }));
    await flushMicrotasks();
    expect(result.current.events.length).toBe(1);
    expect(result.current.events[0].id).toBe(eventKey(fakeEvent(1)));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS);
    });
    expect(result.current.events.length).toBe(2);
  });

  it('dedupes events with the same content across polls instead of re-appending them', async () => {
    const repeated = fakeEvent(5, 'same');
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async (): Promise<WorldResponse> => ({ view: fakeWorld(5), nextTickAt: 0, events: [repeated] })),
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

  it('markEventsSeen clears unseenCount down to zero, new events after that count again', async () => {
    let tick = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: vi.fn(async (): Promise<WorldResponse> => {
        tick += 1;
        return { view: fakeWorld(tick), nextTickAt: 0, events: [fakeEvent(tick, `e${tick}`)] };
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
      fetchWorld: vi.fn(async (): Promise<WorldResponse> => ({ view: fakeWorld(++calls), nextTickAt: 0, events: [] })),
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
      resolvers[1]({ view: fakeWorld(99), nextTickAt: 0, events: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.world?.tick).toBe(99);

    // 先發出但慢的第一次才 resolve,應被丟棄,不覆蓋畫面上的 tick 99
    await act(async () => {
      resolvers[0]({ view: fakeWorld(1), nextTickAt: 0, events: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.world?.tick).toBe(99);
  });
});

describe('eventKey', () => {
  it('is stable for identical events and differs for different ones', () => {
    const a = fakeEvent(1, 'x');
    const b = fakeEvent(1, 'x');
    const c = fakeEvent(1, 'y');
    expect(eventKey(a)).toBe(eventKey(b));
    expect(eventKey(a)).not.toBe(eventKey(c));
  });
});
