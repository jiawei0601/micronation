# Interface Contract(v1 — 2026-08-26)

所有模塊實作前必讀。**共用型別的正本在 `packages/shared/src/types.ts` 與 `constants.ts`**,本檔是其設計依據;兩者不一致時以本檔為準並回報。純邏輯模塊(engine/market/diplomacy/military/npc)**禁止任何 IO**(無 fetch/DB/Date.now,時間一律吃參數)。

## 共用基礎型別(packages/shared)

```ts
type Id = string;                    // ulid
type Tick = number;                  // 賽季內第 N tick,從 0 起
type ResourceKind = 'food' | 'ore' | 'fuel' | 'money';
type Resources = Record<ResourceKind, number>;      // 整數
type BuildingKind = 'farm' | 'mine' | 'refinery' | 'market'
  | 'barracks' | 'warehouse' | 'university' | 'wall';
type PolicyAxis = 'tax' | 'economy' | 'conscription' | 'openness';
// 各軸檔位(constants.ts 定義每檔修正值):
// tax: low|mid|high; economy: agri|industry|commerce;
// conscription: volunteer|draft; openness: closed|neutral|free

interface Nation {
  id: Id; ownerId: Id | null;        // null = NPC
  name: string; flag: FlagSpec; regionId: Id;
  resources: Resources; tech: number; actionPoints: number;
  population: number; morale: number;          // morale 0-100
  buildings: Record<BuildingKind, number>;     // 等級,0=未建
  buildQueue: { building: BuildingKind; completesAt: Tick }[];
  army: { size: number };
  policies: Record<PolicyAxis, string>;
  policyChangedAt: Partial<Record<PolicyAxis, Tick>>;
  reputation: { breaches: number };
  protectedUntil: Tick;              // 新手保護
  score: ScoreBreakdown;
  createdAt: Tick;
}
interface ScoreBreakdown { economy: number; warfare: number; tech: number; diplomacy: number; total: number; }
interface FlagSpec { layout: string; colors: string[]; emblem: string; }
interface Region { id: Id; name: string; bonuses: Partial<Record<ResourceKind, number>>; } // ±百分比
interface WorldState {
  seasonId: Id; tick: Tick;
  regions: Region[]; nations: Nation[];
  marches: March[]; treaties: Treaty[]; orders: MarketOrder[];
}
interface GameEvent { tick: Tick; type: string; nationIds: Id[]; payload: unknown; } // type 常數表在 shared/events.ts
```

## engine(packages/engine)——唯一入口

```ts
resolveTick(state: WorldState, seed: string): { state: WorldState; events: GameEvent[] }
```
- 職責順序:資源產出(區域加成×政策×建築)→ 人口/士氣 → 建設佇列完成 → 行軍推進與抵達戰鬥解算 → 條約到期 → 行動點發放 → 計分。
- 純函式:同 (state, seed) 必得同輸出;隨機一律走 seeded PRNG(shared 提供 `createRng(seed)`)。
- 另輸出輔助純函式供前端預覽:`projectProduction(nation, region)`, `previewBattle(attacker, defender, seed?)`。
- **平衡常數集中在 `packages/shared/src/constants.ts` 單檔**,不得散落。
- 戰鬥:`power = army.size × techMod × moraleMod × (0.9~1.1 rng)`;敗方損失=未保護資源(倉庫保護額度外)的 20-30%;攻方兵損與燃料成本必計;不可滅國。

## market(packages/market)

```ts
placeOrder(book: MarketOrder[], o: NewOrder, ref: PriceRef, ctx: NationCtx, tariffRate: number): Result<{book, trades}>
cancelOrder(book, orderId, nationId): Result<{book}>
// MarketOrder: { id, nationId, kind: ResourceKind, side: 'buy'|'sell', qty, price, createdAt }
// PriceRef: 近期成交均價表;偏離 ±30% → Err('PRICE_BAND')
// NationCtx: { verified: boolean; protectedUntil; tick } — 未驗證/保護期大額 → Err
// tariffRate: 跨區關稅率(呼叫端算好傳入,同區/免稅傳 0);Trade.tariff = round(成交量 × 成交價 × tariffRate)
// 撮合:價格優先→時間優先;部分成交允許
// id 一律走 shared.makeId(prefix, ...parts) 純字串組合,不可用 Date.now/crypto
```
`Result<T> = { ok: true; value: T } | { ok: false; error: string }`(shared 定義,全模塊共用,不丟例外)。

## diplomacy(packages/diplomacy)

```ts
propose/respond/breach/expire → 純狀態轉移函式,輸入 Treaty[]+動作,輸出 Result<{treaties, events}>
// Treaty: { id, kind: 'nap'|'alliance'|'trade', aId, bId, status: 'proposed'|'countered'|'active'|'expired'|'breached'|'rejected', terms: TreatyTerms, createdAt }
// TreatyTerms(shared/types.ts 正本): { duration, compensation?; allianceDefense?(kind==='alliance' 協防旗標);
//   tariffDiscount?(kind==='trade' 關稅減免率 0~1); pendingResponderId?(propose/counter 後下一次 respond 應由誰發起);
//   activatedAt?(進入 active 的 tick,expire 以此+duration 判定到期) }
canAttack(treaties, attackerId, defenderId): { allowed: boolean; reason?: 'NAP'|'ALLIANCE' }
breachPenalty(treaty): { compensation: number; reputationDelta: number }
```

## military(packages/military)

```ts
declareAttack(state-view, attackerId, defenderId, army, tick): Result<March>
// 檢查:保護期、打農(國力比 < FARM_RATIO 無收益→Err 'FARMING')、NAP(呼叫 diplomacy.canAttack)、行動點(ATTACK_ACTION_POINT_COST,shared/constants)
// March: { id, attackerId, defenderId, size, departedAt, arrivesAt } — arrivesAt = tick + marchTime(regionDistance)
regionDistance(a: Region 索引, b): number   // 距離表在 shared/constants
```
抵達後的戰鬥由 engine 在 resolveTick 內解算——military 只管合法性與排程。

## npc(packages/npc)

```ts
decideActions(nation: Nation, view: PublicWorldView, seed: string): NpcAction[]
// NpcAction 是與玩家 API 同語意的指令聯集:{type:'build'|'placeOrder'|'train'|...}
// 規則狀態機:糧食缺→買/蓋農場;盈餘→掛賣單;被打過→練兵;不主動攻擊玩家。
// 倉容公式 warehouseCapacity(level)、練兵成本 TRAIN_COST_PER_UNIT、佇列容量 BUILD_QUEUE_CAPACITY、
// NPC 初始值 NPC_INITIAL_*——皆定義於 shared/constants.ts,npc 讀取同一份,不得自建假設值。
```

## db / auth / api / tick-cron(apps/api)

- D1 schema:`seasons, regions, nations, users, sessions, market_orders, trades, treaties, marches, events, tasks(教學進度), hall_of_fame`。migration 檔置 `apps/api/migrations/`,只用標準 SQL。
- auth:email+密碼(PBKDF2, WebCrypto)、session cookie(HttpOnly)、驗證信 token。`users.verified` 供 market ctx。
- api(Hono):`/api/auth/*`, `/api/nation`(GET 自己+GET /:id 公開視圖), `/api/world`(地圖輪詢,含 tick 倒數+events since), `/api/build`, `/api/policy`, `/api/market/*`, `/api/military/*`, `/api/diplomacy/*`, `/api/messages/*`, `/api/rankings`, `/api/tasks`。薄殼:驗 session→組 ctx→呼叫純模塊→寫 DB。錯誤格式統一 `{ error: string }` + 4xx。
- tick-cron:Cron Trigger(`0 * * * *`)→ 讀全世界→ `resolveTick` → 單一 D1 batch 交易寫回+events。NPC 決策在 tick 內執行(`npc.decideActions` → 同玩家路徑)。

## web(apps/web)

- 路由:`/`(C 地圖主殼)、`/nation`(B 總覽)、`/build /policy /market /military /diplomacy /rankings /tasks`(B 面板)、`/treaty/:id`(A 公文風簽署)。
- 輪詢:`/api/world` 每 45s;字串集中 `src/i18n/zh-Hant.ts`。
- 旗幟:`<Flag spec={FlagSpec}/>` 純 SVG;產生器輸出 FlagSpec。

## 依賴方向(單向,禁反向)

shared ← engine/market/diplomacy/military/npc ← api/tick-cron;web 只依賴 shared(型別+預覽公式)與 HTTP API。

## Monorepo

npm workspaces:`packages/{shared,engine,market,diplomacy,military,npc}` + `apps/{api,web}`。測試 vitest,root `npm test` 全跑。TypeScript strict。
