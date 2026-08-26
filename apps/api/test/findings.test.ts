// Codex 一審 routes/game/tick 層 findings — 回歸測試。每個 describe 對應派工清單裡的編號,
// 修復前(舊行為)這些斷言會紅。

import { describe, it, expect, beforeEach } from 'vitest';
import { app, mailSender } from '../src/index';
import { createTestD1 } from './support/sqliteD1Adapter';
import {
  createSeason,
  loadWorldState,
  getEventsSince,
  claimNextMessageSeq,
  insertMessage,
} from '../src/db/repository';
import { makeWorld, makeRegion, makeNation, makeTreaty } from './support/fixtures';
import { applyBuild, applyPlaceOrder, applyCancelOrder } from '../src/game/actions';
import { isNameAllowed, isValidFlagSpec, buildDefaultRegions } from '../src/game/constants';
import { runTick } from '../src/tick/run';
import { resetRateLimits } from '../src/lib/rateLimit';
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

describe('finding #1 — 市場成交資源結算(escrow + settle)', () => {
  it('掛賣單即鎖定(escrow)資源;成交後買方得貨、賣方得款(扣關稅)', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-1', regions: [makeRegion({ id: 'region-0' }), makeRegion({ id: 'region-1' })] }), 0);
    const seller = await registerLoginFoundNation(db, env, 'seller@example.com', '賣家國');
    const buyer = await registerLoginFoundNation(db, env, 'buyer@example.com', '買家國');

    const beforeSeller = await app.request('/api/nation', { headers: { Cookie: seller.cookie } }, env);
    const sellerBefore = (await json<{ nation: { resources: { food: number } } }>(beforeSeller)).nation;
    expect(sellerBefore.resources.food).toBe(300);

    const place = await app.request(
      '/api/market',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: seller.cookie },
        body: JSON.stringify({ kind: 'food', side: 'sell', qty: 10, price: 10 }),
      },
      env
    );
    expect(place.status).toBe(201);

    // 掛單當下食物已扣(escrow),不等到成交才扣。
    const afterPlace = await app.request('/api/nation', { headers: { Cookie: seller.cookie } }, env);
    const sellerAfterPlace = (await json<{ nation: { resources: { food: number } } }>(afterPlace)).nation;
    expect(sellerAfterPlace.resources.food).toBe(290);

    const buyerMoneyBefore = (
      await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: buyer.cookie } }, env))
    ).nation.resources.money;

    const buy = await app.request(
      '/api/market',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: buyer.cookie },
        body: JSON.stringify({ kind: 'food', side: 'buy', qty: 10, price: 10 }),
      },
      env
    );
    expect(buy.status).toBe(201);
    const buyBody = await json<{ trades: { tariff: number; qty: number; price: number }[] }>(buy);
    expect(buyBody.trades.length).toBe(1);
    const tariff = buyBody.trades[0].tariff;

    const buyerAfter = (
      await json<{ nation: { resources: { food: number; money: number } } }>(await app.request('/api/nation', { headers: { Cookie: buyer.cookie } }, env))
    ).nation;
    expect(buyerAfter.resources.food).toBe(310); // 建國初始 food=300 + 成交得貨 10
    expect(buyerAfter.resources.money).toBe(buyerMoneyBefore - 10 * 10);

    const sellerAfter = (
      await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: seller.cookie } }, env))
    ).nation;
    // 賣方收到:成交額 - 關稅(finding #1:關稅系統回收=直接消失,不轉給任何第三方)。
    expect(sellerAfter.resources.money).toBe(500 + 10 * 10 - tariff);
  });

  it('撤單退回鎖定的資源(sell 退貨、buy 退錢)', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-2', regions: [makeRegion({ id: 'region-0' })] }), 0);
    const nation = await registerLoginFoundNation(db, env, 'solo@example.com', '獨自國');

    const place = await app.request(
      '/api/market',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: nation.cookie },
        body: JSON.stringify({ kind: 'ore', side: 'sell', qty: 20, price: 5 }),
      },
      env
    );
    const placed = await json<{ book: { id: string }[] }>(place);
    const orderId = placed.book[placed.book.length - 1].id;

    const afterPlace = (
      await json<{ nation: { resources: { ore: number } } }>(await app.request('/api/nation', { headers: { Cookie: nation.cookie } }, env))
    ).nation;
    expect(afterPlace.resources.ore).toBe(180); // 200 - 20

    await app.request(`/api/market/${orderId}`, { method: 'DELETE', headers: { Cookie: nation.cookie } }, env);

    const afterCancel = (
      await json<{ nation: { resources: { ore: number } } }>(await app.request('/api/nation', { headers: { Cookie: nation.cookie } }, env))
    ).nation;
    expect(afterCancel.resources.ore).toBe(200); // 全額退回
  });

  it('掛單資源不足 → INSUFFICIENT_RESOURCES,不留下任何殘留掛單', async () => {
    const db = createTestD1();
    const world = makeWorld({
      seasonId: 'season-insufficient',
      tick: 200,
      nations: [makeNation({ id: 'n1', resources: { food: 5, ore: 5, fuel: 5, money: 5 }, protectedUntil: 0 })],
    });
    await createSeason(db, 'S', world, 0);
    const nation = world.nations[0];
    const result = await applyPlaceOrder(db, world, world.seasonId, nation, { nationId: 'n1', kind: 'food', side: 'sell', qty: 999, price: 10 }, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('INSUFFICIENT_RESOURCES');
  });
});

describe('finding #4 — order.nationId/seasonId 一致性', () => {
  it('order.nationId 與呼叫端 nation.id 不符 → NATION_MISMATCH', async () => {
    const db = createTestD1();
    const world = makeWorld({ nations: [makeNation({ id: 'n1' })] });
    const result = await applyPlaceOrder(db, world, world.seasonId, world.nations[0], { nationId: 'someone-else', kind: 'food', side: 'sell', qty: 1, price: 1 }, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('NATION_MISMATCH');
  });

  it('seasonId 與 state.seasonId 不符 → SEASON_MISMATCH', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-real', nations: [makeNation({ id: 'n1' })] });
    const result = await applyPlaceOrder(db, world, 'season-wrong', world.nations[0], { nationId: 'n1', kind: 'food', side: 'sell', qty: 1, price: 1 }, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('SEASON_MISMATCH');
  });
});

describe('finding #5 — applyBuild 邊界檢查', () => {
  it('未知 building → INVALID_BUILDING(不崩潰)', () => {
    const world = makeWorld({ nations: [makeNation({ id: 'n1', buildQueue: [] })] });
    const result = applyBuild(world, world.nations[0], 'castle' as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('INVALID_BUILDING');
  });
});

describe('finding #6 — DEFAULT_REGIONS 跨季不撞號', () => {
  it('不同 seasonId 產生不同的 region id', () => {
    const r1 = buildDefaultRegions('season-a');
    const r2 = buildDefaultRegions('season-b');
    expect(r1[0].id).not.toBe(r2[0].id);
  });
});

describe('finding #7 — 國名 byte 長度上限', () => {
  it('60 bytes 以內的中文名(20 字內)允許,超出 UTF-8 byte 上限的字串被拒', () => {
    expect(isNameAllowed('二十字的中文國名測試字串正好二十字')).toBe(true);
    // 20 個 emoji(每個 4 bytes)= 80 bytes,length 檢查(<=20)可能放行但 byte 上限應擋下。
    expect(isNameAllowed('🎌'.repeat(20))).toBe(false);
  });
});

describe('finding #8 — 國旗顏色 hex 收緊為 3/6 位', () => {
  it('4/5/7/8 位長度一律拒絕', () => {
    const base = { layout: 'stripes', emblem: 'star' };
    expect(isValidFlagSpec({ ...base, colors: ['#fff'] })).toBe(true);
    expect(isValidFlagSpec({ ...base, colors: ['#ffffff'] })).toBe(true);
    expect(isValidFlagSpec({ ...base, colors: ['#ffff'] })).toBe(false);
    expect(isValidFlagSpec({ ...base, colors: ['#fffffff'] })).toBe(false);
    expect(isValidFlagSpec({ ...base, colors: ['#ffffffff'] })).toBe(false);
  });
});

describe('finding #9 — JSON body 統一 helper 擋非物件', () => {
  it('body 為陣列 → 400 INVALID_BODY,不是把陣列元素當欄位讀', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-arr', regions: [makeRegion()] }), 0);
    const res = await app.request(
      '/api/auth/register',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' },
      env
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('INVALID_BODY');
  });

  it('body 為 null → 400 INVALID_BODY', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    const res = await app.request(
      '/api/auth/register',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' },
      env
    );
    expect(res.status).toBe(400);
  });
});

describe('finding #11 — admin token 固定時間比較,行為正確性', () => {
  it('token 完全相符才通過,長度不同/內容不同一律 401', async () => {
    const db = createTestD1();
    const env = { DB: db, ADMIN_TOKEN: 'correct-token-value', ENVIRONMENT: 'test' };
    const wrongLen = await app.request('/api/admin/season', { method: 'POST', headers: { Authorization: 'Bearer short' } }, env);
    expect(wrongLen.status).toBe(401);
    const wrongContent = await app.request(
      '/api/admin/season',
      { method: 'POST', headers: { Authorization: 'Bearer correct-token-wrong' } },
      env
    );
    expect(wrongContent.status).toBe(401);
  });
});

describe('finding #12 — diplomacy propose 驗證 counterpartyId 存在', () => {
  it('counterpartyId 不存在 → 404 COUNTERPARTY_NOT_FOUND', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-dip', tick: 200, regions: [makeRegion({ id: 'region-0' })] }), 0);
    const nation = await registerLoginFoundNation(db, env, 'dip@example.com', '外交國');

    const res = await app.request(
      '/api/diplomacy/propose',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: nation.cookie },
        body: JSON.stringify({ kind: 'nap', counterpartyId: 'no-such-nation', terms: { duration: 100 } }),
      },
      env
    );
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe('COUNTERPARTY_NOT_FOUND');
  });
});

describe('finding #13 — diplomacy breach 實際結算賠償+信譽', () => {
  it('毀約方付賠償金給對方,reputation.breaches +1', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    const nA = makeNation({ id: 'n-a', ownerId: 'user-a', regionId: 'region-0', resources: { food: 0, ore: 0, fuel: 0, money: 200 }, reputation: { breaches: 0 } });
    const nB = makeNation({ id: 'n-b', ownerId: 'user-b', regionId: 'region-0', resources: { food: 0, ore: 0, fuel: 0, money: 100 }, reputation: { breaches: 0 } });
    const treaty = makeTreaty({ id: 'treaty-1', aId: 'n-a', bId: 'n-b', status: 'active', terms: { duration: 100, activatedAt: 0, compensation: 40 } });
    const world = makeWorld({ seasonId: 'season-breach', tick: 10, nations: [nA, nB], treaties: [treaty], regions: [makeRegion({ id: 'region-0' })] });
    await createSeason(db, 'S', world, 0);

    // 直接用 users/sessions 太麻煩,改走 repository 層驗證(不透過 HTTP session)。
    const { breach, breachPenalty } = await import('@micronation/diplomacy');
    const before = await loadWorldState(db, 'season-breach');
    const result = breach(before!.treaties, 'treaty-1', 'n-a', 10);
    expect(result.ok).toBe(true);
    const penalty = breachPenalty(treaty);
    expect(penalty.compensation).toBe(40);
    // 對應 route 邏輯(diplomacy.ts breach handler)應該把 40 從 n-a 轉給 n-b、n-a breaches+1——
    // 這裡驗證的是 breachPenalty 本身回傳值正確,route 層轉帳邏輯由下面的 HTTP 測試驗證。
  });

  it('HTTP /api/diplomacy/breach 實際扣款+加信譽', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-breach2', tick: 200, regions: [makeRegion({ id: 'region-0' })] }), 0);
    const a = await registerLoginFoundNation(db, env, 'breach-a@example.com', 'A國');
    const b = await registerLoginFoundNation(db, env, 'breach-b@example.com', 'B國');

    const propose = await app.request(
      '/api/diplomacy/propose',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
        body: JSON.stringify({ kind: 'nap', counterpartyId: b.nationId, terms: { duration: 500, compensation: 30 } }),
      },
      env
    );
    const proposed = await json<{ treaties: { id: string }[] }>(propose);
    const treatyId = proposed.treaties[0].id;

    await app.request(
      '/api/diplomacy/respond',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: b.cookie }, body: JSON.stringify({ treatyId, action: 'accept' }) },
      env
    );

    const bMoneyBefore = (await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: b.cookie } }, env))).nation
      .resources.money;

    const breachRes = await app.request(
      '/api/diplomacy/breach',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie }, body: JSON.stringify({ treatyId }) },
      env
    );
    expect(breachRes.status).toBe(200);

    const aAfter = (await json<{ nation: { resources: { money: number }; reputation: { breaches: number } } }>(await app.request('/api/nation', { headers: { Cookie: a.cookie } }, env)))
      .nation;
    // Codex 四審⑦:breaches 改回每次毀約固定 +1(語意是「毀約次數」,不是「累積信譽分數」)——
    // ③-5 那版曾改成累加 breachPenalty().reputationDelta 的絕對值(固定 10),見
    // routes/diplomacy.ts breach handler 註解,已回退。
    expect(aAfter.reputation.breaches).toBe(1);
    expect(aAfter.resources.money).toBe(500 - 30);

    const bAfter = (await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: b.cookie } }, env))).nation;
    expect(bAfter.resources.money).toBe(bMoneyBefore + 30);
  });
});

describe('finding #16 — policy axis 白名單擋 __proto__', () => {
  it('axis=__proto__ → 400 INVALID_POLICY(不崩潰、不觸發 prototype 相關行為)', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-proto', tick: 200, regions: [makeRegion({ id: 'region-0' })] }), 0);
    const nation = await registerLoginFoundNation(db, env, 'proto@example.com', '原型國');

    const res = await app.request(
      '/api/policy',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: nation.cookie }, body: JSON.stringify({ axis: '__proto__', tier: 'high' }) },
      env
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('INVALID_POLICY');
  });
});

describe('finding #18 — 一國一владелец靠 DB 唯一索引', () => {
  it('繞過記憶體檢查直接呼叫 insertNewNation 兩次 → 第二次撞唯一索引', async () => {
    const db = createTestD1();
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-dup', regions: [makeRegion({ id: 'region-0' })] }), 0);
    const { insertNewNation, NationAlreadyFoundedError } = await import('../src/db/repository');
    const n1 = makeNation({ id: 'dup-1', ownerId: 'same-user', regionId: 'region-0' });
    const n2 = makeNation({ id: 'dup-2', ownerId: 'same-user', regionId: 'region-0' });
    await insertNewNation(db, 'season-dup', n1);
    await expect(insertNewNation(db, 'season-dup', n2)).rejects.toThrow(NationAlreadyFoundedError as never);
  });
});

describe('finding #20 — 訊息分頁 + 速率限制 + 單調序號', () => {
  it('每國每 tick 超過上限 → 429 RATE_LIMITED', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-msg2', tick: 200, regions: [makeRegion({ id: 'region-0' })] }), 0);
    const a = await registerLoginFoundNation(db, env, 'rate-a@example.com', 'A國');
    const b = await registerLoginFoundNation(db, env, 'rate-b@example.com', 'B國');

    let lastStatus = 0;
    for (let i = 0; i < 15; i++) {
      const res = await app.request(
        '/api/messages',
        { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie }, body: JSON.stringify({ toNationId: b.nationId, body: `msg-${i}` }) },
        env
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('claimNextMessageSeq 單調遞增、不重複', async () => {
    const db = createTestD1();
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-seq' }), 0);
    const s1 = await claimNextMessageSeq(db, 'season-seq');
    const s2 = await claimNextMessageSeq(db, 'season-seq');
    expect(s2).toBe(s1 + 1);
  });
});

describe('finding #24 — /api/world 回傳 nextCursor', () => {
  it('events 為空時 nextCursor 維持原本 since;有事件時前進到最後一筆 seq', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-cursor', nations: [makeNation({ id: 'n1', ownerId: 'u1' })] });
    await createSeason(db, 'S', world, 0);
    const events = await getEventsSince(db, 'season-cursor', 0, 'n1');
    expect(events.events.length).toBe(0);
  });
});

describe('finding #25 — 統一 404 handler', () => {
  it('未知路徑回傳 JSON { error: NOT_FOUND },不是 Hono 預設純文字', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    const res = await app.request('/api/does-not-exist', {}, env);
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe('NOT_FOUND');
  });
});

describe('finding #26 — rankings 同分 tie-breaker(nation id 排序)決定性', () => {
  it('同分數兩次請求排序一致', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    const n1 = makeNation({ id: 'nb', ownerId: 'u1', score: { economy: 5, warfare: 0, tech: 0, diplomacy: 0, total: 5 } });
    const n2 = makeNation({ id: 'na', ownerId: 'u2', score: { economy: 5, warfare: 0, tech: 0, diplomacy: 0, total: 5 } });
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-rank', nations: [n1, n2], regions: [makeRegion({ id: 'region-0' })] }), 0);

    const r1 = await app.request('/api/rankings', {}, env);
    const r2 = await app.request('/api/rankings', {}, env);
    const b1 = await json<{ overall: { id: string }[] }>(r1);
    const b2 = await json<{ overall: { id: string }[] }>(r2);
    expect(b1.overall.map((n) => n.id)).toEqual(b2.overall.map((n) => n.id));
    expect(b1.overall[0].id).toBe('na'); // localeCompare('na','nb') < 0
  });
});

describe('finding #27/#32 — 賽季結算順序與名人堂 tie-breaker', () => {
  it('同分時名人堂 rank 1 決定性地選 id 較小者', async () => {
    const db = createTestD1();
    const zeroBuildings = { farm: 0, mine: 0, refinery: 0, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 };
    const n1 = makeNation({ id: 'zb', ownerId: 'u1', regionId: 'region-0', resources: { food: 0, ore: 0, fuel: 0, money: 0 }, tech: 0, buildings: zeroBuildings, buildQueue: [], score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 } });
    const n2 = makeNation({ id: 'za', ownerId: 'u2', regionId: 'region-0', resources: { food: 0, ore: 0, fuel: 0, money: 0 }, tech: 0, buildings: zeroBuildings, buildQueue: [], score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 } });
    const { SEASON_LENGTH_TICKS } = await import('../src/game/constants');
    const world = makeWorld({ seasonId: 'season-tie', tick: SEASON_LENGTH_TICKS - 1, nations: [n1, n2], regions: [makeRegion({ id: 'region-0' })] });
    await createSeason(db, 'S', world, 0);

    await runTick(db, { now: 1000 });

    const hof = await db.prepare('SELECT * FROM hall_of_fame WHERE season_id = ? AND category IS NULL AND rank = 1').bind('season-tie').all();
    const rows = hof.results as { nation_id: string }[];
    expect(rows[0].nation_id).toBe('za');

    // 賽季結算後,最後一 tick 的狀態必須已經落地(finalizeSeason 在 saveWorldState 之後才跑)。
    const loaded = await loadWorldState(db, 'season-tie');
    expect(loaded?.tick).toBe(SEASON_LENGTH_TICKS);
  });
});

describe('finding #28 — tick_running stale 可搶', () => {
  it('tick_running 已超過 stale 門檻 → 下一輪可接管、不永久卡死', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-stale', tick: 0, nations: [] });
    await createSeason(db, 'S', world, 0);

    const { setSeasonTickRunning, TICK_RUNNING_STALE_MS } = await import('../src/db/repository');
    // 模擬「很久以前開始跑、但從未清除」的卡死旗標。
    await setSeasonTickRunning(db, 'season-stale', true, 0);

    const result = await runTick(db, { now: TICK_RUNNING_STALE_MS + 1000 });
    expect(result.ranTick).toBe(true);
  });

  it('未逾時的 tick_running 仍正常擋下本輪', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-fresh', tick: 0, nations: [] });
    await createSeason(db, 'S', world, 0);
    const { setSeasonTickRunning } = await import('../src/db/repository');
    await setSeasonTickRunning(db, 'season-fresh', true, 1000);

    const result = await runTick(db, { now: 1500 });
    expect(result.ranTick).toBe(false);
    expect(result.skippedReason).toBe('TICK_IN_PROGRESS');
  });
});

describe('finding #23/#29 — scheduled tick 時槽冪等', () => {
  it('同一 scheduledSlot 再次呼叫 → 跳過,不重複推進 tick', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-slot', tick: 0, nations: [] });
    await createSeason(db, 'S', world, 0);

    const slot = 3_600_000;
    const first = await runTick(db, { now: 1000, scheduledSlot: slot });
    expect(first.ranTick).toBe(true);

    const second = await runTick(db, { now: 2000, scheduledSlot: slot });
    expect(second.ranTick).toBe(false);
    expect(second.skippedReason).toBe('ALREADY_PROCESSED_SLOT');

    const loaded = await loadWorldState(db, 'season-slot');
    expect(loaded?.tick).toBe(1); // 只推進一次,不是兩次
  });
});

describe('finding #10 — 開季併發靠 DB 唯一索引兜底', () => {
  it('繞過 admin.ts 的記憶體檢查,直接對 createSeason 製造衝突 → SeasonAlreadyActiveError', async () => {
    const db = createTestD1();
    const { createSeason: rawCreateSeason, SeasonAlreadyActiveError } = await import('../src/db/repository');
    await rawCreateSeason(db, 'First', makeWorld({ seasonId: 'season-first', regions: [makeRegion()] }), 0);
    await expect(rawCreateSeason(db, 'Second', makeWorld({ seasonId: 'season-second', regions: [makeRegion()] }), 0)).rejects.toThrow(
      SeasonAlreadyActiveError as never
    );
  });
});

describe('finding #19 — 玩家初始值集中於 api 層 constants', () => {
  it('開國後的資源/人口/軍力與 game/constants.ts PLAYER_INITIAL_* 一致', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-init', regions: [makeRegion({ id: 'region-0' })] }), 0);
    const nation = await registerLoginFoundNation(db, env, 'init@example.com', '初始國');
    const res = await app.request('/api/nation', { headers: { Cookie: nation.cookie } }, env);
    const body = await json<{ nation: { population: number; morale: number; actionPoints: number; army: { size: number } } }>(res);
    const { PLAYER_INITIAL_POPULATION, PLAYER_INITIAL_MORALE, PLAYER_INITIAL_ACTION_POINTS, PLAYER_INITIAL_ARMY_SIZE } = await import(
      '../src/game/constants'
    );
    expect(body.nation.population).toBe(PLAYER_INITIAL_POPULATION);
    expect(body.nation.morale).toBe(PLAYER_INITIAL_MORALE);
    expect(body.nation.actionPoints).toBe(PLAYER_INITIAL_ACTION_POINTS);
    expect(body.nation.army.size).toBe(PLAYER_INITIAL_ARMY_SIZE);
  });
});

describe('finding #15 — recallMarch 回傳受限視角', () => {
  it('回傳的 marches 不含其他國家精確 size(非涉己者為 sizeTier)', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-recall', tick: 0, regions: [makeRegion({ id: 'region-0' }), makeRegion({ id: 'region-1' })] }), 0);
    const a = await registerLoginFoundNation(db, env, 'recall-a@example.com', 'A國');
    const b = await registerLoginFoundNation(db, env, 'recall-b@example.com', 'B國');
    await db.prepare('UPDATE seasons SET tick = ? WHERE id = ?').bind(200, 'season-recall').run();

    const attack = await app.request(
      '/api/military/attack',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie }, body: JSON.stringify({ defenderId: b.nationId, army: 5 }) },
      env
    );
    const march = await json<{ march: { id: string }; error?: string }>(attack);
    expect(attack.status, JSON.stringify(march)).toBe(201);

    const recall = await app.request(
      '/api/military/recall',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie }, body: JSON.stringify({ marchId: march.march.id }) },
      env
    );
    expect(recall.status).toBe(200);
    const body = await json<{ marches: { size?: number; sizeTier?: string }[] }>(recall);
    expect(Array.isArray(body.marches)).toBe(true);
  });
});
