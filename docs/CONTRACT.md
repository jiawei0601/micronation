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
// Policies = { tax: TaxTier; economy: EconomyTier; conscription: ConscriptionTier; openness: OpennessTier }
//   ——每軸只接受自己的檔位聯集,取代裸 Record<PolicyAxis, string>(2026-08-26 修訂,finding #6)。

interface Nation {
  id: Id; ownerId: Id | null;        // null = NPC
  name: string; flag: FlagSpec; regionId: Id;
  resources: Resources; tech: number; actionPoints: number;
  population: number; morale: number;          // morale 0-100
  buildings: Record<BuildingKind, number>;     // 等級,0=未建
  buildQueue: { building: BuildingKind; completesAt: Tick }[];
  army: { size: number };
  policies: Policies;
  policyChangedAt: Partial<Record<PolicyAxis, Tick>>;
  reputation: { breaches: number };
  protectedUntil: Tick;              // 新手保護
  score: ScoreBreakdown;
  createdAt: Tick;
  lastAttackedAt?: Tick;             // 最近一次以本國為 defender 的戰鬥解算 tick,engine 於 resolveBattle 後寫入(finding #25)
}
interface ScoreBreakdown { economy: number; warfare: number; tech: number; diplomacy: number; total: number; }
interface FlagSpec { layout: string; colors: string[]; emblem: string; }
interface Region { id: Id; name: string; bonuses: Partial<Record<ResourceKind, number>>; } // ±百分比
// PublicRegion/PublicTreaty(三審 finding #6):PublicWorldView 內的巢狀可變欄位(Region.bonuses、
// Treaty.terms)須額外標記深層 readonly——`Readonly<Region>`/`Readonly<Treaty>` 只讓頂層唯讀,
// bonuses/terms 本身仍是可變物件、擋不住 view.regions[0].bonuses.food = 999 這類改動。
// type PublicRegion = Readonly<Omit<Region,'bonuses'>> & { readonly bonuses: Readonly<Partial<Record<ResourceKind,number>>> };
// type PublicTreaty = Readonly<Omit<Treaty,'terms'>> & { readonly terms: Readonly<TreatyTerms> };
interface WorldState {
  seasonId: Id; tick: Tick;
  regions: Region[]; nations: Nation[];
  marches: March[]; treaties: Treaty[]; orders: MarketOrder[];
  // 呼叫端維護的單調遞增行軍序號,供 military.declareAttack 組 March id(第二輪 finding #4/#8)。
  // 不可用 marches.filter(...).length 之類「現存筆數」推算——行軍抵達/撤回後筆數會下降,
  // 重新出征時可能拿到用過的序號而撞號(含已從 marches 移除但仍存在 D1/事件紀錄裡的歷史 id)。
  nextMarchSeq: number;
}
interface GameEvent { tick: Tick; type: EventType; nationIds: Id[]; payload: unknown; } // EventType = shared/events.ts 常數表的聯集(finding #9)

// PublicWorldView — npc 與 web 用的受限視角(finding #7)。nations 換成 PublicNation[],
// 只暴露 id/ownerId/name/flag/regionId/score/reputation/armySizeTier(概略級距,非精確兵力)/
// protectedUntil/policies(依 PRD 政策本就公開)。不含 resources/actionPoints/buildQueue/lastAttackedAt。
// 由純函式 `toPublicWorldView(state: WorldState, viewerId: Id | null): PublicWorldView`(shared/src/view.ts)產生。
interface PublicNation {
  id: Id; ownerId: Id | null; name: string; flag: FlagSpec; regionId: Id;
  score: ScoreBreakdown; reputation: { breaches: number };
  armySizeTier: 'none' | 'small' | 'medium' | 'large' | 'huge';
  protectedUntil: Tick; policies: Policies;
}
// PublicMarch — March 的受限投影(第二輪 finding #15)。只有出征雙方(viewer 為 attackerId
// 或 defenderId)才拿得到精確 size,其餘 viewer(含 null/匿名)只拿到概略級距 sizeTier,
// 不洩漏他國精確兵力(呼應 PublicNation.armySizeTier 的同一原則)。
// PublicMarch 用 union 強制 size/sizeTier 互斥(三審 finding #2/#5)——舊版兩者皆 optional,
// 型別上允許「兩者同時有值」或「兩者都缺」這種語意錯誤狀態,編譯器攔不住。
type PublicMarch = { id: Id; attackerId: Id; defenderId: Id; departedAt: Tick; arrivesAt: Tick } &
  ( { size: number; sizeTier?: never }        // 僅 viewer 為 attacker/defender 時提供
  | { size?: never; sizeTier: ArmySizeTier } ); // viewer 非當事方時提供,取代精確 size
interface PublicWorldView {
  seasonId: Id; tick: Tick; regions: PublicRegion[]; nations: PublicNation[];
  marches: PublicMarch[]; treaties: PublicTreaty[]; orders: MarketOrder[];
}
```
- `toPublicWorldView` 的每一層輸出皆為深拷貝(flag/colors/score/reputation/policies/region
  bonuses/marches/treaty terms/orders),不與輸入 `WorldState` 共享任何可變參照——呼叫端拿到
  view 後改動它,不可能反過來污染純函式輸入(第二輪 finding #14)。`PublicNation`/`PublicWorldView`
  巢狀欄位型別上標記 `readonly`。
- `armySizeTier(size)` 對非負安全整數以外的輸入(NaN/Infinity/負數/小數/超出安全整數範圍)一律
  回傳 `'none'`,不落入任何比較分支意外算出語意錯誤的級距(第二輪 finding #16)。

## engine(packages/engine)——唯一入口

```ts
resolveTick(state: WorldState, seed: string): { state: WorldState; events: GameEvent[] }
```
- 職責順序:資源產出(區域加成×政策×建築)→ 人口/士氣 → 建設佇列完成 → 行軍推進與抵達戰鬥解算 → 條約到期 → 行動點發放 → 計分。
- **`resolveTick` 回傳的 `state.tick` = 輸入 `state.tick + 1`**(2026-08-26 修訂,finding #1——舊版未推進 tick,會讓所有「到期」判定失準)。
- 純函式:同 (state, seed) 必得同輸出;隨機一律走 seeded PRNG(shared 提供 `createRng(seed)`)。
- 另輸出輔助純函式供前端預覽:`projectProduction(nation, region)`, `previewBattle(attacker, defender, seed?)`。`previewBattle` 用 `seed !== undefined` 判斷有無 seed(finding #5——原本的 truthiness 判斷會把空字串 seed 誤當「無 seed」)。
- **平衡常數集中在 `packages/shared/src/constants.ts` 單檔**,不得散落。
- 戰鬥:`power = army.size × techMod × moraleMod × (0.9~1.1 rng)`;敗方損失=未保護資源(倉庫保護額度外)的 20-30%;攻方兵損與燃料成本必計;不可滅國。
  - 戰功(warfare score)計算一律用 `resolveBattle` 實際算出的 power(含 tech/morale/rng 修正),不是原始 `army.size`(finding #2)。計分時直接傳 `result.attackerPower`/`defenderPower` 原始值,**不可**用 `|| 1` 之類的 fallback 頂替(那會把 0 或極小 power 硬拉成 1、扭曲比例計算)——`warfareGainForBattle` 已對 `ownPower<=0` 做防禦性處理(第二輪 finding #1)。
  - 燃料成本事件(`BATTLE_RESOLVED` payload 的 `fuelCost`)回報的是**實際扣除量**(燃料不足時會被 clamp 到剩餘量),不是名目應扣量(finding #3)。
  - `MORALE_CHANGE` 事件 payload 的 `delta` 回報 clamp 後的實際差值(0-100 邊界會截斷),不是常數本身(finding #4)。
  - 條約到期(步驟 5)以 `terms.activatedAt` 判定(不是 `createdAt`);若 `status==='active'` 但缺 `activatedAt`(不變量被破壞,見 diplomacy 段落),`resolveTick` 安全跳過該筆(無 Result 通道可回錯,採防禦性略過而非崩潰整個 tick)。
  - 戰鬥解算後,defender 的 `lastAttackedAt` 寫入本 tick(finding #25,供 npc 判斷是否需練兵)。

## market(packages/market)

```ts
placeOrder(book: MarketOrder[], o: NewOrder, ref: PriceRef, ctx: NationCtx, tariffRate: number, seq: number): Result<{book, trades, unbanded: boolean}>
cancelOrder(book, orderId, nationId): Result<{book}>
// MarketOrder: { id, nationId, kind: ResourceKind, side: 'buy'|'sell', qty, price, createdAt }
// PriceRef: 近期成交均價表;偏離 ±30% → Err('PRICE_BAND')。avgPrice 缺值/非有限(NaN/Infinity)/<=0
//   時視為無有效參考價,跳過價格帶檢查,回傳 unbanded:true(finding #13)。
// NationCtx: { verified: boolean; protectedUntil; tick } — 未驗證/保護期大額 → Err
// tariffRate: 跨區關稅率(呼叫端算好傳入,同區/免稅傳 0);須為有限數且落在 [0,1),否則 Err('INVALID_TARIFF')
//   (finding #12)。Trade.tariff = round(成交量 × 成交價 × tariffRate)
// seq: 呼叫端提供的單調遞增序號(例如 D1 autoincrement),用於組 order id,避免用 book.length
//   當序號在撤單/成交後被重複使用而撞號(finding #10)。非安全整數或負數 → Err('INVALID_ORDER')。
// 撮合:價格優先→時間優先;部分成交允許;禁止自我對敲——resting order 的 nationId 與 taker 相同時
//   直接跳過該筆(不成交,兩邊都留在 book),不是 Err(finding #11)。
// isPositiveInteger 用 Number.isSafeInteger(不是 Number.isInteger)(finding #12)。
// id 一律走 shared.makeId(prefix, ...parts) 純字串組合,不可用 Date.now/crypto
// 撮合候選(isMatch)須同時驗證 resting order 的 qty/price 為正安全整數、side 須 ∈ {'buy','sell'},
// book 中若混入損壞資料(含 side 非法值)直接視為不可撮合對象跳過,不炸整個請求
// (第二輪 finding #6,side 檢查為三審 finding #3——非法 side 可能被 !== o.side 誤判為對邊)。
// 成交前計算 notional = fillQty × tradePrice 與 tariff = round(notional × tariffRate),
// 任一非 Number.isSafeInteger(即使 qty/price 個別皆安全整數、僅乘積溢位)一律 Err('UNSAFE_NOTIONAL')
// (第二輪 finding #6/#9)。
```
`Result<T> = { ok: true; value: T } | { ok: false; error: string }`(shared 定義,全模塊共用,不丟例外)。

## diplomacy(packages/diplomacy)

```ts
propose/respond/breach/expire → 純狀態轉移函式,輸入 Treaty[]+動作,輸出 Result<{treaties, events}>
// Treaty: { id, kind: 'nap'|'alliance'|'trade', aId, bId, status: 'proposed'|'countered'|'active'|'expired'|'breached'|'rejected', terms: TreatyTerms, createdAt }
// TreatyTerms(shared/types.ts 正本): { duration, compensation?; allianceDefense?(kind==='alliance' 協防旗標);
//   tariffDiscount?(kind==='trade' 關稅減免率 0~1); pendingResponderId?(propose/counter 後下一次 respond 應由誰發起);
//   activatedAt?(進入 active 的 tick,expire 以此+duration 判定到期) }
// 不變量(finding #8):status==='active' 的 Treaty 必有 terms.activatedAt——respond(action='accept') 必寫入
//   (tick 參數)。expire() 若發現 active 卻缺 activatedAt(資料損壞),整批回 Err('CORRUPTED_TREATY'),
//   不用 createdAt 當 fallback(那會讓到期時間算錯,見 finding #16)。engine.resolveTick 內建的條約到期邏輯
//   面對同樣的損壞資料時採防禦性跳過(見 engine 段落),因為它沒有 Result 通道可回錯。
// propose/respond(counter) 驗證 terms:duration 必為正安全整數;compensation(若提供)須 >=0;
//   tariffDiscount(若提供)須落在 [0,1];不合法 → Err('INVALID_TERMS')(finding #15)。
// propose 額外驗證:id 不可與既有 treaty 重複(Err('DUPLICATE_ID'));同 kind+同 pair 的重複檢查涵蓋
//   'active'|'proposed'|'countered' 三種狀態(原本漏了 'countered')(finding #14)。
// respond 的 action 須為 'accept'|'reject'|'counter' 白名單,其餘 → Err('INVALID_ACTION')(finding #17)。
// 內部 validateTerms(kind, terms, requireDuration) 統一驗證(第二輪 finding #2/#5):
//   - duration:requireDuration 為 true 或有提供時,必為正安全整數(NaN/Infinity/0/負/小數/缺值皆非法)。
//   - compensation(若提供):須為有限數且 >=0。
//   - allianceDefense(若提供):kind 必為 'alliance' 且型別 boolean,否則視為不相容欄位、判定非法。
//   - tariffDiscount(若提供):kind 必為 'trade' 且落在 [0,1] 的有限數,否則不相容欄位、判定非法。
//   respond(action='counter') 驗證的是「既有 terms 與 counterTerms 合併後」的結果(`{...terms, ...counterTerms}`),
//   不是只驗 counterTerms 本身——否則「counter 把 duration 蓋成 undefined」這類案例會漏檢。
// propose/respond/breach/expire 的 tick 參數須為非負安全整數,否則 Err('INVALID_TICK')(第二輪 finding #3)。
// expire() 對每筆 active 條約額外要求 activatedAt 為非負安全整數、duration 為正安全整數(duration===0
//   視為資料損壞,而非「立即到期」——propose/respond 的 validateTerms 本就要求 duration>0,三審 finding #1)、
//   且兩者相加不溢位安全整數範圍,否則同樣回 Err('CORRUPTED_TREATY')(第二輪 finding #3,擴充原本只查
//   「缺值」的檢查)。
canAttack(treaties, attackerId, defenderId): { allowed: boolean; reason?: 'NAP'|'ALLIANCE' }
breachPenalty(treaty): { compensation: number; reputationDelta: number }
```

## military(packages/military)

```ts
declareAttack(state-view, attackerId, defenderId, army, tick): Result<{ march: March; nextMarchSeq: number }>
// 檢查順序:stateView.tick 須為非負安全整數,否則 Err('INVALID_TICK')(第二輪 finding #7)
//   → tick 必須等於 stateView.tick,否則 Err('TICK_MISMATCH')——簽名保留 tick 參數,
//   但只信任 stateView.tick,不信任外部傳入值(finding #19)。
//   → 保護期 → army 合法性(見下)→ 打農(國力比 < FARM_RATIO 無收益→Err 'FARMING')
//   → NAP(呼叫 diplomacy.canAttack)→ 行動點(ATTACK_ACTION_POINT_COST,shared/constants)
//   → region 存在性(見下)。
// army 檢查:Number.isSafeInteger(army) 且 >0;可用兵力 = attacker.army.size 減去該國所有
//   arrivesAt > tick 的在途行軍 size 總和,army 超出可用兵力 → Err('INSUFFICIENT_ARMY')(finding #18)。
// region 檢查:attacker/defender 的 regionId 在 stateView.regions 找不到 index → Err('REGION_NOT_FOUND'),
//   不可用 -1 index 硬算距離(finding #20)。
// arrivesAt = tick + marchTime(regionDistance) 算出後須為非負安全整數,否則 Err('INVALID_ARRIVAL')
//   (第二輪 finding #7)。
// March: { id, attackerId, defenderId, size, departedAt, arrivesAt }
//   id 用 shared.makeId('march', attackerId, defenderId, tick, seq) 組成——seq 一律吃
//   stateView.nextMarchSeq(呼叫端維護的單調遞增計數器,須為非負安全整數,否則 Err('INVALID_MARCH_SEQ')),
//   **不可**用 marches.filter(...).length 之類「現存筆數」推算(行軍抵達/撤回後筆數會下降,
//   重新出征可能拿到用過的序號、和歷史 march id 撞號)(第二輪 finding #4/#8,取代原 finding #21 的做法)。
//   declareAttack 回傳 { march, nextMarchSeq: seq + 1 },呼叫端(api 層)須把 nextMarchSeq 存回
//   WorldState.nextMarchSeq,下次呼叫時帶入。seq+1 本身也須驗證是安全整數(三審 finding #4)——
//   nextMarchSeq === Number.MAX_SAFE_INTEGER 時 seq+1 會溢位成不精確值,直接 Err('INVALID_MARCH_SEQ')。
regionDistance(a: Region 索引, b): number   // 距離表在 shared/constants
```
抵達後的戰鬥由 engine 在 resolveTick 內解算——military 只管合法性與排程。

## npc(packages/npc)

```ts
decideActions(nation: Nation, view: PublicWorldView, seed: string): NpcAction[]
generateNpcNations(count: number, regions: Region[], seed: string): Result<Nation[]>
// NpcAction 是與玩家 API 同語意的指令聯集:{type:'build'|'placeOrder'|'train'|...}
// 規則狀態機:糧食缺→買/蓋農場;盈餘→掛賣單;被打過→練兵;不主動攻擊玩家。
// 「被打過」訊號改用 nation.lastAttackedAt(近 WAS_ATTACKED_RECENT_TICKS=48 tick 內),不是
//   view.marches(行軍抵達即從 WorldState.marches 移除,讀不到「剛被打完」的情況)(finding #25)。
// decideActions 內部維護影子資源/佇列狀態(逐規則模擬扣減),確保同一批回傳的 NpcAction[]
//   合計起來整體可行、不會超支(例如①規則買糧花掉的錢,③規則不會誤判還付得起練兵)(finding #24,
//   第二輪 finding #13 補上①③money 的 cross-rule regression test——原①④組合已被下方互斥規則取代)。
// 規則④「否則」為嚴格互斥,只在 actions.length===0(規則①②③本 tick 都沒有產生任何動作)時才執行,
//   不是「還有動作額度就順便塞一個」(第二輪 finding #10)。
// wasAttacked(nation, view) 用 elapsed = view.tick - nation.lastAttackedAt;elapsed 須為非負安全整數
//   且 <= WAS_ATTACKED_RECENT_TICKS 才算「近期被攻擊過」——lastAttackedAt 若因資料損壞指向未來
//   (> view.tick),elapsed 會是負值,沒有 >=0 守衛的話「負值 <= 窗口」恆真、被誤判為近期被攻擊
//   (第二輪 finding #11)。
// generateNpcNations 驗證 count(Number.isSafeInteger、0<=count<=NPC_MAX_GENERATE_COUNT)與
//   regions 非空,不合法回 Err('INVALID_COUNT' | 'NO_REGIONS')(finding #22, #23;簽名由 Nation[] 改為 Result<Nation[]>)。
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
