import { useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { Flag } from '../../components/flag/Flag';
import { useWorldContext } from '../../api/WorldProvider';
import { useNation } from '../../api/useNation';
import { authFn } from '../../api/auth';
import { t } from '../../i18n/zh-Hant';
import type { PanelContext } from './context';

const NAV_ITEMS: { to: string; icon: string; label: string }[] = [
  { to: '/nation', icon: '📊', label: t.nav.nation },
  { to: '/build', icon: '🏗', label: t.nav.build },
  { to: '/policy', icon: '⚖', label: t.nav.policy },
  { to: '/market', icon: '🛒', label: t.nav.market },
  { to: '/military', icon: '⚔', label: t.nav.military },
  { to: '/diplomacy', icon: '🕊', label: t.nav.diplomacy },
  { to: '/rankings', icon: '🏆', label: t.nav.rankings },
  { to: '/tasks', icon: '📜', label: t.nav.tasks },
  { to: '/', icon: '🌍', label: t.nav.map },
];

/** B 風深色數據面板殼——建設/政策/市場/軍事/外交/排行/任務共用的側欄版式。 */
export function PanelLayout() {
  const navigate = useNavigate();
  const { world, unseenCount, markEventsSeen, resetWorld } = useWorldContext();
  const { nation, status: nationStatus, error: nationError, refresh: refreshNation } = useNation();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  // Codex 四審⑪:只有 authFn.logout() 真正成功,才清空本地 world 狀態並導去 /login——舊版用
  // try/finally,不論成功或失敗都執行 resetWorld()+navigate,等於「後端登出失敗(例如網路中斷、
  // 伺服器 500)時,前端還是宣稱已登出、把使用者導去登入頁」——但伺服器那邊的 session 可能仍然
  // 有效(cookie 沒被清掉),使用者以為自己登出了,實際上這個裝置上這個帳號仍是登入狀態,是
  // 誤導性的安全假象。失敗時改成顯示錯誤訊息+提供重試按鈕,不清 world、不導頁,不宣稱已登出。
  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await authFn.logout();
      // 跨帳號事件外洩修復:登出成功後清空本地累積的 world/events/游標,避免下一位使用
      // 同一裝置登入的人看到殘留事件。
      resetWorld();
      navigate('/login');
    } catch (err) {
      setLogoutError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoggingOut(false);
    }
  }

  // finding #6/#12:三態分離——401 導 /login,一般錯誤顯示重試,未建國才是 CTA(不可混為一談)。
  if (nationStatus === 'unauthenticated') {
    return <Navigate to="/login" replace />;
  }
  if (nationStatus === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-chart-panel2 text-[#e6e9ef]">
        <div className="rounded-xl border border-[#232a38] bg-chart-panel p-8 text-center">
          <p className="mb-4 text-sm text-[#ff8f88]">{t.common.error}: {nationError}</p>
          <button type="button" onClick={refreshNation} className="rounded bg-chart-blue px-4 py-2 text-sm">
            {t.common.retry}
          </button>
        </div>
      </div>
    );
  }
  if (nationStatus === 'no-nation') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-chart-panel2 text-[#e6e9ef]">
        <div className="rounded-xl border border-[#232a38] bg-chart-panel p-8 text-center">
          <p className="mb-4 text-sm text-[#9aa4b5]">尚未建國</p>
          <Link to="/founding" className="rounded bg-chart-blue px-4 py-2 text-sm">
            {t.founding.found}
          </Link>
        </div>
      </div>
    );
  }

  const player = world?.nations.find((n) => n.id === nation?.id) ?? null;
  const outletCtx: PanelContext = { world, player, nation };

  return (
    <div className="flex min-h-screen bg-chart-panel2 text-[#e6e9ef]">
      <nav className="flex w-52 flex-shrink-0 flex-col border-r border-[#232a38] bg-chart-panel py-5">
        <div className="flex items-center gap-2 border-b border-[#232a38] px-4 pb-4">
          {player ? <Flag spec={player.flag} className="h-6 w-9 rounded-sm" title={player.name} /> : null}
          <b className="text-sm">{player?.name ?? t.common.appName}</b>
        </div>
        <div className="mt-2 flex flex-col">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end
              className={({ isActive }) =>
                `flex items-center gap-2 px-4 py-2 text-sm ${
                  isActive ? 'border-r-2 border-chart-blue bg-[#1d2635] text-white' : 'text-[#9aa4b5]'
                }`
              }
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
        {logoutError ? (
          <div className="mt-auto px-4 py-2 text-xs text-[#ff8f88]">
            <p className="mb-1">{t.common.error}: {logoutError}</p>
            <button type="button" onClick={handleLogout} disabled={loggingOut} className="underline disabled:opacity-50">
              {t.common.retry}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="mt-auto px-4 py-2 text-left text-sm text-[#9aa4b5] hover:text-white disabled:opacity-50"
          >
            {loggingOut ? t.common.loading : t.auth.logout}
          </button>
        )}
      </nav>
      <main className="flex-1 px-6 py-5 pb-24">
        <div className="mb-4 flex items-center gap-3">
          <span className="ml-auto rounded-lg bg-chart-panel px-3 py-1 text-xs text-[#9aa4b5]">
            {t.common.tick} {world?.tick ?? '—'}
          </span>
          <button
            type="button"
            onClick={markEventsSeen}
            className="relative rounded-lg bg-chart-panel px-2 py-1 text-xs"
            aria-label={unseenCount > 0 ? `${unseenCount} 則未讀事件,點擊標記已讀` : '無未讀事件'}
          >
            🔔
            {unseenCount > 0 ? (
              <i className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[#e5534b]" aria-hidden="true" />
            ) : null}
          </button>
        </div>
        <Outlet context={outletCtx} />
      </main>
    </div>
  );
}

export default PanelLayout;
