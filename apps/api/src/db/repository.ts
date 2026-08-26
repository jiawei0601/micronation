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
    // Codex 五審②:再附上 D1Result.error——真正 D1 對 batch 內單一 statement 失敗時,success:
    // false 不一定伴隨拋出的原生例外(同本函式開頭註解),error 欄位常是唯一能取得的失敗原因;
    // 呼叫端(如 auth/service.ts register 的 EMAIL_TAKEN fallback 判斷)可能需要這段內容。
    const failed = results[failedIndex];
    throw new Error(
      `D1_BATCH_FAILED: statement #${failedIndex} did not succeed; error=${failed?.error ?? 'unknown'}; meta=${JSON.stringify(failed?.meta ?? null)}`
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
  version: number;
}

interface LoadedWorldState {
  state: WorldState;
  /** ③-1/③-8:與 state 出自同一次 season row 讀取的 version——見 loadWorldStateVersioned。 */
  version: number;
}

async function loadWorldStateRow(db: D1Database, seasonId: Id): Promise<LoadedWorldState | null> {
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

  const state: WorldState = {
    seasonId: season.id,
    tick: season.tick,
    nextMarchSeq: season.next_march_seq,
    regions: (regionsRes.results as never[]).map((r) => rowToRegion(r as never)),
    nations: (nationsRes.results as never[]).map((r) => rowToNation(r as never)),
    marches: (marchesRes.results as never[]).map((r) => rowToMarch(r as never)),
    treaties: (treatiesRes.results as never[]).map((r) => rowToTreaty(r as never)),
    orders: (ordersRes.results as never[]).map((r) => rowToOrder(r as never)),
  };
  return { state, version: season.version };
}

export async function loadWorldState(db: D1Database, seasonId: Id): Promise<WorldState | null> {
  const loaded = await loadWorldStateRow(db, seasonId);
  return loaded?.state ?? null;
}

/**
 * ③-1/③-8:TOCTOU 收斂——原本 loadActiveWorld/runTick 各自呼叫 loadWorldState(讀 season row
 * 取得 tick/next_march_seq,但捨棄同一列裡的 version)之後,又另外呼叫一次 getSeasonVersion
 * (再讀一次 seasons 表取 version)。這兩次讀取之間有一個小窗口——若另一個寫入者(玩家的另一
 * 個請求、或 tick-cron)剛好在這個窗口內完成一次 saveWorldState(version +1),呼叫端手上的
 * WorldState 快照(來自第一次讀取)其實已經對應不上它稍後拿到的「版本號」(來自第二次讀取)。
 * 樂觀鎖檢查用的 expectedVersion 若剛好等於這個「稍後才讀到的新版本」,會誤判成「這次讀到的
 * state 快照是最新的」而放行寫入,實際上 state 快照仍是舊的——樂觀鎖形同虛設。改成單一次
 * season row 讀取(loadWorldStateRow)同時取得 state 與 version,兩者保證出自同一個 SELECT,
 * 不再有分開讀取的窗口。 */
export async function loadWorldStateVersioned(db: D1Database, seasonId: Id): Promise<LoadedWorldState | null> {
  return loadWorldStateRow(db, seasonId);
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
    // Codex 四審①-1:events.id 仍用 next_event_seq(claimEventSeqRange)產生——這個計數器
    // per-season 歸零沒關係,因為 id 字串本身已含 seasonId 前綴,不同賽季的 id 不會撞號。
    const id = makeId('event', next.seasonId, eventSeqStart + i);
    const row = eventToRow(next.seasonId, id, e, eventCreatedAt);
    // Codex 四審①-1:events.seq 是全表(跨賽季共用)的 INTEGER PRIMARY KEY AUTOINCREMENT——
    // 舊版顯式指定 seq = eventSeqStart+i+1(基於 per-season 的 next_event_seq,每季從 0 起算),
    // 第二季的第一筆事件會拿到與第一季第一筆事件相同的 seq(=1),INSERT 撞主鍵。
    // 改成完全不指定 seq,交給 SQLite AUTOINCREMENT 全域配發(保證跨賽季也不重複、且單調遞增,
    // getEventsSince 的 cursor 語意不變)。events_nations 需要的 event_seq 這裡還不知道實際值
    // (要等 INSERT 執行完才由 AUTOINCREMENT 決定),改用子查詢 `SELECT seq FROM events WHERE
    // id = ?` 取得——同一個 batch 是單一交易、依序執行,這條子查詢執行時,前面那條 events
    // INSERT 已經生效,能查到剛寫入的那一列(id 全域唯一,子查詢恰好命中一筆)。
    stmts.push(
      db
        .prepare(
          'INSERT INTO events (id, season_id, tick, type, nation_ids, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(row.id, row.season_id, row.tick, row.type, row.nation_ids, row.payload, row.created_at)
    );
    // ①-12/②-17/③-2/③-4:events_nations 正規化子表——getEventsSince 改走這張表查詢(以
    // event_seq 為鍵,不再是 event_id),不再對 events.nation_ids 做 LIKE 全表掃描。③-2:補上
    // season_id,滿足 (season_id, nation_id) → nations(season_id, id) 的複合外鍵。
    for (const nationId of e.nationIds) {
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO events_nations (event_seq, nation_id, season_id)
             SELECT seq, ?, ? FROM events WHERE id = ?`
          )
          .bind(nationId, next.seasonId, row.id)
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

/** ③-7:單語句(非 batch).run() 的共用成功檢查——D1 對單一 statement 也可能回傳
 * success:false 而不拋例外(依 driver/後端而定,同 runBatch 開頭註解的理由;insertNewNation
 * 已對這點有專門處理,見該函式)。這裡收攏其餘「寫入後不特別關心回傳值」的呼叫端,不檢查就
 * 靜默漏寫,呼叫端(auth/routes)卻以為寫入成功。context 只用於錯誤訊息,方便人工排查是哪個
 * 呼叫點失敗。 */
async function runOne(stmt: D1PreparedStatement, context: string): Promise<void> {
  const res = await stmt.run();
  if (!res.success) throw new Error(`D1_RUN_FAILED: ${context}`);
}

// ---- users ----

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  verified: number;
  created_at: number;
}

function insertUserStmt(db: D1Database, row: UserRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO users
      (id, email, password_hash, password_salt, password_iterations, verified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(row.id, row.email, row.password_hash, row.password_salt, row.password_iterations, row.verified, row.created_at);
}

export async function insertUser(db: D1Database, row: UserRow): Promise<void> {
  await runOne(insertUserStmt(db, row), `insertUser id=${row.id}`);
}

/** Codex 四審②:register 的 user INSERT + verification_token INSERT 併入同一 batch(單一交易)
 * 原子寫入——舊版分兩次獨立呼叫(insertUser 先跑、insertVerificationToken 後跑),兩者之間若
 * process 中途崩潰(例如 Worker 被強制終止)或第二次呼叫拋錯,會留下「使用者已建立、但沒有任何
 * verification token」的半成品帳號——這個帳號永遠無法驗證信箱(resend 需要先查到 user,查得到,
 * 但使用者從未收到過第一封信,也不知道要主動點 resend),等同卡死。改成單一 batch,要嘛兩筆都
 * 成功,要嘛都不成功(users.email 撞唯一鍵時,原始 driver 例外仍會從 db.batch() 拋出,呼叫端
 * service.ts 的 unique-constraint 轉譯邏輯不受影響)。 */
export async function insertUserWithVerificationToken(
  db: D1Database,
  userRow: UserRow,
  tokenRow: VerificationTokenRow
): Promise<void> {
  await runBatch(db, [insertUserStmt(db, userRow), insertVerificationTokenStmt(db, tokenRow)]);
}

export async function findUserByEmail(db: D1Database, normalizedEmail: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(normalizedEmail).first<UserRow>();
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function markUserVerified(db: D1Database, id: string): Promise<void> {
  await runOne(db.prepare('UPDATE users SET verified = 1 WHERE id = ?').bind(id), `markUserVerified id=${id}`);
}

// ---- verification_tokens(③-1)----
// 多列表取代原本 users.verify_token 單一欄位——見 migrations/0001_init.sql 的表註解:每次
// 產生驗證 token 都是新增一列,不覆寫既有列,resendVerification 的並發呼叫天生不會互相覆蓋。

export interface VerificationTokenRow {
  token_hash: string;
  user_id: string;
  expires_at: number;
  created_at: number;
  delivered_at?: number | null;
}

function insertVerificationTokenStmt(db: D1Database, row: VerificationTokenRow): D1PreparedStatement {
  return db
    .prepare('INSERT INTO verification_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(row.token_hash, row.user_id, row.expires_at, row.created_at);
}

export async function insertVerificationToken(db: D1Database, row: VerificationTokenRow): Promise<void> {
  await runOne(insertVerificationTokenStmt(db, row), `insertVerificationToken user=${row.user_id}`);
}

/** Codex 四審③:同一 user 名下最多保留幾筆 verification_tokens——每次 resend 都會新增一列
 * (見表註解,天生不覆蓋),沒有上限的話,一個持續狂點「重寄驗證信」的帳號會讓這張表無限增長。 */
export const VERIFICATION_TOKEN_KEEP_MAX = 5;

/** Codex 五審①:原本 insertVerificationTokenWithCleanup 把「插入新 token」與「保留上限
 * (cap cleanup,只留最新 keepMax 筆)」包在同一個 batch,搶在寄信之前就把舊列砍到剩
 * keepMax-1 筆再插入這筆湊滿 keepMax——若這次插入之後緊接著寄信失敗(finding #16 的既有
 * 前提:寄信失敗不該讓使用者失去退路),使用者手上那些「先前已成功寄出、仍未過期」的舊信
 * 裡的 token,有可能因為剛好落在被砍掉的那批裡而提前失效,即使這次 resend 根本沒有真的寄出
 * 新信——退路反而變窄。改成兩階段,呼叫端(auth/service.ts resendVerification)必須依序:
 * (1) insertVerificationTokenAtomic——只做「清過期 + 插入新 token」,不做保留上限的淘汰;
 * (2) 寄信;
 * (3) 寄信成功 → cleanupVerificationTokensKeepingLatest(此時才安全砍到 keepMax,新 token
 *     已確定寄達,不怕使用者兩頭落空);寄信失敗 → deleteVerificationTokenByHash(刪掉這次
 *     插入但沒寄出去的孤兒 token,不留在表裡佔位、也不誤導使用者以為它有效)。 */
export async function insertVerificationTokenAtomic(db: D1Database, row: VerificationTokenRow, now: number): Promise<void> {
  await runBatch(db, [
    db.prepare('DELETE FROM verification_tokens WHERE user_id = ? AND expires_at <= ?').bind(row.user_id, now),
    insertVerificationTokenStmt(db, row),
  ]);
}

/** Codex 六審:寄信成功後、做 cap cleanup 之前呼叫——把這次的 token 從 pending 原子標記為
 * delivered。單一 UPDATE 語句本身即原子(SQLite 單語句保證),不需要額外包 batch。標記之後
 * 這筆 token 才會被 cleanupVerificationTokensKeepingLatest 的「最新 keepMax 筆」計數與淘汰
 * 邏輯看見——標記之前(仍是 pending)對任何並發的 cleanup 呼叫完全不可見、不可能被誤刪。 */
export async function markVerificationTokenDelivered(db: D1Database, tokenHash: string, now: number): Promise<void> {
  await runOne(
    db.prepare('UPDATE verification_tokens SET delivered_at = ? WHERE token_hash = ?').bind(now, tokenHash),
    `markVerificationTokenDelivered hash=${tokenHash}`
  );
}

/** 寄信成功、且已呼叫 markVerificationTokenDelivered 標記本次 token 為 delivered 之後才呼叫——
 * 保留該 user 最新 keepMax 筆「已 delivered」的 token,排序鍵用 seq(AUTOINCREMENT 插入序,
 * 單調遞增不重複),不用 created_at(同一 user 連續 resend 可能落在同一毫秒,無法單獨當穩定
 * 排序鍵)。keepTokenHash(本次剛標記 delivered 的 token)額外用 `token_hash != ?` 明確排除在
 * 刪除範圍外——即使它基於某種理由不在「最新 keepMax 筆」之列(理論上不會,它是剛插入的
 * 最新一筆,但不依賴這個假設),這道清理也絕不會誤刪它。
 * Codex 六審(併發 resend 競態):WHERE 條件明確加上 `delivered_at IS NOT NULL`——只計數、只
 * 淘汰已確認寄達的列,任何仍在等待寄信結果的 pending 列(另一個並發 resend 呼叫剛插入、
 * 尚未標記 delivered)天生不在這個 DELETE 的候選範圍內,不論它的 seq 有多舊都不會被這裡
 * 誤刪。 */
export async function cleanupVerificationTokensKeepingLatest(
  db: D1Database,
  userId: string,
  keepTokenHash: string,
  keepMax: number = VERIFICATION_TOKEN_KEEP_MAX
): Promise<void> {
  await runOne(
    db
      .prepare(
        `DELETE FROM verification_tokens WHERE user_id = ? AND token_hash != ? AND delivered_at IS NOT NULL AND token_hash NOT IN (
           SELECT token_hash FROM verification_tokens WHERE user_id = ? AND delivered_at IS NOT NULL ORDER BY seq DESC LIMIT ?
         )`
      )
      .bind(userId, keepTokenHash, userId, keepMax),
    `cleanupVerificationTokensKeepingLatest user=${userId}`
  );
}

/** 寄信失敗後才呼叫——刪掉這次剛插入、但信沒寄出去的孤兒 token(見上方 insertVerificationTokenAtomic
 * 註解的兩階段設計)。 */
export async function deleteVerificationTokenByHash(db: D1Database, tokenHash: string): Promise<void> {
  await runOne(
    db.prepare('DELETE FROM verification_tokens WHERE token_hash = ?').bind(tokenHash),
    `deleteVerificationTokenByHash hash=${tokenHash}`
  );
}

/** Codex 六審:不依 delivered_at 篩選——pending(信已寄出但 markVerificationTokenDelivered
 * 尚未落地的窗口期)與 delivered 兩種狀態的 token 都必須能被查到、通過 verifyEmail。使用者
 * 拿到信、點了連結,不該因為伺服器端「標記 delivered」這個記帳動作還沒跑完就被拒絕。 */
export async function findVerificationToken(db: D1Database, tokenHash: string): Promise<VerificationTokenRow | null> {
  return db.prepare('SELECT * FROM verification_tokens WHERE token_hash = ?').bind(tokenHash).first<VerificationTokenRow>();
}

/** verifyEmail 成功後呼叫——刪掉該 user 名下所有 verification_tokens 列(不論驗證時用的是哪
 * 一個),避免用過的舊 token 或其他仍未過期的並存 token 繼續有效。
 * Codex 四審④:改用 runOne(統一走「單語句成功檢查」路徑,見 runOne 註解)——舊版直接
 * `.run()` 不檢查回傳的 success flag,D1 對單一 statement 也可能 success:false 而不拋例外,
 * 不檢查就會靜默漏刪,呼叫端(verifyEmail)卻以為舊 token 已清空。 */
export async function deleteVerificationTokensForUser(db: D1Database, userId: string): Promise<void> {
  await runOne(
    db.prepare('DELETE FROM verification_tokens WHERE user_id = ?').bind(userId),
    `deleteVerificationTokensForUser user=${userId}`
  );
}

/** Codex 四審④:verifyEmail 的「標記已驗證」+「清空該 user 的所有 verification_tokens」併入
 * 同一 batch 原子寫入——舊版分兩次獨立呼叫,兩者之間中途失敗會留下「使用者已標記 verified,
 * 但舊 token 沒清掉(仍可再次拿去用 verifyEmail 打一次,雖然 markUserVerified 是 idempotent
 * 不會出錯,但語意上不乾淨)」或反過來的不一致窗口。 */
/** Codex 四審③(補):與 insertVerificationTokenWithCleanup 互補的全域清理路徑——後者只在
 * 「該 user 又插入新 token」時才順帶清掉自己的過期列,一個註冊後從未 resend、也從未點驗證信
 * 的 user,他名下那唯一一筆 token 過期後永遠不會被清掉(沒有下一次插入觸發清理)。這裡供
 * tick-cron(runTick)每次跑合定期呼叫一次,全表掃過期列直接刪除,不分 user。 */
export async function cleanupExpiredVerificationTokens(db: D1Database, now: number): Promise<void> {
  await runOne(
    db.prepare('DELETE FROM verification_tokens WHERE expires_at <= ?').bind(now),
    `cleanupExpiredVerificationTokens now=${now}`
  );
}

export async function finalizeEmailVerification(db: D1Database, userId: string): Promise<void> {
  await runBatch(db, [
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').bind(userId),
    db.prepare('DELETE FROM verification_tokens WHERE user_id = ?').bind(userId),
  ]);
}

// ---- sessions ----

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export async function insertSession(db: D1Database, row: SessionRow): Promise<void> {
  await runOne(
    db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(row.id, row.user_id, row.created_at, row.expires_at),
    `insertSession user=${row.user_id}`
  );
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
  // ③-7:runOne 檢查的是「這條 UPDATE 語句本身有沒有成功執行」(success flag),不是「有沒有
  // 剛好命中一列」——0 rows affected(owner 不符,鎖已被接管)本來就是合法情況,不當失敗處理。
  await runOne(
    db
      .prepare('UPDATE seasons SET tick_running = 0, tick_running_since = 0, tick_owner = NULL WHERE id = ? AND tick_owner = ?')
      .bind(seasonId, ownerId),
    `releaseTickLease season=${seasonId}`
  );
}

/** 舊介面(單純布林寫入,非原子取得)——保留供既有測試/呼叫端(直接模擬「卡死的旗標」)沿用,
 * 新的 runTick 本身改走 claimTickLease/releaseTickLease(見上方)。 */
export async function setSeasonTickRunning(db: D1Database, seasonId: Id, running: boolean, now: number = Date.now()): Promise<void> {
  await runOne(
    db
      .prepare('UPDATE seasons SET tick_running = ?, tick_running_since = ? WHERE id = ?')
      .bind(running ? 1 : 0, running ? now : 0, seasonId),
    `setSeasonTickRunning season=${seasonId}`
  );
}

/** 賽季到期結算——標記 ended,不刪資料(名人堂/歷史查詢仍可能需要)。
 * finding #27:一般情況請改用 finalizeSeason(名人堂+ended 標記同一 batch),這裡保留單獨版本
 * 供其他可能只需要單獨標記 ended、不牽涉名人堂的呼叫端使用(目前無,保留介面對稱性)。 */
export async function markSeasonEnded(db: D1Database, seasonId: Id, endedAt: number): Promise<void> {
  await runOne(
    db.prepare("UPDATE seasons SET status = 'ended', ended_at = ? WHERE id = ?").bind(endedAt, seasonId),
    `markSeasonEnded season=${seasonId}`
  );
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
  await runOne(
    db.prepare('UPDATE seasons SET last_tick_slot = ? WHERE id = ?').bind(slot, seasonId),
    `setSeasonLastTickSlot season=${seasonId}`
  );
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
/**
 * ③-3/③-4:改成固定參數量的兩段查詢,取代原本「先撈一批 → 用 IN(?,?,...N筆) 展開成隨 limit
 * 增長的參數列表」——limit 預設 200(EVENTS_SINCE_LIMIT),原本的寫法在滿頁時會產生
 * 200+2(nationId + 200 個 event id)= 202 個 bind 參數,雖然目前 SQLite/D1 的單語句參數上限
 * (SQLITE_LIMIT_VARIABLE_NUMBER,預設常見 999 或更高)還沒被踩到,但參數量隨呼叫端傳入的
 * limit 線性增長本身就是脆弱的設計(未來調大 limit 或改用其他後端時可能觸頂)。改成:
 * (1) 先用 season_id+seq 範圍 + LIMIT 決定這批「掃描到」的視窗上界(scannedUpTo),
 * (2) 再用固定 4 個參數的 JOIN 在同一個視窗內篩出真正涉己的事件——不論 limit 多大,參數量
 * 恆定,不會隨之增長。
 */
export async function getEventsSince(
  db: D1Database,
  seasonId: Id,
  sinceSeq: number,
  nationId: Id,
  limit: number = EVENTS_SINCE_LIMIT
): Promise<EventsSinceResult> {
  const windowRow = await db
    .prepare(
      `SELECT MAX(seq) AS maxSeq FROM (
         SELECT seq FROM events WHERE season_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
       )`
    )
    .bind(seasonId, sinceSeq, limit)
    .first<{ maxSeq: number | null }>();
  const scannedUpTo = windowRow?.maxSeq ?? sinceSeq;
  if (scannedUpTo <= sinceSeq) return { events: [], scannedUpTo: sinceSeq };

  const matched = await db
    .prepare(
      `SELECT e.seq AS seq, e.* FROM events e
       JOIN events_nations en ON en.event_seq = e.seq AND en.nation_id = ?
       WHERE e.season_id = ? AND e.seq > ? AND e.seq <= ?
       ORDER BY e.seq ASC`
    )
    .bind(nationId, seasonId, sinceSeq, scannedUpTo)
    .all<{ seq: number; id: string }>();

  const events = matched.results.map((r) => ({ ...rowToEvent(r as never), seq: r.seq }));
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
  await runOne(
    db
      .prepare(
        'INSERT INTO messages (id, season_id, from_nation_id, to_nation_id, body, created_at, read_at, tick) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)'
      )
      .bind(row.id, row.season_id, row.from_nation_id, row.to_nation_id, row.body, row.created_at, row.tick),
    `insertMessage id=${row.id}`
  );
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
