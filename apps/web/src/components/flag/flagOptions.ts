// 旗幟產生器的可選項目——分割樣式(layouts)、調色盤(palettes)、徽章(emblems)。
// FlagSpec 只存 { layout, colors, emblem } 三個字串/陣列欄位(見 packages/shared/src/types.ts),
// 本檔提供產生器 UI 用的選項清單與「id → 如何畫」的純函式對照表。

import {
  boltPath,
  circlePathAsD,
  crossPath,
  diamondPath,
  polygonPath,
  ringPath,
  starPath,
  wavePath,
} from './shapes';

export interface LayoutOption {
  id: string;
  label: string;
  /** 最少需要幾個 colors 才能正確顯示(不足時 Flag 元件會用最後一色補滿)。 */
  minColors: number;
}

export const LAYOUTS: LayoutOption[] = [
  { id: 'solid', label: '純色', minColors: 1 },
  { id: 'stripes-h-2', label: '橫二分', minColors: 2 },
  { id: 'stripes-h-3', label: '橫三分', minColors: 2 },
  { id: 'stripes-v-2', label: '縱二分', minColors: 2 },
  { id: 'stripes-v-3', label: '縱三分', minColors: 2 },
  { id: 'diagonal', label: '對角二分', minColors: 2 },
  { id: 'cross', label: '十字分割', minColors: 2 },
  { id: 'saltire', label: 'X 型分割', minColors: 2 },
  { id: 'quarters', label: '四分格', minColors: 2 },
  { id: 'border-frame', label: '外框內field', minColors: 2 },
];

export const DEFAULT_LAYOUT = LAYOUTS[0].id;

export interface PaletteOption {
  id: string;
  label: string;
  colors: string[]; // 依 layout 需求由前幾色取用,emblem 一律用陣列最後一色
}

export const PALETTES: PaletteOption[] = [
  { id: 'ocean', label: '海圖藍金', colors: ['#1f4e79', '#0b1d2a', '#c9a227'] },
  { id: 'ember', label: '烈焰赤黑', colors: ['#a33333', '#1a1a1a', '#f2b705'] },
  { id: 'forest', label: '森原綠棕', colors: ['#2c6e2f', '#3d2b1f', '#e8dcb5'] },
  { id: 'imperial', label: '帝國紫金', colors: ['#4b2e83', '#1c1030', '#d4af37'] },
  { id: 'steppe', label: '大漠赭青', colors: ['#c07a30', '#274e46', '#f2e8c9'] },
  { id: 'glacier', label: '冰原藍白', colors: ['#2c6e9e', '#0e1b2a', '#e8f2fb'] },
  { id: 'crimson', label: '緋紅象牙', colors: ['#8a1f2b', '#f7f3e8', '#2b2318'] },
  { id: 'jade', label: '翡翠深藍', colors: ['#1f7a5c', '#0b1d2a', '#cfe9ff'] },
  { id: 'sunrise', label: '旭日橙紫', colors: ['#d9622b', '#3a1f5d', '#ffe3b3'] },
  { id: 'slate', label: '石板灰藍', colors: ['#3d4f5c', '#151b21', '#8fd0ff'] },
  { id: 'wine', label: '酒紅奶油', colors: ['#5c1f3a', '#f7e8d4', '#c9a227'] },
  { id: 'pine', label: '松林霧白', colors: ['#204d3b', '#eef2ee', '#0b1d2a'] },
];

export const DEFAULT_PALETTE = PALETTES[0].id;

export interface EmblemOption {
  id: string;
  label: string;
  /** cx/cy 固定 45/30(旗面中心);r 為建議半徑,回傳 path d 字串。 */
  path(): string;
}

function star(points: number, id: string, label: string): EmblemOption {
  return { id, label, path: () => starPath(45, 30, 13, 6, points) };
}
function polygon(sides: number, id: string, label: string): EmblemOption {
  return { id, label, path: () => polygonPath(45, 30, 13, sides) };
}

export const EMBLEMS: EmblemOption[] = [
  star(4, 'star-4', '四角星'),
  star(5, 'star-5', '五角星'),
  star(6, 'star-6', '六角星'),
  star(7, 'star-7', '七角星'),
  star(8, 'star-8', '八角星'),
  star(9, 'star-9', '九角星'),
  star(10, 'star-10', '十角星'),
  star(12, 'star-12', '十二角星'),
  polygon(3, 'triangle', '三角'),
  polygon(5, 'pentagon', '五邊形'),
  polygon(6, 'hexagon', '六邊形'),
  polygon(7, 'heptagon', '七邊形'),
  polygon(8, 'octagon', '八邊形'),
  polygon(9, 'nonagon', '九邊形'),
  polygon(10, 'decagon', '十邊形'),
  polygon(12, 'dodecagon', '十二邊形'),
  { id: 'diamond', label: '菱形', path: () => diamondPath(45, 30, 13) },
  { id: 'diamond-small', label: '小菱形', path: () => diamondPath(45, 30, 8) },
  { id: 'circle', label: '圓形', path: () => circlePathAsD(45, 30, 12) },
  { id: 'circle-small', label: '小圓', path: () => circlePathAsD(45, 30, 7) },
  { id: 'ring', label: '圓環', path: () => ringPath(45, 30, 12, 7) },
  { id: 'ring-thin', label: '細圓環', path: () => ringPath(45, 30, 12, 10) },
  { id: 'cross', label: '十字', path: () => crossPath(45, 30, 24, 6) },
  { id: 'cross-thin', label: '細十字', path: () => crossPath(45, 30, 24, 3) },
  { id: 'bolt', label: '閃電', path: () => boltPath(45, 30, 26) },
  { id: 'wave', label: '單波浪', path: () => wavePath(45, 30, 26, 6) },
  { id: 'wave-wide', label: '寬波浪', path: () => wavePath(45, 30, 30, 9) },
  { id: 'sun-star', label: '旭日星', path: () => starPath(45, 30, 13, 9, 12) },
  { id: 'moon-star', label: '弦月星(六角)', path: () => starPath(45, 30, 12, 8, 6) },
  { id: 'compass-star', label: '羅盤星(十六角)', path: () => starPath(45, 30, 13, 10, 16) },
  { id: 'shield', label: '盾形(五邊)', path: () => polygonPath(45, 30, 13, 5, -90) },
  { id: 'gear', label: '齒輪星(八凹角)', path: () => starPath(45, 30, 13, 10, 8) },
  { id: 'anchor-diamond', label: '錨形菱(旋轉方)', path: () => polygonPath(45, 30, 13, 4, -45) },
  { id: 'square', label: '正方(旋轉)', path: () => polygonPath(45, 30, 11, 4, -45) },
];

export const DEFAULT_EMBLEM = EMBLEMS[1].id; // 五角星

export function findLayout(id: string): LayoutOption {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
}

export function findEmblem(id: string): EmblemOption | undefined {
  return EMBLEMS.find((e) => e.id === id);
}
