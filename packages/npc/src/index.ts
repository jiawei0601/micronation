import type {
  Nation,
  PublicWorldView,
  NpcAction,
  Region,
  ResourceKind,
  BuildingKind,
  FlagSpec,
  Rng,
  Resources,
  Result,
} from '@micronation/shared';
import {
  ok,
  err,
  createRng,
  BUILDING_LEVELS,
  MAX_BUILDING_LEVEL,
  FOOD_PER_POP,
  warehouseCapacity as sharedWarehouseCapacity,
  TRAIN_COST_PER_UNIT,
  BUILD_QUEUE_CAPACITY,
  NPC_INITIAL_RESOURCES,
  NPC_INITIAL_BUILDINGS,
  NPC_INITIAL_ACTION_POINTS,
  NPC_INITIAL_POPULATION,
  NPC_INITIAL_MORALE,
  NPC_INITIAL_ARMY_SIZE,
  NPC_INITIAL_POLICIES,
  NPC_MAX_GENERATE_COUNT,
} from '@micronation/shared';

// 實作依 CONTRACT.md §npc——純函式零 IO,規則優先序:
//   ①糧食將短缺→買/蓋農場 ②資源盈餘→掛賣單 ③被攻擊過→練兵 ④否則→依短板升級對應建築
//
// 糧耗率/倉容公式/練兵成本/佇列容量/NPC 初始值一律讀 shared/constants.ts 正本,不再本地假設。

// ---- NPC 本地啟發式常數(純決策節奏,非遊戲平衡常數,僅供本模塊使用) ----
const FOOD_SHORTAGE_TICKS = 24; // 存量低於此 tick 數的消耗量 → 視為將短缺
const SURPLUS_RATIO = 0.85; // 存量超過倉容此比例 → 視為盈餘
const ARMY_POPULATION_RATIO_CAP = 0.3; // 練兵至人口此比例為上限
const MAX_TRAIN_PER_TICK = 50; // 單次最多練兵數
const MAX_ACTIONS_PER_TICK = 3; // 每 tick 最多動作數上限
const DEFAULT_ORDER_PRICE: Record<ResourceKind, number> = {
  food: 10,
  ore: 12,
  fuel: 15,
  money: 1,
};
const SELL_QTY_RATIO = 0.3; // 盈餘量的此比例掛賣單
const BUY_QTY = 30; // 糧食短缺時的固定掛買量
const RESOURCE_BUILDING: Partial<Record<ResourceKind, BuildingKind>> = {
  food: 'farm',
  ore: 'mine',
  fuel: 'refinery',
};
const WAS_ATTACKED_RECENT_TICKS = 48; // lastAttackedAt 在此 tick 數內視為「近期被攻擊過」

function warehouseCapacity(nation: Nation): number {
  return sharedWarehouseCapacity(nation.buildings.warehouse ?? 0);
}

function canAffordTraining(resources: Resources, size: number): boolean {
  return Object.entries(TRAIN_COST_PER_UNIT).every(
    ([k, perUnit]) => resources[k as ResourceKind] >= (perUnit as number) * size
  );
}

function deductTrainingCost(resources: Resources, size: number): Resources {
  const next = { ...resources };
  for (const [k, perUnit] of Object.entries(TRAIN_COST_PER_UNIT)) {
    next[k as ResourceKind] -= (perUnit as number) * size;
  }
  return next;
}

function avgOrderPrice(view: PublicWorldView, kind: ResourceKind, side: 'buy' | 'sell'): number {
  const matching = view.orders.filter((o) => o.kind === kind && o.side === side);
  if (matching.length === 0) return DEFAULT_ORDER_PRICE[kind];
  const sum = matching.reduce((acc, o) => acc + o.price, 0);
  return Math.round(sum / matching.length);
}

function canAffordNextLevel(nation: Nation, resources: Resources, building: BuildingKind): boolean {
  const level = nation.buildings[building] ?? 0;
  if (level >= MAX_BUILDING_LEVEL) return false;
  const spec = BUILDING_LEVELS[building][level];
  return Object.entries(spec.cost).every(([k, v]) => resources[k as ResourceKind] >= (v as number));
}

function deductBuildCost(resources: Resources, nation: Nation, building: BuildingKind): Resources {
  const level = nation.buildings[building] ?? 0;
  const spec = BUILDING_LEVELS[building][level];
  const next = { ...resources };
  for (const [k, v] of Object.entries(spec.cost)) {
    next[k as ResourceKind] -= v as number;
  }
  return next;
}

function queueHasRoom(queueLen: number): boolean {
  return queueLen < BUILD_QUEUE_CAPACITY;
}

function wasAttacked(nation: Nation, view: PublicWorldView): boolean {
  // 以 nation.lastAttackedAt(engine 於戰鬥解算時寫入)判斷是否「近期」被攻擊過。
  // 不再只看 view.marches:行軍一旦抵達就會從 WorldState.marches 移除,只看在途行軍
  // 會漏掉「剛被打完、行軍已消失」的情況,導致該練兵時沒練兵。
  if (nation.lastAttackedAt === undefined) return false;
  const elapsed = view.tick - nation.lastAttackedAt;
  // lastAttackedAt 若是損壞資料指向未來(> view.tick),elapsed 會是負值——沒有守衛的話
  // 「負值 <= 48」恆真,反而被誤判為「近期被攻擊過」。elapsed 須是非負安全整數且落在窗口內
  // 才算數(finding #11)。
  return Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= WAS_ATTACKED_RECENT_TICKS;
}

/** 依序評估四條規則,回傳本 tick 要執行的 NpcAction 清單(不超過 MAX_ACTIONS_PER_TICK)。 */
export function decideActions(nation: Nation, view: PublicWorldView, seed: string): NpcAction[] {
  const rng = createRng(`${seed}:${nation.id}`);
  const actions: NpcAction[] = [];
  let ap = nation.actionPoints;

  // 影子狀態:規則②③④依序評估時,必須看到規則①②已經「計劃要花掉」的資源/佇列額度,
  // 否則例如規則①花光了 money 買糧,規則④卻還用 nation.resources(未扣除)的舊值判斷付得起升級,
  // 導致回傳的整批動作合計起來會超支——呼叫端依序套用時第二筆以後可能失敗或造成資料不一致。
  let plannedResources: Resources = { ...nation.resources };
  let plannedQueueLen = nation.buildQueue.length;

  const pushIfRoom = (a: NpcAction) => {
    if (actions.length >= MAX_ACTIONS_PER_TICK) return false;
    if (ap < 1) return false;
    actions.push(a);
    ap -= 1;
    return true;
  };

  // ① 糧食將短缺 → 買糧或蓋/升農場
  const consumption = nation.population * FOOD_PER_POP;
  const foodTicksLeft = consumption > 0 ? plannedResources.food / consumption : Infinity;
  if (foodTicksLeft < FOOD_SHORTAGE_TICKS) {
    if (queueHasRoom(plannedQueueLen) && canAffordNextLevel(nation, plannedResources, 'farm')) {
      if (pushIfRoom({ type: 'build', nationId: nation.id, building: 'farm' })) {
        plannedResources = deductBuildCost(plannedResources, nation, 'farm');
        plannedQueueLen += 1;
      }
    } else {
      const price = avgOrderPrice(view, 'food', 'sell');
      const cost = BUY_QTY * price;
      if (plannedResources.money >= cost) {
        if (
          pushIfRoom({
            type: 'placeOrder',
            order: { nationId: nation.id, kind: 'food', side: 'buy', qty: BUY_QTY, price },
          })
        ) {
          plannedResources = { ...plannedResources, money: plannedResources.money - cost };
        }
      }
    }
  }

  // ② 資源盈餘 → 掛賣單(價格貼近近期均價,不觸價格帶——直接沿用觀測到的均價)
  if (actions.length < MAX_ACTIONS_PER_TICK) {
    const capacity = warehouseCapacity(nation);
    const surplusThreshold = capacity * SURPLUS_RATIO;
    const sellable: ResourceKind[] = ['food', 'ore', 'fuel'];
    for (const kind of sellable) {
      if (actions.length >= MAX_ACTIONS_PER_TICK) break;
      const stock = plannedResources[kind];
      if (stock > surplusThreshold) {
        const surplus = stock - surplusThreshold;
        const qty = Math.max(1, Math.floor(surplus * SELL_QTY_RATIO));
        const price = avgOrderPrice(view, kind, 'buy') || avgOrderPrice(view, kind, 'sell');
        if (pushIfRoom({ type: 'placeOrder', order: { nationId: nation.id, kind, side: 'sell', qty, price } })) {
          // 掛賣單視為已承諾出售此量,從影子庫存扣除,避免後續規則重複計入同一批存量。
          plannedResources = { ...plannedResources, [kind]: plannedResources[kind] - qty };
        }
      }
    }
  }

  // ③ 被攻擊過 → 練兵至人口比例上限
  if (actions.length < MAX_ACTIONS_PER_TICK && wasAttacked(nation, view)) {
    const cap = Math.floor(nation.population * ARMY_POPULATION_RATIO_CAP);
    const deficit = cap - nation.army.size;
    if (deficit > 0) {
      const size = Math.min(deficit, MAX_TRAIN_PER_TICK);
      if (canAffordTraining(plannedResources, size)) {
        if (pushIfRoom({ type: 'train', nationId: nation.id, size })) {
          plannedResources = deductTrainingCost(plannedResources, size);
        }
      }
    }
  }

  // ④ 否則 → 依短板升級對應建築(佇列有空位才排)。
  // CONTRACT「否則」語意:只在規則①②③本 tick 都沒有產生任何動作時才執行,不是「還有動作額度就
  // 順便塞一個」——後者會讓④和①②③同時發生,失去「否則」的互斥語意(finding #10)。
  if (actions.length === 0 && queueHasRoom(plannedQueueLen)) {
    const tracked: ResourceKind[] = ['food', 'ore', 'fuel'];
    let weakest: ResourceKind | null = null;
    let weakestStock = Infinity;
    for (const kind of tracked) {
      const stock = plannedResources[kind];
      if (stock < weakestStock) {
        weakestStock = stock;
        weakest = kind;
      }
    }
    if (weakest) {
      const building = RESOURCE_BUILDING[weakest];
      if (building && canAffordNextLevel(nation, plannedResources, building)) {
        if (pushIfRoom({ type: 'build', nationId: nation.id, building })) {
          plannedResources = deductBuildCost(plannedResources, nation, building);
          plannedQueueLen += 1;
        }
      }
    }
  }

  // rng 保留供未來需要決策內隨機打散之用(目前規則為確定性優先序,rng() 呼叫一次以確保
  // seed 有被消費、但不影響輸出,維持「同輸入同 seed 同輸出」)。
  void rng();

  return actions;
}

// ---- generateNpcNations ----

const NAME_PREFIXES = [
  '新', '大', '北', '南', '東', '西', '古', '聖', '自由', '聯合', '共和', '皇家', '青', '金', '銀', '赤',
];
const NAME_ROOTS = [
  '陽', '風', '林', '海', '山', '川', '城', 'island', '谷', '原', '洲', '灣', '嶼', '嶺', '澤', '域',
];
const NAME_SUFFIXES = [
  '國', '邦', '共和國', '聯邦', '公國', '自治區', '王國', '聯盟',
];

const FLAG_LAYOUTS = ['horizontal-tricolor', 'vertical-tricolor', 'cross', 'diagonal', 'circle-emblem'];
const FLAG_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#f1c40f', '#8e44ad', '#2c3e50', '#ecf0f1', '#d35400'];
const FLAG_EMBLEMS = ['star', 'eagle', 'lion', 'wheat', 'anchor', 'mountain', 'sun', 'wave'];

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function emptyResources(): Record<ResourceKind, number> {
  return { ...NPC_INITIAL_RESOURCES };
}

function emptyBuildings(): Record<BuildingKind, number> {
  return { ...NPC_INITIAL_BUILDINGS };
}

function makeFlag(rng: Rng): FlagSpec {
  const colors = [pick(rng, FLAG_COLORS), pick(rng, FLAG_COLORS)];
  return { layout: pick(rng, FLAG_LAYOUTS), colors, emblem: pick(rng, FLAG_EMBLEMS) };
}

function makeName(rng: Rng, used: Set<string>): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const name = `${pick(rng, NAME_PREFIXES)}${pick(rng, NAME_ROOTS)}${pick(rng, NAME_SUFFIXES)}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  // 詞庫組合耗盡(理論上不會發生於合理 count)→ 附加序號保底唯一性
  const fallback = `${pick(rng, NAME_PREFIXES)}${pick(rng, NAME_ROOTS)}${pick(rng, NAME_SUFFIXES)}-${used.size}`;
  used.add(fallback);
  return fallback;
}

/** 開季生成 NPC 國家:名字從內建詞庫組合、FlagSpec 隨機參數、分散各區。純函式、確定性。 */
export function generateNpcNations(count: number, regions: Region[], seed: string): Result<Nation[]> {
  if (!Number.isSafeInteger(count) || count < 0 || count > NPC_MAX_GENERATE_COUNT) {
    return err('INVALID_COUNT');
  }
  if (regions.length === 0) {
    return err('NO_REGIONS');
  }

  const rng = createRng(seed);
  const used = new Set<string>();
  const nations: Nation[] = [];

  for (let i = 0; i < count; i++) {
    const region = regions[i % regions.length];
    const name = makeName(rng, used);
    const idSuffix = Math.floor(rng() * 1e9).toString(36);
    nations.push({
      id: `npc-${idSuffix}-${i}`,
      ownerId: null,
      name,
      flag: makeFlag(rng),
      regionId: region.id,
      resources: emptyResources(),
      tech: 0,
      actionPoints: NPC_INITIAL_ACTION_POINTS,
      population: NPC_INITIAL_POPULATION,
      morale: NPC_INITIAL_MORALE,
      buildings: emptyBuildings(),
      buildQueue: [],
      army: { size: NPC_INITIAL_ARMY_SIZE },
      policies: { ...NPC_INITIAL_POLICIES },
      policyChangedAt: {},
      reputation: { breaches: 0 },
      protectedUntil: 0,
      score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 },
      createdAt: 0,
    });
  }

  return ok(nations);
}
