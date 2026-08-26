import { Link } from 'react-router-dom';
import { Flag } from '../components/flag/Flag';
import { WorldMap } from '../components/WorldMap';
import { useWorld, mockViewerId } from '../api/useWorld';
import { formatDelta, formatInt } from '../lib/format';
import { t } from '../i18n/zh-Hant';

const DOCK_LINKS: { to: string; label: string }[] = [
  { to: '/build', label: `🏗 ${t.nav.build}` },
  { to: '/policy', label: `⚖ ${t.nav.policy}` },
  { to: '/market', label: `🛒 ${t.nav.market}` },
  { to: '/military', label: `⚔ ${t.nav.military}` },
  { to: '/diplomacy', label: `🕊 ${t.nav.diplomacy}` },
  { to: '/rankings', label: `🏆 ${t.nav.rankings}` },
];

/** C 風地圖主殼——登入後主畫面。SVG 地圖+國庫/內政 HUD+警報流+功能 dock。 */
export function MapShell() {
  const { world, events, loading, error } = useWorld();
  const player = world?.nations.find((n) => n.id === mockViewerId) ?? world?.nations[0] ?? null;

  return (
    <div className="relative min-h-screen overflow-hidden bg-chart-bg text-[#dce8f2]">
      <div className="absolute inset-0 flex items-center justify-center">
        {world ? <WorldMap regions={world.regions} activeMarch={{ fromRegionIndex: 0, toRegionIndex: 2 }} /> : null}
      </div>

      <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-[rgba(8,20,30,0.9)] to-transparent px-5 py-3">
        {player ? <Flag spec={player.flag} className="h-7 w-10 rounded-sm shadow" title={player.name} /> : null}
        <h1 className="text-lg tracking-wide">{player?.name ?? t.common.appName}</h1>
        <span className="text-xs text-[#7fa3bd]">
          {t.common.tick} {world?.tick ?? '—'}
        </span>
        <div className="ml-auto text-xs text-chart-accent">
          {loading ? t.common.loading : error ? `${t.common.error}: ${error}` : `${t.nav.nation}`}
        </div>
      </div>

      <aside className="absolute left-5 top-16 z-10 w-56 rounded-xl border border-chart-border bg-[rgba(13,32,46,0.82)] p-4 text-sm backdrop-blur">
        <h3 className="mb-2 text-xs tracking-widest text-chart-accent">{t.map.hud_treasury}</h3>
        {player ? (
          <dl className="space-y-1">
            <Row label={t.resources.food} value={formatDelta(120)} />
            <Row label={t.resources.ore} value={formatDelta(80)} />
            <Row label={t.resources.fuel} value={formatDelta(-20)} />
            <Row label={t.resources.money} value={formatDelta(300)} />
          </dl>
        ) : (
          <p className="text-[#7fa3bd]">{t.common.loading}</p>
        )}
      </aside>

      <aside className="absolute bottom-20 left-5 z-10 w-56 rounded-xl border border-chart-border bg-[rgba(13,32,46,0.82)] p-4 text-sm backdrop-blur">
        <h3 className="mb-2 text-xs tracking-widest text-chart-accent">{t.map.hud_domestic}</h3>
        {player ? (
          <dl className="space-y-1">
            <Row label={t.nation.population} value={formatInt(45210)} />
            <Row label={t.nation.morale} value="良好" />
            <Row label={t.nation.army} value={player.armySizeTier} />
          </dl>
        ) : null}
      </aside>

      <div className="absolute right-5 top-16 z-10 w-72 space-y-2">
        {events.slice(-3).map((e, i) => (
          <div key={i} className="rounded-r-lg border-l-4 border-chart-blue bg-[rgba(13,32,46,0.85)] px-3 py-2 text-xs">
            {e.type} · tick {e.tick}
          </div>
        ))}
      </div>

      <nav className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 gap-2">
        {DOCK_LINKS.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            className="rounded-lg border border-chart-border bg-[rgba(13,32,46,0.9)] px-4 py-2 text-sm hover:border-chart-accent"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 tabular-nums">
      <span className="text-[#9fb8cc]">{label}</span>
      <b>{value}</b>
    </div>
  );
}

export default MapShell;
