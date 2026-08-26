export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(error: string): Result<T> {
  return { ok: false, error };
}

/** 純字串組合的確定性 id 工具——不得用 Date.now/crypto,供純函式模塊產生可重現 id。 */
export function makeId(prefix: string, ...parts: (string | number)[]): string {
  return [prefix, ...parts].join('-');
}
