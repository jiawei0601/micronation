# HANDOFF — 微國家

## 任務
網頁版多人國家模擬經營遊戲 MVP(S1)。PRD=issue #1,決策=docs/DECISIONS-grill-2026-08-26.md,契約=docs/CONTRACT.md(改介面前必讀)。

## 已完成
- Phase 1-4:grill 15 決策、UI 定案(C 地圖主殼+B 面板+A 公文點綴,原型 prototype/ui-variants.html)、PRD(#1)、issues M0-M9、CONTRACT v1。
- M0 monorepo scaffold(npm workspaces、shared 型別/常數/RNG/Result、vitest+tsc 綠)。
- M1-M5(engine/market/diplomacy/military/npc)五模塊平行實作+收攏(統一常數/型別)。
- Codex 審查四輪收斂:41+16+6 findings 全修,四審 approve(2026-08-26,session 01a03cb9)。M0-M5 可交付。
- M6-M9 全部完成並過審:M7 api 全路由+教學任務、M8 tick-cron+賽季管理+admin 開季、玩家練兵路由。
  Codex 七輪審查收斂(一審 72→二審 50→三審 21→四審 13→五審 4→六審 1→七審 approve),
  共 161 條 findings 全修,484 tests 綠。重大修復:市場 escrow 結算、session/verify token 雜湊化、
  tick lease+時槽冪等、events.seq AUTOINCREMENT、樂觀鎖 version、前端跨帳號重置、logout 失敗處理。
- M6 db+auth(D1 12表+repository 差異寫回+PBKDF2/session,14 tests)+M9 前端 MVP(全路由+旗幟產生器+mock 世界+輪詢,29 tests)。239 tests 綠。dev:`npm run dev -w @micronation/web`(mock 模式預設開)。已知小瑕疵:地圖殼士氣顯示原文 medium、事件流顯示原始 event type 未走 i18n——UI Polish 階段處理。

## 下一步
1. ✅M0-M9 全部完成且 Codex approve(2026-08-26)。
2. ✅**已部署上線(2026-08-26)**:https://micronation-api.micronation.workers.dev
   單 Worker 同源服務前端(assets)+API+每小時 cron;D1=micronation-db(id 見 wrangler.toml);
   S1 已開季(5 區/8 NPC);煙霧測試通過(註冊→登入→開國→建設→任務→市場,UI 實測 OK)。
   ADMIN_TOKEN 在本機 ~/.micronation-admin-token(勿入 repo);部署指令=`npm run build -w @micronation/web && npx wrangler --cwd apps/api deploy`。
   ⚠️PBKDF2 用 100k(CF Workers WebCrypto 硬上限,非疏漏)。
   ⚠️ENVIRONMENT=development(mail 走 console):**email 驗證信寄不到使用者**→無法解鎖貿易。
   轉正式=申請 Resend(免費)→`wrangler secret put RESEND_API_KEY`→補完 ResendMailSender 模板→ENVIRONMENT=production。
   (原部署步驟紀錄):註冊/登入 CF→`wrangler login`→建 D1(micronation-db,
   替換 wrangler.toml placeholder id)→跑 migration→`wrangler secret put ADMIN_TOKEN`(+正式寄信需
   RESEND_API_KEY,無則 ENVIRONMENT 必須非 production 語意——mail fail-closed 見 index.ts)→部署
   Workers+Pages→admin 開 S1(POST /api/admin/season)→煙霧測試(註冊/開國/tick)。
3. 部署後:UI Polish(HANDOFF 舊註記的 i18n 小瑕疵)+/security-review+對外發佈。

## 決策+原因(摘要,全文見 docs/)
賽季 8 週/每小時 tick/抽象區域/4 資源+特化逼貿易/掠奪有上限不可滅國/系統強制條約+信譽/4 軸政策/一國一城/市場掛單無定向轉帳(反小號)/NPC 冷啟動/戰功計分非囤兵/組合式旗幟(零審核)/CF Workers+D1+Pages $0(使用者明確不用自有 Hetzner)。

## 雷區
- 純邏輯包(engine/market/diplomacy/military/npc)禁 IO、禁 Date.now,隨機一律 shared createRng。
- 平衡常數只准在 packages/shared/src/constants.ts。
- D1 migration 只用標準 SQL(保留換 Postgres 退路)。
- M0 的區域距離=|i-j| 佔位公式;BATTLE_LOSS_RATE 0.2-0.25(scaffold agent 折衷,可調)。

## 怎麼跑測
`npm install && npm test`(全 workspace vitest);型別 `npx tsc -b`。

## 最後 commit
七審 minor cap cleanup 收尾。實作=Claude Code(sonnet subagents,主對話收攏),審查=Codex 七輪 approve(session 01a03cb9)。
