import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PublicWorldView } from '@micronation/shared';
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

function worldWithTreaty(pendingResponderId: string | undefined): PublicWorldView {
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
        status: 'proposed',
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
    fetchWorld: async (): Promise<WorldResponse> => ({ view: worldWithTreaty(pendingResponderId), nextTickAt: 0, events: [] }),
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
