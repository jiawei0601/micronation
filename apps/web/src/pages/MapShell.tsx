import { Link } from 'react-router-dom';
import { Flag } from '../components/flag/Flag';
import { WorldMap } from '../components/WorldMap';
import { StatusNotice } from '../components/panel/PanelKit';
import { useWorldContext } from '../api/WorldProvider';
import { useNation } from '../api/useNation';
import { formatInt } from '../lib/format';
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
  const { world, events, loading, error } = useWorldContext();
  const { nation, loading: nationLoading, hasNation } = useNation();

  // 找不到自己的國家時,不准 fallback 到 nations[0](那是別人的國家)——導向開國流程。
  if (!nationLoading && !hasNation) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-chart-bg text-[#dce8f2]">
        <div className="rounded-xl border border-chart-border bg-[rgba(13,32,46,0.9)] p-8 text-center">
          <p className="mb-4 text-sm text-[#9fb8cc]">尚未建國</p>
          <Link to="/founding" className="rounded bg-chart-blue px-4 py-2 text-sm">
            {t.founding.found}
          </Link>
        </div>
      </div>
    );
  }

  const player = world?.nations.find((n) => n.id === nation?.id) ?? null;
  const playerMarch =
    world && nation ? (world.marches.find((m) => m.attackerId === nation.id || m.defenderId === nation.id) ?? null) : null;
  const attackerNation = playerMarch ? (world?.nations.find((n) => n.id === playerMarch.attackerId) ?? null) : null;
  const defenderNation = playerMarch ? (world?.nations.find((n) => n.id === playerMarch.defenderId) ?? null) : null;
  const activeMarch =
    world && attackerNation && defenderNation
      ? {
          fromRegionIndex: world.regions.findIndex((r) => r.id === attackerNation.regionId),
          toRegionIndex: world.regions.findIndex((r) => r.id === defenderNation.regionId),
        }
      : null;

  return (
    <div className="relative min-h-screen overflow-hidden bg-chart-bg text-[#dce8f2]">
      <div className="absolute inset-0 flex items-center justify-center">
        {world ? <WorldMap regions={world.regions} playerRegionId={nation?.regionId ?? null} activeMarch={activeMarch} /> : null}
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
        {nation ? (
          <dl className="space-y-1">
            <Row label={t.resources.food} value={formatInt(nation.resources.food)} />
            <Row label={t.resources.ore} value={formatInt(nation.resources.ore)} />
            <Row label={t.resources.fuel} value={formatInt(nation.resources.fuel)} />
            <Row label={t.resources.money} value={formatInt(nation.resources.money)} />
          </dl>
        ) : (
          <p className="text-[#7fa3bd]">{t.common.loading}</p>
        )}
      </aside>

      <aside className="absolute bottom-20 left-5 z-10 w-56 rounded-xl border border-chart-border bg-[rgba(13,32,46,0.82)] p-4 text-sm backdrop-blur">
        <h3 className="mb-2 text-xs tracking-widest text-chart-accent">{t.map.hud_domestic}</h3>
        {nation && player ? (
          <dl className="space-y-1">
            <Row label={t.nation.population} value={formatInt(nation.population)} />
            <Row label={t.nation.morale} value={formatInt(nation.morale)} />
            <Row label={t.nation.army} value={player.armySizeTier} />
          </dl>
        ) : null}
      </aside>

      <div className="absolute right-5 top-16 z-10 w-72 space-y-2">
        {events.slice(-3).map((e) => (
          <div key={e.id} className="rounded-r-lg border-l-4 border-chart-blue bg-[rgba(13,32,46,0.85)] px-3 py-2 text-xs">
            {e.type} · tick {e.tick}
          </div>
        ))}
      </div>

      {error ? (
        <div className="absolute right-5 bottom-24 z-10 w-72">
          <StatusNotice kind="error" message={error} />
        </div>
      ) : null}

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
