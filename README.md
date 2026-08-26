# 微國家 (Micronation)

網頁版多人國家模擬經營遊戲。賽季制(8 週)× 每小時 tick × 抽象區域;資源管理、市場貿易、外交條約、戰爭、政策與排行榜。繁中介面,零美術資產(全 SVG/CSS)。

**正式站**:https://micronation-api.micronation.workers.dev

- 設計決策:`docs/DECISIONS-grill-2026-08-26.md`|模塊契約:`docs/CONTRACT.md`|PRD:issue #1|現況交接:`HANDOFF.md`

## 架構

```
apps/web   React+Vite+Tailwind SPA(C 地圖主殼+B 面板+A 公文條約頁)
apps/api   Hono on Cloudflare Workers:/api/* 路由+每小時 Cron tick+靜態資產(同源服務 web 的 dist)
packages/  純邏輯零 IO:shared(型別/常數/RNG)、engine(tick 結算)、market、diplomacy、military、npc
資料庫      Cloudflare D1(SQLite),migration 在 apps/api/migrations/
```

單一 Worker 同源服務前端與 API(免跨域 cookie 問題)。月費 $0(全 Cloudflare 免費層)。

## 本地開發

```bash
npm install
npm test                      # 全 workspace vitest(484 tests)
npx tsc -b                    # 型別檢查
npm run dev -w @micronation/web   # 前端 dev server(http://localhost:5173)
```

前端 mock 模式:設 `VITE_USE_MOCK=1` 可不接後端跑完整 UI(內建假世界);未設定=打真 API。

## 部署需求

| 項目 | 說明 |
|---|---|
| Cloudflare 帳號 | 免費層即可;需已註冊 workers.dev 子網域(本專案=`micronation`) |
| wrangler | repo devDependency,`npx wrangler` 即用;首次 `npx wrangler login` OAuth 授權 |
| D1 資料庫 | `micronation-db`,id 寫在 `apps/api/wrangler.toml`(換帳號重建:`wrangler d1 create micronation-db` 後回填 id) |
| Secret:`ADMIN_TOKEN` | 開季/管理端點的 Bearer token。本機備份在 `~/.micronation-admin-token`(不入 repo) |
| Secret:`RESEND_API_KEY` | (尚未設定)正式寄驗證信用;沒有它時 `ENVIRONMENT` 不可設 production(mail fail-closed 會 500) |
| Var:`ENVIRONMENT` | wrangler.toml `[vars]`。目前=`development`(驗證信只進 log→玩家無法完成 email 驗證/解鎖貿易);轉正式=申請 Resend→設 secret→改 `production` |

⚠️ 平台限制:PBKDF2 迭代上限 100k(Cloudflare Workers WebCrypto 硬限制,`apps/api/src/auth/password.ts` 有註記,勿調高)。

## 部署操作

```bash
# 0. 首次:登入+建庫(已完成,換帳號才需要)
npx wrangler login
npx wrangler --cwd apps/api d1 create micronation-db     # 回填 id 到 wrangler.toml
echo "<隨機token>" | npx wrangler --cwd apps/api secret put ADMIN_TOKEN

# 1. 套 migration(首次或 schema 變更後)
npx wrangler --cwd apps/api d1 migrations apply micronation-db --remote

# 2. 建前端+部署(日常更新就這兩行)
npm run build -w @micronation/web
npx wrangler --cwd apps/api deploy
```

### 開新賽季

```bash
curl -X POST https://micronation-api.micronation.workers.dev/api/admin/season \
  -H "Authorization: Bearer $(cat ~/.micronation-admin-token)" \
  -H "Content-Type: application/json" -d '{"name":"S2"}'
```

已有 active 賽季會回 409;賽季到期(1344 tick=8 週)由 cron 自動結算名人堂後才可開新季。開季自動生成 5 大區+NPC 國家。

### 維運

```bash
npx wrangler --cwd apps/api tail --format pretty      # 即時 log(development 模式驗證 token 也在這)
npx wrangler --cwd apps/api d1 execute micronation-db --remote --command "SELECT tick,status FROM seasons"
```

- tick 每小時整點由 Cron Trigger 觸發;`tick_running` 租期鎖 10 分鐘 stale 可搶,異常卡死等下一輪即自癒。
- migration 檔為 pre-deployment squash(單一 `0001_init.sql`);**已上線後不可再改此檔**,schema 變更一律開新編號 migration。

## 品質紀錄

實作=Claude Code(多 subagent),審查=Codex 跨廠商獨立審(規則見 `AGENTS.md`)。M0-M5 四輪、M6-M9 七輪審查收斂至 approve,共修 161 條 findings;484 tests 綠。
