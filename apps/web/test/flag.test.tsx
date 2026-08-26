import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Flag } from '../src/components/flag/Flag';
import { EMBLEMS, LAYOUTS } from '../src/components/flag/flagOptions';
import type { FlagSpec } from '@micronation/shared';

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('expected <svg>');
  return svg;
}

describe('Flag — 合法 spec', () => {
  it('renders one field shape for solid layout', () => {
    const spec: FlagSpec = { layout: 'solid', colors: ['#1f4e79'], emblem: 'star-5' };
    const { container } = render(<Flag spec={spec} />);
    const svg = svgOf(container);
    expect(svg.querySelectorAll('[data-shape="field"]').length).toBe(1);
    expect(svg.querySelector('[data-shape="emblem"]')).not.toBeNull();
  });

  it('renders multiple field shapes for a striped layout', () => {
    const spec: FlagSpec = { layout: 'stripes-h-3', colors: ['#1f4e79', '#0b1d2a'], emblem: 'ring' };
    const { container } = render(<Flag spec={spec} />);
    const svg = svgOf(container);
    expect(svg.querySelectorAll('[data-shape="field"]').length).toBe(3);
  });

  it('every declared layout renders without throwing', () => {
    for (const layout of LAYOUTS) {
      const spec: FlagSpec = { layout: layout.id, colors: ['#111111', '#222222', '#333333'], emblem: 'circle' };
      expect(() => render(<Flag spec={spec} />)).not.toThrow();
    }
  });

  it('every declared emblem renders a non-empty path', () => {
    for (const emblem of EMBLEMS) {
      const spec: FlagSpec = { layout: 'solid', colors: ['#111111'], emblem: emblem.id };
      const { container } = render(<Flag spec={spec} />);
      const path = svgOf(container).querySelector('[data-shape="emblem"]');
      expect(path).not.toBeNull();
      expect(path?.getAttribute('d')?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('Flag — 非法 spec 防護', () => {
  it('falls back to solid layout for unknown layout id', () => {
    const spec = { layout: 'not-a-real-layout', colors: ['#1f4e79'], emblem: 'star-5' } as FlagSpec;
    const { container } = render(<Flag spec={spec} />);
    expect(svgOf(container).getAttribute('data-layout')).toBe('solid');
  });

  it('skips emblem rendering for unknown emblem id instead of throwing', () => {
    const spec = { layout: 'solid', colors: ['#1f4e79'], emblem: 'not-a-real-emblem' } as FlagSpec;
    const { container } = render(<Flag spec={spec} />);
    expect(svgOf(container).querySelector('[data-shape="emblem"]')).toBeNull();
  });

  it('falls back to default palette when colors is empty', () => {
    const spec = { layout: 'solid', colors: [], emblem: 'star-5' } as FlagSpec;
    expect(() => render(<Flag spec={spec} />)).not.toThrow();
  });

  it('tolerates non-array colors without throwing', () => {
    const spec = { layout: 'solid', colors: null as unknown as string[], emblem: 'star-5' } as FlagSpec;
    expect(() => render(<Flag spec={spec} />)).not.toThrow();
  });

  it('pads a single color into all field/emblem slots without throwing', () => {
    const spec: FlagSpec = { layout: 'quarters', colors: ['#1f4e79'], emblem: 'wave' };
    expect(() => render(<Flag spec={spec} />)).not.toThrow();
  });
});

describe('Flag — colors 白名單(finding #16)', () => {
  it('replaces a non-hex color string with the fallback default at that position', () => {
    const spec = { layout: 'solid', colors: ['javascript:alert(1)'], emblem: 'star-5' } as FlagSpec;
    const { container } = render(<Flag spec={spec} />);
    const field = svgOf(container).querySelector('[data-shape="field"]');
    expect(field?.getAttribute('fill')).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(field?.getAttribute('fill')).not.toBe('javascript:alert(1)');
  });

  it('accepts a valid 3-digit hex color', () => {
    const spec: FlagSpec = { layout: 'solid', colors: ['#0f0'], emblem: 'star-5' };
    const { container } = render(<Flag spec={spec} />);
    const field = svgOf(container).querySelector('[data-shape="field"]');
    expect(field?.getAttribute('fill')).toBe('#0f0');
  });

  it('rejects url()/expression()-style values that are not a bare hex color', () => {
    const spec = { layout: 'solid', colors: ['url(javascript:alert(1))'], emblem: 'star-5' } as FlagSpec;
    const { container } = render(<Flag spec={spec} />);
    const field = svgOf(container).querySelector('[data-shape="field"]');
    expect(field?.getAttribute('fill')).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('emblem uses the last sanitized color, not a fixed index', () => {
    const spec: FlagSpec = { layout: 'solid', colors: ['#111111', '#222222'], emblem: 'star-5' };
    const { container } = render(<Flag spec={spec} />);
    const emblem = svgOf(container).querySelector('[data-shape="emblem"]');
    expect(emblem?.getAttribute('fill')).toBe('#222222');
  });

  it('ring emblem path uses evenodd fill-rule so the hole renders', () => {
    const spec: FlagSpec = { layout: 'solid', colors: ['#111111'], emblem: 'ring' };
    const { container } = render(<Flag spec={spec} />);
    const emblem = svgOf(container).querySelector('[data-shape="emblem"]');
    expect(emblem?.getAttribute('fill-rule')).toBe('evenodd');
  });
});
