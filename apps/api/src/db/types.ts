// D1 介面的最小子集——與 Cloudflare Workers 執行環境內建的 D1Database/D1PreparedStatement
// 結構相容(duck typing,不依賴 @cloudflare/workers-types 也能通過型別檢查)。
// repository/auth 只依賴這個介面,方便測試用 better-sqlite3 adapter 取代真正的 D1(見
// apps/api/test/support/sqliteD1Adapter.ts)。

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(query: string): Promise<D1Result>;
}

/** apps/api 的 Hono Env 綁定——DB 為必要 binding,tick-cron(M8)另掛 scheduled handler。
 * ADMIN_TOKEN:POST /api/admin/season 的 bearer token(wrangler secret,未設定時該端點一律 401)。 */
export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
}
