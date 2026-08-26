// M8 tick-cron 測試——runTick 的「讀-算-寫」全流程(NPC 決策套用/行軍抵達戰鬥/tick 推進/
// tick_running 互斥/賽季到期名人堂)+ /api/admin/season 開季端點 + 玩家寫入路由的 503 阻擋。

import { describe, it, expect } from 'vitest';
import { runTick } from '../src/tick/run';
import { app, mailSender } from '../src/index';
import { createTestD1 } from './support/sqliteD1Adapter';
import {
  createSeason,
  loadWorldState,
  getSeasonTickRunning,
  setSeasonTickRunning,
  insertVerificationTokenAtomic,
  findVerificationToken,
} from '../src/db/repository';
import { makeWorld, makeRegion, makeNation, makeMarch } from './support/fixtures';
import { SEASON_LENGTH_TICKS } from '../src/game/constants';

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('runTick — 基本 tick 推進', () => {
  it('無 active 賽季 → ranTick false, skippedReason NO_ACTIVE_SEASON', async () => {
    const db = createTestD1();
    const result = await runTick(db, { now: 0 });
    expect(result.ranTick).toBe(false);
    expect(result.skippedReason).toBe('NO_ACTIVE_SEASON');
  });

  it('Codex 五審④:無 active 賽季時,過期的 verification_tokens 仍會被全域清理', async () => {
    const db = createTestD1();
    await db
      .prepare(
        'INSERT INTO users (id, email, password_hash, password_salt, password_iterations, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind('user-no-season', 'no-season@example.com', 'h', 's', 1, 0, 0)
      .run();
    // expires_at=100,runTick 呼叫時 now=999999 早已過期——且這個賽季一個 active season 都
    // 沒有(修復前:cleanupExpiredVerificationTokens 排在 getActiveSeasonId 的 NO_ACTIVE_SEASON
    // 提早 return 之後,永遠不會被呼叫到,這筆過期列會卡死不刪)。
    await insertVerificationTokenAtomic(
      db,
      { token_hash: 'stale-no-season', user_id: 'user-no-season', expires_at: 100, created_at: 0 },
      0
    );

    const result = await runTick(db, { now: 999_999 });
    expect(result.ranTick).toBe(false);
    expect(result.skippedReason).toBe('NO_ACTIVE_SEASON');
    expect(await findVerificationToken(db, 'stale-no-season')).toBeNull();
  });

  it('正常一輪:tick 推進 +1、季末寫回 D1', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 's-1', tick: 5, nations: [] });
    await createSeason(db, 'S1', world, 0);

    const result = await runTick(db, { now: 1000 });
    expect(result.ranTick).toBe(true);
    expect(result.seasonEnded).toBe(false);

    const loaded = await loadWorldState(db, 's-1');
    expect(loaded?.tick).toBe(6);
  });

  it('events 寫入 D1(至少每個 nation 一筆 production_tick)', async () => {
    const db = createTestD1();
    const nation = makeNation({ id: 'n-1', ownerId: 'user-1', buildQueue: [] });
    const world = makeWorld({ seasonId: 's-2', tick: 0, nations: [nation] });
    await createSeason(db, 'S2', world, 0);

    const result = await runTick(db, { now: 1000 });
    expect(result.eventCount).toBeGreaterThan(0);

    const rows = await db.prepare('SELECT * FROM events WHERE season_id = ?').bind('s-2').all();
    expect((rows.results as { type: string }[]).some((r) => r.type === 'production_tick')).toBe(true);
  });

  it('行軍抵達 → 戰鬥於 tick 中解算(marches 清空、寫入 battle_resolved 事件)', async () => {
    const db = createTestD1();
    const attacker = makeNation({ id: 'atk', ownerId: 'user-1', regionId: 'region-0', army: { size: 20 }, buildQueue: [] });
    const defender = makeNation({ id: 'def', ownerId: 'user-2', regionId: 'region-0', army: { size: 5 }, buildQueue: [] });
    const march = makeMarch({ id: 'march-1', attackerId: 'atk', defenderId: 'def', size: 10, arrivesAt: 0 });
    const world = makeWorld({ seasonId: 's-3', tick: 0, nations: [attacker, defender], marches: [march] });
    await createSeason(db, 'S3', world, 0);

    await runTick(db, { now: 1000 });

    const loaded = await loadWorldState(db, 's-3');
    expect(loaded?.marches).toHaveLength(0);

    const rows = await db.prepare('SELECT * FROM events WHERE season_id = ?').bind('s-3').all();
    expect((rows.results as { type: string }[]).some((r) => r.type === 'battle_resolved')).toBe(true);
  });

  it('tick_running 互斥:已在跑時再呼叫 → 跳過本輪,tick 不推進', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 's-4', tick: 0, nations: [] });
    await createSeason(db, 'S4', world, 0);
    await setSeasonTickRunning(db, 's-4', true);

    const result = await runTick(db, { now: 1000 });
    expect(result.ranTick).toBe(false);
    expect(result.skippedReason).toBe('TICK_IN_PROGRESS');

    const loaded = await loadWorldState(db, 's-4');
    expect(loaded?.tick).toBe(0);
  });

  it('tick_running 旗標於正常結束後清除', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 's-5', tick: 0, nations: [] });
    await createSeason(db, 'S5', world, 0);

    await runTick(db, { now: 1000 });
    expect(await getSeasonTickRunning(db, 's-5')).toBe(false);
  });
});

describe('runTick — NPC 決策套用(走與玩家 route 相同的 game/actions.ts)', () => {
  it('NPC 糧食短缺 → 本 tick 排入農場建設(buildQueue 增加)', async () => {
    const db = createTestD1();
    const npc = makeNation({
      id: 'npc-1',
      ownerId: null,
      regionId: 'region-0',
      resources: { food: 5, ore: 50, fuel: 50, money: 200 },
      population: 50,
      buildings: { farm: 0, mine: 0, refinery: 0, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
      buildQueue: [],
      lastAttackedAt: undefined,
    });
    delete npc.lastAttackedAt;
    const world = makeWorld({ seasonId: 's-6', tick: 0, nations: [npc] });
    await createSeason(db, 'S6', world, 0);

    await runTick(db, { now: 1000 });

    const loaded = await loadWorldState(db, 's-6');
    const updated = loaded?.nations.find((n) => n.id === 'npc-1');
    expect(updated?.buildQueue.length).toBe(1);
    expect(updated?.buildQueue[0]?.building).toBe('farm');
    // 農場成本(money:100, ore:10)已從影子狀態扣除(applyBuild real 扣款,production 之後再加產出)
    expect(updated?.resources.money).toBeLessThan(200 + 50); // 上限保守檢查,產出後仍應 < 起始+誇張值
  });

  it('NPC 資源盈餘 → 掛賣單(orders 增加)', async () => {
    const db = createTestD1();
    const npc = makeNation({
      id: 'npc-2',
      ownerId: null,
      regionId: 'region-0',
      resources: { food: 5000, ore: 50, fuel: 50, money: 200 },
      population: 10,
      protectedUntil: 0, // 不在保護期,避免掛單量超過 PROTECTED_ORDER_QTY_CAP(50)被擋
      buildings: { farm: 0, mine: 0, refinery: 0, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
      buildQueue: [{ building: 'mine', completesAt: 999 }], // 佇列已滿,避免規則①④搶動作額度
      lastAttackedAt: undefined,
    });
    delete npc.lastAttackedAt;
    const world = makeWorld({ seasonId: 's-7', tick: 0, nations: [npc] });
    await createSeason(db, 'S7', world, 0);

    await runTick(db, { now: 1000 });

    const loaded = await loadWorldState(db, 's-7');
    expect(loaded?.orders.length).toBeGreaterThan(0);
    expect(loaded?.orders[0]?.side).toBe('sell');
  });

  it('NPC 被攻擊過 → 練兵(army.size 增加)', async () => {
    const db = createTestD1();
    const npc = makeNation({
      id: 'npc-3',
      ownerId: null,
      regionId: 'region-0',
      resources: { food: 5000, ore: 50, fuel: 50, money: 5000 },
      population: 100,
      army: { size: 5 },
      buildings: { farm: 0, mine: 0, refinery: 0, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
      buildQueue: [{ building: 'mine', completesAt: 999 }],
      lastAttackedAt: 0,
    });
    const world = makeWorld({ seasonId: 's-8', tick: 1, nations: [npc] });
    await createSeason(db, 'S8', world, 0);

    await runTick(db, { now: 1000 });

    const loaded = await loadWorldState(db, 's-8');
    const updated = loaded?.nations.find((n) => n.id === 'npc-3');
    expect(updated?.army.size).toBeGreaterThan(5);
  });
});

describe('runTick — 賽季到期結算', () => {
  it('達 SEASON_LENGTH_TICKS → 名人堂寫入(總分前三 + 4 分項)+ season 標記 ended', async () => {
    const db = createTestD1();
    // engine.computeScore 每 tick 都會重算 economy/tech/diplomacy(只有 warfare 是累積值、
    // 本 tick 無戰鬥時直接沿用 fixture 給的值)——用真實欄位(resources/buildings/tech/
    // score.warfare)設計出各分項冠軍分明的三國,而不是直接塞 score 期待原樣保留。
    const zeroBuildings = { farm: 0, mine: 0, refinery: 0, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 };
    const n1 = makeNation({
      id: 'n1',
      ownerId: 'u1',
      regionId: 'region-0',
      resources: { food: 10000, ore: 10000, fuel: 10000, money: 10000 }, // 經濟分數遠高於其他兩國
      tech: 0,
      buildings: zeroBuildings,
      buildQueue: [],
      score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 },
    });
    const n2 = makeNation({
      id: 'n2',
      ownerId: 'u2',
      regionId: 'region-0',
      resources: { food: 10, ore: 10, fuel: 10, money: 10 },
      tech: 50, // 科技分數遠高於其他兩國
      buildings: zeroBuildings,
      buildQueue: [],
      score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 },
    });
    const n3 = makeNation({
      id: 'n3',
      ownerId: 'u3',
      regionId: 'region-0',
      resources: { food: 10, ore: 10, fuel: 10, money: 10 },
      tech: 0,
      buildings: zeroBuildings,
      buildQueue: [],
      score: { economy: 0, warfare: 300, tech: 0, diplomacy: 0, total: 300 }, // 戰功累積值,本 tick 無戰鬥則沿用
    });
    const world = makeWorld({ seasonId: 's-9', tick: SEASON_LENGTH_TICKS - 1, nations: [n1, n2, n3] });
    await createSeason(db, 'S9', world, 0);

    const result = await runTick(db, { now: 5000 });
    expect(result.seasonEnded).toBe(true);

    const season = await db.prepare('SELECT status, ended_at FROM seasons WHERE id = ?').bind('s-9').first<{
      status: string;
      ended_at: number | null;
    }>();
    expect(season?.status).toBe('ended');
    expect(season?.ended_at).toBe(5000);

    const hof = await db.prepare('SELECT * FROM hall_of_fame WHERE season_id = ?').bind('s-9').all();
    expect(hof.results.length).toBe(7); // 總分前三 + 4 分項冠軍

    const rows = hof.results as { rank: number; category: string | null; nation_id: string }[];
    const overall = rows.filter((r) => r.category === null);
    expect(overall).toHaveLength(3);
    expect(overall.find((r) => r.rank === 1)?.nation_id).toBe('n1'); // 經濟分數把總分拉到最高

    expect(rows.find((r) => r.category === 'economy')?.nation_id).toBe('n1');
    expect(rows.find((r) => r.category === 'tech')?.nation_id).toBe('n2');
    expect(rows.find((r) => r.category === 'warfare')?.nation_id).toBe('n3');
  });

  it('未達 SEASON_LENGTH_TICKS → 不寫名人堂、season 仍 active', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 's-10', tick: 10, nations: [] });
    await createSeason(db, 'S10', world, 0);

    const result = await runTick(db, { now: 1000 });
    expect(result.seasonEnded).toBe(false);

    const season = await db.prepare('SELECT status FROM seasons WHERE id = ?').bind('s-10').first<{ status: string }>();
    expect(season?.status).toBe('active');

    const hof = await db.prepare('SELECT * FROM hall_of_fame WHERE season_id = ?').bind('s-10').all();
    expect(hof.results.length).toBe(0);
  });
});

describe('POST /api/admin/season', () => {
  it('token 錯誤 → 401', async () => {
    const db = createTestD1();
    const env = { DB: db, ADMIN_TOKEN: 'secret-token', ENVIRONMENT: 'test' };
    const res = await app.request(
      '/api/admin/season',
      { method: 'POST', headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' }, body: '{}' },
      env
    );
    expect(res.status).toBe(401);
  });

  it('未設定 ADMIN_TOKEN → 一律 401(不可能「沒設定就開放」)', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    const res = await app.request(
      '/api/admin/season',
      { method: 'POST', headers: { Authorization: 'Bearer anything', 'Content-Type': 'application/json' }, body: '{}' },
      env
    );
    expect(res.status).toBe(401);
  });

  it('token 正確 → 開新賽季成功,含 NPC 國家', async () => {
    const db = createTestD1();
    const env = { DB: db, ADMIN_TOKEN: 'secret-token', ENVIRONMENT: 'test' };
    const res = await app.request(
      '/api/admin/season',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '新賽季', npcCount: 3 }),
      },
      env
    );
    expect(res.status).toBe(201);
    const body = await json<{ seasonId: string }>(res);

    const loaded = await loadWorldState(db, body.seasonId);
    expect(loaded?.nations).toHaveLength(3);
    expect(loaded?.nations.every((n) => n.ownerId === null)).toBe(true);
  });

  it('已有 active 賽季時再開新季 → 409 SEASON_ALREADY_ACTIVE', async () => {
    const db = createTestD1();
    const env = { DB: db, ADMIN_TOKEN: 'secret-token', ENVIRONMENT: 'test' };
    await createSeason(db, 'Existing', makeWorld({ seasonId: 'existing', regions: [makeRegion()] }), 0);

    const res = await app.request(
      '/api/admin/season',
      { method: 'POST', headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' }, body: '{}' },
      env
    );
    expect(res.status).toBe(409);
  });
});

describe('tick_running 阻擋玩家寫入(503 TICK_IN_PROGRESS)', () => {
  it('build 路由在 tick 進行中回 503', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S11', makeWorld({ seasonId: 's-11', regions: [makeRegion({ id: 'region-0' })] }), 0);

    await app.request(
      '/api/auth/register',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'password123' }) },
      env
    );
    // finding #1/#13:DB 只存 verify_token 雜湊,改從 ConsoleMailSender 攔截明文 token。
    await app.request(
      '/api/auth/verify',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: mailSender.lastToken }) },
      env
    );
    const login = await app.request(
      '/api/auth/login',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'password123' }) },
      env
    );
    const raw = login.headers.get('set-cookie')!;
    const cookie = `mn_session=${raw.match(/mn_session=([^;]+)/)![1]}`;

    await app.request(
      '/api/nation',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: '測試國', flag: { layout: 'stripes', colors: ['#fff'], emblem: 'star' } }) },
      env
    );

    await setSeasonTickRunning(db, 's-11', true);
    const res = await app.request(
      '/api/build',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ building: 'farm' }) },
      env
    );
    expect(res.status).toBe(503);
    expect((await json<{ error: string }>(res)).error).toBe('TICK_IN_PROGRESS');
  });
});
