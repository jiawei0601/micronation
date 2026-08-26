import { describe, it, expect } from 'vitest';
import { createTestDb } from './support/sqliteD1Adapter';

describe('migration 0001_init.sql', () => {
  it('可跑,建出全部合約列出的資料表', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'seasons',
        'regions',
        'nations',
        'users',
        'sessions',
        'market_orders',
        'trades',
        'treaties',
        'marches',
        'events',
        'tasks',
        'hall_of_fame',
      ])
    );
    db.close();
  });
});
