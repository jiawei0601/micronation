-- M9 二審 squash:專案尚未部署、無任何線上資料,0001-0005 合併重整為單一乾淨 schema。
-- ⚠️pre-deployment squash——部署後不可再改史(改用新的遞增 migration 檔)。
-- 標準 SQL(SQLite 方言,D1 相容)。複雜欄位(flag/buildings/build_queue/policies/
-- policy_changed_at/score/marches/treaties/market_orders/events payload 等)一律存 JSON text,
-- 由 apps/api/src/db 的 repository 層序列化/反序列化。
--
-- 本檔合併了原 0001_init/0002_messages/0003_tick_cron/0004_hardening/0005_hardening2 的內容,
-- 並補上原本受限於「SQLite ALTER TABLE 加 FK 需要整表重建」而未做的完整複合外鍵
-- (season_id, ...) → parent(season_id, id)(①-1),以及 events 的正規化子表 events_nations
-- 取代 events.nation_ids 的 LIKE 查詢(①-12/②-17)。

CREATE TABLE seasons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tick INTEGER NOT NULL DEFAULT 0,
  next_march_seq INTEGER NOT NULL DEFAULT 0,
  next_order_seq INTEGER NOT NULL DEFAULT 0,
  next_event_seq INTEGER NOT NULL DEFAULT 0,
  next_message_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active|ended
  -- ①-6:WorldState 寫回樂觀鎖版本號——saveWorldState 每次成功寫入都 +1,呼叫端須帶著讀取時
  -- 的版本號 UPDATE ... WHERE version = ?,0 rows affected 視為衝突(ConflictError)。
  version INTEGER NOT NULL DEFAULT 0,
  -- ①-7:tick lease owner——runTick 取得鎖時寫入自己的隨機 id,finally 只清除 owner 相符的旗標,
  -- 避免「A 的 stale 鎖被 B 接管後,A 遲來的 finally 又把 B 剛拿到的鎖清掉」。
  tick_owner TEXT,
  tick_running INTEGER NOT NULL DEFAULT 0,
  -- ①-8:squash 後不再有「舊 schema 遺留 NULL」的相容性問題,NOT NULL DEFAULT 0——0 與
  -- tick_running=0(未在跑)同時成立時視同「從未跑過」,邏輯(claimTickLease)仍防禦性地保留
  -- IS NULL 分支,不假設呼叫端一定用這個預設值寫入。
  tick_running_since INTEGER NOT NULL DEFAULT 0,
  last_tick_slot INTEGER,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
-- finding #10(一審):同一時間只允許一筆 status='active' 的 row,併發開季時後到的 INSERT
-- 撞這個 partial unique index 被拒絕。
CREATE UNIQUE INDEX idx_seasons_one_active ON seasons(status) WHERE status = 'active';

CREATE TABLE regions (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  region_index INTEGER NOT NULL, -- regionDistanceByIndex 用的陣列序,建立時依序寫入
  name TEXT NOT NULL,
  bonuses TEXT NOT NULL -- JSON: Partial<Record<ResourceKind, number>>
);
CREATE INDEX idx_regions_season ON regions(season_id);
CREATE UNIQUE INDEX idx_regions_season_index ON regions(season_id, region_index);
CREATE UNIQUE INDEX idx_regions_season_id ON regions(season_id, id); -- 供子表複合 FK 參照

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,               -- 正規化後(trim + lowercase)
  password_hash TEXT NOT NULL,       -- PBKDF2-SHA256 hex digest
  password_salt TEXT NOT NULL,       -- hex,隨機
  password_iterations INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0, -- 0/1,供 market NationCtx.verified
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users(email);

-- ③-1:原本驗證 token 只存在 users.verify_token 單一欄位——resendVerification 每次呼叫都是
-- 「產生新 token → 覆蓋掉舊 token」,兩個幾乎同時的 resend 請求(或 register 剛寄信失敗、
-- 使用者手動點了兩次「重寄」)彼此互相覆蓋,較晚寫入的那個覆蓋較早的,較早那次呼叫寄出的信
-- 裡的 token 就此失效,即使那次寄信其實成功送達。改成多列表:每次產生 token 都是新增一列,
-- 不覆寫任何既有列,天生免疫這種競態——多個同時有效的 token 並存完全合法(使用者用哪一封
-- 信裡的都能驗證成功),驗證成功後一次刪光該 user 的所有列(不論用的是哪一個)。
-- Codex 五審①:seq 改為真正的 INTEGER PRIMARY KEY AUTOINCREMENT(SQLite rowid alias),
-- token_hash 降為 UNIQUE(而非 PRIMARY KEY)——resend/cleanup 需要一個「插入序」穩定鍵排序
-- 保留最新 N 筆,created_at(epoch ms)在同一毫秒內對同一 user 連續 resend 時可能重複,無法
-- 單獨當穩定排序鍵;seq 是單調遞增、不重複的插入序,不受時鐘精度影響。
CREATE TABLE verification_tokens (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,   -- SHA-256(token),不落地明文
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_verification_tokens_user ON verification_tokens(user_id);
-- Codex 五審③:cleanupExpiredVerificationTokens(全表 WHERE expires_at <= ?)與
-- insertVerificationTokenAtomic(WHERE user_id = ? AND expires_at <= ?)都以 expires_at 為
-- 過濾條件——沒有索引時隨表成長變成全表掃描。
CREATE INDEX idx_verification_tokens_expires ON verification_tokens(expires_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- session token 的 SHA-256 雜湊(不落地明文)
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
  region_id TEXT NOT NULL,
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
  last_attacked_at INTEGER,           -- nullable
  -- ①-1:複合外鍵,region_id 須屬於同一 season。
  FOREIGN KEY (season_id, region_id) REFERENCES regions(season_id, id)
);
CREATE INDEX idx_nations_season ON nations(season_id);
CREATE INDEX idx_nations_owner_id ON nations(owner_id);
CREATE INDEX idx_nations_region ON nations(region_id);
-- finding #2(一審):同賽季同一 owner 只能有一個國家(owner_id 為 NULL 的 NPC 不受此限)。
CREATE UNIQUE INDEX idx_nations_season_owner ON nations(season_id, owner_id) WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX idx_nations_season_id ON nations(season_id, id); -- 供子表複合 FK 參照

CREATE TABLE market_orders (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  nation_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- ResourceKind
  side TEXT NOT NULL,                 -- 'buy'|'sell'
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (season_id, nation_id) REFERENCES nations(season_id, id)
);
-- 撮合候選查詢的常用組合(同 kind+side,依 price/createdAt 排序)。
CREATE INDEX idx_orders_kind_side_price ON market_orders(season_id, kind, side, price, created_at);
CREATE INDEX idx_orders_nation ON market_orders(nation_id);
CREATE UNIQUE INDEX idx_orders_season_id ON market_orders(season_id, id);

-- trades 記錄的 buy_order_id/sell_order_id 是「成交當下」的掛單 id——成交後原掛單可能已從
-- market_orders 刪除(全部成交/撤單),不可對這兩欄加 FK(會擋合法的歷史成交紀錄寫入)。
CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  buy_order_id TEXT NOT NULL,
  sell_order_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  tariff INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  FOREIGN KEY (season_id, buyer_id) REFERENCES nations(season_id, id),
  FOREIGN KEY (season_id, seller_id) REFERENCES nations(season_id, id)
);
CREATE INDEX idx_trades_season_tick ON trades(season_id, tick);
CREATE INDEX idx_trades_buyer ON trades(buyer_id);
CREATE INDEX idx_trades_seller ON trades(seller_id);

CREATE TABLE treaties (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  kind TEXT NOT NULL,                 -- 'nap'|'alliance'|'trade'
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  status TEXT NOT NULL,               -- TreatyStatus
  terms TEXT NOT NULL,                -- JSON TreatyTerms
  created_at INTEGER NOT NULL,
  FOREIGN KEY (season_id, a_id) REFERENCES nations(season_id, id),
  FOREIGN KEY (season_id, b_id) REFERENCES nations(season_id, id)
);
CREATE INDEX idx_treaties_season ON treaties(season_id);
CREATE INDEX idx_treaties_pair ON treaties(a_id, b_id);
CREATE UNIQUE INDEX idx_treaties_season_id ON treaties(season_id, id);

CREATE TABLE marches (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  attacker_id TEXT NOT NULL,
  defender_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  departed_at INTEGER NOT NULL,
  arrives_at INTEGER NOT NULL,
  FOREIGN KEY (season_id, attacker_id) REFERENCES nations(season_id, id),
  FOREIGN KEY (season_id, defender_id) REFERENCES nations(season_id, id)
);
CREATE INDEX idx_marches_season ON marches(season_id);
CREATE INDEX idx_marches_arrives ON marches(season_id, arrives_at);
CREATE UNIQUE INDEX idx_marches_season_id ON marches(season_id, id);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  tick INTEGER NOT NULL,
  type TEXT NOT NULL,                 -- EventType
  nation_ids TEXT NOT NULL,           -- JSON Id[](顯示/除錯用;查詢改走 events_nations)
  payload TEXT NOT NULL,              -- JSON unknown
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_tick ON events(season_id, tick);
CREATE INDEX idx_events_type ON events(season_id, type);

-- events_nations
CREATE TABLE events_nations (
  event_seq INTEGER NOT NULL REFERENCES events(seq),
  nation_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  PRIMARY KEY (event_seq, nation_id),
  FOREIGN KEY (season_id, nation_id) REFERENCES nations(season_id, id)
);
CREATE INDEX idx_events_nations_nation ON events_nations(nation_id, event_seq);

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
  -- 分項冠軍標記——NULL = 總分前三名(rank 為 1-3 名次);非 NULL('economy'|'warfare'|'tech'|
  -- 'diplomacy') = 該分項第一名(rank 固定 1)。
  category TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (season_id, nation_id) REFERENCES nations(season_id, id)
);
CREATE INDEX idx_hof_season_rank ON hall_of_fame(season_id, rank);

-- 站內訊息(國與國一對一)。
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  from_nation_id TEXT NOT NULL,
  to_nation_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  tick INTEGER NOT NULL DEFAULT 0,    -- 訊息送出當下的 WorldState.tick,供每 tick 速率限制查詢
  FOREIGN KEY (season_id, from_nation_id) REFERENCES nations(season_id, id),
  FOREIGN KEY (season_id, to_nation_id) REFERENCES nations(season_id, id)
);
CREATE INDEX idx_messages_to ON messages(to_nation_id, created_at);
CREATE INDEX idx_messages_from ON messages(from_nation_id, created_at);
CREATE INDEX idx_messages_from_tick ON messages(from_nation_id, tick);
