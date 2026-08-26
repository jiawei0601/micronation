-- M9(Codex 審查修復):db/auth 層加固。標準 SQL(SQLite 方言,D1 相容),沿用 0001-0003 慣例。
-- 0001 已定案,不回頭改既有欄位定義;sessions.id / users.verify_token 從明文改存 SHA-256(token)
-- 雜湊(finding #1/#13)不需要改欄位型別(本來就是 TEXT,雜湊後固定 64 hex 字元),純屬應用層
-- 寫入內容的改變,故這裡不需要 ALTER/重建那兩個欄位本身,只補索引與新的唯一鍵約束。

-- finding #2:nations 同賽季同一 owner 只能有一個國家(owner_id 為 NULL 的 NPC 不受此限,
-- partial index 用 WHERE owner_id IS NOT NULL 排除)。
CREATE UNIQUE INDEX idx_nations_season_owner ON nations(season_id, owner_id) WHERE owner_id IS NOT NULL;

-- finding #3:跨賽季一致性。完整的複合外鍵(child 表也存 season_id 並對 parent(season_id, id)
-- 建複合 FK)需要把 regions/nations/marches/treaties/market_orders 全部關聯表都加上對應的
-- season_id 複合參照,SQLite 對 ALTER TABLE 加 FK 的支援有限(需要整表重建),對現有 4 張表
-- 的關聯欄位(region_id/attacker_id/defender_id/a_id/b_id/nation_id 等)逐一補齊代價過高、
-- 又是 dev 階段就要大改 schema。這裡先用「同賽季內 id 唯一」的複合唯一鍵確立不變量(id 本身
-- 已是全域唯一 PK,複合唯一鍵在此語意上是 PK 唯一性的超集,不會擋合法寫入),供未來若要補
-- 完整複合外鍵時,子表已經有這個唯一鍵可以參照。取捨記錄於 HANDOFF.md。
CREATE UNIQUE INDEX idx_regions_season_id ON regions(season_id, id);
CREATE UNIQUE INDEX idx_nations_season_id ON nations(season_id, id);
CREATE UNIQUE INDEX idx_marches_season_id ON marches(season_id, id);
CREATE UNIQUE INDEX idx_treaties_season_id ON treaties(season_id, id);
CREATE UNIQUE INDEX idx_orders_season_id ON market_orders(season_id, id);

-- finding #17:verify_token(雜湊後)查找加索引——verifyEmail 走 WHERE verify_token = ?。
CREATE INDEX idx_users_verify_token ON users(verify_token);
