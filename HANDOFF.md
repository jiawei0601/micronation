# HANDOFF — 微國家

## 任務
網頁版多人國家模擬經營遊戲 MVP(S1)。PRD=issue #1,決策=docs/DECISIONS-grill-2026-08-26.md,契約=docs/CONTRACT.md(改介面前必讀)。

## 已完成
- Phase 1-4:grill 15 決策、UI 定案(C 地圖主殼+B 面板+A 公文點綴,原型 prototype/ui-variants.html)、PRD(#1)、issues M0-M9、CONTRACT v1。
- M0 monorepo scaffold(npm workspaces、shared 型別/常數/RNG/Result、vitest+tsc 綠)。

## 進行中
- M1-M5(engine/market/diplomacy/military/npc)五個 sonnet subagent 平行實作中(2026-08-26),各自只動自己 package、不 commit,完成後主對話統一驗證+commit。

## 下一步
1. M1-M5 收攏:跑全 repo `npm test`+`tsc -b`,處理 shared 缺口回報,統一 commit。
2. M6(db+auth)→M7(api)→M8(tick-cron)依序(共享 apps/api,不平行)。M9(web)可與 M6-M8 平行。
3. 完成後照 R6:新功能強制 Codex 審(MCP review_code)。
4. Cloudflare 部署(wrangler,帳號待使用者提供/授權)。

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
M0 scaffold(Claude Code sonnet subagent 實作、Fable 主對話驗收)。實作=Claude Code,審查=Codex(照 AGENTS.md)。
