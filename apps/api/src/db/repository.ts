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
    throw new Error(`D1_BATCH_FAILED: statement #${failedIndex} did not succeed`);
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
  await runBatch(db, stmts);
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
  eventCreatedAt: number
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  // events.id 用 seasons.next_event_seq 單調遞增序號組成(見 0002 migration 註解)——
  // 同一 tick 內可能有多次 saveWorldState 呼叫(玩家操作觸發,不像 tick-cron 只跑一次),
  // 若沿用「本次呼叫內的陣列序 i」會和先前已寫入的 event id 撞主鍵。
  // finding #8:原本「SELECT 讀現值 → 之後的 batch 用讀到的值算好結果再 UPDATE」分兩步,
  // 兩次 saveWorldState 幾乎同時呼叫時,兩者都可能讀到同一個舊值、各自算出同一段 event seq
  // 範圍,導致寫入的 events.id 撞主鍵(其中一筆整批 batch 失敗回滾)。改用單一
  // `UPDATE ... RETURNING` 原子地「認領」一段 seq 範圍——SQLite 3.35+ 支援 RETURNING,
  // 已在 sqliteD1Adapter(better-sqlite3 13.x)與正式 D1 皆可用。
  const eventSeqStart = await claimEventSeqRange(db, next.seasonId, newEvents.length);

  stmts.push(
    db
      .prepare('UPDATE seasons SET tick = ?, next_march_seq = ? WHERE id = ?')
      .bind(next.tick, next.nextMarchSeq, next.seasonId)
  );

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
  });

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

/** runTick 開頭讀取:旗標為真代表本賽季已有一次 tick 正在跑,呼叫端應跳過本輪。 */
export async function getSeasonTickRunning(db: D1Database, seasonId: Id): Promise<boolean> {
  const row = await db
    .prepare('SELECT tick_running FROM seasons WHERE id = ?')
    .bind(seasonId)
    .first<{ tick_running: number }>();
  return !!row?.tick_running;
}

export async function setSeasonTickRunning(db: D1Database, seasonId: Id, running: boolean): Promise<void> {
  await db
    .prepare('UPDATE seasons SET tick_running = ? WHERE id = ?')
    .bind(running ? 1 : 0, seasonId)
    .run();
}

/** 賽季到期結算——標記 ended,不刪資料(名人堂/歷史查詢仍可能需要)。 */
export async function markSeasonEnded(db: D1Database, seasonId: Id, endedAt: number): Promise<void> {
  await db
    .prepare("UPDATE seasons SET status = 'ended', ended_at = ? WHERE id = ?")
    .bind(endedAt, seasonId)
    .run();
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

export async function insertHallOfFameEntries(db: D1Database, entries: HallOfFameEntry[], createdAt: number): Promise<void> {
  if (entries.length === 0) return;
  const stmts = entries.map((e, i) =>
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
  await runBatch(db, stmts);
}

// ---- trades(市場成交紀錄,供 PriceRef 近期均價計算) ----

export async function insertTrades(db: D1Database, seasonId: Id, trades: Trade[]): Promise<void> {
  if (trades.length === 0) return;
  const stmts = trades.map((t) =>
    db
      .prepare(
        `INSERT INTO trades
        (id, season_id, buy_order_id, sell_order_id, buyer_id, seller_id, kind, qty, price, tariff, tick)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(t.id, seasonId, t.buyOrderId, t.sellOrderId, t.buyerId, t.sellerId, t.kind, t.qty, t.price, t.tariff, t.tick)
  );
  await runBatch(db, stmts);
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
export async function getEventsSince(
  db: D1Database,
  seasonId: Id,
  sinceSeq: number,
  nationId: Id,
  limit: number = EVENTS_SINCE_LIMIT
): Promise<EventWithSeq[]> {
  const res = await db
    .prepare(
      'SELECT rowid AS seq, * FROM events WHERE season_id = ? AND rowid > ? AND nation_ids LIKE ? ORDER BY rowid ASC LIMIT ?'
    )
    .bind(seasonId, sinceSeq, `%"${nationId}"%`, limit)
    .all();
  return (res.results as { seq: number }[]).map((r) => ({ ...rowToEvent(r as never), seq: r.seq }));
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
}

export async function insertMessage(db: D1Database, row: MessageRow): Promise<void> {
  await db
    .prepare(
      'INSERT INTO messages (id, season_id, from_nation_id, to_nation_id, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
    )
    .bind(row.id, row.season_id, row.from_nation_id, row.to_nation_id, row.body, row.created_at)
    .run();
}

export const MESSAGES_LIST_LIMIT = 100; // finding #12

export async function listMessagesForNation(
  db: D1Database,
  nationId: Id,
  box: 'inbox' | 'sent',
  limit: number = MESSAGES_LIST_LIMIT
): Promise<MessageRow[]> {
  const column = box === 'inbox' ? 'to_nation_id' : 'from_nation_id';
  const res = await db
    .prepare(`SELECT * FROM messages WHERE ${column} = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(nationId, limit)
    .all<MessageRow>();
  return res.results;
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
}
