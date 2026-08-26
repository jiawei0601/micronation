import { NavLink, Outlet } from 'react-router-dom';
import { Flag } from '../../components/flag/Flag';
import { useWorld, mockViewerId } from '../../api/useWorld';
import { t } from '../../i18n/zh-Hant';

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
  const { world, unseenCount } = useWorld();
  const player = world?.nations.find((n) => n.id === mockViewerId) ?? world?.nations[0] ?? null;

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
          <span className="relative rounded-lg bg-chart-panel px-2 py-1 text-xs">
            🔔
            {unseenCount > 0 ? (
              <i className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[#e5534b]" aria-label={`${unseenCount} 則未讀`} />
            ) : null}
          </span>
        </div>
        <Outlet context={{ world, player }} />
      </main>
    </div>
  );
}

export default PanelLayout;
