# PRD:微國家 — 網頁版多人國家模擬經營遊戲(MVP / S1)

決策來源:`docs/DECISIONS-grill-2026-08-26.md`(15 項 grill 決策+UI 方向定案)。

## Problem Statement

想在瀏覽器裡經營自己的國家、並與其他真人玩家外交與競爭的玩家,目前只能玩節奏過肝的即時制策略遊戲、或互動扁平的單機模擬器。上班族玩家需要一款「一天上線一到三次、每次十分鐘」就能認真治國、且多人互動(貿易/外交/戰爭)是玩法核心而非裝飾的網頁遊戲。

對專案擁有者而言,這也是一件公開上線、能長期營運且月費 $0 的作品集作品。

## Solution

「微國家」:賽季制(8 週)tick 制(每小時)多人國家經營網頁遊戲。玩家免費註冊開國(自訂國名+組合式國旗),落在 6-12 個大區之一,經營一座首都(8 種建築、4 種資源+科技點、人口與士氣),透過全球市場掛單貿易補區域短板,以系統強制條約(NAP/同盟/貿易協定)經營外交,以有損失上限的掠奪戰爭競爭,最終在綜合國力排行榜與名人堂留名。世界由 NPC 國家填充冷啟動。介面為繁中「地圖主殼(C)+數據面板內頁(B)」,部署於 Cloudflare Workers + D1 + Pages。

## User Stories

### 帳號與開國
1. As a 新玩家, I want 用 email+密碼在 30 秒內註冊並立即開國, so that 不被冗長流程擋在門外。
2. As a 新玩家, I want 自由輸入國名(敏感詞過濾、允許重名), so that 建立身分認同。
3. As a 新玩家, I want 用組合式產生器(分割樣式×調色盤×徽章)設計國旗並即時預覽, so that 擁有獨一無二的旗幟且無需審核。
4. As a 新玩家, I want 選擇或被分配到一個大區, so that 有地緣歸屬。
5. As a 玩家, I want 完成 email 驗證後解鎖市場交易, so that 系統能阻擋小號資源輸送。
6. As a 玩家, I want 登入後回到我的國家儀表板, so that 接續經營。
7. As a 玩家, I want 修改密碼與基本設定, so that 帳號安全。

### 世界與 tick
8. As a 玩家, I want 世界每小時整點推進一次(產出/人口/建設/行軍結算), so that 離線也照規則成長。
9. As a 玩家, I want 看到「下次 tick 倒數」與目前 tick 數, so that 掌握節奏。
10. As a 玩家, I want 每 tick 獲得行動點(可囤 1-2 天), 重大操作消耗行動點, so that 不必掛機也不輸給腳本。
11. As a 玩家, I want 在 C 風格地圖主畫面看到各大區、我的位置、進行中的行軍與警報, so that 一眼掌握世界局勢。

### 資源與內政
12. As a 玩家, I want 查看糧食/礦石/燃料/金錢/科技點的存量與每 tick 增減, so that 規劃經濟。
13. As a 玩家, I want 我的大區有資源產出特化(加成/懲罰), so that 有貿易或開戰的理由。
14. As a 玩家, I want 人口隨糧食盈餘/稅率/士氣成長並決定產出與徵兵上限, so that 內政決策有連鎖後果。
15. As a 玩家, I want 在糧食短缺導致人口衰退前收到明確警告, so that 避免死亡螺旋。

### 建設
16. As a 玩家, I want 升級 8 種建築(農場/礦場/煉油廠/市場/兵營/倉庫/大學/城牆), so that 提升國力。
17. As a 玩家, I want 建設佇列(1-2 位)顯示進度與剩餘 tick, so that 安排離線期間的成長。
18. As a 玩家, I want 倉庫提供資源保護額度, so that 戰敗損失有下限。

### 政策
19. As a 玩家, I want 在 4 個政策軸(稅率/經濟路線/兵役/開放度)各選一檔且 trade-off 明示, so that 定義國家路線。
20. As a 玩家, I want 改政策有 48 tick 冷卻與成本, so that 對手無法戰前瞬間切檔。

### 市場貿易
21. As a 玩家, I want 在全球市場掛買/賣單並查看掛單簿與近期成交價, so that 補短板換盈餘。
22. As a 玩家, I want 掛單價超出近期成交價 ±30% 被拒絕, so that 市場不被小號輸送操縱。
23. As a 玩家, I want 跨區交易成本高於同區、貿易協定可減免, so that 地緣與外交影響經濟。
24. As a 玩家, I want 沒有任何定向轉帳/贈與功能, so that 多帳號輸送無利可圖。

### 軍事
25. As a 玩家, I want 消耗資源與人口訓練軍隊(受兵營與兵役政策影響), so that 建立武力。
26. As a 玩家, I want 對他國發起攻擊後部隊按區域距離行軍 N tick 才抵達, so that 防守方有反應窗口。
27. As a 防守玩家, I want 被宣戰時立即收到警報並可備戰/撤資/求援, so that 睡覺不被偷光。
28. As a 玩家, I want 戰鬥由系統解算(兵力×科技×士氣+少量隨機)且結果附戰報, so that 勝負可理解。
29. As a 戰敗玩家, I want 損失上限為未保護資源的 20-30%、建築只受損可修、國家不可被滅, so that 最慘也能翻身。
30. As a 新手, I want 開國 7 天或完成教學前不可被攻擊, so that 安全學會遊戲。
31. As a 強國玩家, I want 攻打國力遠低於我的目標無收益無戰功, so that 打農不成立。

### 外交
32. As a 玩家, I want 對他國發起 NAP/同盟/貿易協定提案並可還價, so that 用談判塑造局勢。
33. As a 玩家, I want NAP 生效期間系統直接擋雙方攻擊, so that 條約有真實效力。
34. As a 玩家, I want 提前毀約需付高額賠償且全服公告背信標記, so that 背刺有代價。
35. As a 盟友, I want 盟友被攻擊時可派兵協防, so that 同盟有軍事意義。
36. As a 玩家, I want 每個國家頁公開顯示信譽(毀約紀錄), so that 選擇可信的夥伴。
37. As a 玩家, I want 與他國一對一站內訊息, so that 談判不必離開遊戲。

### 排行與賽季
38. As a 玩家, I want 綜合國力分(經濟+戰功+科技+外交履約)每 tick 更新並排名, so that 知道自己的位置。
39. As a 玩家, I want 軍事分計戰功(打強敵多、打農趨零)而非囤兵量, so that 排行鼓勵真實對抗。
40. As a 非戰鬥玩家, I want 首富/戰神/科技/信譽 4 個分項榜, so that 和平路線也有頭銜可爭。
41. As a 玩家, I want 賽季 8 週結束時結算、頒發名人堂(跨賽季保存), so that 努力有永久紀錄。
42. As a 回流玩家, I want 新賽季所有人重新起跑, so that 任何時候入坑都有公平機會。

### NPC 與冷啟動
43. As a 早期玩家, I want 世界有 20-30 個 NPC 國家照規則成長、在市場自動掛單, so that 人少時市場與世界依然活著。
44. As a 新手, I want 教學指定可攻打的弱小 NPC, so that 無風險練習戰爭系統。
45. As a 玩家, I want 攻打 NPC 的戰功打 5 折, so that 沒人靠刷 NPC 上榜。

### 教學與通知
46. As a 新手, I want 「建國之路」12-15 步任務鏈(每步教一系統+給獎勵), so that 自然學會全部玩法。
47. As a 玩家, I want 每個功能頁有「?」說明角, so that 隨時查規則不求人。
48. As a 玩家, I want 頁面每 30-60 秒輪詢更新並在有事件時顯示紅點/警報, so that 不刷新也知道被宣戰。
49. As a 玩家, I want 事件時間軸(戰報/條約/市場成交/tick 摘要), so that 回顧離線期間發生的事。

### 管理與營運
50. As a 管理者, I want 敏感國名檢舉處理與強制改名權限, so that 零人力也能維持社群底線。
51. As a 管理者, I want 同 IP 帳號市場成交標記後台可查, so that 異常輸送可人工處置。
52. As a 管理者, I want 賽季開關與 NPC 數量設定, so that 逐季調整世界參數。

## Implementation Decisions

- **平台**:Cloudflare Workers(Hono+TypeScript)+ D1(SQLite)+ Pages(React+Vite+Tailwind)。tick 用 Cron Triggers 每小時觸發。無 WebSocket/SSE,前端 30-60 秒輪詢。
- **模塊切分**(深模塊優先,1-5 純邏輯零 IO、前後端共用):
  1. `engine` 規則引擎:單一入口 `resolveTick(worldState, seed) → { newState, events }`;產出、人口、戰鬥、政策修正、計分、行動點全在內;確定性(種子隨機)。
  2. `market` 撮合:掛單/吃單/撤單、±30% 價格帶、成交紀錄。
  3. `diplomacy` 條約狀態機:提案→接受/拒絕/還價→生效→到期/毀約;NAP 攔截判定;信譽。
  4. `military` 行動佇列:宣戰合法性(保護期/打農/NAP)、行軍排程;抵達後由 engine 解算。
  5. `npc` 行為狀態機:輸出與玩家相同的指令格式,不走後門。
  6. `db` D1 schema+repository(不用 SQLite 特有語法,保留換 Postgres 退路)。
  7. `auth` email+密碼、驗證信、session。
  8. `api` Hono 薄殼路由。
  9. `tick-cron` orchestrator:交易性執行 engine 結算。
  10. `web` 前端:C 地圖主殼+B 面板內頁+A 公文元素(條約畫面);旗幟參數→SVG 元件;任務鏈;i18n 字串第一天抽離(僅填繁中)。
- **反輸送**:僅市場掛單無定向轉帳;價格帶;同 IP 標記;保護期限制大額交易;email 驗證解鎖貿易。
- **旗幟**:存參數 JSON(分割樣式/色/徽章),前端 SVG 渲染,零圖檔儲存。
- **賽季資料**:世界表帶 `season_id`;名人堂與玩家檔案跨賽季。
- **美術**:零繪圖資產——SVG/CSS+開源圖示庫(game-icons.net CC、Lucide),不用 AI 生圖、不用 3D。

## Testing Decisions

- 好測試=只驗外部行為(輸入 state/指令→輸出 state/events),不綁實作細節。
- **必測(單元)**:`engine`(經濟循環、戰鬥邊界、損失上限、保護期、計分)、`market`(撮合順序、價格帶、部分成交)、`diplomacy`(狀態機全轉移、毀約、NAP 攔截)、`military`(合法性檢查、行軍時間)、`npc`(決策規則)。全部純函式,vitest 直測。
- **整合**:`api` 端到端(註冊→開國→建設→掛單→宣戰主要 happy path+反輸送拒絕案例),用 wrangler 本地 D1。
- **前端**:只測旗幟產生器(參數→SVG 結構)與數值顯示公式;不測版面。
- 先例:無(新 repo),依 vitest 標準慣例。

## Out of Scope(第二階段以後)

- 格子地圖/領土佔領、多城(≤3 城的賽季後期擴張)、國內事件系統、法令清單制、國際組織/投票/制裁、OAuth 登入、英文介面、行動 App、AI 生圖美術、聊天室/公開頻道(僅一對一訊息)、付費功能。

## Further Notes

- 冷啟動策略=NPC 國家+市場流動性,是 MVP 成敗關鍵,實作優先級不可後移。
- 平衡數值(產出率/戰損公式/權重)先拍腦袋,集中於 engine 的單一常數檔,上線後靠數據迭代。
- 跨 agent 紀律照 AGENTS.md:實作=Claude Code,審查=Codex。
