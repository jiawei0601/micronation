import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Nation } from '@micronation/shared';
import { useNation, type NationFetcher, type NationFetchResult } from '../src/api/useNation';

const FAKE_NATION = { id: 'n1' } as Nation;

function fetcherReturning(result: NationFetchResult | Error): NationFetcher {
  return {
    fetchNation: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('useNation — 三態分離(finding #6/#12)', () => {
  it('status=ready when the nation loads successfully', async () => {
    const fetcher = fetcherReturning({ kind: 'ok', nation: FAKE_NATION });
    const { result } = renderHook(() => useNation(fetcher));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status).toBe('ready');
    expect(result.current.hasNation).toBe(true);
    expect(result.current.nation).not.toBeNull();
  });

  it('status=unauthenticated on 401 — caller should redirect to /login, not show "尚未建國"', async () => {
    const fetcher = fetcherReturning({ kind: 'unauthenticated' });
    const { result } = renderHook(() => useNation(fetcher));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.hasNation).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('status=no-nation on 404 — caller should show the founding CTA', async () => {
    const fetcher = fetcherReturning({ kind: 'no-nation' });
    const { result } = renderHook(() => useNation(fetcher));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status).toBe('no-nation');
    expect(result.current.hasNation).toBe(false);
  });

  it('status=error on unexpected failures — caller should show error + retry, distinct from no-nation', async () => {
    const fetcher = fetcherReturning(new Error('network down'));
    const { result } = renderHook(() => useNation(fetcher));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('network down');
    expect(result.current.hasNation).toBe(false);
  });

  it('refresh() re-triggers fetchNation and can transition status', async () => {
    let call = 0;
    const fetcher: NationFetcher = {
      fetchNation: vi.fn(async (): Promise<NationFetchResult> => {
        call += 1;
        return call === 1 ? { kind: 'no-nation' } : { kind: 'ok', nation: FAKE_NATION };
      }),
    };
    const { result } = renderHook(() => useNation(fetcher));
    await waitFor(() => expect(result.current.status).toBe('no-nation'));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetcher.fetchNation).toHaveBeenCalledTimes(2);
  });
});
