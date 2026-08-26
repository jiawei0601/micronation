// 數值顯示 formatter——集中處理千分位、正負號、時間倒數,元件不得自己拼字串。

/** 千分位整數顯示,非有限數一律回傳 '—'。 */
export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('zh-Hant-TW');
}

/** 帶正負號的增減量,例如 +312 / −42(全形負號避免與連字號混淆)。0 顯示 '0'。 */
export function formatDelta(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  if (rounded > 0) return `+${rounded.toLocaleString('zh-Hant-TW')}`;
  if (rounded < 0) return `−${Math.abs(rounded).toLocaleString('zh-Hant-TW')}`;
  return '0';
}

/** 百分比顯示,input 為 0~1 小數。 */
export function formatPercent(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** tick 數轉為約略時間文字(每 tick = 1 小時)。 */
export function formatTicksAsDuration(ticks: number): string {
  if (!Number.isFinite(ticks) || ticks < 0) return '—';
  const whole = Math.floor(ticks);
  if (whole < 24) return `${whole} 小時`;
  const days = Math.floor(whole / 24);
  const hours = whole % 24;
  return hours === 0 ? `${days} 天` : `${days} 天 ${hours} 小時`;
}

/** 下次 tick 倒數(分鐘),用於 45s 輪詢 UI 顯示,傳入距下個整點的秒數。 */
export function formatCountdownMinutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} 分鐘後`;
}
