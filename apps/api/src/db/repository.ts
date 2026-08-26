// D1 repository 層——loadWorldState/saveWorldState(差異寫回)+ user/session CRUD。
// 只做 prepared statement 組裝與 batch 呼叫,不含業務邏輯(業務邏輯在 packages/* 純模塊)。

import type { WorldState, GameEvent, Id, Trade, ResourceKind, ScoreBreakdown } from '@micronation/shared';
import { makeId } from '@micronation/shared';
import type { D1Database, D1PreparedStatement } from './types';
import {
  nationToRow,
  rowToNation,
  regionToRow,
  rowToRegion,
  marchToRow,
  rowToMarch,
  treatyToRow,
  rowToTreaty,
  orderToRow,
  rowToOrder,
  eventToRow,
  rowToEvent,
} from './rows';

/** finding #11:db.batch() 回傳每個 statement 各自的 D1Result,success:false 不會讓
 * Promise reject——D1 的 batch 對單一 statement 失敗不保證拋例外(依 driver/後端而定),不檢查
 * 就會靜默漏寫。統一收攏在這裡,任何一筆失敗就 throw,不吞錯繼續。 */
async function runBatch(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  if (stmts.length === 0) return;
  const results = await db.batch(stmts);
  const failedIndex = results.findIndex((r) => !r.success);
  if (failedIndex !== -1) {
    // ①-10:原本只回報「第幾筆失敗」,附上該筆的 D1Result(含 meta,可能有底層 driver 給的
    // 錯誤碼/訊息)供人工排查,不只是一個裸字串。
    const failed = results[failedIndex];
    throw new Error(
      `D1_BATCH_FAILED: statement #${failedIndex} did not succeed; meta=${JSON.stringify(failed?.meta ?? null)}`
    );
  }
}

/** ①-6:saveWorldState 樂觀鎖版本衝突——呼叫端讀到的 WorldState 版本已被別人(另一個玩家請求
 * 或 tick-cron)搶先寫入,路由應回 409 並提示重試(見 index.ts app.onError)。 */
export class ConflictError extends Error {
  constructor(seasonId: string) {
    super(`CONFLICT: season ${seasonId} version changed since read`);
    this.name = 'ConflictError';
  }
}

interface SeasonRow {
  id: string;
  name: string;
  tick: number;
  next_march_seq: number;
  status: string;
  created_at: number;
  ended_at: number | null;
}

export async function loadWorldState(db: D1Database, seasonId: Id): Promise<WorldState | null> {
  const season = await db
    .prepare('SELECT * FROM seasons WHERE id = ?')
    .bind(seasonId)
    .first<SeasonRow>();
  if (!season) return null;

  // finding #7:全部加 ORDER BY id——沒有明確排序時 SQLite/D1 的回傳順序不保證穩定(依實體
  // 儲存/索引選擇而定),diffCollection 之類「比對前後兩次讀取」的邏輯、或任何依賴陣列序做
  // 快照比較/測試斷言的呼叫端都可能因為順序抖動而誤判。
  const [regionsRes, nationsRes, marchesRes, treatiesRes, ordersRes] = await Promise.all([
    db.prepare('SELECT * FROM regions WHERE season_id = ? ORDER BY region_index ASC').bind(seasonId).all(),
    db.prepare('SELECT * FROM nations WHERE season_id = ? ORDER BY id ASC').bind(seasonId).all(),
    db.prepare('SELECT * FROM marches WHERE season_id = ? ORDER BY id ASC').bind(seasonId).all(),
    db.prepare('SELECT * FROM treaties WHERE season_id = ? ORDER BY id ASC').bind(seasonId).all(),
    db.prepare('SELECT * FROM market_orders WHERE season_id = ? ORDER BY id ASC').bind(seasonId).all(),
  ]);

  return {
    seasonId: season.id,
    tick: season.tick,
    nextMarchSeq: season.next_march_seq,
    regions: (regionsRes.results as never[]).map((r) => rowToRegion(r as never)),
    nations: (nationsRes.results as never[]).map((r) => rowToNation(r as never)),
    marches: (marchesRes.results as never[]).map((r) => rowToMarch(r as never)),
    treaties: (treatiesRes.results as never[]).map((r) => rowToTreaty(r as never)),
    orders: (ordersRes.results as never[]).map((r) => rowToOrder(r as never)),
  };
}

/** finding #10:createSeason 的 INSERT 撞 idx_seasons_one_active(併發開季)時,底層拋出的是
 * driver 原生的 constraint 錯誤(SQLite: `UNIQUE constraint failed`;D1 亦同錯誤字串型態)。
 * 呼叫端(admin.ts)接到這個型別的錯誤才知道要回 409 SEASON_ALREADY_ACTIVE,而不是當成
 * 500 INTERNAL_ERROR。 */
export class SeasonAlreadyActiveError extends Error {
  constructor() {
    super('SEASON_ALREADY_ACTIVE');
    this.name = 'SeasonAlreadyActiveError';
  }
}

function isUniqueConstraintError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /unique constraint/i.test(msg);
}

/** ①-5/①-10:better-sqlite3/D1 的 unique 違規錯誤訊息格式為
 * `UNIQUE constraint failed: <table>.<col>[, <table>.<col>...]`(見 test 驗證)——只用寬鬆的
 * /unique/i 判斷會把「任何」unique 違規都轉譯成呼叫端當下期待的那個特定錯誤(例如
 * users.email 撞號被誤判成 seasons.status 撞號)。這裡改成要求訊息包含目標欄位的完整
 * `table.column` 簽章,不符合就不是那個特定約束,原樣往上拋。 */
function isUniqueConstraintOn(e: unknown, signature: string): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /unique constraint/i.test(msg) && msg.includes(signature);
}

/** 建立新賽季(初始 WorldState 全量寫入,regions 依陣列序寫入 region_index)。 */
export async function createSeason(
  db: D1Database,
  name: string,
  state: WorldState,
  createdAt: number
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  stmts.push(
    db
      .prepare(
        'INSERT INTO seasons (id, name, tick, next_march_seq, status, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
      )
      .bind(state.seasonId, name, state.tick, state.nextMarchSeq, 'active', createdAt)
  );
  state.regions.forEach((region, index) => {
    const row = regionToRow(state.seasonId, index, region);
    stmts.push(
      db
        .prepare('INSERT INTO regions (id, season_id, region_index, name, bonuses) VALUES (?, ?, ?, ?, ?)')
        .bind(row.id, row.season_id, row.region_index, row.name, row.bonuses)
    );
  });
  for (const n of state.nations) stmts.push(insertNationStmt(db, state.seasonId, n));
  for (const m of state.marches) stmts.push(insertMarchStmt(db, state.seasonId, m));
  for (const t of state.treaties) stmts.push(insertTreatyStmt(db, state.seasonId, t));
  for (const o of state.orders) stmts.push(insertOrderStmt(db, state.seasonId, o));
  try {
    await runBatch(db, stmts);
  } catch (e) {
    // ①-10:只有撞到 idx_seasons_one_active(seasons.status 唯一鍵)才轉譯成
    // SeasonAlreadyActiveError——其他 unique 違規(例如巧合的 region/nation id 撞號)不該被
    // 誤判成「已有 active 賽季」。
    if (isUniqueConstraintOn(e, 'seasons.status')) throw new SeasonAlreadyActiveError();
    throw e;
  }
}

/**
 * 差異寫回:比對 prev/next 各集合(nations/marches/treaties/orders),
 * 只對新增/變更的 row 發 INSERT OR REPLACE,只對消失的 id 發 DELETE。
 * seasons(tick/next_march_seq)每次呼叫必寫。events 一律全量 append(events 只增不改)。
 * 全部包成單一 batch 交易寫回(呼應 tick-cron 段落「單一 D1 batch 交易寫回」)。
 */
export async function saveWorldState(
  db: D1Database,
  prev: WorldState | null,
  next: WorldState,
  newEvents: GameEvent[],
  eventCreatedAt: number,
  trades: Trade[] = [],
  expectedVersion?: number,
  extraStmts: D1PreparedStatement[] = []
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  // finding #3:trades 併入本次 batch,與 nations/orders/events 一起原子寫入。
  stmts.push(...tradeStmts(db, next.seasonId, trades));

  // events.id 用 seasons.next_event_seq 單調遞增序號組成(見 migration 註解)——
  // 同一 tick 內可能有多次 saveWorldState 呼叫(玩家操作觸發,不像 tick-cron 只跑一次),
  // 若沿用「本次呼叫內的陣列序 i」會和先前已寫入的 event id 撞主鍵。
  // finding #8:原本「SELECT 讀現值 → 之後的 batch 用讀到的值算好結果再 UPDATE」分兩步,
  // 兩次 saveWorldState 幾乎同時呼叫時,兩者都可能讀到同一個舊值、各自算出同一段 event seq
  // 範圍,導致寫入的 events.id 撞主鍵(其中一筆整批 batch 失敗回滾)。改用單一
  // `UPDATE ... RETURNING` 原子地「認領」一段 seq 範圍——SQLite 3.35+ 支援 RETURNING,
  // 已在 sqliteD1Adapter(better-sqlite3 13.x)與正式 D1 皆可用。
  const eventSeqStart = await claimEventSeqRange(db, next.seasonId, newEvents.length);

  // ①-6:expectedVersion 有帶入時(玩家寫入路由/tick-cron 皆帶),用樂觀鎖 UPDATE 一併推進
  // version——WHERE version = expectedVersion 若 0 rows 命中,代表讀取之後、這次寫回之前已經
  // 有另一個請求(或 tick-cron)搶先寫入過同一個 season,呼叫端手上的 prev/next diff 是基於
  // 過期快照算出來的,不該繼續寫——丟 ConflictError,交給 index.ts onError 統一回 409。
  // 未帶 expectedVersion(呼叫端明確不做樂觀鎖檢查,例如舊測試直接呼叫)時退回原本行為。
  if (expectedVersion !== undefined) {
    const versionRow = await db
      .prepare(
        'UPDATE seasons SET tick = ?, next_march_seq = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING id'
      )
      .bind(next.tick, next.nextMarchSeq, next.seasonId, expectedVersion)
      .first<{ id: string }>();
    if (versionRow === null) throw new ConflictError(next.seasonId);
  } else {
    stmts.push(
      db
        .prepare('UPDATE seasons SET tick = ?, next_march_seq = ?, version = version + 1 WHERE id = ?')
        .bind(next.tick, next.nextMarchSeq, next.seasonId)
    );
  }

  diffCollection(
    prev?.nations ?? [],
    next.nations,
    (n) => n.id,
    (n) => insertNationStmt(db, next.seasonId, n),
    (id) => db.prepare('DELETE FROM nations WHERE id = ?').bind(id)
  ).forEach((s) => stmts.push(s));

  diffCollection(
    prev?.marches ?? [],
    next.marches,
    (m) => m.id,
    (m) => insertMarchStmt(db, next.seasonId, m),
    (id) => db.prepare('DELETE FROM marches WHERE id = ?').bind(id)
  ).forEach((s) => stmts.push(s));

  diffCollection(
    prev?.treaties ?? [],
    next.treaties,
    (t) => t.id,
    (t) => insertTreatyStmt(db, next.seasonId, t),
    (id) => db.prepare('DELETE FROM treaties WHERE id = ?').bind(id)
  ).forEach((s) => stmts.push(s));

  diffCollection(
    prev?.orders ?? [],
    next.orders,
    (o) => o.id,
    (o) => insertOrderStmt(db, next.seasonId, o),
    (id) => db.prepare('DELETE FROM market_orders WHERE id = ?').bind(id)
  ).forEach((s) => stmts.push(s));

  newEvents.forEach((e, i) => {
    const id = makeId('event', next.seasonId, eventSeqStart + i);
    const row = eventToRow(next.seasonId, id, e, eventCreatedAt);
    stmts.push(
      db
        .prepare(
          'INSERT INTO events (id, season_id, tick, type, nation_ids, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(row.id, row.season_id, row.tick, row.type, row.nation_ids, row.payload, row.created_at)
    );
    // ①-12/②-17:events_nations 正規化子表——getEventsSince 改走這張表查詢,不再對
    // events.nation_ids 做 LIKE 全表掃描(也避免 id 恰為另一 id 子字串時的誤配風險)。
    for (const nationId of e.nationIds) {
      stmts.push(
        db.prepare('INSERT OR IGNORE INTO events_nations (event_id, nation_id) VALUES (?, ?)').bind(row.id, nationId)
      );
    }
  });

  // ②-15:賽季到期時,呼叫端(tick/run.ts)把 finalizeSeasonStmts(hall_of_fame + ended 標記)
  // 併入這裡,和本次 tick 的其餘差異寫回同一個 batch 原子提交。
  stmts.push(...extraStmts);

  await runBatch(db, stmts);
}

function insertNationStmt(db: D1Database, seasonId: string, n: WorldState['nations'][number]): D1PreparedStatement {
  const r = nationToRow(seasonId, n);
  return db
    .prepare(
      `INSERT OR REPLACE INTO nations
      (id, season_id, owner_id, name, flag, region_id, resource_food, resource_ore, resource_fuel, resource_money,
       tech, action_points, population, morale, buildings, build_queue, army_size, policies, policy_changed_at,
       reputation_breaches, protected_until, score, created_at, last_attacked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      r.id,
      r.season_id,
      r.owner_id,
      r.name,
      r.flag,
      r.region_id,
      r.resource_food,
      r.resource_ore,
      r.resource_fuel,
      r.resource_money,
      r.tech,
      r.action_points,
      r.population,
      r.morale,
      r.buildings,
      r.build_queue,
      r.army_size,
      r.policies,
      r.policy_changed_at,
      r.reputation_breaches,
      r.protected_until,
      r.score,
      r.created_at,
      r.last_attacked_at
    );
}

/** finding #18:開國原本只靠讀取時的 `findOwnNation(state, user.id)` 記憶體檢查擋「一國一владелец」,
 * 有 TOCTOU 窗口(兩個並發開國請求都可能讀到「還沒有國家」)。真正把關在 DB 唯一索引
 * (idx_nations_season_owner,migrations/0004_hardening.sql)——但 saveWorldState 既有的
 * insertNationStmt 用 `INSERT OR REPLACE`,REPLACE 語意是「先刪掉撞鍵的舊 row 再插入新
 * row」,根本不會觸發 UNIQUE 違規錯誤(等於靜默覆蓋掉舊國家!)。開國走專用的純 INSERT
 * (不是 REPLACE),撞唯一索引時才會是真正的錯誤,可轉譯回 ALREADY_FOUNDED。 */
export class NationAlreadyFoundedError extends Error {
  constructor() {
    super('ALREADY_FOUNDED');
    this.name = 'NationAlreadyFoundedError';
  }
}

export async function insertNewNation(db: D1Database, seasonId: string, n: WorldState['nations'][number]): Promise<void> {
  const r = nationToRow(seasonId, n);
  try {
    const res = await db
      .prepare(
        `INSERT INTO nations
        (id, season_id, owner_id, name, flag, region_id, resource_food, resource_ore, resource_fuel, resource_money,
         tech, action_points, population, morale, buildings, build_queue, army_size, policies, policy_changed_at,
         reputation_breaches, protected_until, score, created_at, last_attacked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        r.id,
        r.season_id,
        r.owner_id,
        r.name,
        r.flag,
        r.region_id,
        r.resource_food,
        r.resource_ore,
        r.resource_fuel,
        r.resource_money,
        r.tech,
        r.action_points,
        r.population,
        r.morale,
        r.buildings,
        r.build_queue,
        r.army_size,
        r.policies,
        r.policy_changed_at,
        r.reputation_breaches,
        r.protected_until,
        r.score,
        r.created_at,
        r.last_attacked_at
      )
      .run();
    // ①-11:D1 對單一(非 batch)statement 也可能回傳 success:false 而不拋例外(依 driver/後端
    // 而定,同 runBatch 開頭註解的理由)——不檢查就會靜默漏寫,呼叫端(nation.ts)卻以為開國成功。
    if (!res.success) throw new Error(`D1_INSERT_FAILED: nations id=${n.id}`);
  } catch (e) {
    // ①-5:只有撞到 idx_nations_season_owner(nations.season_id, nations.owner_id 複合唯一鍵)
    // 才轉譯成 NationAlreadyFoundedError。
    if (isUniqueConstraintOn(e, 'nations.season_id, nations.owner_id')) throw new NationAlreadyFoundedError();
    throw e;
  }
}

function insertMarchStmt(db: D1Database, seasonId: string, m: WorldState['marches'][number]): D1PreparedStatement {
  const r = marchToRow(seasonId, m);
  return db
    .prepare(
      'INSERT OR REPLACE INTO marches (id, season_id, attacker_id, defender_id, size, departed_at, arrives_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(r.id, r.season_id, r.attacker_id, r.defender_id, r.size, r.departed_at, r.arrives_at);
}

function insertTreatyStmt(db: D1Database, seasonId: string, t: WorldState['treaties'][number]): D1PreparedStatement {
  const r = treatyToRow(seasonId, t);
  return db
    .prepare(
      'INSERT OR REPLACE INTO treaties (id, season_id, kind, a_id, b_id, status, terms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(r.id, r.season_id, r.kind, r.a_id, r.b_id, r.status, r.terms, r.created_at);
}

function insertOrderStmt(db: D1Database, seasonId: string, o: WorldState['orders'][number]): D1PreparedStatement {
  const r = orderToRow(seasonId, o);
  return db
    .prepare(
      'INSERT OR REPLACE INTO market_orders (id, season_id, nation_id, kind, side, qty, price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(r.id, r.season_id, r.nation_id, r.kind, r.side, r.qty, r.price, r.created_at);
}

/** 通用差異比對:回傳「需要 upsert 的項目 stmt」+「需要 delete 的 id stmt」。 */
function diffCollection<T>(
  prevItems: T[],
  nextItems: T[],
  keyOf: (item: T) => string,
  upsert: (item: T) => D1PreparedStatement,
  del: (id: string) => D1PreparedStatement
): D1PreparedStatement[] {
  const prevById = new Map(prevItems.map((i) => [keyOf(i), i]));
  const nextById = new Map(nextItems.map((i) => [keyOf(i), i]));
  const stmts: D1PreparedStatement[] = [];

  for (const [id, item] of nextById) {
    const prevItem = prevById.get(id);
    if (!prevItem || JSON.stringify(prevItem) !== JSON.stringify(item)) {
      stmts.push(upsert(item));
    }
  }
  for (const id of prevById.keys()) {
    if (!nextById.has(id)) stmts.push(del(id));
  }
  return stmts;
}

// ---- users ----

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  verified: number;
  verify_token: string | null;
  verify_token_expires_at: number | null;
  created_at: number;
}

export async function insertUser(db: D1Database, row: UserRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users
      (id, email, password_hash, password_salt, password_iterations, verified, verify_token, verify_token_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.email,
      row.password_hash,
      row.password_salt,
      row.password_iterations,
      row.verified,
      row.verify_token,
      row.verify_token_expires_at,
      row.created_at
    )
    .run();
}

export async function findUserByEmail(db: D1Database, normalizedEmail: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(normalizedEmail).first<UserRow>();
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function markUserVerified(db: D1Database, id: string): Promise<void> {
  await db
    .prepare('UPDATE users SET verified = 1, verify_token = NULL, verify_token_expires_at = NULL WHERE id = ?')
    .bind(id)
    .run();
}

export async function setVerifyToken(db: D1Database, id: string, token: string, expiresAt: number): Promise<void> {
  await db.prepare('UPDATE users SET verify_token = ?, verify_token_expires_at = ? WHERE id = ?').bind(token, expiresAt, id).run();
}

// ---- sessions ----

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export async function insertSession(db: D1Database, row: SessionRow): Promise<void> {
  await db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(row.id, row.user_id, row.created_at, row.expires_at)
    .run();
}

export async function findSession(db: D1Database, token: string): Promise<SessionRow | null> {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').bind(token).first<SessionRow>();
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
}

// ---- seasons(M7 補充:active season 查找 + order seq) ----

/** 目前唯一 active 賽季(M7 範圍:單賽季,取最早建立的 active 者)。 */
export async function getActiveSeasonId(db: D1Database): Promise<Id | null> {
  const row = await db
    .prepare("SELECT id FROM seasons WHERE status = 'active' ORDER BY created_at ASC LIMIT 1")
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** ①-6:讀取當下的樂觀鎖版本號,供 loadActiveWorld/runTick 帶著給 saveWorldState 做寫回檢查。
 * 找不到 season 時回 0(呼叫端理論上不該對不存在的 season 寫回,回 0 只是安全預設值,不代表
 * 「版本 0 一定合法」)。 */
export async function getSeasonVersion(db: D1Database, seasonId: Id): Promise<number> {
  const row = await db.prepare('SELECT version FROM seasons WHERE id = ?').bind(seasonId).first<{ version: number }>();
  return row?.version ?? 0;
}

/**
 * finding #8:market.placeOrder 的 seq 參數來源——原本「SELECT 讀現值」+「UPDATE +1」分兩次
 * D1 呼叫,兩個並發請求可能都讀到同一個舊值、拿到同一個 seq、各自組出撞號的 order id。改用
 * 單一 `UPDATE ... RETURNING` 原子地「認領並遞增」,不留讀-改-寫之間的競態窗口。
 * 找不到該 season(seasonId 打錯/season 已被刪除)時丟例外,不要靜默回 0 讓呼叫端拿到假序號。
 */
export async function claimNextOrderSeq(db: D1Database, seasonId: Id): Promise<number> {
  const row = await db
    .prepare('UPDATE seasons SET next_order_seq = next_order_seq + 1 WHERE id = ? RETURNING next_order_seq - 1 AS seq')
    .bind(seasonId)
    .first<{ seq: number }>();
  if (row === null) throw new Error(`SEASON_NOT_FOUND: ${seasonId}`);
  return row.seq;
}

/** 同 claimNextOrderSeq 的原子手法,一次認領 [start, start+count) 這段 events seq 範圍。
 * count === 0 時單純讀現值,不觸發寫入(saveWorldState 沒有新事件時的常見情況)。 */
async function claimEventSeqRange(db: D1Database, seasonId: Id, count: number): Promise<number> {
  if (count <= 0) {
    const row = await db
      .prepare('SELECT next_event_seq FROM seasons WHERE id = ?')
      .bind(seasonId)
      .first<{ next_event_seq: number }>();
    return row?.next_event_seq ?? 0;
  }
  const row = await db
    .prepare('UPDATE seasons SET next_event_seq = next_event_seq + ? WHERE id = ? RETURNING next_event_seq - ? AS seq')
    .bind(count, seasonId, count)
    .first<{ seq: number }>();
  if (row === null) throw new Error(`SEASON_NOT_FOUND: ${seasonId}`);
  return row.seq;
}

// ---- tick-cron 競態緩解旗標(M8) ----

/** finding #28:tick_running 改存「什麼時候開始跑」的時間戳(tick_running_since),不是單純
 * 布林——runTick 若中途崩潰(未執行到 finally 的清旗標,例如整個 Worker 被強制終止),旗標會
 * 卡死永遠是 true,玩家寫入路由永遠 503。改存時間戳後,呼叫端可判斷「超過門檻(見
 * TICK_RUNNING_STALE_MS)沒更新」視為 stale、可搶(下一次 runTick 直接接管)。 */
export const TICK_RUNNING_STALE_MS = 10 * 60 * 1000;

export interface TickRunningState {
  running: boolean;
  since: number | null;
}

export async function getSeasonTickRunningState(db: D1Database, seasonId: Id): Promise<TickRunningState> {
  const row = await db
    .prepare('SELECT tick_running, tick_running_since FROM seasons WHERE id = ?')
    .bind(seasonId)
    .first<{ tick_running: number; tick_running_since: number | null }>();
  return { running: !!row?.tick_running, since: row?.tick_running_since ?? null };
}

/** 舊介面(單純布林)——供 game/state.ts loadActiveWorld 沿用(玩家寫入路由的 503 讀取檢查,
 * 純粹提早失敗、非鎖的正確性來源):stale 的旗標視為「未在跑」,避免真正卡死的旗標永久擋住
 * 玩家寫入路由。 */
export async function getSeasonTickRunning(db: D1Database, seasonId: Id, now: number = Date.now()): Promise<boolean> {
  const { running, since } = await getSeasonTickRunningState(db, seasonId);
  if (!running) return false;
  if (since !== null && now - since > TICK_RUNNING_STALE_MS) return false; // stale,視為未在跑
  return true;
}

/** ①-7/②-13:tick lease 的原子取得——單一 UPDATE ... WHERE (未在跑 OR 已 stale) 一次判斷+搶佔,
 * 不再是「先 SELECT 讀狀態 → 再 UPDATE 寫入」兩步(兩個 runTick 幾乎同時觸發時,兩者都可能讀到
 * 「未在跑」,都認為自己搶到鎖)。ownerId 為呼叫端(runTick)產生的隨機值,搶到鎖時寫入自己的
 * owner——release 只清除 owner 相符的旗標,避免「A 的 stale 鎖被 B 接管後,A 遲來的 finally
 * 又把 B 剛拿到的鎖清掉」這種 lease 被誤釋放的情況。回傳 true = 搶到鎖。 */
export async function claimTickLease(
  db: D1Database,
  seasonId: Id,
  ownerId: string,
  now: number,
  staleMs: number = TICK_RUNNING_STALE_MS
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE seasons SET tick_running = 1, tick_running_since = ?, tick_owner = ?
       WHERE id = ? AND (tick_running = 0 OR tick_running_since IS NULL OR tick_running_since < ?)
       RETURNING id`
    )
    .bind(now, ownerId, seasonId, now - staleMs)
    .first<{ id: string }>();
  return row !== null;
}

/** release 只清除 tick_owner 與自己相符的旗標(見 claimTickLease 註解)——owner 不符代表這把鎖
 * 早已被別人的 stale-takeover 接管,此時清空反而會誤放行接管者尚未跑完的那一輪。 */
export async function releaseTickLease(db: D1Database, seasonId: Id, ownerId: string): Promise<void> {
  // ①-8:tick_running_since 是 NOT NULL DEFAULT 0(squash 後的欄位定義),清除旗標時歸零而不是
  // 寫 NULL(會違反 NOT NULL 約束)——0 與 tick_running=0 同時成立時語意就是「未在跑」。
  await db
    .prepare('UPDATE seasons SET tick_running = 0, tick_running_since = 0, tick_owner = NULL WHERE id = ? AND tick_owner = ?')
    .bind(seasonId, ownerId)
    .run();
}

/** 舊介面(單純布林寫入,非原子取得)——保留供既有測試/呼叫端(直接模擬「卡死的旗標」)沿用,
 * 新的 runTick 本身改走 claimTickLease/releaseTickLease(見上方)。 */
export async function setSeasonTickRunning(db: D1Database, seasonId: Id, running: boolean, now: number = Date.now()): Promise<void> {
  await db
    .prepare('UPDATE seasons SET tick_running = ?, tick_running_since = ? WHERE id = ?')
    .bind(running ? 1 : 0, running ? now : 0, seasonId)
    .run();
}

/** 賽季到期結算——標記 ended,不刪資料(名人堂/歷史查詢仍可能需要)。
 * finding #27:一般情況請改用 finalizeSeason(名人堂+ended 標記同一 batch),這裡保留單獨版本
 * 供其他可能只需要單獨標記 ended、不牽涉名人堂的呼叫端使用(目前無,保留介面對稱性)。 */
export async function markSeasonEnded(db: D1Database, seasonId: Id, endedAt: number): Promise<void> {
  await db
    .prepare("UPDATE seasons SET status = 'ended', ended_at = ? WHERE id = ?")
    .bind(endedAt, seasonId)
    .run();
}

/** finding #23/#29:scheduled() 用 Cron Trigger 的 scheduledTime 換算出的「目標 tick 時槽」
 * 讀寫——用來判斷同一時槽是否已經處理過(冪等)。 */
export async function getSeasonLastTickSlot(db: D1Database, seasonId: Id): Promise<number | null> {
  const row = await db
    .prepare('SELECT last_tick_slot FROM seasons WHERE id = ?')
    .bind(seasonId)
    .first<{ last_tick_slot: number | null }>();
  return row?.last_tick_slot ?? null;
}

export async function setSeasonLastTickSlot(db: D1Database, seasonId: Id, slot: number): Promise<void> {
  await db.prepare('UPDATE seasons SET last_tick_slot = ? WHERE id = ?').bind(slot, seasonId).run();
}

/** ①-9/②-14:同一時槽的「讀 last_tick_slot → 判斷 → 之後才 UPDATE」原本分兩步,兩個幾乎同時
 * 觸發的 runTick 呼叫都可能讀到「還沒處理過這個時槽」而都跑下去。改成單一 UPDATE ... WHERE
 * (未處理過這個時槽) RETURNING 原子地「認領」——回傳 true 才代表這次呼叫真正拿到這個時槽,
 * 應該把它移到 runTick 最前面(取 tick lease 之前)呼叫。
 * 取捨(②-14 註記):slot 在這裡就先認領,若後續整個 tick batch 中途失敗,這個時槽已經被標記
 * 「處理過」、不會被下一次觸發重跑——寧可漏一個 tick(下一整點的觸發會接著跑,狀態只是慢了
 * 一小時推進),也不要讓同一時槽因為重試而跑兩次(tick 內有非冪等的資源結算/事件寫入)。 */
export async function claimTickSlot(db: D1Database, seasonId: Id, slot: number): Promise<boolean> {
  const row = await db
    .prepare(
      'UPDATE seasons SET last_tick_slot = ? WHERE id = ? AND (last_tick_slot IS NULL OR last_tick_slot < ?) RETURNING id'
    )
    .bind(slot, seasonId, slot)
    .first<{ id: string }>();
  return row !== null;
}

export interface HallOfFameEntry {
  seasonId: Id;
  nationId: Id;
  nationName: string;
  ownerId: Id | null;
  finalScore: ScoreBreakdown;
  rank: number;
  /** null = 總分前三名(rank 1-3);否則為分項冠軍識別碼(economy|warfare|tech|diplomacy,rank 固定 1)。 */
  category: string | null;
}

export function hallOfFameStmts(db: D1Database, entries: HallOfFameEntry[], createdAt: number): D1PreparedStatement[] {
  return entries.map((e, i) =>
    db
      .prepare(
        `INSERT INTO hall_of_fame (id, season_id, nation_id, nation_name, owner_id, final_score, rank, category, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        makeId('hof', e.seasonId, e.nationId, e.category ?? 'overall', i),
        e.seasonId,
        e.nationId,
        e.nationName,
        e.ownerId,
        JSON.stringify(e.finalScore),
        e.rank,
        e.category,
        createdAt
      )
  );
}

export async function insertHallOfFameEntries(db: D1Database, entries: HallOfFameEntry[], createdAt: number): Promise<void> {
  if (entries.length === 0) return;
  await runBatch(db, hallOfFameStmts(db, entries, createdAt));
}

/** finding #27/#32:賽季結算——hall_of_fame 寫入與 seasons.status='ended' 標記合成單一 batch
 * 一起原子提交,且必須在呼叫端已完成 saveWorldState(最後一次 tick 的狀態落地)之後才呼叫
 * (見 tick/run.ts runTick 呼叫順序註解),避免「名人堂已經寫了,但最後一 tick 的資源/分數
 * 其實沒存到 DB」這種不一致。 */
export async function finalizeSeason(
  db: D1Database,
  seasonId: Id,
  entries: HallOfFameEntry[],
  endedAt: number
): Promise<void> {
  await runBatch(db, finalizeSeasonStmts(db, seasonId, entries, endedAt));
}

/** ②-15:純組裝版本(不自行呼叫 db.batch),供 saveWorldState 的 extraStmts 併入同一 batch——
 * 「最後一 tick 的狀態落地」與「名人堂+ended 標記」原本是兩次獨立 runBatch 呼叫,若第一次成功
 * 第二次失敗仍有 finding #27 提過的不一致窗口(只是窗口從「順序反過來」縮小成「兩次呼叫之間」)。
 * runTick(tick/run.ts)在賽季到期時改把這裡的 stmts 一併交給 saveWorldState 的 extraStmts,
 * 兩者在同一個 D1 batch 交易內原子提交。 */
export function finalizeSeasonStmts(
  db: D1Database,
  seasonId: Id,
  entries: HallOfFameEntry[],
  endedAt: number
): D1PreparedStatement[] {
  return [
    ...hallOfFameStmts(db, entries, endedAt),
    db.prepare("UPDATE seasons SET status = 'ended', ended_at = ? WHERE id = ?").bind(endedAt, seasonId),
  ];
}

// ---- trades(市場成交紀錄,供 PriceRef 近期均價計算) ----

/** finding #3:抽出成純組裝函式(不自行呼叫 db.batch),供 saveWorldState 併入同一 batch。 */
export function tradeStmts(db: D1Database, seasonId: Id, trades: Trade[]): D1PreparedStatement[] {
  return trades.map((t) =>
    db
      .prepare(
        `INSERT INTO trades
        (id, season_id, buy_order_id, sell_order_id, buyer_id, seller_id, kind, qty, price, tariff, tick)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(t.id, seasonId, t.buyOrderId, t.sellOrderId, t.buyerId, t.sellerId, t.kind, t.qty, t.price, t.tariff, t.tick)
  );
}

const RESOURCE_KINDS: ResourceKind[] = ['food', 'ore', 'fuel', 'money'];

/** market.placeOrder 的 PriceRef.avgPrice——各資源近 N 筆成交價的平均(不足則缺值,由 market 判 unbanded)。 */
export async function getRecentAvgPrices(
  db: D1Database,
  seasonId: Id,
  lookback = 20
): Promise<Partial<Record<ResourceKind, number>>> {
  const avgPrice: Partial<Record<ResourceKind, number>> = {};
  for (const kind of RESOURCE_KINDS) {
    const row = await db
      .prepare(
        `SELECT AVG(price) as avg FROM (
           SELECT price FROM trades WHERE season_id = ? AND kind = ? ORDER BY tick DESC LIMIT ?
         )`
      )
      .bind(seasonId, kind, lookback)
      .first<{ avg: number | null }>();
    if (row?.avg !== null && row?.avg !== undefined) avgPrice[kind] = row.avg;
  }
  return avgPrice;
}

// ---- events(涉己事件輪詢) ----

export const EVENTS_SINCE_LIMIT = 200; // finding #12

export interface EventWithSeq extends GameEvent {
  /** events 表的 SQLite rowid——單調遞增,供下一次輪詢的 `since` cursor 使用(finding #9)。 */
  seq: number;
}

/**
 * `/api/world?since=` 用:season 內 nation_ids 涉及 nationId、且比上次輪詢新的事件。
 * finding #9:原本用「tick > sinceTick」判斷,但同一個 tick 內常有多次 saveWorldState 呼叫
 * (玩家操作觸發,見 saveWorldState 開頭註解),也就是同一 tick 可能分好幾批寫入 events。
 * 客戶端若把「目前看到的最大 tick」當作下次的 since,同一 tick 內較晚才寫入、但還沒輪詢過的
 * 事件會被 `tick > sinceTick`(嚴格大於)永久漏掉——它們的 tick 不大於 sinceTick,但當時
 * 還沒寫入,上一次輪詢也沒拿到。改用 events 表本身的 rowid(單調遞增、不重複,不受同一 tick
 * 內多筆這種語意影響)當 cursor,呼叫端把上次拿到的最大 seq 帶回來即可,不會漏、也不會重複。
 * （world.ts 的 `since` query 參數語意隨之從「tick」改為「seq」，型別仍是 number，已在該檔
 * 加註解標示。）
 */
export interface EventsSinceResult {
  events: EventWithSeq[];
  /** ①-12/②-17:本批「掃描到」的最大 seq(即使掃到的事件裡沒有任何一筆與 nationId 涉己),
   * 呼叫端(world.ts)拿這個值當下次 since,不會因為這批剛好都是別人的事件就卡住不前進。
   * 完全沒有新事件(scanned 為空)時等於 sinceSeq,呼叫端不倒退。 */
  scannedUpTo: number;
}

/**
 * `/api/world?since=` 用:season 內 nation_ids 涉及 nationId、且比上次輪詢新的事件。
 * finding #9:用 events 表本身的 rowid(單調遞增、不重複)當 cursor。
 * ①-12/②-17:原本用 `nation_ids LIKE '%"<id>"%'` 對 events.nation_ids 做全表 LIKE 掃描——
 * 除了效能隨事件量成長變差,`<id>` 恰為另一個 id 的子字串時理論上也有誤配風險。改成先撈
 * `season_id + rowid > sinceSeq` 範圍內最多 limit 筆事件(不論是否涉己),再用正規化子表
 * events_nations(有索引)篩出哪些真的與 nationId 相關——`scannedUpTo` 用「這批掃到的最後一筆
 * rowid」(不論是否涉己)當下次 cursor,呼叫端才不會被一連串跟自己無關的事件卡住。
 */
export async function getEventsSince(
  db: D1Database,
  seasonId: Id,
  sinceSeq: number,
  nationId: Id,
  limit: number = EVENTS_SINCE_LIMIT
): Promise<EventsSinceResult> {
  const scanned = await db
    .prepare('SELECT rowid AS seq, * FROM events WHERE season_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?')
    .bind(seasonId, sinceSeq, limit)
    .all<{ seq: number; id: string }>();
  const rows = scanned.results;
  if (rows.length === 0) return { events: [], scannedUpTo: sinceSeq };

  const placeholders = rows.map(() => '?').join(', ');
  const matched = await db
    .prepare(`SELECT event_id FROM events_nations WHERE nation_id = ? AND event_id IN (${placeholders})`)
    .bind(nationId, ...rows.map((r) => r.id))
    .all<{ event_id: string }>();
  const matchedIds = new Set(matched.results.map((r) => r.event_id));

  const events = rows
    .filter((r) => matchedIds.has(r.id))
    .map((r) => ({ ...rowToEvent(r as never), seq: r.seq }));
  const scannedUpTo = rows[rows.length - 1].seq;
  return { events, scannedUpTo };
}

// ---- messages(一對一站內訊息) ----

export interface MessageRow {
  id: string;
  season_id: string;
  from_nation_id: string;
  to_nation_id: string;
  body: string;
  created_at: number;
  read_at: number | null;
  tick: number;
}

export async function insertMessage(db: D1Database, row: MessageRow): Promise<void> {
  await db
    .prepare(
      'INSERT INTO messages (id, season_id, from_nation_id, to_nation_id, body, created_at, read_at, tick) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)'
    )
    .bind(row.id, row.season_id, row.from_nation_id, row.to_nation_id, row.body, row.created_at, row.tick)
    .run();
}

/** finding #20:訊息 id 的單調遞增序號,比照 claimNextOrderSeq 的原子手法。 */
export async function claimNextMessageSeq(db: D1Database, seasonId: Id): Promise<number> {
  const row = await db
    .prepare('UPDATE seasons SET next_message_seq = next_message_seq + 1 WHERE id = ? RETURNING next_message_seq - 1 AS seq')
    .bind(seasonId)
    .first<{ seq: number }>();
  if (row === null) throw new Error(`SEASON_NOT_FOUND: ${seasonId}`);
  return row.seq;
}

/** finding #20:每國每 tick 最多送幾則訊息的簡單速率限制——查詢本 tick 已送出的筆數。 */
export async function countMessagesSentInTick(db: D1Database, fromNationId: Id, tick: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE from_nation_id = ? AND tick = ?')
    .bind(fromNationId, tick)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export const MESSAGES_LIST_LIMIT = 100; // finding #12/#20

/** finding #20:分頁——`before`(訊息 rowid cursor,不傳則從最新開始)+ limit(上限 100)。
 * 回傳含 nextCursor:還有更舊的資料時,呼叫端下次帶這個值繼續往前翻;無更多資料則為 null。 */
export async function listMessagesForNation(
  db: D1Database,
  nationId: Id,
  box: 'inbox' | 'sent',
  opts: { before?: number; limit?: number } = {}
): Promise<{ messages: (MessageRow & { seq: number })[]; nextCursor: number | null }> {
  const column = box === 'inbox' ? 'to_nation_id' : 'from_nation_id';
  const limit = Math.min(Math.max(1, opts.limit ?? MESSAGES_LIST_LIMIT), MESSAGES_LIST_LIMIT);
  const before = opts.before;
  const res =
    before === undefined
      ? await db
          .prepare(`SELECT rowid AS seq, * FROM messages WHERE ${column} = ? ORDER BY rowid DESC LIMIT ?`)
          .bind(nationId, limit + 1)
          .all<MessageRow & { seq: number }>()
      : await db
          .prepare(`SELECT rowid AS seq, * FROM messages WHERE ${column} = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`)
          .bind(nationId, before, limit + 1)
          .all<MessageRow & { seq: number }>();

  const rows = res.results;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { messages: page, nextCursor: hasMore ? page[page.length - 1].seq : null };
}

// ---- tasks(教學任務鏈進度) ----

export interface TaskRow {
  id: string;
  user_id: string;
  task_key: string;
  completed_at: number | null;
  created_at: number;
}

export async function getUserTaskRows(db: D1Database, userId: string): Promise<TaskRow[]> {
  const res = await db.prepare('SELECT * FROM tasks WHERE user_id = ?').bind(userId).all<TaskRow>();
  return res.results;
}

/**
 * 標記任務完成——冪等,對應 idx_tasks_user_key 唯一鍵。
 * finding #10:原本「SELECT 現況 → 依結果決定 UPDATE 或 INSERT」分兩步,兩個並發請求(同一
 * user 同一 task_key 幾乎同時觸發,例如重複點兩下)可能都讀到「不存在」,兩者都嘗試 INSERT,
 * 其中一個撞 idx_tasks_user_key 唯一鍵而丟未預期的例外。改用 INSERT OR IGNORE——已存在就
 * 什麼都不做(第一次完成的時間點為準,不覆寫),單一 SQL 語句沒有讀-改-寫之間的競態窗口。
 */
export async function completeTask(db: D1Database, userId: string, taskKey: string, now: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO tasks (id, user_id, task_key, completed_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(makeId('task', userId, taskKey), userId, taskKey, now, now)
    .run();
  // ①-13:目前唯一的寫入路徑(這個函式本身)一律以 completed_at=now 插入,理論上不會留下
  // completed_at IS NULL 的殘留 row;但 schema 註解明確定義 NULL = 未完成,若未來任何其他呼叫端
  // (或人工/其他工具)寫入了「已建立但未完成」的 row,INSERT OR IGNORE 會因為 (user_id,task_key)
  // 已存在而永遠靜默跳過、那筆任務永遠無法被補標記完成。這裡補一道防禦:row 已存在但尚未完成時,
  // 用 UPDATE 補上 completed_at(冪等——已完成的 row 不受影響,WHERE 已限定 completed_at IS NULL)。
  await db
    .prepare('UPDATE tasks SET completed_at = ? WHERE user_id = ? AND task_key = ? AND completed_at IS NULL')
    .bind(now, userId, taskKey)
    .run();
}

/** finding #14:任務進度屬附屬效果——寫入失敗不可讓整個動作(build/messages/auth...)500。
 * 呼叫端一律改用這個包 try/catch 的版本,失敗只記 log,不往上拋。 */
export async function safeCompleteTask(db: D1Database, userId: string, taskKey: string, now: number): Promise<void> {
  try {
    await completeTask(db, userId, taskKey, now);
  } catch (e) {
    console.error(`[tasks] completeTask failed: user=${userId} key=${taskKey}`, e);
  }
}
