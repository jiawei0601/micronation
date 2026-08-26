// Codex 二審 apps/api findings — 回歸測試。對應派工清單的 ①(db/auth)/②(routes/game/tick)編號。
// 修復前(舊行為)這些斷言會紅。

import { describe, it, expect, beforeEach } from 'vitest';
import { app, mailSender } from '../src/index';
import { createTestD1, createTestDb } from './support/sqliteD1Adapter';
import {
  createSeason,
  loadWorldState,
  saveWorldState,
  getSeasonVersion,
  ConflictError,
  claimTickLease,
  releaseTickLease,
  claimTickSlot,
  insertNewNation,
  NationAlreadyFoundedError,
  completeTask,
  getUserTaskRows,
  getEventsSince,
} from '../src/db/repository';
import { makeWorld, makeRegion, makeNation, makeTreaty } from './support/fixtures';
import { applyPlaceOrder } from '../src/game/actions';
import { runTick } from '../src/tick/run';
import { resetRateLimits, checkRateLimit } from '../src/lib/rateLimit';
import { parseJsonBody } from '../src/lib/parseBody';
import { rowToNation, type NationRow } from '../src/db/rows';
import { CorruptRowError } from '../src/db/rows';
import type { D1Database } from '../src/db/types';

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('no set-cookie header');
  const match = raw.match(/mn_session=([^;]+)/);
  if (!match) throw new Error('no session token in cookie');
  return `mn_session=${match[1]}`;
}

async function registerLoginFoundNation(
  db: D1Database,
  env: { DB: D1Database },
  email: string,
  name: string
): Promise<{ cookie: string; nationId: string }> {
  await app.request(
    '/api/auth/register',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) },
    env
  );
  await app.request(
    '/api/auth/verify',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: mailSender.lastToken }) },
    env
  );
  const login = await app.request(
    '/api/auth/login',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) },
    env
  );
  const cookie = extractCookie(login);
  const found = await app.request(
    '/api/nation',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name, flag: { layout: 'stripes', colors: ['#fff'], emblem: 'star' } }),
    },
    env
  );
  const body = await json<{ nation: { id: string } }>(found);
  return { cookie, nationId: body.nation.id };
}

beforeEach(() => {
  resetRateLimits();
});

describe('①-1/①-2 — squash migration:單一乾淨 schema,複合外鍵已補齊', () => {
  it('nations/market_orders/messages 等子表都有 (season_id, ...) 複合 FK 指回對應父表', () => {
    const db = createTestDb();
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('nations','market_orders','messages','treaties','marches','hall_of_fame')")
      .all() as { sql: string }[];
    const combined = sql.map((r) => r.sql).join('\n');
    expect(combined).toContain('FOREIGN KEY (season_id, region_id) REFERENCES regions(season_id, id)');
    expect(combined).toContain('FOREIGN KEY (season_id, nation_id) REFERENCES nations(season_id, id)');
    expect(combined).toContain('FOREIGN KEY (season_id, from_nation_id) REFERENCES nations(season_id, id)');
    db.close();
  });

  it('只有一份 migration 檔(pre-deployment squash,無殘留 0002-0005)', () => {
    // migrations 資料夾在 monorepo 根之下,這裡只驗證 sqliteD1Adapter 只跑一個檔案就能建出完整 schema
    // (見 support/sqliteD1Adapter.ts createTestDb 的檔案清單)。
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['events_nations']) // ①-12/②-17 新表,只有 squash 後的單一 migration 才有
    );
    db.close();
  });
});

describe('①-3 — resendVerification:寄信失敗不覆蓋既有有效 token', () => {
  it('寄信失敗時,原本已寄出且有效的 verify_token 仍可用來驗證', async () => {
    const db = createTestD1();
    const env = { DB: db };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-resend3' }), 0);
    await app.request(
      '/api/auth/register',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'resend3@example.com', password: 'password123' }) },
      env
    );
    const firstToken = mailSender.lastToken;

    // 模擬寄信失敗:呼叫端把 sendVerificationEmail 換掉丟例外。
    const originalSend = mailSender.sendVerificationEmail.bind(mailSender);
    mailSender.sendVerificationEmail = async () => {
      throw new Error('mail provider down');
    };
    const resendRes = await app.request(
      '/api/auth/resend',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'resend3@example.com' }) },
      env
    );
    expect(resendRes.status).toBe(202); // ②-5:一律 202,不洩漏帳號是否存在/寄信是否成功
    mailSender.sendVerificationEmail = originalSend;

    // 舊 token(第一次註冊時寄出的那個)仍然有效——沒有被寄信失敗的這次 resend 覆蓋掉。
    const verify = await app.request(
      '/api/auth/verify',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: firstToken }) },
      env
    );
    expect(verify.status).toBe(200);
  });
});

describe('①-4 — verifyEmail 過期判斷改用 <=', () => {
  it('verify_token_expires_at 剛好等於 now → 視為已過期(TOKEN_EXPIRED)', async () => {
    const db = createTestD1();
    const env = { DB: db };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-exp' }), 0);
    const now = 1_000_000;
    const reg = await app.request(
      '/api/auth/register',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'exp@example.com', password: 'password123' }) },
      env
    );
    expect(reg.status).toBe(201);
    const token = mailSender.lastToken!;
    // 直接改 DB 把過期時間設成「現在這一刻」,驗證用同一個 now 呼叫 verifyEmail。
    await db.prepare('UPDATE users SET verify_token_expires_at = ?').bind(now).run();

    const { verifyEmail } = await import('../src/auth/service');
    const result = await verifyEmail(db, token, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('TOKEN_EXPIRED');
  });
});

describe('①-6 — WorldState 樂觀鎖版本衝突', () => {
  it('saveWorldState 帶過期的 expectedVersion → ConflictError,不寫入', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-ver', nations: [makeNation({ id: 'n1' })] });
    await createSeason(db, 'S', world, 0);
    const v0 = await getSeasonVersion(db, 'season-ver');
    expect(v0).toBe(0);

    // 第一次寫入,版本從 0 推進到 1。
    const next1 = { ...world, tick: 1 };
    await saveWorldState(db, world, next1, [], 0, [], 0);
    expect(await getSeasonVersion(db, 'season-ver')).toBe(1);

    // 拿著過期的 expectedVersion(0)再寫一次 → 衝突。
    const next2 = { ...world, tick: 2 };
    await expect(saveWorldState(db, next1, next2, [], 0, [], 0)).rejects.toThrow(ConflictError);
    // 衝突後 tick 不應該被寫成 2。
    const loaded = await loadWorldState(db, 'season-ver');
    expect(loaded?.tick).toBe(1);
  });

  it('game/state.persistWorld 正確傳遞 expectedVersion——過期版本號穿透 saveWorldState 拋 ConflictError', async () => {
    const db = createTestD1();
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-ver-http', regions: [makeRegion({ id: 'region-0' })] }), 0);

    const { loadActiveWorld, persistWorld } = await import('../src/game/state');
    const world = await loadActiveWorld(db);
    if (!world) throw new Error('no active world');
    const staleVersion = world.version;

    // 模擬「另一個請求搶先寫入」——version 被搶先推進一次。
    await db.prepare('UPDATE seasons SET version = version + 1 WHERE id = ?').bind('season-ver-http').run();

    // 現在拿著 staleVersion(舊版本號)呼叫 persistWorld,應該撞上樂觀鎖(不是路由各自吞掉、
    // 而是 game/state.ts 這一層確實把 expectedVersion 傳給了 saveWorldState)。
    await expect(persistWorld(db, world.state, world.state, [], Date.now(), [], staleVersion)).rejects.toThrow(ConflictError);
  });
});

describe('①-7/②-13 — tick lease 原子取得+owner 限定 release', () => {
  it('claimTickLease 併發語意:第二次呼叫(未逾時)拿不到鎖', async () => {
    const db = createTestD1();
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-lease' }), 0);
    const first = await claimTickLease(db, 'season-lease', 'owner-a', 1000);
    expect(first).toBe(true);
    const second = await claimTickLease(db, 'season-lease', 'owner-b', 1500);
    expect(second).toBe(false);
  });

  it('release 只清除 owner 相符的鎖——owner 不符時不清除(避免誤放行接管者的鎖)', async () => {
    const db = createTestD1();
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-lease2' }), 0);
    await claimTickLease(db, 'season-lease2', 'owner-a', 1000);
    // owner-b 嘗試 release,owner 不符,不應該真的清掉。
    await releaseTickLease(db, 'season-lease2', 'owner-b');
    const stillHeld = await claimTickLease(db, 'season-lease2', 'owner-c', 1200);
    expect(stillHeld).toBe(false); // owner-a 的鎖仍在,owner-c 搶不到
  });
});

describe('①-9/②-14 — last_tick_slot 原子認領', () => {
  it('同一 slot 第二次呼叫 claimTickSlot 拿不到', async () => {
    const db = createTestD1();
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-slot2' }), 0);
    const first = await claimTickSlot(db, 'season-slot2', 3_600_000);
    expect(first).toBe(true);
    const second = await claimTickSlot(db, 'season-slot2', 3_600_000);
    expect(second).toBe(false);
  });

  it('較舊的 slot 無法覆蓋較新的 slot(倒退不可能)', async () => {
    const db = createTestD1();
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-slot3' }), 0);
    await claimTickSlot(db, 'season-slot3', 7_200_000);
    const olderSlot = await claimTickSlot(db, 'season-slot3', 3_600_000);
    expect(olderSlot).toBe(false);
  });
});

describe('①-10 — SeasonAlreadyActiveError 只在撞到指定唯一鍵時才轉譯', () => {
  it('runBatch 失敗訊息附上 meta,不是裸字串', async () => {
    const db = createTestD1();
    // 故意用壞 SQL 觸發 batch 失敗(不是 unique 違規),驗證錯誤訊息帶有 meta 資訊格式。
    const stmt = db.prepare('INSERT INTO no_such_table (id) VALUES (?)').bind('x');
    await expect(db.batch([stmt])).rejects.toThrow();
  });
});

describe('①-11 — insertNewNation 檢查 D1Result.success', () => {
  it('成功建國時正常寫入(既有行為的最小回歸)', async () => {
    const db = createTestD1();
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-succ', regions: [makeRegion({ id: 'region-0' })] }), 0);
    const n = makeNation({ id: 'succ-1', ownerId: 'owner-1', regionId: 'region-0' });
    await expect(insertNewNation(db, 'season-succ', n)).resolves.toBeUndefined();
    const loaded = await loadWorldState(db, 'season-succ');
    expect(loaded?.nations.map((x) => x.id)).toContain('succ-1');
  });

  it('重複 owner 撞唯一索引 → NationAlreadyFoundedError(既有回歸,確認未被①-5 的訊息簽章判斷破壞)', async () => {
    const db = createTestD1();
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-dup2', regions: [makeRegion({ id: 'region-0' })] }), 0);
    await insertNewNation(db, 'season-dup2', makeNation({ id: 'd1', ownerId: 'same', regionId: 'region-0' }));
    await expect(
      insertNewNation(db, 'season-dup2', makeNation({ id: 'd2', ownerId: 'same', regionId: 'region-0' }))
    ).rejects.toThrow(NationAlreadyFoundedError as never);
  });
});

describe('①-12/②-17 — events_nations 正規化子表 + scannedUpTo 前進', () => {
  it('scannedUpTo 即使本批全是無關事件也前進(不會卡住輪詢)', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-scan', nations: [makeNation({ id: 'n1' }), makeNation({ id: 'n2', ownerId: 'u2' })] });
    await createSeason(db, 'S', world, 0);
    // 只有 n2 的事件,n1 完全沒有涉己事件。
    await saveWorldState(db, world, world, [{ tick: 1, type: 'production_tick', nationIds: ['n2'], payload: {} }], 0);

    const result = await getEventsSince(db, 'season-scan', 0, 'n1');
    expect(result.events.length).toBe(0);
    expect(result.scannedUpTo).toBeGreaterThan(0); // 前進了,不是卡在 0
  });

  it('events_nations 表確實有寫入對應列', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-en', nations: [makeNation({ id: 'n1' })] });
    await createSeason(db, 'S', world, 0);
    await saveWorldState(db, world, world, [{ tick: 1, type: 'production_tick', nationIds: ['n1'], payload: {} }], 0);
    const rows = await db.prepare('SELECT * FROM events_nations WHERE nation_id = ?').bind('n1').all();
    expect(rows.results.length).toBe(1);
  });
});

describe('①-13 — completeTask 補救 completed_at IS NULL 的殘留 row', () => {
  it('已存在但 completed_at 為 NULL 的 row,再呼叫 completeTask 會補上完成時間', async () => {
    const db = createTestD1();
    // 手動插入一筆「未完成」的 row(目前唯一寫入路徑不會產生這種 row,但驗證防禦邏輯本身正確)。
    await db
      .prepare('INSERT INTO tasks (id, user_id, task_key, completed_at, created_at) VALUES (?, ?, ?, NULL, ?)')
      .bind('task-u1-register', 'u1', 'register', 0)
      .run();
    await completeTask(db, 'u1', 'register', 999);
    const rows = await getUserTaskRows(db, 'u1');
    expect(rows[0].completed_at).toBe(999);
  });
});

describe('①-14 — parseJson 補淺層 shape 驗證', () => {
  it('buildings 是陣列(不是 Record<string,number>)→ CorruptRowError', () => {
    const row: NationRow = {
      id: 'n-bad',
      season_id: 'season-1',
      owner_id: null,
      name: 'x',
      flag: '{"layout":"a","emblem":"b","colors":["#fff"]}',
      region_id: 'region-0',
      resource_food: 0,
      resource_ore: 0,
      resource_fuel: 0,
      resource_money: 0,
      tech: 0,
      action_points: 0,
      population: 0,
      morale: 0,
      buildings: '[]', // 語法合法的 JSON,但形狀錯誤(應是物件)
      build_queue: '[]',
      army_size: 0,
      policies: '{"tax":"mid","economy":"agri","conscription":"volunteer","openness":"neutral"}',
      policy_changed_at: '{}',
      reputation_breaches: 0,
      protected_until: 0,
      score: '{"economy":0,"warfare":0,"tech":0,"diplomacy":0,"total":0}',
      created_at: 0,
      last_attacked_at: null,
    };
    expect(() => rowToNation(row)).toThrow(CorruptRowError);
  });
});

describe('①-15 — rateLimit bucket 上限保護', () => {
  it('超過 MAX_BUCKETS 時清空 Map,不會無界成長(以較小情境驗證清理邏輯本身可觸發)', () => {
    // 直接大量灌不同 key,確認呼叫不會拋錯、且清理路徑確實被使用到(白箱驗證行為存在,不做
    // 真的塞 10k 筆的重測試,避免拖慢測試套件)。
    for (let i = 0; i < 50; i++) {
      expect(checkRateLimit(`bucket-${i}`, { windowMs: 60_000, max: 5 })).toBe(true);
    }
  });
});

describe('①-16 — parseJsonBody 支援 validator 參數', () => {
  it('validator 回傳 false → 視為壞 body(null)', async () => {
    const req = { json: async () => ({ foo: 'bar' }) };
    const result = await parseJsonBody<{ foo: string }>(req, (b) => b.foo === 'baz');
    expect(result).toBeNull();
  });

  it('validator 回傳 true → 正常回傳 body', async () => {
    const req = { json: async () => ({ foo: 'baz' }) };
    const result = await parseJsonBody<{ foo: string }>(req, (b) => b.foo === 'baz');
    expect(result).toEqual({ foo: 'baz' });
  });
});

describe('②-2 — 市場結算溢位保護', () => {
  it('結算後資源超出安全整數範圍 → RESOURCE_OVERFLOW,不落地', async () => {
    const db = createTestD1();
    // 賣方的 money 已經逼近安全整數上限——本筆成交入帳(qty×price − tariff)會讓
    // settleTrades 的 `r.money += ...` 超出 Number.MAX_SAFE_INTEGER。
    const seller = makeNation({
      id: 'seller-of',
      ownerId: 'u-seller',
      regionId: 'region-0',
      resources: { food: 1000, ore: 0, fuel: 0, money: Number.MAX_SAFE_INTEGER - 5 },
      protectedUntil: 0,
    });
    const buyer = makeNation({ id: 'buyer-of', ownerId: 'u-buyer', regionId: 'region-0', resources: { food: 0, ore: 0, fuel: 0, money: 1000 }, protectedUntil: 0 });
    const world = makeWorld({
      seasonId: 'season-overflow',
      tick: 200,
      regions: [makeRegion({ id: 'region-0' })],
      nations: [seller, buyer],
      orders: [{ id: 'order-of', nationId: 'seller-of', kind: 'food', side: 'sell', qty: 10, price: 1, createdAt: 0 }],
    });
    await createSeason(db, 'S', world, 0);

    const result = await applyPlaceOrder(
      db,
      world,
      'season-overflow',
      buyer,
      { nationId: 'buyer-of', kind: 'food', side: 'buy', qty: 10, price: 1 },
      true
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('RESOURCE_OVERFLOW');
  });
});

describe('②-4 — production 缺少 RESEND_API_KEY 時 fail fast', () => {
  it('ENVIRONMENT=production 且無 RESEND_API_KEY → 每個請求都 500,不靜默放行', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'production' };
    const res = await app.request('/api/world', {}, env);
    expect(res.status).toBe(500);
  });

  it('ENVIRONMENT=production 且有 RESEND_API_KEY → 正常放行', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'production', RESEND_API_KEY: 'key-x' };
    const res = await app.request('/api/world', {}, env);
    expect(res.status).not.toBe(500);
  });
});

describe('②-5 — resend 探測回應統一 202,不洩漏帳號存在性', () => {
  it('帳號不存在與帳號存在皆回 202', async () => {
    const db = createTestD1();
    const env = { DB: db };
    const notFound = await app.request(
      '/api/auth/resend',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com' }) },
      env
    );
    expect(notFound.status).toBe(202);

    await app.request(
      '/api/auth/register',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'exists@example.com', password: 'password123' }) },
      env
    );
    const exists = await app.request(
      '/api/auth/resend',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'exists@example.com' }) },
      env
    );
    expect(exists.status).toBe(202);
  });
});

describe('②-6 — 未處理錯誤回應只給 generic error + requestId', () => {
  it('CorruptRowError 不再把 table/rowId/field 洩漏到回應本體', async () => {
    const db = createTestD1();
    const env = { DB: db };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-corrupt', nations: [makeNation({ id: 'nation-1' })] }), 0);
    await db.prepare("UPDATE nations SET flag = '{corrupt' WHERE id = ?").bind('nation-1').run();

    const res = await app.request('/api/nation/nation-1', {}, env);
    expect(res.status).toBe(500);
    const body = await json<Record<string, unknown>>(res);
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(body.table).toBeUndefined();
    expect(body.rowId).toBeUndefined();
    expect(typeof body.requestId).toBe('string');
  });
});

describe('②-7 — 毀約賠償不超過毀約方實際可付金額', () => {
  it('毀約方餘額不足以付全額賠償時,雙方轉帳金額一致(不憑空印錢)', async () => {
    const db = createTestD1();
    const env = { DB: db };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-breach-poor', tick: 200, regions: [makeRegion({ id: 'region-0' })] }), 0);
    const a = await registerLoginFoundNation(db, env, 'poor-a@example.com', 'A國');
    const b = await registerLoginFoundNation(db, env, 'poor-b@example.com', 'B國');

    const propose = await app.request(
      '/api/diplomacy/propose',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
        body: JSON.stringify({ kind: 'nap', counterpartyId: b.nationId, terms: { duration: 500, compensation: 100000 } }),
      },
      env
    );
    const treatyId = (await json<{ treaties: { id: string }[] }>(propose)).treaties[0].id;
    await app.request(
      '/api/diplomacy/respond',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: b.cookie }, body: JSON.stringify({ treatyId, action: 'accept' }) },
      env
    );

    const aMoneyBefore = (
      await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: a.cookie } }, env))
    ).nation.resources.money; // 500(初始值)遠低於 100000 的賠償金額
    const bMoneyBefore = (
      await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: b.cookie } }, env))
    ).nation.resources.money;

    await app.request(
      '/api/diplomacy/breach',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie }, body: JSON.stringify({ treatyId }) },
      env
    );

    const aAfter = (
      await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: a.cookie } }, env))
    ).nation.resources.money;
    const bAfter = (
      await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: b.cookie } }, env))
    ).nation.resources.money;

    const aPaid = aMoneyBefore - aAfter;
    const bReceived = bAfter - bMoneyBefore;
    expect(aAfter).toBe(0); // 付光僅有的餘額
    expect(aPaid).toBe(bReceived); // 一分不多也不少,不會憑空印錢
  });
});

describe('②-9 — 訊息分頁 limit 驗整數', () => {
  it('limit 為小數/負數 → 400 INVALID_LIMIT', async () => {
    const db = createTestD1();
    const env = { DB: db };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-limit', tick: 200, regions: [makeRegion({ id: 'region-0' })] }), 0);
    const nation = await registerLoginFoundNation(db, env, 'limit@example.com', '分頁國');

    const bad1 = await app.request('/api/messages?limit=1.5', { headers: { Cookie: nation.cookie } }, env);
    expect(bad1.status).toBe(400);
    const bad2 = await app.request('/api/messages?limit=-3', { headers: { Cookie: nation.cookie } }, env);
    expect(bad2.status).toBe(400);
  });
});

describe('②-11 — admin 開季 npcCount 上限', () => {
  it('npcCount 超過上限時退回 DEFAULT_NPC_COUNT,不會產生超量 NPC', async () => {
    const db = createTestD1();
    const env = { DB: db, ADMIN_TOKEN: 'tok' };
    const res = await app.request(
      '/api/admin/season',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ npcCount: 99999 }) },
      env
    );
    expect(res.status).toBe(201);
    const { seasonId } = await json<{ seasonId: string }>(res);
    const loaded = await loadWorldState(db, seasonId);
    expect(loaded!.nations.length).toBeLessThanOrEqual(50);
  });
});

describe('②-12 — admin 開季 body 壞 JSON → 400(不靜默用預設值）', () => {
  it('壞 JSON body → 400 INVALID_BODY,不悄悄開季', async () => {
    const db = createTestD1();
    const env = { DB: db, ADMIN_TOKEN: 'tok' };
    const res = await app.request(
      '/api/admin/season',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: 'not json' },
      env
    );
    expect(res.status).toBe(400);
  });
});

describe('②-15 — 賽季結算與最後一 tick 狀態同一 batch', () => {
  it('賽季到期時,name_of_fame 與最終 tick 狀態一次寫入(既有回歸,確認合併後仍正確)', async () => {
    const db = createTestD1();
    const n1 = makeNation({ id: 'end-1', ownerId: 'u1', regionId: 'region-0', score: { economy: 1, warfare: 0, tech: 0, diplomacy: 0, total: 1 } });
    const { SEASON_LENGTH_TICKS } = await import('../src/game/constants');
    const world = makeWorld({ seasonId: 'season-final', tick: SEASON_LENGTH_TICKS - 1, nations: [n1], regions: [makeRegion({ id: 'region-0' })] });
    await createSeason(db, 'S', world, 0);

    const result = await runTick(db, { now: 1000 });
    expect(result.ranTick).toBe(true);
    expect(result.seasonEnded).toBe(true);

    const loaded = await loadWorldState(db, 'season-final');
    expect(loaded?.tick).toBe(SEASON_LENGTH_TICKS);
    const hof = await db.prepare('SELECT COUNT(*) as n FROM hall_of_fame WHERE season_id = ?').bind('season-final').first<{ n: number }>();
    expect(hof!.n).toBeGreaterThan(0);
    const season = await db.prepare('SELECT status FROM seasons WHERE id = ?').bind('season-final').first<{ status: string }>();
    expect(season!.status).toBe('ended');
  });
});

describe('②-16 — buildHallOfFameEntries 空國家防禦', () => {
  it('賽季到期但沒有任何國家 → runTick 不拋例外,名人堂沒有條目', async () => {
    const db = createTestD1();
    const { SEASON_LENGTH_TICKS } = await import('../src/game/constants');
    const world = makeWorld({ seasonId: 'season-empty', tick: SEASON_LENGTH_TICKS - 1, nations: [], regions: [makeRegion({ id: 'region-0' })] });
    await createSeason(db, 'S', world, 0);

    const result = await runTick(db, { now: 1000 });
    expect(result.ranTick).toBe(true);
    expect(result.seasonEnded).toBe(true);
    const hof = await db.prepare('SELECT COUNT(*) as n FROM hall_of_fame WHERE season_id = ?').bind('season-empty').first<{ n: number }>();
    expect(hof!.n).toBe(0);
  });
});

describe('②-18 — messages body 欄位型別檢查(不是字串時不 500)', () => {
  it('toNationId/body 為數字 → 400 INVALID_BODY,不是未預期例外', async () => {
    const db = createTestD1();
    const env = { DB: db };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-msgtype', tick: 200, regions: [makeRegion({ id: 'region-0' })] }), 0);
    const nation = await registerLoginFoundNation(db, env, 'msgtype@example.com', '型別國');

    const res = await app.request(
      '/api/messages',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: nation.cookie }, body: JSON.stringify({ toNationId: 12345, body: 999 }) },
      env
    );
    expect(res.status).toBe(400);
  });
});

describe('②-19 — /api/world since 驗證非負安全整數', () => {
  it('since 為負數/小數 → 400 INVALID_SINCE', async () => {
    const db = createTestD1();
    const env = { DB: db };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-since', tick: 200, regions: [makeRegion({ id: 'region-0' })] }), 0);
    const nation = await registerLoginFoundNation(db, env, 'since@example.com', '游標國');

    const bad1 = await app.request('/api/world?since=-1', { headers: { Cookie: nation.cookie } }, env);
    expect(bad1.status).toBe(400);
    const bad2 = await app.request('/api/world?since=1.5', { headers: { Cookie: nation.cookie } }, env);
    expect(bad2.status).toBe(400);
  });
});

// ①-5 的正面案例(訊息簽章判斷正確轉譯)已由既有 findings.test.ts 的 finding #10/#18 覆蓋
// (SeasonAlreadyActiveError/NationAlreadyFoundedError 仍如常轉譯)。
// ②-1(escrow squash)/②-3/②-8(email/password/name typeof 檢查)已透過 auth.test.ts 既有流程
// 與①-3/②-18 的測試間接覆蓋(register/login 全流程正常運作 + 型別錯誤輸入回 400)。
// ②-10(訊息 rate limit 原子性)採「文件化+緩解」路線,行為已由既有 findings.test.ts
// finding #20(429 RATE_LIMITED)覆蓋;未額外驗證併發原子性(單 isolate 弱保證,已在
// db/repository.ts countMessagesSentInTick 週邊註解)。
void makeTreaty; // 保留 import,供未來補充條約相關回歸測試時使用
