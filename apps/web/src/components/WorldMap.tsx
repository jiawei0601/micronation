import type { PublicRegion } from '@micronation/shared';

export interface WorldMapProps {
  regions: readonly PublicRegion[];
  /** 有行軍正在路上時,以區域 index 表示起訖(僅示意用,非精確座標)。 */
  activeMarch?: { fromRegionIndex: number; toRegionIndex: number } | null;
}

// 六大區風格化多邊形(對齊 prototype/ui-variants.html 變體 C 的地圖示意)。
// 不做格子地圖——純示意用途,index 對齊 mock/世界資料的 regions 陣列順序。
const REGION_SHAPES = [
  { d: 'M80,120 L230,80 L310,150 L260,240 L120,230 Z', cx: 140, cy: 170 },
  { d: 'M330,60 L520,40 L590,130 L500,210 L360,180 Z', cx: 420, cy: 120 },
  { d: 'M620,90 L800,70 L850,180 L740,260 L640,200 Z', cx: 700, cy: 160 },
  { d: 'M100,300 L280,280 L330,390 L220,460 L110,420 Z', cx: 180, cy: 380 },
  { d: 'M370,260 L540,250 L600,360 L480,440 L380,400 Z', cx: 450, cy: 350 },
  { d: 'M640,320 L810,300 L860,410 L730,480 L650,430 Z', cx: 710, cy: 400 },
];

export function WorldMap({ regions, activeMarch }: WorldMapProps) {
  return (
    <svg viewBox="0 0 900 520" width="100%" style={{ maxWidth: 1100 }} role="img" aria-label="世界地圖">
      {REGION_SHAPES.map((shape, i) => {
        const region = regions[i];
        const isHighlighted = i === 2; // 玩家所在區域示意(對齊 mock 的 region-3)
        return (
          <g key={region?.id ?? i}>
            <path
              d={shape.d}
              fill={isHighlighted ? '#1d5673' : '#16394f'}
              stroke={isHighlighted ? '#8fd0ff' : '#24455e'}
            />
            <text x={shape.cx} y={shape.cy} fill={isHighlighted ? '#cfe9ff' : '#9fb8cc'} fontSize="11">
              {region?.name ?? '—'}
              {isHighlighted ? ' ★' : ''}
            </text>
          </g>
        );
      })}
      {activeMarch ? (
        <>
          <circle cx={REGION_SHAPES[activeMarch.toRegionIndex]?.cx ?? 0} cy={REGION_SHAPES[activeMarch.toRegionIndex]?.cy ?? 0} r={5} fill="#ffd166" />
          <line
            x1={REGION_SHAPES[activeMarch.fromRegionIndex]?.cx ?? 0}
            y1={REGION_SHAPES[activeMarch.fromRegionIndex]?.cy ?? 0}
            x2={REGION_SHAPES[activeMarch.toRegionIndex]?.cx ?? 0}
            y2={REGION_SHAPES[activeMarch.toRegionIndex]?.cy ?? 0}
            stroke="#e5534b"
            strokeDasharray="6 4"
          />
        </>
      ) : null}
    </svg>
  );
}

export default WorldMap;
