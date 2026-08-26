import { describe, it, expect } from 'vitest';
import { createRng } from '../src/rng';

describe('createRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng('season-1-tick-42');
    const b = createRng('season-1-tick-42');
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = createRng('seed-a');
    const b = createRng('seed-b');
    expect(a()).not.toEqual(b());
  });

  it('produces values within [0, 1)', () => {
    const rng = createRng('range-check');
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
