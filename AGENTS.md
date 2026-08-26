# AGENTS.md — 專案統一規則（所有 AI agent 共用）

> Claude Code 透過 CLAUDE.md（內含 @AGENTS.md）讀本檔；Codex 等其他 agent 原生讀本檔。
> 一份規則，所有 agent 共用，不分叉。

## 專案慣例（待填）
- 語言 / 框架：
- 風格 / 命名：
- 測試怎麼跑：
- build / run：

## 跨 agent 交接紀律
- repo 是唯一真相來源；交接資訊一律寫進 repo，不可只留私有記憶（如 Claude memory）。
- 交出前：測試綠 → commit 乾淨（絕不交髒工作區）→ 更新 HANDOFF.md → 更新 issue。
- 接手前：clean tree + pull → 讀 HANDOFF.md / issue / git log / 本檔 → 先複述現況與下一步再動手。
- 架構決策寫 docs/adr/；任務狀態走 issues。

## 跨 agent review（實作者不自審）
- 實作與審查分屬不同廠商：Claude Code 實作 → **Codex 審**；Codex 實作 → Claude Code 審。
- 審查方以乾淨 session 啟動，輸入只有 `git diff` + HANDOFF.md + 完成條件，**不聽實作方口頭簡報**。
- 審查輸出三選一：`通過` / `退回（附具體失效案例）` / `無法判定（附缺什麼資訊）`。
- 退回後修改必須重審（針對當前 HEAD）。
- 適用門檻與完整規則見 `C:\CLAUDE\ops\10-model-dispatch.md` §8。
