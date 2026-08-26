import { Link, NavLink, Outlet } from 'react-router-dom';
import { Flag } from '../../components/flag/Flag';
import { useWorldContext } from '../../api/WorldProvider';
import { useNation } from '../../api/useNation';
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
  const { world, unseenCount, markEventsSeen } = useWorldContext();
  const { nation, loading: nationLoading, hasNation } = useNation();

  // 找不到自己的國家時,不准 fallback 到 nations[0]——導向開國流程,而不是把別人的國家當自己的顯示。
  if (!nationLoading && !hasNation) {
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
      <nav className="w-52 flex-shrink-0 border-r border-[#232a38] bg-chart-panel py-5">
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
