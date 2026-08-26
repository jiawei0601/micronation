import type { Resources, ResourceKind } from '@micronation/shared';

export const RESOURCE_KINDS: ResourceKind[] = ['food', 'ore', 'fuel', 'money'];

export function zeroResources(): Resources {
  return { food: 0, ore: 0, fuel: 0, money: 0 };
}

export function cloneResources(r: Resources): Resources {
  return { ...r };
}

export function addResources(a: Resources, b: Partial<Record<ResourceKind, number>>): Resources {
  const out = cloneResources(a);
  for (const k of RESOURCE_KINDS) {
    out[k] += b[k] ?? 0;
  }
  return out;
}

export function clampNonNegative(r: Resources): Resources {
  const out = cloneResources(r);
  for (const k of RESOURCE_KINDS) {
    if (out[k] < 0) out[k] = 0;
  }
  return out;
}
