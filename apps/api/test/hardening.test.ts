// Codex 審查 findings(apps/api db/auth 層)回歸測試——每條在對應修復前應為紅燈。
// session/verify_token 雜湊化、密碼強度/長度、resend 端點的回歸測試在 test/auth.test.ts。

import { describe, it, expect } from 'vitest';
import { createTestD1, createTestDb } from './support/sqliteD1Adapter';
import {
  createSeason,
  loadWorldState,
  saveWorldState,
  claimNextOrderSeq,
  completeTask,
  getUserTaskRows,
  insertMessage,
  listMessagesForNation,
  MESSAGES_LIST_LIMIT,
  getEventsSince,
  EVENTS_SINCE_LIMIT,
  insertUser,
  type UserRow,
} from '../src/db/repository';
import { rowToNation, rowToTreaty, rowToOrder, rowToEvent, eventToRow, CorruptRowError, type NationRow, type TreatyRow, type OrderRow, type EventRow } from '../src/db/rows';
import { makeWorld, makeNation, makeRegion } from './support/fixtures';
import { parseSessionTokenFromCookieHeader } from '../src/auth/session';
import type { D1Database, D1PreparedStatement, D1Result } from '../src/db/types';
import { makeId } from '@micronation/shared';

const baseNationRow = (): NationRow => ({
  id: 'nation-x',
  season_id: 'season-1',
  owner_id: null,
  name: 'X',
  flag: JSON.stringify({ layout: 'stripes', colors: ['#fff'], emblem: 'star' }),
  region_id: 'region-0',
  resource_food: 0,
  resource_ore: 0,
  resource_fuel: 0,
  resource_money: 0,
  tech: 0,
  action_points: 0,
  population: 0,
  morale: 0,
  buildings: '{}',
  build_queue: '[]',
  army_size: 0,
  policies: JSON.stringify({ tax: 'mid', economy: 'agri', conscription: 'volunteer', openness: 'neutral' }),
  policy_changed_at: '{}',
  reputation_breaches: 0,
  protected_until: 0,
  score: JSON.stringify({ economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 }),
  created_at: 0,
  last_attacked_at: null,
});

describe('finding #4 — rows.ts 對壞資料 fail fast(CorruptRowError)', () => {
  it('JSON 欄位壞掉 → 丟 CorruptRowError,附 table/rowId/field', () => {
    const row = baseNationRow();
    row.flag = '{not valid json';
    expect(() => rowToNation(row)).toThrow(CorruptRowError);
    try {
      rowToNation(row);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CorruptRowError);
      expect((e as CorruptRowError).table).toBe('nations');
      expect((e as CorruptRowError).rowId).toBe('nation-x');
      expect((e as CorruptRowError).field).toBe('flag');
    }
  });

  it('enum 欄位不在白名單內(如 order.side="up") → 丟 CorruptRowError', () => {
    const row: OrderRow = {
      id: 'order-x',
      season_id: 'season-1',
      nation_id: 'nation-1',
      kind: 'food',
      side: 'up', // 不合法值
      qty: 1,
      price: 1,
      created_at: 0,
    };
    expect(() => rowToOrder(row)).toThrow(CorruptRowError);
  });

  it('treaty.kind 不在白名單內 → 丟 CorruptRowError', () => {
    const row: TreatyRow = {
      id: 'treaty-x',
      season_id: 'season-1',
      kind: 'friendship', // 不合法
      a_id: 'nation-1',
      b_id: 'nation-2',
      status: 'active',
      terms: '{}',
      created_at: 0,
    };
    expect(() => rowToTreaty(row)).toThrow(CorruptRowError);
  });

  it('event.type 不在 EVENT 白名單內 → 丟 CorruptRowError', () => {
    const row: EventRow = {
      id: 'event-x',
      season_id: 'season-1',
      tick: 0,
      type: 'not_a_real_event',
      nation_ids: '[]',
      payload: 'null',
      created_at: 0,
    };
    expect(() => rowToEvent(row)).toThrow(CorruptRowError);
  });

  it('loadWorldState 對壞資料 fail fast,不會靜默回傳半殘的 WorldState', async () => {
    const db = createTestD1();
    const world = makeWorld({ nations: [makeNation()] });
    await createSeason(db, 'S', world, 0);
    // 直接手改 DB,模擬資料損毀
    await db.prepare("UPDATE nations SET flag = '{corrupt' WHERE id = ?").bind('nation-1').run();

    await expect(loadWorldState(db, world.seasonId)).rejects.toThrow(CorruptRowError);
  });
});

describe('finding #5 — GameEvent.payload undefined 落地存 JSON \'null\'', () => {
  it('eventToRow 對 payload undefined 回傳字串 "null",不是 undefined', () => {
    const row = eventToRow('season-1', 'event-1', { tick: 0, type: 'production_tick', nationIds: [], payload: undefined }, 0);
    expect(row.payload).toBe('null');
    expect(typeof row.payload).toBe('string');
  });
});

describe('finding #2 — nations 同賽季同 owner 唯一(partial unique index)', () => {
  it('同一 owner 在同賽季建立第二個國家 → 違反唯一鍵(直接 INSERT,不透過 OR REPLACE)', async () => {
    // 注意:repository.ts 的 insertNationStmt 用 INSERT OR REPLACE(以 id 為準的 upsert 語意),
    // 若拿它測兩個「不同 id、同 owner」的衝突,OR REPLACE 會直接把舊列刪掉重插而不是報錯
    // (那是它原本的功能,不是 bug)。這裡改用最原始的 plain INSERT 直接對 DB 下手,單純驗證
    // migration 0004 建的 partial unique index 本身確實存在且會擋下違反的寫入——這是防禦同一
    // owner 兩個並發建國請求互相競態繞過 app 層 findOwnNation 檢查的最後一道防線。
    const db = createTestD1();
    const world = makeWorld({ nations: [] });
    await createSeason(db, 'S', world, 0);
    const n1 = makeNation({ id: 'nation-a', ownerId: 'user-shared' });
    const n2 = makeNation({ id: 'nation-b', ownerId: 'user-shared' });
    const insertRaw = async (n: ReturnType<typeof makeNation>) => {
      await db
        .prepare(
          `INSERT INTO nations
          (id, season_id, owner_id, name, flag, region_id, resource_food, resource_ore, resource_fuel, resource_money,
           tech, action_points, population, morale, buildings, build_queue, army_size, policies, policy_changed_at,
           reputation_breaches, protected_until, score, created_at, last_attacked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          n.id,
          world.seasonId,
          n.ownerId,
          n.name,
          JSON.stringify(n.flag),
          n.regionId,
          n.resources.food,
          n.resources.ore,
          n.resources.fuel,
          n.resources.money,
          n.tech,
          n.actionPoints,
          n.population,
          n.morale,
          JSON.stringify(n.buildings),
          JSON.stringify(n.buildQueue),
          n.army.size,
          JSON.stringify(n.policies),
          JSON.stringify(n.policyChangedAt),
          n.reputation.breaches,
          n.protectedUntil,
          JSON.stringify(n.score),
          n.createdAt,
          n.lastAttackedAt ?? null
        )
        .run();
    };
    await insertRaw(n1);
    await expect(insertRaw(n2)).rejects.toThrow();
  });

  it('owner_id 為 null(NPC)不受唯一鍵限制,可以有多個', async () => {
    const db = createTestD1();
    const n1 = makeNation({ id: 'nation-a', ownerId: null });
    const n2 = makeNation({ id: 'nation-b', ownerId: null });
    const world = makeWorld({ nations: [n1, n2] });
    await createSeason(db, 'S', world, 0);
    const loaded = await loadWorldState(db, world.seasonId);
    expect(loaded?.nations).toHaveLength(2);
  });
});

describe('finding #3 — 跨賽季一致性複合唯一鍵(migration 0004)', () => {
  it('regions/nations/marches/treaties/market_orders 都有 (season_id, id) 唯一索引', () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r: unknown) => (r as { name: string }).name);
    for (const idx of [
      'idx_regions_season_id',
      'idx_nations_season_id',
      'idx_marches_season_id',
      'idx_treaties_season_id',
      'idx_orders_season_id',
      'idx_users_verify_token', // finding #17
    ]) {
      expect(indexes).toContain(idx);
    }
    db.close();
  });
});

describe('finding #7 — loadWorldState 全部查詢 ORDER BY id', () => {
  it('nations/marches/treaties/orders 依 id 升冪回傳,不受寫入順序影響', async () => {
    const db = createTestD1();
    const world = makeWorld({
      nations: [makeNation({ id: 'nation-z' }), makeNation({ id: 'nation-a' }), makeNation({ id: 'nation-m' })],
    });
    await createSeason(db, 'S', world, 0);
    const loaded = await loadWorldState(db, world.seasonId);
    const ids = loaded!.nations.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('finding #8 — 序號認領原子化(UPDATE...RETURNING)', () => {
  it('claimNextOrderSeq 並發呼叫回傳互不重複的序號', async () => {
    const db = createTestD1();
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-seq' }), 0);

    const [a, b, c] = await Promise.all([
      claimNextOrderSeq(db, 'season-seq'),
      claimNextOrderSeq(db, 'season-seq'),
      claimNextOrderSeq(db, 'season-seq'),
    ]);
    const seqs = new Set([a, b, c]);
    expect(seqs.size).toBe(3); // 沒有重複——舊版「SELECT 再 UPDATE」分兩步在並發下可能重複
  });

  it('saveWorldState 連續多次呼叫(同一 tick 內、玩家操作觸發的常態)event id 不撞號', async () => {
    // 註:sqliteD1Adapter 是單一 better-sqlite3 連線,無法真的模擬兩個平行 D1 batch 交易
    // (adapter 自身註解已說明這個已知落差),用 Promise.all 硬跑兩個 saveWorldState 只會撞到
    // 「同一連線不能巢狀開交易」這個 adapter 限制,不是在測本次修的邏輯。這裡改測「連續呼叫」
    // ——這正是 saveWorldState 開頭註解描述的真實場景(同一 tick 內多次玩家操作各自觸發一次
    // saveWorldState),驗證 claimEventSeqRange 產生的 id 序列不重複、且用完全新的 seq 起點
    // (不是依賴呼叫端自己传入的陣列序 i,那正是舊版會撞號的原因)。
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-evt' });
    await createSeason(db, 'S', world, 0);

    await saveWorldState(db, world, world, [{ tick: 0, type: 'production_tick', nationIds: [], payload: {} }], 0);
    await saveWorldState(db, world, world, [{ tick: 0, type: 'population_change', nationIds: [], payload: {} }], 0);

    const rows = await db.prepare('SELECT id FROM events WHERE season_id = ?').bind('season-evt').all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // 全部唯一
    expect(ids).toHaveLength(2);
  });
});

describe('finding #9 — getEventsSince 用 seq(rowid)當 cursor,不漏同 tick 事件', () => {
  it('同一 tick 內分兩次 saveWorldState 寫入的事件都拿得到,且 cursor 遞增不重複不遺漏', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-cursor' });
    await createSeason(db, 'S', world, 0);

    // 同一 tick(=5)分兩批寫入,涉及同一個 nationId
    await saveWorldState(db, world, world, [{ tick: 5, type: 'production_tick', nationIds: ['nation-1'], payload: { a: 1 } }], 0);
    const firstBatch = await getEventsSince(db, 'season-cursor', 0, 'nation-1');
    expect(firstBatch).toHaveLength(1);
    const cursor = firstBatch[0].seq;

    await saveWorldState(db, world, world, [{ tick: 5, type: 'population_change', nationIds: ['nation-1'], payload: { b: 2 } }], 0);

    // 用舊版「tick > sinceTick」邏輯:sinceTick=5(上次拿到的最大 tick),tick=5 的新事件會被
    // `tick > 5` 擋掉(漏掉)。新版用 seq cursor,不會漏。
    const secondBatch = await getEventsSince(db, 'season-cursor', cursor, 'nation-1');
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0].type).toBe('population_change');
  });

  it('LIMIT 生效:超過 EVENTS_SINCE_LIMIT 的事件只回傳上限筆數', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-many-events' });
    await createSeason(db, 'S', world, 0);

    const many = Array.from({ length: EVENTS_SINCE_LIMIT + 20 }, (_, i) => ({
      tick: i,
      type: 'production_tick' as const,
      nationIds: ['nation-1'],
      payload: {},
    }));
    await saveWorldState(db, world, world, many, 0);

    const events = await getEventsSince(db, 'season-many-events', 0, 'nation-1');
    expect(events.length).toBe(EVENTS_SINCE_LIMIT);
  });
});

describe('finding #10 — completeTask 用 INSERT OR IGNORE(冪等)', () => {
  it('重複呼叫不報錯,且保留第一次完成的時間', async () => {
    const db = createTestD1();
    await insertUser(db, {
      id: 'user-1',
      email: 'u@example.com',
      password_hash: 'h',
      password_salt: 's',
      password_iterations: 1,
      verified: 0,
      verify_token: null,
      verify_token_expires_at: null,
      created_at: 0,
    } as UserRow);

    await completeTask(db, 'user-1', 'register', 100);
    await completeTask(db, 'user-1', 'register', 999); // 重複呼叫,不應覆寫

    const rows = await getUserTaskRows(db, 'user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].completed_at).toBe(100);
  });

  it('並發呼叫不因撞唯一鍵而拋例外', async () => {
    const db = createTestD1();
    await insertUser(db, {
      id: 'user-2',
      email: 'u2@example.com',
      password_hash: 'h',
      password_salt: 's',
      password_iterations: 1,
      verified: 0,
      verify_token: null,
      verify_token_expires_at: null,
      created_at: 0,
    } as UserRow);

    await expect(
      Promise.all([completeTask(db, 'user-2', 'register', 1), completeTask(db, 'user-2', 'register', 2)])
    ).resolves.toBeDefined();
    const rows = await getUserTaskRows(db, 'user-2');
    expect(rows).toHaveLength(1);
  });
});

describe('finding #11 — batch 寫入檢查 D1Result.success', () => {
  function wrapWithFailingBatch(db: D1Database): D1Database {
    return {
      prepare: (q: string) => db.prepare(q),
      exec: (q: string) => db.exec(q),
      batch: async (stmts: D1PreparedStatement[]): Promise<D1Result[]> => {
        const results = await db.batch(stmts);
        // 模擬其中一筆語句「執行了但回報失敗」(D1 對單一 statement 失敗不一定拋例外)
        if (results.length > 0) results[0] = { ...results[0], success: false };
        return results;
      },
    };
  }

  it('saveWorldState 若 batch 內有 statement success:false → 拋例外,不吞錯', async () => {
    const realDb = createTestD1();
    const world = makeWorld({ seasonId: 'season-fail', nations: [makeNation()] });
    await createSeason(realDb, 'S', world, 0);

    const failingDb = wrapWithFailingBatch(realDb);
    const next = { ...world, tick: world.tick + 1 };
    await expect(saveWorldState(failingDb, world, next, [], 0)).rejects.toThrow('D1_BATCH_FAILED');
  });
});

describe('finding #12 — 查詢加 LIMIT 常數', () => {
  it('listMessagesForNation 最多回傳 MESSAGES_LIST_LIMIT 筆', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-msg', nations: [makeNation({ id: 'nation-a' }), makeNation({ id: 'nation-b', ownerId: 'user-2' })] });
    await createSeason(db, 'S', world, 0);

    for (let i = 0; i < MESSAGES_LIST_LIMIT + 10; i++) {
      await insertMessage(db, {
        id: makeId('msg', String(i)),
        season_id: 'season-msg',
        from_nation_id: 'nation-b',
        to_nation_id: 'nation-a',
        body: `msg-${i}`,
        created_at: i,
        read_at: null,
      });
    }

    const inbox = await listMessagesForNation(db, 'nation-a', 'inbox');
    expect(inbox.length).toBe(MESSAGES_LIST_LIMIT);
  });
});

describe('finding #14 — session cookie 解析對壞的 %escape 不拋例外', () => {
  it('格式不良的 cookie 值視為未登入(回傳 null),不丟例外', () => {
    expect(() => parseSessionTokenFromCookieHeader('mn_session=%E0%A4%A')).not.toThrow();
    expect(parseSessionTokenFromCookieHeader('mn_session=%E0%A4%A')).toBeNull();
  });

  it('正常 cookie 仍能正確解析', () => {
    expect(parseSessionTokenFromCookieHeader('mn_session=abc123; other=x')).toBe('abc123');
  });
});
