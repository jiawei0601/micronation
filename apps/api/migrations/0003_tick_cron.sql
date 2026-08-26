-- M8: tick-cron 支援欄位。標準 SQL(SQLite 方言,D1 相容),沿用 0001/0002 慣例。

-- 競態緩解旗標——runTick 開頭寫 1、結束清 0。玩家寫入路由在套用變更前檢查此旗標,
-- 若 tick 正在跑則回 503 TICK_IN_PROGRESS,避免玩家請求與 tick-cron 對同一 WorldState
-- 的讀-改-寫互相覆蓋(CONTRACT 尚未有樂觀鎖/D1 原生 transaction,先用此旗標降低碰撞機率;
-- 仍有 TOCTOU 殘餘風險,見 apps/api/src/tick/run.ts 開頭註解)。
ALTER TABLE seasons ADD COLUMN tick_running INTEGER NOT NULL DEFAULT 0;

-- 名人堂分項冠軍標記——NULL = 總分前三名(hall_of_fame.rank 為 1-3 名次);
-- 非 NULL('economy'|'warfare'|'tech'|'diplomacy') = 該分項第一名(rank 固定 1,category 標識分項)。
-- 賽季到期結算時一次寫入「總分前三 + 4 分項各一名」,兩種記錄用 category 區分,不互相覆蓋。
ALTER TABLE hall_of_fame ADD COLUMN category TEXT;

