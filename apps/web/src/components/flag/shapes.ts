// 純函式:產生內嵌 SVG path 的 `d` 字串。不外連任何圖檔/字型,徽章全部用幾何運算畫出。

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 正 n 邊形,rotationDeg=-90 讓第一個頂點朝上。 */
export function polygonPath(cx: number, cy: number, r: number, sides: number, rotationDeg = -90): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = toRad(rotationDeg + (360 / sides) * i);
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

/** n 角星,rOuter=尖端半徑,rInner=凹角半徑。 */
export function starPath(cx: number, cy: number, rOuter: number, rInner: number, points: number, rotationDeg = -90): string {
  const pts: string[] = [];
  const step = 360 / (points * 2);
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const angle = toRad(rotationDeg + step * i);
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

/** 十字。 */
export function crossPath(cx: number, cy: number, size: number, thickness: number): string {
  const h = size / 2;
  const t = thickness / 2;
  return [
    `M${cx - t},${cy - h}`,
    `L${cx + t},${cy - h}`,
    `L${cx + t},${cy - t}`,
    `L${cx + h},${cy - t}`,
    `L${cx + h},${cy + t}`,
    `L${cx + t},${cy + t}`,
    `L${cx + t},${cy + h}`,
    `L${cx - t},${cy + h}`,
    `L${cx - t},${cy + t}`,
    `L${cx - h},${cy + t}`,
    `L${cx - h},${cy - t}`,
    `L${cx - t},${cy - t}`,
    'Z',
  ].join('');
}

/** 菱形(polygon 4 邊、旋轉 -90 已是菱形)。 */
export function diamondPath(cx: number, cy: number, r: number): string {
  return polygonPath(cx, cy, r, 4, -90);
}

/** 圓環(evenodd fill-rule 搭配使用,由外圓減內圓)。 */
export function ringPath(cx: number, cy: number, rOuter: number, rInner: number): string {
  const outer = `M${cx - rOuter},${cy}A${rOuter},${rOuter} 0 1,0 ${cx + rOuter},${cy}A${rOuter},${rOuter} 0 1,0 ${cx - rOuter},${cy}Z`;
  const inner = `M${cx - rInner},${cy}A${rInner},${rInner} 0 1,0 ${cx + rInner},${cy}A${rInner},${rInner} 0 1,0 ${cx - rInner},${cy}Z`;
  return `${outer} ${inner}`;
}

/** 閃電(固定比例,縮放至 size)。 */
export function boltPath(cx: number, cy: number, size: number): string {
  const s = size / 20;
  const pts = [
    [2, -10],
    [-4, 1],
    [0, 1],
    [-2, 10],
    [4, -1],
    [0, -1],
  ];
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${cx + x * s},${cy + y * s}`).join('');
  return `${d}Z`;
}

/** 水波(兩道正弦曲線)。 */
export function wavePath(cx: number, cy: number, width: number, amplitude: number): string {
  const w = width / 2;
  return `M${cx - w},${cy} C${cx - w / 2},${cy - amplitude} ${cx - w / 2},${cy + amplitude} ${cx},${cy} C${cx + w / 2},${cy - amplitude} ${cx + w / 2},${cy + amplitude} ${cx + w},${cy}`;
}

/** 圓形。 */
export function circlePathAsD(cx: number, cy: number, r: number): string {
  return `M${cx - r},${cy}A${r},${r} 0 1,0 ${cx + r},${cy}A${r},${r} 0 1,0 ${cx - r},${cy}Z`;
}
