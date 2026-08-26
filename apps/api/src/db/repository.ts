// D1 repository 層——loadWorldState/saveWorldState(差異寫回)+ user/session CRUD。
// 只做 prepared statement 組裝與 batch 呼叫,不含業務邏輯(業務邏輯在 packages/* 純模塊)。

import type { WorldState, GameEvent, Id } from '@micronation/shared';
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
} from './rows';

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

  const [regionsRes, nationsRes, marchesRes, treatiesRes, ordersRes] = await Promise.all([
    db.prepare('SELECT * FROM regions WHERE season_id = ? ORDER BY region_index ASC').bind(seasonId).all(),
    db.prepare('SELECT * FROM nations WHERE season_id = ?').bind(seasonId).all(),
    db.prepare('SELECT * FROM marches WHERE season_id = ?').bind(seasonId).all(),
    db.prepare('SELECT * FROM treaties WHERE season_id = ?').bind(seasonId).all(),
    db.prepare('SELECT * FROM market_orders WHERE season_id = ?').bind(seasonId).all(),
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
  await db.batch(stmts);
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
    const id = makeId('event', next.seasonId, next.tick, i);
    const row = eventToRow(next.seasonId, id, e, eventCreatedAt);
    stmts.push(
      db
        .prepare(
          'INSERT INTO events (id, season_id, tick, type, nation_ids, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(row.id, row.season_id, row.tick, row.type, row.nation_ids, row.payload, row.created_at)
    );
  });

  if (stmts.length > 0) await db.batch(stmts);
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
