import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWorld, WORLD_POLL_INTERVAL_MS } from '../src/api/useWorld';
import type { GameEvent, PublicWorldView } from '@micronation/shared';

function fakeWorld(tick: number): PublicWorldView {
  return { seasonId: 's1', tick, regions: [], nations: [], marches: [], treaties: [], orders: [] };
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
    const fetcher = { fetchWorld: vi.fn(async () => fakeWorld(++calls)) };
    const { result } = renderHook(() => useWorld({ fetcher, eventsFor: () => [] }));

    await flushMicrotasks();

    expect(fetcher.fetchWorld).toHaveBeenCalledTimes(1);
    expect(result.current.world?.tick).toBe(1);
  });

  it('polls again after the interval elapses, not before', async () => {
    let calls = 0;
    const fetcher = { fetchWorld: vi.fn(async () => fakeWorld(++calls)) };
    const { result } = renderHook(() => useWorld({ fetcher, eventsFor: () => [] }));
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

  it('accumulates only events newer than the last seen tick', async () => {
    let tick = 0;
    const fetcher = { fetchWorld: vi.fn(async () => fakeWorld(++tick)) };
    const eventsFor = (world: PublicWorldView): GameEvent[] => [
      { tick: world.tick, type: 'production_tick', nationIds: [], payload: null },
    ];
    const { result } = renderHook(() => useWorld({ fetcher, eventsFor }));
    await flushMicrotasks();
    expect(result.current.events.length).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD_POLL_INTERVAL_MS);
    });
    expect(result.current.events.length).toBe(2);
  });

  it('sets error message when fetchWorld rejects, without throwing', async () => {
    const fetcher = { fetchWorld: vi.fn(async () => Promise.reject(new Error('network down'))) };
    const { result } = renderHook(() => useWorld({ fetcher, eventsFor: () => [] }));

    await flushMicrotasks();

    expect(result.current.error).toBe('network down');
    expect(result.current.world).toBeNull();
  });

  it('refresh() triggers an immediate extra fetch', async () => {
    let calls = 0;
    const fetcher = { fetchWorld: vi.fn(async () => fakeWorld(++calls)) };
    const { result } = renderHook(() => useWorld({ fetcher, eventsFor: () => [] }));
    await flushMicrotasks();
    expect(fetcher.fetchWorld).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher.fetchWorld).toHaveBeenCalledTimes(2);
  });
});
