import { describe, it, expect } from 'vitest';
import {
  formatInt,
  formatDelta,
  formatPercent,
  formatTicksAsDuration,
  formatCountdownMinutes,
} from '../src/lib/format';

describe('formatInt', () => {
  it('formats with thousands separator', () => {
    expect(formatInt(12480)).toBe('12,480');
  });
  it('rounds fractional values', () => {
    expect(formatInt(12.6)).toBe('13');
  });
  it('returns em-dash for non-finite input', () => {
    expect(formatInt(NaN)).toBe('—');
    expect(formatInt(Infinity)).toBe('—');
  });
});

describe('formatDelta', () => {
  it('prefixes positive values with +', () => {
    expect(formatDelta(312)).toBe('+312');
  });
  it('prefixes negative values with full-width minus', () => {
    expect(formatDelta(-42)).toBe('−42');
  });
  it('renders exact zero as 0', () => {
    expect(formatDelta(0)).toBe('0');
  });
  it('returns em-dash for non-finite input', () => {
    expect(formatDelta(NaN)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('converts 0-1 ratio to percent string', () => {
    expect(formatPercent(0.625)).toBe('63%');
  });
  it('supports fixed digits', () => {
    expect(formatPercent(0.625, 1)).toBe('62.5%');
  });
});

describe('formatTicksAsDuration', () => {
  it('shows hours under a day', () => {
    expect(formatTicksAsDuration(6)).toBe('6 小時');
  });
  it('shows days and hours over a day', () => {
    expect(formatTicksAsDuration(30)).toBe('1 天 6 小時');
  });
  it('shows whole days with no remainder', () => {
    expect(formatTicksAsDuration(48)).toBe('2 天');
  });
  it('returns em-dash for negative input', () => {
    expect(formatTicksAsDuration(-1)).toBe('—');
  });
});

describe('formatCountdownMinutes', () => {
  it('rounds up to whole minutes', () => {
    expect(formatCountdownMinutes(61)).toBe('2 分鐘後');
  });
  it('handles exact minutes', () => {
    expect(formatCountdownMinutes(120)).toBe('2 分鐘後');
  });
});
