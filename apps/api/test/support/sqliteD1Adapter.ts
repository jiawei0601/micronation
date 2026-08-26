// 測試專用 adapter——用 better-sqlite3 模擬 D1Database 介面(見 src/db/types.ts)。
//
// 為什麼不用 @cloudflare/vitest-pool-workers:該套件要求 vitest ^4.1.0,而本 monorepo
// root/其餘 packages 全部固定在 vitest ^2.1.0(單一 vitest.workspace.ts 跨全 workspace
// 跑測試),混版會破壞 root `npm test`。故依 M6 任務指示的退路,改用本 adapter 對
// repository/auth 做真實 SQL 的整合測試,純邏輯層與 D1 的介面契約一致(duck typing)。
// 已知落差:沒有真正的 D1 batch 交易語意(這裡逐條 run,不保證原子性),D1 專屬錯誤
// (如網路重試)也測不到——這兩點留給 M7 接上真正 wrangler/miniflare 時補。

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { D1Database, D1PreparedStatement, D1Result, D1ExecResult } from '../../src/db/types';

class SqliteD1Statement implements D1PreparedStatement {
  constructor(
    private readonly db: InstanceType<typeof Database>,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1Statement(this.db, this.sql, values);
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results: rows, success: true };
  }

  async run(): Promise<D1Result> {
    this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true };
  }
}

export class SqliteD1Adapter implements D1Database {
  constructor(private readonly db: InstanceType<typeof Database>) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.db, query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    // better-sqlite3 的 .transaction() callback 必須同步,而 D1PreparedStatement.run() 回傳
    // Promise(對齊真正 D1 的非同步介面),故這裡手動包 BEGIN/COMMIT/ROLLBACK 而非用 db.transaction()。
    this.db.exec('BEGIN');
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return results;
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.db.exec(query);
    return { count: 0, duration: 0 };
  }
}

export function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  // 明確關掉 foreign_keys——比照 D1 預設行為(FK 不強制),避免測試 fixture 需要湊齊
  // 完整關聯鏈(user/region 等)才能寫入,同時貼近真正 D1 的約束強度。
  db.pragma('foreign_keys = OFF');
  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
  for (const file of ['0001_init.sql']) {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
  }
  return db;
}

export function createTestD1(): D1Database {
  return new SqliteD1Adapter(createTestDb());
}
