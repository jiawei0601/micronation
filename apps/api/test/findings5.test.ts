// Codex 五審 apps/api findings 回歸測試(對應派工清單①-④)。修復前(舊行為)這些斷言會紅。
// ①(resend token 保留競態)與④(cleanupExpiredVerificationTokens 移到 runTick 最前)的回歸
// 測試併入 findings4.test.ts / tick.test.ts 既有分類,不在此檔重複。這裡放②(runBatch/
// EMAIL_TAKEN 契約)與③(verification_tokens.expires_at 索引)。

import { describe, it, expect } from 'vitest';
import { createTestDb, SqliteD1Adapter } from './support/sqliteD1Adapter';
import { register } from '../src/auth/service';
import { ConsoleMailSender } from '../src/auth/mail';
import {
  insertUserWithVerificationToken,
  findUserByEmail,
  type UserRow,
} from '../src/db/repository';
import type { D1Database, D1PreparedStatement, D1Result } from '../src/db/types';

/** 把一個真正的 D1Database(sqliteD1Adapter)包一層——batch() 對「單一 statement 執行時拋出
 * 原生例外」的情況,不讓例外往外冒(不 reject),改成回傳 success:false + 一個不含
 * "unique constraint" 字樣的 opaque error 訊息。用來模擬派工單指出的情況:「D1 對 batch 內
 * 單一 statement 失敗不保證拋例外,依 driver/後端而定」——runBatch 目前雖然有處理
 * success:false(見其開頭註解與 runBatch 實作),但呼叫端(register 的 EMAIL_TAKEN 轉譯)原本
 * 依賴「捕捉到的例外訊息含 unique constraint 字樣」來判斷是不是 EMAIL_TAKEN,opaque 錯誤訊息
 * 會讓這個判斷失效。也刻意不做真正的 rollback(哪個 statement 先跑先落地),貼近「不保證原子性」這個
 * 已知落差(見 sqliteD1Adapter.ts 檔頭註解)。 */
function wrapWithOpaqueBatchFailures(db: D1Database): D1Database {
  return {
    prepare: (q: string) => db.prepare(q),
    exec: (q: string) => db.exec(q),
    batch: async (stmts: D1PreparedStatement[]): Promise<D1Result[]> => {
      const results: D1Result[] = [];
      for (const stmt of stmts) {
        try {
          results.push(await stmt.run());
        } catch {
          results.push({ results: [], success: false, error: 'D1_OPAQUE_CONSTRAINT_VIOLATION' });
        }
      }
      return results;
    },
  };
}

describe('② — runBatch 錯誤訊息附上 D1Result.error', () => {
  it('D1Database.batch() 回傳 success:false + error 時,runBatch 拋出的訊息包含該 error 內容', async () => {
    const failingDb: D1Database = {
      prepare: () => ({
        bind: () => ({
          bind: () => {
            throw new Error('not implemented');
          },
          first: async () => null,
          all: async () => ({ results: [], success: true }),
          run: async () => ({ results: [], success: false, error: 'SQLITE_BUSY: database is locked' }),
        }),
        first: async () => null,
        all: async () => ({ results: [], success: true }),
        run: async () => ({ results: [], success: false, error: 'SQLITE_BUSY: database is locked' }),
      }),
      batch: async (stmts) => {
        const results: D1Result[] = [];
        for (const s of stmts) results.push(await s.run());
        return results;
      },
      exec: async () => ({ count: 0, duration: 0 }),
    };

    const userRow: UserRow = {
      id: 'user-err-content',
      email: 'errcontent@example.com',
      password_hash: 'h',
      password_salt: 's',
      password_iterations: 1,
      verified: 0,
      created_at: 0,
    };
    await expect(
      insertUserWithVerificationToken(failingDb, userRow, {
        token_hash: 'tok-err-content',
        user_id: 'user-err-content',
        expires_at: 1,
        created_at: 0,
      })
    ).rejects.toThrow('SQLITE_BUSY: database is locked');
  });
});

describe('② — register()：db.batch() success:false 不 reject 時,EMAIL_TAKEN 仍正確轉譯', () => {
  it('email 已存在、batch 失敗訊息不含 "unique constraint" 字樣(opaque driver 錯誤)時,fallback 查表仍回 EMAIL_TAKEN', async () => {
    const rawDb = createTestDb();
    const realDb = new SqliteD1Adapter(rawDb);
    const mail = new ConsoleMailSender();

    // 先用真正的 db 註冊一次,建立會撞號的既有 email。
    const first = await register(realDb, mail, 'opaque@example.com', 'password123', 0);
    expect(first.ok).toBe(true);

    // 第二次註冊改用「batch 失敗不拋例外、且錯誤訊息是 opaque 字串」的包裝 db——模擬派工單
    // 描述的情況:D1 對 batch 內單一 statement 失敗不保證拋出可解析的原生例外。
    const wrapped = wrapWithOpaqueBatchFailures(realDb);
    const second = await register(wrapped, mail, 'opaque@example.com', 'another-pass', 1);

    // 修復前:isUniqueConstraintErrorOn 對 opaque 錯誤訊息比對失敗,又沒有 fallback,這裡會是
    // 未預期的 throw(traceable 但不是 EMAIL_TAKEN),測試在這裡就會失敗。
    expect(second).toEqual({ ok: false, error: 'EMAIL_TAKEN' });

    // 且沒有因為這次失敗的嘗試而多出一筆同 email 的 user(fallback 只查詢、不寫入)。
    const count = await rawDb
      .prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?')
      .get('opaque@example.com') as { n: number };
    expect(count.n).toBe(1);
  });

  it('email 不存在時,即使 batch opaque 失敗,fallback 查無此人 → 原始例外原樣往上拋(不是誤判成 EMAIL_TAKEN 或靜默吞掉)', async () => {
    const rawDb = createTestDb();
    const realDb = new SqliteD1Adapter(rawDb);

    // 讓 batch 內每個 statement 都回 success:false(非 unique 撞號,單純模擬其他故障,如
    // SQLITE_BUSY/連線中斷),email 事先不存在——fallback 的 findUserByEmail 查無此人,
    // 應該保留原始例外往上拋,而不是被誤判成 EMAIL_TAKEN。
    const alwaysFailDb: D1Database = {
      prepare: (q: string) => realDb.prepare(q),
      exec: (q: string) => realDb.exec(q),
      batch: async (stmts: D1PreparedStatement[]) =>
        stmts.map(() => ({ results: [], success: false, error: 'SQLITE_BUSY' }) as D1Result),
    };

    const mail = new ConsoleMailSender();
    await expect(register(alwaysFailDb, mail, 'nobody-yet@example.com', 'password123', 0)).rejects.toThrow();

    const found = await findUserByEmail(realDb, 'nobody-yet@example.com');
    expect(found).toBeNull();
  });
});

describe('③ — verification_tokens.expires_at 有索引', () => {
  it('sqlite_master 存在以 expires_at 為鍵的索引(idx_verification_tokens_expires)', () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='verification_tokens'")
      .all() as { name: string; sql: string | null }[];
    const hit = indexes.find((i) => i.sql && /expires_at/i.test(i.sql));
    expect(hit).toBeDefined();
    db.close();
  });
});
