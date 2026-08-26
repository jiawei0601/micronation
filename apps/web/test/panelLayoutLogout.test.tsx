// Codex 四審⑪ 回歸測試——PanelLayout 的登出失敗處理:authFn.logout() 失敗時,不該宣稱已登出
// (不清空 world、不導向 /login),應顯示錯誤並提供重試按鈕。修復前(舊版 try/finally 不論
// 成敗都 resetWorld()+navigate)這裡的斷言會紅:失敗時仍會被導去 /login。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PublicWorldView } from '@micronation/shared';
import { WorldProvider } from '../src/api/WorldProvider';
import PanelLayout from '../src/pages/panels/PanelLayout';
import type { WorldFetcher, WorldResponse } from '../src/api/useWorld';

function fakeWorld(): PublicWorldView {
  return { seasonId: 's1', tick: 1, regions: [], nations: [], marches: [], treaties: [], orders: [] };
}

function fullNation() {
  return {
    id: 'n1',
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

function renderPanelLayout() {
  const fetcher: WorldFetcher = {
    fetchWorld: async (): Promise<WorldResponse> => ({ view: fakeWorld(), nextTickAt: 0, events: [], nextCursor: null }),
  };
  return render(
    <MemoryRouter initialEntries={['/nation']}>
      <WorldProvider options={{ fetcher }}>
        <Routes>
          <Route path="/nation" element={<PanelLayout />}>
            <Route index element={<div>panel-body</div>} />
          </Route>
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </WorldProvider>
    </MemoryRouter>
  );
}

describe('PanelLayout — 登出失敗處理(Codex 四審⑪)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('authFn.logout() 失敗時:留在原頁、顯示錯誤、提供重試,不導向 /login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/auth/logout')) {
          return { ok: false, status: 500, json: async () => ({ error: 'LOGOUT_FAILED' }) };
        }
        return { ok: true, status: 200, json: async () => ({ nation: fullNation() }) };
      })
    );

    renderPanelLayout();
    const logoutButton = await screen.findByText('登出');

    await act(async () => {
      fireEvent.click(logoutButton);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 沒有被導去 /login——失敗不該宣稱已登出。
    expect(screen.queryByText('login-page')).toBeNull();
    // 仍看得到面板本體(沒有被 resetWorld 之類的副作用打斷渲染)。
    expect(screen.getByText('panel-body')).not.toBeNull();
    // 顯示了錯誤 + 重試按鈕(不再是原本單純的「登出」按鈕文字)。
    expect(screen.getByText(/LOGOUT_FAILED/)).not.toBeNull();
    expect(screen.getByText('重試')).not.toBeNull();
  });

  it('authFn.logout() 成功時:導向 /login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/auth/logout')) {
          return { ok: true, status: 200, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ nation: fullNation() }) };
      })
    );

    renderPanelLayout();
    const logoutButton = await screen.findByText('登出');

    await act(async () => {
      fireEvent.click(logoutButton);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText('login-page')).not.toBeNull();
  });
});
