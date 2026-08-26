-- M9 二審(Codex 一審 routes/game/tick 層 findings)加固。標準 SQL(SQLite 方言,D1 相容),
-- 沿用 0001-0004 慣例。

-- finding #10:開季 admin 端點原本靠「先 SELECT active season 是否存在 → 不存在才 INSERT」
-- 兩步判斷,並發呼叫仍可能都通過檢查、都成功 INSERT 出兩個 active 賽季(TOCTOU)。改用 DB
-- 條件式唯一索引擋——同一時間只允許一筆 status='active' 的 row,並發時後到的 INSERT 會撞
-- 這個 unique index、被資料庫拒絕(admin.ts 捕捉錯誤轉譯回 SEASON_ALREADY_ACTIVE)。
CREATE UNIQUE INDEX idx_seasons_one_active ON seasons(status) WHERE status = 'active';

-- finding #28:tick_running 從單純布林改記錄「何時開始跑」的時間戳,供 stale(見
-- apps/api/src/db/repository.ts TICK_RUNNING_STALE_MS)判斷是否可搶。
ALTER TABLE seasons ADD COLUMN tick_running_since INTEGER;

-- finding #23/#29:scheduled() 用 Cron Trigger 的 scheduledTime 換算出的「目標 tick 時槽」
-- 寫回這裡——同一時槽已經跑過就跳過(冪等),避免 Cloudflare 對同一次觸發偶發重試造成
-- 一小時內跑兩次 tick。
ALTER TABLE seasons ADD COLUMN last_tick_slot INTEGER;

-- finding #20:訊息 rate limit 用「本 tick 已送幾則」判斷,需要在 messages 表記錄當時的
-- tick(訊息送出當下的 WorldState.tick,不是 created_at 時間戳)。
ALTER TABLE messages ADD COLUMN tick INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_from_tick ON messages(from_nation_id, tick);

-- finding #20:訊息 id 改用單調遞增序號(比照 next_order_seq/next_event_seq 的既有模式),
-- 不再只靠 makeId(..., now) 的毫秒時間戳(同毫秒內連續送出有理論上的撞號風險)。
ALTER TABLE seasons ADD COLUMN next_message_seq INTEGER NOT NULL DEFAULT 0;
