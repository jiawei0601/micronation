// 確定性 PRNG——mulberry32 + 字串雜湊 seed。純函式模塊(engine/market/...)一律透過此處取得隨機數,
// 禁止直接使用 Math.random()。

export type Rng = () => number; // 回傳 [0, 1)

function hashStringToSeed(str: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed: string): Rng {
  return mulberry32(hashStringToSeed(seed));
}

// [min, max) 均勻分布輔助函式
export function rngRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}
