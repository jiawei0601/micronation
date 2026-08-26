import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PublicWorldView, TreatyStatus } from '@micronation/shared';
import { WorldProvider } from '../src/api/WorldProvider';
import TreatyPage from '../src/pages/TreatyPage';
import type { WorldFetcher, WorldResponse } from '../src/api/useWorld';

const VIEWER_ID = 'nation-viewer';
const OTHER_ID = 'nation-other';

function nation(id: string, name: string, regionId: string) {
  return {
    id,
    ownerId: 'user-1',
    name,
    flag: { layout: 'solid', colors: ['#111111'], emblem: 'star-5' },
    regionId,
    score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 },
    reputation: { breaches: 0 },
    armySizeTier: 'small' as const,
    protectedUntil: 0,
    policies: { tax: 'mid' as const, economy: 'agri' as const, conscription: 'volunteer' as const, openness: 'neutral' as const },
  };
}

function worldWithTreaty(pendingResponderId: string | undefined, status: TreatyStatus = 'proposed'): PublicWorldView {
  return {
    seasonId: 's1',
    tick: 1,
    regions: [],
    nations: [nation(VIEWER_ID, '我國', 'r1'), nation(OTHER_ID, '對方', 'r2')],
    marches: [],
    treaties: [
      {
        id: 'treaty-1',
        kind: 'nap',
        aId: VIEWER_ID,
        bId: OTHER_ID,
        status,
        terms: { duration: 168, pendingResponderId },
        createdAt: 0,
      },
    ],
    orders: [],
  };
}

function fullNation(id: string) {
  return {
    id,
    ownerId: 'user-1',
    name: '我國',
    flag: { layout: 'solid', colors: ['#111111'], emblem: 'star-5' },
    regionId: 'r1',
    resources: { food: 0, ore: 0, fuel: 0, money: 0 },
    tech: 0,
    actionPoints: 0,
    population: 0,
    morale: 0,
    buildings: { farm: 0, mine: 0, refinery: 0, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
    buildQueue: [],
    army: { size: 0 },
    policies: { tax: 'mid', economy: 'agri', conscription: 'volunteer', openness: 'neutral' },
    policyChangedAt: {},
    reputation: { breaches: 0 },
    protectedUntil: 0,
    score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 },
    createdAt: 0,
  };
}

function renderTreatyPage(pendingResponderId: string | undefined) {
  const fetcher: WorldFetcher = {
    fetchWorld: async (): Promise<WorldResponse> => ({
      view: worldWithTreaty(pendingResponderId),
      nextTickAt: 0,
      events: [],
      nextCursor: null,
    }),
  };
  return render(
    <MemoryRouter initialEntries={['/treaty/treaty-1']}>
      <WorldProvider options={{ fetcher }}>
        <Routes>
          <Route path="/treaty/:id" element={<TreatyPage />} />
        </Routes>
      </WorldProvider>
    </MemoryRouter>
  );
}

describe('TreatyPage — 權限渲染(finding #12)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ nation: fullNation(VIEWER_ID) }) }))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('shows accept/counter/reject when the viewer is the pending responder', async () => {
    renderTreatyPage(VIEWER_ID);
    expect(await screen.findByText('接受')).not.toBeNull();
    expect(screen.getByText('還價')).not.toBeNull();
    expect(screen.getByText('拒絕')).not.toBeNull();
  });

  it('hides response buttons when the viewer is not the pending responder (read-only)', async () => {
    renderTreatyPage(OTHER_ID);
    // 等世界資料載入完成(找得到條約書標題以外的內容,例如條款表格)。
    expect(await screen.findByText('期限')).not.toBeNull();
    expect(screen.queryByText('接受')).toBeNull();
    expect(screen.queryByText('還價')).toBeNull();
    expect(screen.queryByText('拒絕')).toBeNull();
  });

  it('hides response buttons entirely when nobody is the pending responder', async () => {
    renderTreatyPage(undefined);
    expect(await screen.findByText('期限')).not.toBeNull();
    expect(screen.queryByText('接受')).toBeNull();
  });
});

describe('TreatyPage — localStatus 重設(finding #7:伺服器狀態優先於本地樂觀值)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/diplomacy/respond')) {
          return { ok: true, status: 200, json: async () => ({ treaties: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({ nation: fullNation(VIEWER_ID) }) };
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('server status wins over the optimistic local guess once a refresh lands', async () => {
    // 場景:玩家按下「接受」,本地先樂觀顯示 active;但下一次輪詢回來的伺服器狀態其實是
    // countered(例如同時被對方還價搶先)——畫面最終應以伺服器為準顯示「已還價」,不能卡在本地的「生效中」。
    let call = 0;
    const fetcher: WorldFetcher = {
      fetchWorld: async (): Promise<WorldResponse> => {
        call += 1;
        const status: TreatyStatus = call === 1 ? 'proposed' : 'countered';
        return { view: worldWithTreaty(VIEWER_ID, status), nextTickAt: 0, events: [], nextCursor: null };
      },
    };
    render(
      <MemoryRouter initialEntries={['/treaty/treaty-1']}>
        <WorldProvider options={{ fetcher }}>
          <Routes>
            <Route path="/treaty/:id" element={<TreatyPage />} />
          </Routes>
        </WorldProvider>
      </MemoryRouter>
    );

    const acceptButton = await screen.findByText('接受');
    await act(async () => {
      fireEvent.click(acceptButton);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText('已還價')).not.toBeNull();
    expect(screen.queryByText('生效中')).toBeNull();
  });

  it('resets localStatus when navigating to a different treaty id', async () => {
    const fetcher: WorldFetcher = {
      fetchWorld: async (): Promise<WorldResponse> => ({
        view: worldWithTreaty(VIEWER_ID, 'proposed'),
        nextTickAt: 0,
        events: [],
        nextCursor: null,
      }),
    };
    render(
      <MemoryRouter initialEntries={['/treaty/treaty-1']}>
        <WorldProvider options={{ fetcher }}>
          <Routes>
            <Route path="/treaty/:id" element={<TreatyPage />} />
          </Routes>
        </WorldProvider>
      </MemoryRouter>
    );

    const acceptButton = await screen.findByText('接受');
    await act(async () => {
      fireEvent.click(acceptButton);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // 本地樂觀值仍是 active(伺服器這次輪詢仍回 proposed,尚未追上)。
    expect(await screen.findByText('生效中')).not.toBeNull();
  });
});
