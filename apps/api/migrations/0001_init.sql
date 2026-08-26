-- M6: D1 schema init. 標準 SQL(SQLite 方言,D1 相容)。
-- 複雜欄位(flag/buildings/build_queue/policies/policy_changed_at/score/marches/treaties/
-- market_orders/events payload 等)一律存 JSON text,由 apps/api/src/db 的 repository 層序列化/反序列化。

-- 一個 season = 一個 WorldState。world 級的 tick/nextMarchSeq 存這裡,不放散在別處。
CREATE TABLE seasons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tick INTEGER NOT NULL DEFAULT 0,
  next_march_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active|ended
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE regions (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  region_index INTEGER NOT NULL, -- regionDistanceByIndex 用的陣列序,建立時依序寫入
  name TEXT NOT NULL,
  bonuses TEXT NOT NULL -- JSON: Partial<Record<ResourceKind, number>>
);
CREATE INDEX idx_regions_season ON regions(season_id);
CREATE UNIQUE INDEX idx_regions_season_index ON regions(season_id, region_index);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,               -- 正規化後(trim + lowercase)
  password_hash TEXT NOT NULL,       -- PBKDF2-SHA256 hex digest
  password_salt TEXT NOT NULL,       -- hex,隨機
  password_iterations INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0, -- 0/1,供 market NationCtx.verified
  verify_token TEXT,                 -- 待確認的驗證信 token(確認後清空)
  verify_token_expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users(email);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- session token(隨機 256bit,hex/base64url)
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL        -- 建立時+30天(epoch ms)
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Nation:標準欄位攤平成 column,複雜欄位(flag/buildings/build_queue/policies/
-- policy_changed_at/score)JSON text,足以序列化 shared Nation 全欄位。
CREATE TABLE nations (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  owner_id TEXT REFERENCES users(id), -- NULL = NPC
  name TEXT NOT NULL,
  flag TEXT NOT NULL,                 -- JSON FlagSpec
  region_id TEXT NOT NULL REFERENCES regions(id),
  resource_food INTEGER NOT NULL,
  resource_ore INTEGER NOT NULL,
  resource_fuel INTEGER NOT NULL,
  resource_money INTEGER NOT NULL,
  tech INTEGER NOT NULL,
  action_points INTEGER NOT NULL,
  population INTEGER NOT NULL,
  morale INTEGER NOT NULL,
  buildings TEXT NOT NULL,            -- JSON Record<BuildingKind, number>
  build_queue TEXT NOT NULL,          -- JSON { building, completesAt }[]
  army_size INTEGER NOT NULL,
  policies TEXT NOT NULL,             -- JSON Policies
  policy_changed_at TEXT NOT NULL,    -- JSON Partial<Record<PolicyAxis, Tick>>
  reputation_breaches INTEGER NOT NULL,
  protected_until INTEGER NOT NULL,
  score TEXT NOT NULL,                -- JSON ScoreBreakdown
  created_at INTEGER NOT NULL,
  last_attacked_at INTEGER            -- nullable(finding #25 的 optional 欄位)
);
CREATE INDEX idx_nations_season ON nations(season_id);
CREATE INDEX idx_nations_owner_id ON nations(owner_id);
CREATE INDEX idx_nations_region ON nations(region_id);

CREATE TABLE market_orders (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  nation_id TEXT NOT NULL REFERENCES nations(id),
  kind TEXT NOT NULL,                 -- ResourceKind
  side TEXT NOT NULL,                 -- 'buy'|'sell'
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- 撮合候選查詢的常用組合(同 kind+side,依 price/createdAt 排序)。
CREATE INDEX idx_orders_kind_side_price ON market_orders(season_id, kind, side, price, created_at);
CREATE INDEX idx_orders_nation ON market_orders(nation_id);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  buy_order_id TEXT NOT NULL,
  sell_order_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL REFERENCES nations(id),
  seller_id TEXT NOT NULL REFERENCES nations(id),
  kind TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  tariff INTEGER NOT NULL,
  tick INTEGER NOT NULL
);
CREATE INDEX idx_trades_season_tick ON trades(season_id, tick);
CREATE INDEX idx_trades_buyer ON trades(buyer_id);
CREATE INDEX idx_trades_seller ON trades(seller_id);

CREATE TABLE treaties (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  kind TEXT NOT NULL,                 -- 'nap'|'alliance'|'trade'
  a_id TEXT NOT NULL REFERENCES nations(id),
  b_id TEXT NOT NULL REFERENCES nations(id),
  status TEXT NOT NULL,               -- TreatyStatus
  terms TEXT NOT NULL,                -- JSON TreatyTerms
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_treaties_season ON treaties(season_id);
CREATE INDEX idx_treaties_pair ON treaties(a_id, b_id);

CREATE TABLE marches (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  attacker_id TEXT NOT NULL REFERENCES nations(id),
  defender_id TEXT NOT NULL REFERENCES nations(id),
  size INTEGER NOT NULL,
  departed_at INTEGER NOT NULL,
  arrives_at INTEGER NOT NULL
);
CREATE INDEX idx_marches_season ON marches(season_id);
CREATE INDEX idx_marches_arrives ON marches(season_id, arrives_at);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  tick INTEGER NOT NULL,
  type TEXT NOT NULL,                 -- EventType
  nation_ids TEXT NOT NULL,           -- JSON Id[]
  payload TEXT NOT NULL,              -- JSON unknown
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_tick ON events(season_id, tick);
CREATE INDEX idx_events_type ON events(season_id, type);

-- 教學進度(每 user 逐項任務狀態)
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  task_key TEXT NOT NULL,             -- 教學任務識別碼
  completed_at INTEGER,               -- NULL = 未完成
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_tasks_user_key ON tasks(user_id, task_key);

CREATE TABLE hall_of_fame (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  nation_id TEXT NOT NULL,
  nation_name TEXT NOT NULL,
  owner_id TEXT,
  final_score TEXT NOT NULL,          -- JSON ScoreBreakdown(賽季結束時的快照)
  rank INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_hof_season_rank ON hall_of_fame(season_id, rank);
