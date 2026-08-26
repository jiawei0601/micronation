import { describe, it, expect } from 'vitest';
import { ok, err } from '../src/result';

describe('Result helpers', () => {
  it('ok() wraps a value as a success result', () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it('err() wraps a message as a failure result', () => {
    const r = err('PRICE_BAND');
    expect(r).toEqual({ ok: false, error: 'PRICE_BAND' });
  });
});
