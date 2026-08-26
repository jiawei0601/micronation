// M7 全路由整合測試——沿用 M6 的 sqliteD1Adapter,走真實 HTTP(app.request)驗證薄殼
// 串接 auth+db+五個純模塊的完整流程。同一 describe 內的 it() 依序執行、共用世界狀態
// (vitest 預設保序執行,模擬玩家連續操作的真實序列)。

import { describe, it, expect, beforeAll } from 'vitest';
import { app, mailSender } from '../src/index';
import { createTestD1 } from './support/sqliteD1Adapter';
import { createSeason } from '../src/db/repository';
import { makeWorld, makeRegion } from './support/fixtures';
import type { D1Database } from '../src/db/types';

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('no set-cookie header');
  const match = raw.match(/mn_session=([^;]+)/);
  if (!match) throw new Error('no session token in cookie');
  return `mn_session=${match[1]}`;
}

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const FLAG = { layout: 'horizontal-tricolor', colors: ['#ff0000', '#0000ff'], emblem: 'star' };

describe('M7 api 全路由整合測試', () => {
  let db: D1Database;
  let env: { DB: D1Database };
  let cookie1: string;
  let cookie2: string;
  let nation1Id: string;
  let nation2Id: string;

  beforeAll(async () => {
    db = createTestD1();
    env = { DB: db };
    await createSeason(
      db,
      'Test Season',
      makeWorld({
        seasonId: 'season-test',
        tick: 0,
        regions: [makeRegion({ id: 'region-0' }), makeRegion({ id: 'region-1' })],
        nations: [],
      }),
      0
    );
  });

  // finding #1/#13:DB 只存 verify_token 的雜湊,測試改從 ConsoleMailSender 攔截明文 token
  // (見 src/index.ts 匯出的 mailSender)。逐一 register 立刻擷取,避免被下一次 register 覆蓋。
  let verifyToken1: string;
  let verifyToken2: string;

  it('01 register user1/user2', async () => {
    const r1 = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'p1@example.com', password: 'password123' }),
    }, env);
    expect(r1.status).toBe(201);
    verifyToken1 = mailSender.lastToken!;

    const r2 = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'p2@example.com', password: 'password123' }),
    }, env);
    expect(r2.status).toBe(201);
    verifyToken2 = mailSender.lastToken!;
  });

  it('02 verify user1/user2 email', async () => {
    expect(verifyToken1).toBeTruthy();
    expect(verifyToken2).toBeTruthy();

    const v1 = await app.request('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verifyToken1 }),
    }, env);
    expect(v1.status).toBe(200);

    const v2 = await app.request('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verifyToken2 }),
    }, env);
    expect(v2.status).toBe(200);
  });

  it('03 login user1/user2 拿 session cookie', async () => {
    const l1 = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'p1@example.com', password: 'password123' }),
    }, env);
    expect(l1.status).toBe(200);
    cookie1 = extractCookie(l1);

    const l2 = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'p2@example.com', password: 'password123' }),
    }, env);
    expect(l2.status).toBe(200);
    cookie2 = extractCookie(l2);
  });

  it('04 GET /api/nation 未建國 → 404 NO_NATION', async () => {
    const res = await app.request('/api/nation', { headers: { Cookie: cookie1 } }, env);
    expect(res.status).toBe(404);
  });

  it('05 POST /api/nation 建國成功(自動分區,兩國應落在不同區)', async () => {
    const r1 = await app.request('/api/nation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ name: '測試國一', flag: FLAG }),
    }, env);
    expect(r1.status).toBe(201);
    const body1 = await json<{ nation: { id: string; regionId: string } }>(r1);
    nation1Id = body1.nation.id;

    const r2 = await app.request('/api/nation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ name: '測試國二', flag: FLAG }),
    }, env);
    expect(r2.status).toBe(201);
    const body2 = await json<{ nation: { id: string; regionId: string } }>(r2);
    nation2Id = body2.nation.id;

    expect(body1.nation.regionId).not.toBe(body2.nation.regionId);
  });

  it('06 重複建國 → ALREADY_HAS_NATION', async () => {
    const res = await app.request('/api/nation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ name: '測試國三', flag: FLAG }),
    }, env);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('ALREADY_HAS_NATION');
  });

  it('07 敏感詞國名 → INVALID_NAME', async () => {
    const db2 = createTestD1();
    const env2 = { DB: db2 };
    await createSeason(db2, 'S2', makeWorld({ seasonId: 'season-x', regions: [makeRegion()] }), 0);
    await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bad@example.com', password: 'password123' }),
    }, env2);
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bad@example.com', password: 'password123' }),
    }, env2);
    const badCookie = extractCookie(login);
    const res = await app.request('/api/nation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: badCookie },
      body: JSON.stringify({ name: 'fuck國', flag: FLAG }),
    }, env2);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('INVALID_NAME');
  });

  it('08 GET /api/nation 回自己完整資料', async () => {
    const res = await app.request('/api/nation', { headers: { Cookie: cookie1 } }, env);
    expect(res.status).toBe(200);
    const body = await json<{ nation: { resources: { money: number } } }>(res);
    expect(body.nation.resources.money).toBe(500);
  });

  it('09 GET /api/nation/:id 公開視圖不含 resources', async () => {
    const res = await app.request(`/api/nation/${nation1Id}`, {}, env);
    expect(res.status).toBe(200);
    const body = await json<{ nation: Record<string, unknown> }>(res);
    expect(body.nation.resources).toBeUndefined();
    expect(body.nation.armySizeTier).toBeDefined();
  });

  it('10 GET /api/world 匿名輪詢', async () => {
    const res = await app.request('/api/world', {}, env);
    expect(res.status).toBe(200);
    const body = await json<{ view: { nations: unknown[] }; nextTickAt: number }>(res);
    expect(body.view.nations.length).toBe(2);
    expect(body.nextTickAt).toBeGreaterThan(Date.now());
  });

  it('11 POST /api/build 蓋農場成功並扣資源', async () => {
    const res = await app.request('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ building: 'farm' }),
    }, env);
    expect(res.status).toBe(200);
    const body = await json<{ nation: { resources: { money: number }; buildQueue: unknown[] } }>(res);
    expect(body.nation.resources.money).toBeLessThan(500);
    expect(body.nation.buildQueue.length).toBe(1);
  });

  it('12 佇列已滿 → QUEUE_FULL', async () => {
    const res = await app.request('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ building: 'mine' }),
    }, env);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('QUEUE_FULL');
  });

  it('13 POST /api/policy 改稅率成功', async () => {
    const res = await app.request('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ axis: 'tax', tier: 'high' }),
    }, env);
    expect(res.status).toBe(200);
    const body = await json<{ nation: { policies: { tax: string } } }>(res);
    expect(body.nation.policies.tax).toBe('high');
  });

  it('14 冷卻期內再次變更同軸 → POLICY_COOLDOWN', async () => {
    const res = await app.request('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ axis: 'tax', tier: 'low' }),
    }, env);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('POLICY_COOLDOWN');
  });

  it('15 未驗證/超額掛單 → 反輸送案例(qty 超過保護期上限)', async () => {
    const res = await app.request('/api/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ kind: 'food', side: 'sell', qty: 999, price: 10 }),
    }, env);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('PROTECTED_LIMIT');
  });

  it('16 user1 掛賣單(合法量)成功入 book', async () => {
    const res = await app.request('/api/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ kind: 'food', side: 'sell', qty: 10, price: 10 }),
    }, env);
    expect(res.status).toBe(201);
    const body = await json<{ trades: unknown[]; book: unknown[] }>(res);
    expect(body.trades.length).toBe(0);
    expect(body.book.length).toBe(1);
  });

  it('17 user2 掛買單成交(跨區,tariff>0)', async () => {
    const res = await app.request('/api/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ kind: 'food', side: 'buy', qty: 10, price: 10 }),
    }, env);
    expect(res.status).toBe(201);
    const body = await json<{ trades: { tariff: number; qty: number }[] }>(res);
    expect(body.trades.length).toBe(1);
    expect(body.trades[0].qty).toBe(10);
  });

  it('18 價格偏離近期均價超過 30% → PRICE_BAND', async () => {
    const res = await app.request('/api/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ kind: 'food', side: 'sell', qty: 1, price: 999 }),
    }, env);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('PRICE_BAND');
  });

  it('19 掛單後撤單:非本人撤單 → 403 FORBIDDEN', async () => {
    const place = await app.request('/api/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ kind: 'ore', side: 'sell', qty: 1, price: 10 }),
    }, env);
    const placed = await json<{ book: { id: string; nationId: string }[] }>(place);
    const targetId = placed.book[placed.book.length - 1].id;

    const forbidden = await app.request(`/api/market/${targetId}`, { method: 'DELETE', headers: { Cookie: cookie1 } }, env);
    expect(forbidden.status).toBe(403);
  });

  it('20 本人撤單成功', async () => {
    const list = await app.request('/api/market', {}, env);
    const book = (await json<{ book: { id: string; nationId: string }[] }>(list)).book;
    const own = book.find((o) => o.nationId === nation2Id);
    expect(own).toBeDefined();
    const res = await app.request(`/api/market/${own!.id}`, { method: 'DELETE', headers: { Cookie: cookie2 } }, env);
    expect(res.status).toBe(200);
  });

  it('21 宣戰(需先把世界 tick 推過新手保護期)', async () => {
    // 直接改 season.tick 模擬時間經過,繞開需要真正 tick-cron(M8)才能推進 tick 的限制。
    await db.prepare('UPDATE seasons SET tick = ? WHERE id = ?').bind(200, 'season-test').run();

    const res = await app.request('/api/military/attack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ defenderId: nation2Id, army: 5 }),
    }, env);
    expect(res.status).toBe(201);
    const body = await json<{ march: { attackerId: string; defenderId: string; size: number } }>(res);
    expect(body.march.attackerId).toBe(nation1Id);
    expect(body.march.size).toBe(5);
  });

  it('22 保護期內宣戰 → PROTECTED', async () => {
    await db.prepare('UPDATE seasons SET tick = ? WHERE id = ?').bind(1, 'season-test').run();
    const res = await app.request('/api/military/attack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ defenderId: nation1Id, army: 1 }),
    }, env);
    // tick=1 兩國都還在保護期(168)內
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('PROTECTED');
    await db.prepare('UPDATE seasons SET tick = ? WHERE id = ?').bind(200, 'season-test').run();
  });

  it('23 撤回行軍成功', async () => {
    const worldRes = await app.request('/api/world', { headers: { Cookie: cookie1 } }, env);
    const world = await json<{ view: { marches: { id: string; attackerId: string }[] } }>(worldRes);
    const march = world.view.marches.find((m) => m.attackerId === nation1Id);
    expect(march).toBeDefined();

    const res = await app.request('/api/military/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ marchId: march!.id }),
    }, env);
    expect(res.status).toBe(200);
  });

  it('23a POST /api/military/train 練兵成功(資源與人口徵兵上限皆足夠)', async () => {
    const before = await app.request('/api/nation', { headers: { Cookie: cookie1 } }, env);
    const beforeBody = await json<{ nation: { resources: { money: number }; army: { size: number } } }>(before);

    const res = await app.request('/api/military/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ size: 5 }),
    }, env);
    expect(res.status).toBe(200);
    const body = await json<{ nation: { resources: { money: number }; army: { size: number } } }>(res);
    expect(body.nation.army.size).toBe(beforeBody.nation.army.size + 5);
    expect(body.nation.resources.money).toBe(beforeBody.nation.resources.money - 5 * 5); // TRAIN_COST_PER_UNIT.money = 5
  });

  it('23b POST /api/military/train 資源不足 → INSUFFICIENT_RESOURCES', async () => {
    const res = await app.request('/api/military/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ size: 100000 }),
    }, env);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('INSUFFICIENT_RESOURCES');
  });

  it('23c POST /api/military/train 超過人口徵兵上限 → ARMY_CAP', async () => {
    // population=100 × ARMY_POPULATION_RATIO_CAP(0.3) = 30 上限,army 經 23a 後為 15,
    // 練 20 兵資源足夠(20×5=100 <<剩餘資源)但 15+20=35 超過上限應被拒絕。
    const res = await app.request('/api/military/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ size: 20 }),
    }, env);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('ARMY_CAP');
  });

  it('24 提出條約 propose → active 尚未', async () => {
    const res = await app.request('/api/diplomacy/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ kind: 'nap', counterpartyId: nation2Id, terms: { duration: 100 } }),
    }, env);
    expect(res.status).toBe(201);
    const body = await json<{ treaties: { status: string }[] }>(res);
    expect(body.treaties[0].status).toBe('proposed');
  });

  it('25 對方 accept → 條約 active', async () => {
    const listRes = await app.request('/api/diplomacy', { headers: { Cookie: cookie2 } }, env);
    const list = await json<{ treaties: { id: string; status: string }[] }>(listRes);
    const treaty = list.treaties.find((t) => t.status === 'proposed');
    expect(treaty).toBeDefined();

    const res = await app.request('/api/diplomacy/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ treatyId: treaty!.id, action: 'accept' }),
    }, env);
    expect(res.status).toBe(200);
    const body = await json<{ treaties: { status: string }[] }>(res);
    expect(body.treaties.find((t) => t.id === treaty!.id)?.status).toBe('active');
  });

  it('26 GET /api/rankings 綜合+4 分項', async () => {
    const res = await app.request('/api/rankings', {}, env);
    expect(res.status).toBe(200);
    const body = await json<{ overall: unknown[]; economy: unknown[]; warfare: unknown[]; tech: unknown[]; diplomacy: unknown[] }>(
      res
    );
    expect(body.overall.length).toBe(2);
    expect(body.economy).toBeDefined();
    expect(body.warfare).toBeDefined();
  });

  it('27 傳送/查看站內訊息', async () => {
    const send = await app.request('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ toNationId: nation2Id, body: '你好,要不要簽貿易條約?' }),
    }, env);
    expect(send.status).toBe(201);

    const inbox = await app.request('/api/messages?box=inbox', { headers: { Cookie: cookie2 } }, env);
    const body = await json<{ messages: { from_nation_id: string; body: string }[] }>(inbox);
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].from_nation_id).toBe(nation1Id);
  });

  it('28 GET /api/tasks 進度隨動作推進(至少 register/found_nation/build_first 已完成)', async () => {
    const res = await app.request('/api/tasks', { headers: { Cookie: cookie1 } }, env);
    expect(res.status).toBe(200);
    const body = await json<{ tasks: { key: string; completed: boolean }[] }>(res);
    const byKey = new Map(body.tasks.map((t) => [t.key, t.completed]));
    expect(byKey.get('register')).toBe(true);
    expect(byKey.get('found_nation')).toBe(true);
    expect(byKey.get('build_first')).toBe(true);
    expect(byKey.get('place_order')).toBe(true);
  });

  it('29 未登入呼叫需登入路由 → 401 UNAUTHORIZED', async () => {
    const res = await app.request('/api/nation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '無登入', flag: FLAG }),
    }, env);
    expect(res.status).toBe(401);
  });

  it('30 自我對敲跳過(自己買賣同一單不成交,兩邊都留在 book)', async () => {
    await app.request('/api/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ kind: 'fuel', side: 'sell', qty: 3, price: 5 }),
    }, env);
    const res = await app.request('/api/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ kind: 'fuel', side: 'buy', qty: 3, price: 5 }),
    }, env);
    const body = await json<{ trades: unknown[] }>(res);
    expect(body.trades.length).toBe(0);
  });
});
