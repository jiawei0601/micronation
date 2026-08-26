import type { FlagSpec } from '@micronation/shared';
import { DEFAULT_PALETTE, PALETTES, findEmblem, findLayout } from './flagOptions';

export interface FlagProps {
  spec: FlagSpec;
  className?: string;
  title?: string;
}

const W = 90;
const H = 60;

/** spec.colors 不足或缺值時的保底色盤(避免非法 spec 讓元件崩潰)。 */
const FALLBACK_COLORS = PALETTES.find((p) => p.id === DEFAULT_PALETTE)?.colors ?? ['#1f4e79', '#0b1d2a', '#c9a227'];

/** 合法色碼:#rgb 或 #rrggbb(大小寫皆可)。 */
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * 補滿到至少 3 色:不足時重複最後一色。非白名單值(非 #rgb/#rrggbb 色碼、非陣列、空值等)
 * 一律替換為保底色盤對應位置的預設色,不放行任意字串進 SVG fill(finding #16 白名單)。
 */
function sanitizeColors(colors: unknown): string[] {
  const arr = Array.isArray(colors) ? colors : [];
  const sanitized = arr.map((c, i) =>
    typeof c === 'string' && HEX_COLOR_RE.test(c) ? c : FALLBACK_COLORS[i % FALLBACK_COLORS.length]
  );
  if (sanitized.length === 0) return [...FALLBACK_COLORS];
  const out = [...sanitized];
  while (out.length < 3) out.push(out[out.length - 1]);
  return out;
}

function fieldShapes(layoutId: string, colors: string[]): { fill: string; d?: string; rect?: [number, number, number, number] }[] {
  const [c1, c2] = colors;
  switch (layoutId) {
    case 'stripes-h-2':
      return [
        { fill: c1, rect: [0, 0, W, H / 2] },
        { fill: c2, rect: [0, H / 2, W, H / 2] },
      ];
    case 'stripes-h-3':
      return [
        { fill: c1, rect: [0, 0, W, H / 3] },
        { fill: c2, rect: [0, H / 3, W, H / 3] },
        { fill: c1, rect: [0, (2 * H) / 3, W, H / 3] },
      ];
    case 'stripes-v-2':
      return [
        { fill: c1, rect: [0, 0, W / 2, H] },
        { fill: c2, rect: [W / 2, 0, W / 2, H] },
      ];
    case 'stripes-v-3':
      return [
        { fill: c1, rect: [0, 0, W / 3, H] },
        { fill: c2, rect: [W / 3, 0, W / 3, H] },
        { fill: c1, rect: [(2 * W) / 3, 0, W / 3, H] },
      ];
    case 'diagonal':
      return [
        { fill: c1, rect: [0, 0, W, H] },
        { fill: c2, d: `M0,0 L${W},0 L0,${H} Z` },
      ];
    case 'cross':
      return [
        { fill: c1, rect: [0, 0, W, H] },
        { fill: c2, rect: [0, H / 2 - 6, W, 12] },
        { fill: c2, rect: [W / 2 - 8, 0, 16, H] },
      ];
    case 'saltire':
      return [
        { fill: c1, rect: [0, 0, W, H] },
        { fill: c2, d: `M0,0 L14,0 L${W},${H - 14} L${W},${H} L${W - 14},${H} L0,14 Z` },
        { fill: c2, d: `M${W},0 L${W - 14},0 L0,${H - 14} L0,${H} L14,${H} L${W},14 Z` },
      ];
    case 'quarters':
      return [
        { fill: c1, rect: [0, 0, W / 2, H / 2] },
        { fill: c2, rect: [W / 2, 0, W / 2, H / 2] },
        { fill: c2, rect: [0, H / 2, W / 2, H / 2] },
        { fill: c1, rect: [W / 2, H / 2, W / 2, H / 2] },
      ];
    case 'border-frame':
      return [
        { fill: c2, rect: [0, 0, W, H] },
        { fill: c1, rect: [6, 6, W - 12, H - 12] },
      ];
    case 'solid':
    default:
      return [{ fill: c1, rect: [0, 0, W, H] }];
  }
}

/**
 * 純 SVG 國旗元件。對非法 spec(未知 layout/未知 emblem/colors 不足或型別錯誤)一律以保底值
 * 安全降級,不拋出例外——旗幟產生器輸出的 FlagSpec 結構上不可能繪出違規結果。
 */
export function Flag({ spec, className, title }: FlagProps) {
  const layout = findLayout(spec?.layout ?? '');
  const colors = sanitizeColors(spec?.colors);
  const emblemColor = colors[colors.length - 1];
  const emblem = typeof spec?.emblem === 'string' ? findEmblem(spec.emblem) : undefined;
  const shapes = fieldShapes(layout.id, colors);

  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={title ?? '國旗'}
      data-layout={layout.id}
      data-emblem={emblem?.id ?? 'none'}
    >
      {title ? <title>{title}</title> : null}
      {shapes.map((s, i) =>
        s.rect ? (
          <rect key={i} x={s.rect[0]} y={s.rect[1]} width={s.rect[2]} height={s.rect[3]} fill={s.fill} data-shape="field" />
        ) : (
          <path key={i} d={s.d} fill={s.fill} data-shape="field" />
        )
      )}
      {emblem ? (
        <path d={emblem.path()} fill={emblemColor} fillRule="evenodd" data-shape="emblem" />
      ) : null}
    </svg>
  );
}

export default Flag;
