import type { Nation, Region, Resources, ResourceKind } from '@micronation/shared';
import { BUILDING_LEVELS, ECONOMY_MODIFIERS, TAX_MODIFIERS } from '@micronation/shared';
import { RESOURCE_KINDS, zeroResources } from './resources';

/**
 * 單一 nation 在給定 region 下,一個 tick 的資源產出(尚未計入糧食消耗)。
 * 公式:區域加成 × 政策修正(economy 軸對各資源、tax 軸只影響 money)× 建築等級輸出。
 * 純函式,供 engine tick 與前端預覽 (projectProduction) 共用。
 */
export function computeProduction(nation: Nation, region: Region | undefined): Resources {
  const out = zeroResources();
  const economyMod = ECONOMY_MODIFIERS[nation.policies.economy];
  const taxMod = TAX_MODIFIERS[nation.policies.tax];

  for (const kind of Object.keys(nation.buildings) as (keyof Nation['buildings'])[]) {
    const level = nation.buildings[kind];
    if (!level || level <= 0) continue;
    const spec = BUILDING_LEVELS[kind][Math.min(level, BUILDING_LEVELS[kind].length) - 1];
    for (const rk of Object.keys(spec.output) as ResourceKind[]) {
      const base = spec.output[rk] ?? 0;
      if (base === 0) continue;
      const regionMult = 1 + (region?.bonuses[rk] ?? 0);
      const economyMult = economyMod?.[rk] ?? 1;
      const taxMult = rk === 'money' && taxMod ? taxMod.moneyMult : 1;
      out[rk] += base * regionMult * economyMult * taxMult;
    }
  }

  for (const rk of RESOURCE_KINDS) {
    out[rk] = Math.round(out[rk]);
  }
  return out;
}

/** 前端預覽用純函式:單一 nation 在指定 region 下的每 tick 產出估算。 */
export function projectProduction(nation: Nation, region: Region | undefined): Resources {
  return computeProduction(nation, region);
}
