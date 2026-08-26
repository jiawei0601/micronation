// Codex 四審 apps/api findings 回歸測試(對應派工清單 db/auth①1-6、game/routes/tick②7-10)。
// 修復前(舊行為)這些斷言會紅。②7/②8 的回歸測試併入 findings.test.ts / findings3.test.ts
// 既有的 diplomacy breach 案例(直接更新原本斷言舊行為的那幾筆),不在此檔重複。

import { describe, it, expect } from 'vitest';
import { createTestD1 } from './support/sqliteD1Adapter';
import {
  createSeason,
  saveWorldState,
  loadWorldState,
  markSeasonEnded,
  getEventsSince,
  insertUserWithVerificationToken,
  insertVerificationTokenAtomic,
  cleanupVerificationTokensKeepingLatest,
  deleteVerificationTokenByHash,
  finalizeEmailVerification,
  cleanupExpiredVerificationTokens,
  findVerificationToken,
  VERIFICATION_TOKEN_KEEP_MAX,
  claimTickLease,
  getSeasonTickRunningState,
  type UserRow,
} from '../src/db/repository';
import { rowToNation, rowToTreaty, type NationRow, type TreatyRow } from '../src/db/rows';
import { isValidFlagSpec } from '../src/game/constants';
import { runTick } from '../src/tick/run';
import { register, verifyEmail } from '../src/auth/service';
import { ConsoleMailSender } from '../src/auth/mail';
import { sha256Hex } from '../src/auth/password';
import { app, mailSender } from '../src/index';
import { makeWorld, makeRegion, makeNation, makeTreaty, emptyBuildings } from './support/fixtures';
import type { D1Database, D1PreparedStatement } from '../src/db/types';

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
  const loginRes = await app.request(
    '/api/auth/login',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) },
    env
  );
  const cookie = extractCookie(loginRes);
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

describe('①-1 — events.seq 跨賽季不再撞主鍵', () => {
  it('第二季寫入的事件不會因為 next_event_seq 歸零而撞第一季已用過的 events.seq', async () => {
    const db = createTestD1();

    const world1 = makeWorld({ seasonId: 'season-1', tick: 0, regions: [makeRegion({ id: 'region-0' })] });
    await createSeason(db, 'S1', world1, 0);
    // 第一季寫入一筆事件——舊版寫入時 events.seq = eventSeqStart+i+1,此時 season-1 的
    // next_event_seq 從 0 開始,這筆事件的 seq 會是 1。
    await saveWorldState(db, world1, { ...world1, tick: 1 }, [
      { tick: 1, type: 'production_tick', nationIds: [], payload: null },
    ], 100);

    await markSeasonEnded(db, 'season-1', 200);

    const world2 = makeWorld({ seasonId: 'season-2', tick: 0, regions: [makeRegion({ id: 'region-2-0' })] });
    await createSeason(db, 'S2', world2, 300);
    // 第二季的 next_event_seq 也是從 0 起算——舊版寫入的第一筆事件同樣會算出 seq=1,
    // 與第一季已經存在的 events.seq=1 撞主鍵,saveWorldState 這裡會拋 UNIQUE constraint 例外
    // (修復前這個 await 會 reject,測試在這裡就紅了)。
    await expect(
      saveWorldState(db, world2, { ...world2, tick: 1 }, [
        { tick: 1, type: 'production_tick', nationIds: [], payload: null },
      ], 400)
    ).resolves.not.toThrow();

    // 兩季各自查得到自己那筆事件,不互相污染(events.seq 是全表唯一但 season_id 仍正確過濾)。
    const rows1 = await db.prepare('SELECT * FROM events WHERE season_id = ?').bind('season-1').all();
    const rows2 = await db.prepare('SELECT * FROM events WHERE season_id = ?').bind('season-2').all();
    expect(rows1.results).toHaveLength(1);
    expect(rows2.results).toHaveLength(1);
    // events.seq 全表唯一——第二季那筆的 seq 必須跟第一季那筆不同。
    const seq1 = (rows1.results[0] as { seq: number }).seq;
    const seq2 = (rows2.results[0] as { seq: number }).seq;
    expect(seq1).not.toBe(seq2);
  });

  it('events_nations 子表的 event_seq 正確對應到 AUTOINCREMENT 實際配發的 seq(非顯式指定)', async () => {
    const db = createTestD1();
    const nation = makeNation({ id: 'nation-1', regionId: 'region-0' });
    const world = makeWorld({ seasonId: 'season-en', nations: [nation], regions: [makeRegion({ id: 'region-0' })] });
    await createSeason(db, 'S', world, 0);

    await saveWorldState(db, world, { ...world, tick: 1 }, [
      { tick: 1, type: 'production_tick', nationIds: ['nation-1'], payload: null },
    ], 0);

    const result = await getEventsSince(db, 'season-en', 0, 'nation-1');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe('production_tick');
  });
});

describe('②-2 — register 的 user + verification_token 同一 batch(原子)', () => {
  it('insertUserWithVerificationToken:第二筆(token)撞主鍵時,第一筆(user)也會被 rollback', async () => {
    const db = createTestD1();
    // 預先塞一筆同 token_hash 的列,製造第二個 INSERT 撞主鍵。
    await db
      .prepare('INSERT INTO verification_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind('forced-collision', 'someone-else', 999999, 0)
      .run();

    const userRow: UserRow = {
      id: 'user-atomic',
      email: 'atomic@example.com',
      password_hash: 'h',
      password_salt: 's',
      password_iterations: 1,
      verified: 0,
      created_at: 0,
    };
    await expect(
      insertUserWithVerificationToken(db, userRow, {
        token_hash: 'forced-collision',
        user_id: 'user-atomic',
        expires_at: 1,
        created_at: 0,
      })
    ).rejects.toThrow();

    // 修復前(register 分兩次獨立呼叫 insertUser/insertVerificationToken):user 那筆會單獨先
    // 成功寫入,不受後面 token 那筆失敗影響——修復後兩者同一 batch,任一失敗整批 rollback。
    const persistedUser = await db.prepare('SELECT * FROM users WHERE id = ?').bind('user-atomic').first();
    expect(persistedUser).toBeNull();
  });

  it('register() 端到端:成功時 user 與唯一一筆 verification_token 同時存在', async () => {
    const db = createTestD1();
    const mail = new ConsoleMailSender();
    const result = await register(db, mail, 'atomic-e2e@example.com', 'password123', 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tokenRows = await db
      .prepare('SELECT COUNT(*) AS n FROM verification_tokens WHERE user_id = ?')
      .bind(result.value.userId)
      .first<{ n: number }>();
    expect(tokenRows?.n).toBe(1);
  });
});

describe('③ — verification_tokens 插入(清過期)+ 寄信成功後才 cap cleanup(Codex 五審①)', () => {
  it('cleanupVerificationTokensKeepingLatest:超過 VERIFICATION_TOKEN_KEEP_MAX 筆時只保留最新幾筆', async () => {
    const db = createTestD1();
    await db
      .prepare('INSERT INTO users (id, email, password_hash, password_salt, password_iterations, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('user-cap', 'cap@example.com', 'h', 's', 1, 0, 0)
      .run();

    let lastHash = '';
    for (let i = 0; i < VERIFICATION_TOKEN_KEEP_MAX + 3; i++) {
      lastHash = `tok-${i}`;
      await insertVerificationTokenAtomic(db, { token_hash: lastHash, user_id: 'user-cap', expires_at: 999_999, created_at: i }, i);
      // 比照 resendVerification 實際呼叫順序:每次插入後(模擬寄信成功)立刻做 cap cleanup。
      await cleanupVerificationTokensKeepingLatest(db, 'user-cap', lastHash);
    }

    const rows = await db.prepare('SELECT token_hash FROM verification_tokens WHERE user_id = ?').bind('user-cap').all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(VERIFICATION_TOKEN_KEEP_MAX);
    // 保留的應是最新那幾筆(tok-3 ~ tok-9,不是最早的 tok-0~tok-2)。
    const kept = new Set(rows.results.map((r) => r.token_hash));
    expect(kept.has('tok-0')).toBe(false);
    expect(kept.has(`tok-${VERIFICATION_TOKEN_KEEP_MAX + 2}`)).toBe(true);
  });

  it('insertVerificationTokenAtomic:插入時順便清掉該 user 已過期的舊 token', async () => {
    const db = createTestD1();
    await db
      .prepare('INSERT INTO users (id, email, password_hash, password_salt, password_iterations, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('user-exp', 'exp@example.com', 'h', 's', 1, 0, 0)
      .run();
    await db
      .prepare('INSERT INTO verification_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind('expired-tok', 'user-exp', 100, 0)
      .run();

    await insertVerificationTokenAtomic(db, { token_hash: 'fresh-tok', user_id: 'user-exp', expires_at: 999_999, created_at: 200 }, 200);

    expect(await findVerificationToken(db, 'expired-tok')).toBeNull();
    expect(await findVerificationToken(db, 'fresh-tok')).not.toBeNull();
  });

  it('Codex 五審①:寄信失敗時不做 cap cleanup、且刪掉這次的孤兒 token,既有舊 token 不受影響', async () => {
    const db = createTestD1();
    await db
      .prepare('INSERT INTO users (id, email, password_hash, password_salt, password_iterations, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('user-failmail', 'failmail@example.com', 'h', 's', 1, 0, 0)
      .run();
    await insertVerificationTokenAtomic(db, { token_hash: 'existing-tok', user_id: 'user-failmail', expires_at: 999_999, created_at: 0 }, 0);

    // resendVerification 實際順序:插入新 token → 寄信(失敗)→ deleteVerificationTokenByHash(新 token)。
    await insertVerificationTokenAtomic(db, { token_hash: 'new-tok-mail-failed', user_id: 'user-failmail', expires_at: 999_999, created_at: 1 }, 1);
    await deleteVerificationTokenByHash(db, 'new-tok-mail-failed');

    expect(await findVerificationToken(db, 'existing-tok')).not.toBeNull();
    expect(await findVerificationToken(db, 'new-tok-mail-failed')).toBeNull();
  });

  it('Codex 五審①:連續 resend(皆寄信成功)不誤刪剛寄出的最新 token', async () => {
    const db = createTestD1();
    await db
      .prepare('INSERT INTO users (id, email, password_hash, password_salt, password_iterations, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('user-chain', 'chain@example.com', 'h', 's', 1, 0, 0)
      .run();

    const hashes = ['c-tok-0', 'c-tok-1', 'c-tok-2'];
    for (let i = 0; i < hashes.length; i++) {
      await insertVerificationTokenAtomic(db, { token_hash: hashes[i], user_id: 'user-chain', expires_at: 999_999, created_at: i }, i);
      await cleanupVerificationTokensKeepingLatest(db, 'user-chain', hashes[i]);
    }

    // 三筆都在 KEEP_MAX 之內,全部應該還在——特別是最後一筆(剛寄出的)一定不能被自己觸發的
    // cleanup 誤刪。
    for (const h of hashes) {
      expect(await findVerificationToken(db, h)).not.toBeNull();
    }
  });

  it('cleanupExpiredVerificationTokens:tick 路徑的全域清理路徑,獨立於任何 user 的插入時機', async () => {
    const db = createTestD1();
    await db
      .prepare('INSERT INTO users (id, email, password_hash, password_salt, password_iterations, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('user-never-resend', 'never@example.com', 'h', 's', 1, 0, 0)
      .run();
    await db
      .prepare('INSERT INTO verification_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind('stale-tok', 'user-never-resend', 100, 0)
      .run();

    // 這個 user 從未 resend、也沒有下一次插入觸發 insertVerificationTokenWithCleanup 的清理——
    // 只有靠獨立的全域清理路徑才會被清掉。
    await cleanupExpiredVerificationTokens(db, 999_999);
    expect(await findVerificationToken(db, 'stale-tok')).toBeNull();
  });
});

describe('④ — verifyEmail 的 verified 標記 + DELETE token 同一 batch', () => {
  it('finalizeEmailVerification:標記已驗證與清空 token 同時生效', async () => {
    const db = createTestD1();
    await db
      .prepare('INSERT INTO users (id, email, password_hash, password_salt, password_iterations, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('user-verify', 'verify4@example.com', 'h', 's', 1, 0, 0)
      .run();
    await db
      .prepare('INSERT INTO verification_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind('tok-verify', 'user-verify', 999_999, 0)
      .run();

    await finalizeEmailVerification(db, 'user-verify');

    const user = await db.prepare('SELECT verified FROM users WHERE id = ?').bind('user-verify').first<{ verified: number }>();
    expect(user?.verified).toBe(1);
    const remaining = await db.prepare('SELECT COUNT(*) AS n FROM verification_tokens WHERE user_id = ?').bind('user-verify').first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it('verifyEmail() 端到端仍正確(單一 batch 不改變外部行為)', async () => {
    const db = createTestD1();
    const mail = new ConsoleMailSender();
    await register(db, mail, 'verify4-e2e@example.com', 'password123', 0);
    const token = mail.lastToken!;
    const result = await verifyEmail(db, token, 1);
    expect(result.ok).toBe(true);
    expect(await verifyEmail(db, token, 2)).toEqual({ ok: false, error: 'INVALID_TOKEN' });
  });
});

describe('⑤ — rows.ts flag 驗證改共用 isValidFlagSpec(不再是另一份寬鬆規則)', () => {
  it('colors 超過 4 個(isValidFlagSpec 拒絕,舊版 rows.ts 自己的 isFlagSpec 會放行)→ CorruptRowError', async () => {
    const badFlag = { layout: 'stripes', emblem: 'star', colors: ['#111', '#222', '#333', '#444', '#555'] };
    const row: NationRow = {
      id: 'n-badflag',
      season_id: 's1',
      owner_id: null,
      name: 'X',
      flag: JSON.stringify(badFlag),
      region_id: 'r1',
      resource_food: 0,
      resource_ore: 0,
      resource_fuel: 0,
      resource_money: 0,
      tech: 0,
      action_points: 0,
      population: 0,
      morale: 0,
      buildings: JSON.stringify(emptyBuildings()),
      build_queue: '[]',
      army_size: 0,
      policies: JSON.stringify({ tax: 'mid', economy: 'agri', conscription: 'volunteer', openness: 'neutral' }),
      policy_changed_at: '{}',
      reputation_breaches: 0,
      protected_until: 0,
      score: JSON.stringify({ economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 }),
      created_at: 0,
      last_attacked_at: null,
    };
    expect(() => rowToNation(row)).toThrow(/CORRUPT_ROW/);
    // 同一份規則自己也承認這個 flag 不合法(不是兩套各說各話)。
    expect(isValidFlagSpec(badFlag)).toBe(false);
  });

  it('非標準 hex 長度(#ffff,4 位)——舊版 rows.ts 的 isFlagSpec 只檢查 typeof string,會放行', async () => {
    const badFlag = { layout: 'stripes', emblem: 'star', colors: ['#ffff'] };
    expect(isValidFlagSpec(badFlag)).toBe(false);
  });
});

describe('⑥ — rows.ts TreatyTerms 驗證收緊(安全整數 + pendingResponderId 限定 aId/bId）', () => {
  function treatyRow(terms: unknown, aId = 'n-a', bId = 'n-b'): TreatyRow {
    return {
      id: 't-terms',
      season_id: 's1',
      kind: 'nap',
      a_id: aId,
      b_id: bId,
      status: 'active',
      terms: JSON.stringify(terms),
      created_at: 0,
    };
  }

  it('duration 為小數 → CorruptRowError(舊版只檢查 Number.isFinite,會放行)', () => {
    expect(() => rowToTreaty(treatyRow({ duration: 1.5 }))).toThrow(/CORRUPT_ROW/);
  });

  it('duration 為負數 → CorruptRowError', () => {
    expect(() => rowToTreaty(treatyRow({ duration: -10 }))).toThrow(/CORRUPT_ROW/);
  });

  it('compensation 為負數 → CorruptRowError', () => {
    expect(() => rowToTreaty(treatyRow({ duration: 10, compensation: -1 }))).toThrow(/CORRUPT_ROW/);
  });

  it('activatedAt 為負數 → CorruptRowError', () => {
    expect(() => rowToTreaty(treatyRow({ duration: 10, activatedAt: -1 }))).toThrow(/CORRUPT_ROW/);
  });

  it('pendingResponderId 不是這筆條約的 aId 或 bId → CorruptRowError(舊版任意字串都放行)', () => {
    expect(() => rowToTreaty(treatyRow({ duration: 10, pendingResponderId: 'someone-else' }, 'n-a', 'n-b'))).toThrow(/CORRUPT_ROW/);
  });

  it('pendingResponderId 是 aId 或 bId → 合法', () => {
    expect(() => rowToTreaty(treatyRow({ duration: 10, pendingResponderId: 'n-b' }, 'n-a', 'n-b'))).not.toThrow();
    expect(rowToTreaty(treatyRow({ duration: 10, pendingResponderId: 'n-a' }, 'n-a', 'n-b')).terms).toEqual({
      duration: 10,
      pendingResponderId: 'n-a',
    });
  });

  it('合法的正整數 terms 仍正確 round-trip', () => {
    const t = rowToTreaty(treatyRow({ duration: 100, compensation: 40, activatedAt: 5 }));
    expect(t.terms).toEqual({ duration: 100, compensation: 40, activatedAt: 5 });
  });
});

describe('⑧ — 毀約 clamp:付款方扣全額 actualCompensation,收款方只收安全上限', () => {
  it('收款方接近 Number.MAX_SAFE_INTEGER 時,付款方仍扣全額,收款方只收 clamp 後的金額(差額系統回收)', async () => {
    const db = createTestD1();
    const env = { DB: db, ENVIRONMENT: 'test' };
    await createSeason(db, 'S', makeWorld({ seasonId: 'season-clamp8', tick: 200, regions: [makeRegion({ id: 'region-0' })] }), 0);
    const a = await registerLoginFoundNation(db, env, 'clamp8-a@example.com', 'A國');
    const b = await registerLoginFoundNation(db, env, 'clamp8-b@example.com', 'B國');

    // 直接把 B 的餘額推到接近安全整數上限,讓 receiverRoom 明顯小於 compensation。
    const bNearMax = Number.MAX_SAFE_INTEGER - 5;
    await db.prepare('UPDATE nations SET resource_money = ? WHERE id = ?').bind(bNearMax, b.nationId).run();
    const aMoneyBefore = (
      await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: a.cookie } }, env))
    ).nation.resources.money;

    const propose = await app.request(
      '/api/diplomacy/propose',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie }, body: JSON.stringify({ kind: 'nap', counterpartyId: b.nationId, terms: { duration: 500, compensation: 40 } }) },
      env
    );
    const { treaties } = await json<{ treaties: { id: string }[] }>(propose);
    const treatyId = treaties[0].id;
    await app.request(
      '/api/diplomacy/respond',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: b.cookie }, body: JSON.stringify({ treatyId, action: 'accept' }) },
      env
    );

    const breachRes = await app.request(
      '/api/diplomacy/breach',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie }, body: JSON.stringify({ treatyId }) },
      env
    );
    expect(breachRes.status).toBe(200);

    const aAfter = (
      await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: a.cookie } }, env))
    ).nation;
    const bAfter = (
      await json<{ nation: { resources: { money: number } } }>(await app.request('/api/nation', { headers: { Cookie: b.cookie } }, env))
    ).nation;

    const receiverRoom = Math.max(0, Number.MAX_SAFE_INTEGER - bNearMax);
    expect(receiverRoom).toBeLessThan(40); // 確保這個案例真的觸發了 clamp
    // 修復前:付款方扣的是 safeCompensation(=receiverRoom,被 clamp 過的小額),等於少付了差額。
    // 修復後:付款方永遠扣全額 actualCompensation(=40,A 付得起全額)。
    expect(aMoneyBefore - aAfter.resources.money).toBe(40);
    // 收款方只收 clamp 後的安全金額,不會讓餘額超出安全整數範圍。
    expect(bAfter.resources.money).toBe(bNearMax + receiverRoom);
    expect(Number.isSafeInteger(bAfter.resources.money)).toBe(true);
  });
});

describe('⑨ — tick/run.ts claimTickSlot 移入 try/finally,lease 必釋放', () => {
  it('claimTickSlot 本身拋例外時,tick lease 仍會被釋放(不會卡死賽季)', async () => {
    const realDb = createTestD1();
    const world = makeWorld({ seasonId: 'season-slot-throw', regions: [makeRegion({ id: 'region-0' })] });
    await createSeason(realDb, 'S', world, 0);

    // 包一層:對 claimTickSlot 用到的那條 SQL(UPDATE seasons SET last_tick_slot ...)強制拋錯,
    // 其餘 SQL 原樣轉發給真正的 db——模擬「claimTickSlot 本身因為底層連線問題而拋例外」。
    const throwingDb: D1Database = {
      prepare: (sql: string) => {
        if (sql.includes('last_tick_slot = ?')) {
          return {
            bind: () => {
              throw new Error('boom-claimTickSlot');
            },
          } as unknown as D1PreparedStatement;
        }
        return realDb.prepare(sql);
      },
      batch: (stmts) => realDb.batch(stmts),
      exec: (q) => realDb.exec(q),
    };

    await expect(runTick(throwingDb, { now: 1000, scheduledSlot: 1 })).rejects.toThrow('boom-claimTickSlot');

    // 修復前:claimTickSlot 呼叫在 try 區塊之外,拋例外時 lease 永遠不會被釋放,
    // tick_running 會卡在 true 直到 TICK_RUNNING_STALE_MS 逾時。
    const state = await getSeasonTickRunningState(realDb, 'season-slot-throw');
    expect(state.running).toBe(false);
  });

  it('正常路徑(不拋例外)仍照常運作:lease 搶到、tick 跑完後釋放', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-slot-ok', regions: [makeRegion({ id: 'region-0' })] });
    await createSeason(db, 'S', world, 0);

    const result = await runTick(db, { now: 1000, scheduledSlot: 1 });
    expect(result.ranTick).toBe(true);
    const state = await getSeasonTickRunningState(db, 'season-slot-ok');
    expect(state.running).toBe(false);
  });

  it('lease 沒搶到(TICK_IN_PROGRESS)時不受影響,直接跳過', async () => {
    const db = createTestD1();
    const world = makeWorld({ seasonId: 'season-slot-busy', regions: [makeRegion({ id: 'region-0' })] });
    await createSeason(db, 'S', world, 0);
    await claimTickLease(db, 'season-slot-busy', 'someone-else', 1000);

    const result = await runTick(db, { now: 1000, scheduledSlot: 1 });
    expect(result.skippedReason).toBe('TICK_IN_PROGRESS');
  });
});

describe('⑩ — admin 開季 name trim + 長度上限', () => {
  it('name 全是空白 → 400 INVALID_BODY(trim 後為空)', async () => {
    const db = createTestD1();
    const env = { DB: db, ADMIN_TOKEN: 'tok', ENVIRONMENT: 'test' };
    const res = await app.request(
      '/api/admin/season',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ name: '   ' }) },
      env
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('INVALID_BODY');
  });

  it('name 超過 60 字元 → 400 INVALID_BODY', async () => {
    const db = createTestD1();
    const env = { DB: db, ADMIN_TOKEN: 'tok', ENVIRONMENT: 'test' };
    const res = await app.request(
      '/api/admin/season',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ name: 'x'.repeat(61) }) },
      env
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('INVALID_BODY');
  });

  it('name 前後有空白但 trim 後合法 → 201,存入的是 trim 後的名稱', async () => {
    const db = createTestD1();
    const env = { DB: db, ADMIN_TOKEN: 'tok', ENVIRONMENT: 'test' };
    const res = await app.request(
      '/api/admin/season',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ name: '  My Season  ' }) },
      env
    );
    expect(res.status).toBe(201);
    const { seasonId } = await json<{ seasonId: string }>(res);
    const row = await db.prepare('SELECT name FROM seasons WHERE id = ?').bind(seasonId).first<{ name: string }>();
    expect(row?.name).toBe('My Season');
  });
});
