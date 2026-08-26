-- M7: 站內訊息表(國與國一對一)+ market order id 序號欄位。
-- 標準 SQL(SQLite 方言,D1 相容),沿用 0001 慣例。

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  from_nation_id TEXT NOT NULL REFERENCES nations(id),
  to_nation_id TEXT NOT NULL REFERENCES nations(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX idx_messages_to ON messages(to_nation_id, created_at);
CREATE INDEX idx_messages_from ON messages(from_nation_id, created_at);

-- market.placeOrder 需要呼叫端提供單調遞增 seq(CONTRACT §market finding #10)組 order id,
-- 避免用 book.length 之類「現存筆數」推算而撞號。seq 不屬於 WorldState(shared 型別正本
-- 未收錄,只是 api 層 id 產生用的內部序號),故獨立存 seasons.next_order_seq,不與
-- next_march_seq 混用。
ALTER TABLE seasons ADD COLUMN next_order_seq INTEGER NOT NULL DEFAULT 0;

-- events.id 原本用 makeId('event', seasonId, tick, i)(i = 本次呼叫內的陣列序)組成,
-- 在同一 tick 內有多次 saveWorldState 呼叫時(M7 常態——玩家操作不像 tick-cron 只跑一次,
-- 一個 tick 內可能有多筆 propose/respond/build 等各自觸發的事件)i 會從 0 重來,和先前
-- 已寫入的 event id 撞主鍵。改用 seasons.next_event_seq 單調遞增序號組 id,避免撞號。
ALTER TABLE seasons ADD COLUMN next_event_seq INTEGER NOT NULL DEFAULT 0;
