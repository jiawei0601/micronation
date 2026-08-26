import type { PublicRegion } from '@micronation/shared';

export interface WorldMapProps {
  regions: readonly PublicRegion[];
  /** 目前玩家所在區域 id,用於高亮顯示(不再寫死 index===2)。 */
  playerRegionId?: string | null;
  /** 有行軍正在路上時,以區域 index 表示起訖(僅示意用,非精確座標)。index 可能來自
   *  findIndex(找不到回 -1)——越界一律不畫線,不假設一定落在合法範圍。 */
  activeMarch?: { fromRegionIndex: number; toRegionIndex: number } | null;
}

const VIEW_W = 900;
const VIEW_H = 520;
const HEX_R = 90;

function hexPath(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  return `M${pts.join('L')}Z`;
}

/**
 * 依 regions 數量動態排出環狀佈局的區塊中心點——不再寫死 6 塊固定座標(finding #11)。
 * regions 數量變動(例如未來調整賽季地圖大小)時仍能正確渲染,不需改這個元件。
 */
function layoutCenters(count: number): { cx: number; cy: number }[] {
  if (count <= 0) return [];
  const cx0 = VIEW_W / 2;
  const cy0 = VIEW_H / 2;
  if (count === 1) return [{ cx: cx0, cy: cy0 }];
  const radius = Math.max(0, Math.min(VIEW_W, VIEW_H) / 2 - HEX_R - 20);
  const centers: { cx: number; cy: number }[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    centers.push({ cx: cx0 + radius * Math.cos(angle), cy: cy0 + radius * Math.sin(angle) });
  }
  return centers;
}

export function WorldMap({ regions, playerRegionId, activeMarch }: WorldMapProps) {
  const centers = layoutCenters(regions.length);

  function centerAt(index: number): { cx: number; cy: number } | null {
    // 越界防護:index 為 -1(findIndex 找不到)或超出 regions.length 一律回傳 null。
    if (index < 0 || index >= centers.length) return null;
    return centers[index] ?? null;
  }

  const from = activeMarch ? centerAt(activeMarch.fromRegionIndex) : null;
  const to = activeMarch ? centerAt(activeMarch.toRegionIndex) : null;

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" style={{ maxWidth: 1100 }} role="img" aria-label="世界地圖">
      {regions.map((region, i) => {
        const c = centers[i];
        if (!c) return null;
        const isHighlighted = playerRegionId != null && region.id === playerRegionId;
        return (
          <g key={region.id}>
            <path d={hexPath(c.cx, c.cy, HEX_R)} fill={isHighlighted ? '#1d5673' : '#16394f'} stroke={isHighlighted ? '#8fd0ff' : '#24455e'} />
            <text x={c.cx} y={c.cy} fill={isHighlighted ? '#cfe9ff' : '#9fb8cc'} fontSize="11" textAnchor="middle">
              {region.name}
              {isHighlighted ? ' ★' : ''}
            </text>
          </g>
        );
      })}
      {from && to ? (
        <>
          <circle cx={to.cx} cy={to.cy} r={5} fill="#ffd166" />
          <line x1={from.cx} y1={from.cy} x2={to.cx} y2={to.cy} stroke="#e5534b" strokeDasharray="6 4" />
        </>
      ) : null}
    </svg>
  );
}

export default WorldMap;
