# HANDOFF — 微國家

## 任務
網頁版多人國家模擬經營遊戲 MVP(S1)。PRD=issue #1,決策=docs/DECISIONS-grill-2026-08-26.md,契約=docs/CONTRACT.md(改介面前必讀)。

## 已完成
- Phase 1-4:grill 15 決策、UI 定案(C 地圖主殼+B 面板+A 公文點綴,原型 prototype/ui-variants.html)、PRD(#1)、issues M0-M9、CONTRACT v1。
- M0 monorepo scaffold(npm workspaces、shared 型別/常數/RNG/Result、vitest+tsc 綠)。
- M1-M5(engine/market/diplomacy/military/npc)五模塊平行實作+收攏(統一常數/型別)。
- Codex 二輪審查共 41 findings 全修:第一輪 25 findings(commit 0645c29)+第二輪 16 findings
  (本次,2026-08-26)。第二輪重點:engine 戰功計分移除 `|| 1` fallback、diplomacy 統一
  `validateTerms`(kind 相容性+tick 驗證)、market 撮合前 notional/tariff safe-integer 檢查、
  military march id 改用 `WorldState.nextMarchSeq` 單調計數器(取代原本 finding #21 的
  「同 tick 現存筆數」算法,已知不耐撤軍重宣戰)、npc 規則④改嚴格互斥(actions.length===0)+
  wasAttacked 拒絕未來時間戳、shared/view.ts 全面深拷貝+新增 PublicMarch(viewer 為當事方才見
  精確 size,否則 sizeTier)+armySizeTier 拒絕非法輸入。192 tests 綠、tsc -b 綠。
  詳細條款見 docs/CONTRACT.md(標「第二輪 finding #N」的段落)。

## 下一步
1. M6(db+auth)→M7(api)→M8(tick-cron)依序(共享 apps/api,不平行)。M9(web)可與 M6-M8 平行。
   **注意**:api 層要接上 military.declareAttack 時,務必把 WorldState.nextMarchSeq 存回 D1
   並在每次呼叫後更新(declareAttack 回傳 `{march, nextMarchSeq}`,不再只回 March)。
2. 完成後照 R6:新功能強制 Codex 審(MCP review_code)。
3. Cloudflare 部署(wrangler,帳號待使用者提供/授權)。

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
修 Codex 二輪審查 16 findings(shared/engine/market/diplomacy/military/npc)。實作=Claude Code(單一 writer,未再轉派),審查待 Codex(照 AGENTS.md R1-R6)。
