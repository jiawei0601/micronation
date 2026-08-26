import { describe, it, expect } from 'vitest';
import type { Nation, PublicWorldView, Region } from '@micronation/shared';
import { decideActions, generateNpcNations } from './index';

function baseNation(overrides: Partial<Nation> = {}): Nation {
  return {
    id: 'n1',
    ownerId: null,
    name: 'Test',
    flag: { layout: 'horizontal-tricolor', colors: ['#fff'], emblem: 'star' },
    regionId: 'r1',
    resources: { food: 1000, ore: 1000, fuel: 1000, money: 1000 },
    tech: 0,
    actionPoints: 10,
    population: 100,
    morale: 60,
    buildings: { farm: 1, mine: 1, refinery: 0, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
    buildQueue: [],
    army: { size: 5 },
    policies: { tax: 'mid', economy: 'agri', conscription: 'volunteer', openness: 'neutral' },
    policyChangedAt: {},
    reputation: { breaches: 0 },
    protectedUntil: 0,
    score: { economy: 0, warfare: 0, tech: 0, diplomacy: 0, total: 0 },
    createdAt: 0,
    ...overrides,
  };
}

function baseView(overrides: Partial<PublicWorldView> = {}): PublicWorldView {
  return {
    seasonId: 's1',
    tick: 10,
    regions: [{ id: 'r1', name: 'Region 1', bonuses: {} }],
    nations: [],
    marches: [],
    treaties: [],
    orders: [],
    ...overrides,
  };
}

describe('decideActions — ① 糧食短缺', () => {
  it('存量將耗盡且付得起下一級農場時,優先蓋/升農場', () => {
    const nation = baseNation({ resources: { food: 5, ore: 1000, fuel: 1000, money: 1000 }, buildQueue: [] });
    const actions = decideActions(nation, baseView(), 'seed-a');
    expect(actions.some((a) => a.type === 'build' && a.building === 'farm')).toBe(true);
  });

  it('付不起升級或佇列已滿時,改掛買單', () => {
    const nation = baseNation({
      resources: { food: 5, ore: 0, fuel: 0, money: 1000 },
      buildQueue: [{ building: 'mine', completesAt: 20 }],
    });
    const actions = decideActions(nation, baseView(), 'seed-b');
    const buy = actions.find((a) => a.type === 'placeOrder' && a.order.side === 'buy' && a.order.kind === 'food');
    expect(buy).toBeDefined();
  });

  it('糧食充足時不觸發糧食短缺動作', () => {
    const nation = baseNation({ resources: { food: 100000, ore: 1000, fuel: 1000, money: 1000 } });
    const actions = decideActions(nation, baseView(), 'seed-c');
    expect(actions.some((a) => a.type === 'build' && a.building === 'farm')).toBe(false);
    expect(actions.some((a) => a.type === 'placeOrder' && a.order.kind === 'food' && a.order.side === 'buy')).toBe(false);
  });
});

describe('decideActions — ② 資源盈餘', () => {
  it('存量超過倉容比例時掛賣單', () => {
    const nation = baseNation({
      resources: { food: 50000, ore: 1000, fuel: 1000, money: 1000 },
      buildings: { farm: 5, mine: 5, refinery: 5, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
    });
    const actions = decideActions(nation, baseView(), 'seed-d');
    const sell = actions.find((a) => a.type === 'placeOrder' && a.order.side === 'sell' && a.order.kind === 'food');
    expect(sell).toBeDefined();
    if (sell && sell.type === 'placeOrder') {
      expect(sell.order.qty).toBeGreaterThan(0);
    }
  });

  it('賣價貼近近期均價(取自 view.orders 觀測值)', () => {
    const nation = baseNation({
      resources: { food: 50000, ore: 1000, fuel: 1000, money: 1000 },
    });
    const view = baseView({
      orders: [
        { id: 'o1', nationId: 'other', kind: 'food', side: 'buy', qty: 10, price: 42, createdAt: 1 },
        { id: 'o2', nationId: 'other', kind: 'food', side: 'buy', qty: 10, price: 44, createdAt: 1 },
      ],
    });
    const actions = decideActions(nation, view, 'seed-e');
    const sell = actions.find((a) => a.type === 'placeOrder' && a.order.side === 'sell' && a.order.kind === 'food');
    expect(sell).toBeDefined();
    if (sell && sell.type === 'placeOrder') {
      expect(sell.order.price).toBe(43);
    }
  });
});

describe('decideActions — ③ 被攻擊過', () => {
  it('nation.lastAttackedAt 在近期範圍內時,練兵至人口比例上限', () => {
    const nation = baseNation({
      resources: { food: 100, ore: 100, fuel: 100, money: 100000 },
      population: 10,
      army: { size: 0 },
      lastAttackedAt: 9,
    });
    const view = baseView({ tick: 10 });
    const actions = decideActions(nation, view, 'seed-f');
    const train = actions.find((a) => a.type === 'train');
    expect(train).toBeDefined();
    if (train && train.type === 'train') {
      expect(train.size).toBeGreaterThan(0);
      expect(train.size).toBeLessThanOrEqual(30); // 人口 100 * 0.3 上限
    }
  });

  it('未被攻擊時不主動練兵(在無其他觸發條件下)', () => {
    const nation = baseNation({
      resources: { food: 100000, ore: 100000, fuel: 100000, money: 100000 },
      army: { size: 0 },
    });
    const actions = decideActions(nation, baseView(), 'seed-g');
    expect(actions.some((a) => a.type === 'train')).toBe(false);
  });

  it('lastAttackedAt 太久以前(超出近期窗口)不再視為被攻擊過', () => {
    const nation = baseNation({
      resources: { food: 100000, ore: 100000, fuel: 100000, money: 100000 },
      army: { size: 0 },
      lastAttackedAt: 0,
    });
    const view = baseView({ tick: 1000 });
    const actions = decideActions(nation, view, 'seed-g2');
    expect(actions.some((a) => a.type === 'train')).toBe(false);
  });

  it('不再依賴 view.marches 判斷被攻擊(行軍抵達後即從 marches 移除,但仍應能透過 lastAttackedAt 判斷)', () => {
    const nation = baseNation({
      resources: { food: 100, ore: 100, fuel: 100, money: 100000 },
      population: 10,
      army: { size: 0 },
    });
    // marches 裡有一筆指向本國的在途行軍,但 lastAttackedAt 未設定 → 不應觸發練兵
    // (③規則的訊號來源已改為 lastAttackedAt,不是 view.marches)
    const view = baseView({
      marches: [{ id: 'm1', attackerId: 'enemy', defenderId: 'n1', size: 20, departedAt: 5, arrivesAt: 15 }],
    });
    const actions = decideActions(nation, view, 'seed-h2');
    expect(actions.some((a) => a.type === 'train')).toBe(false);
  });

  it('不主動攻擊玩家:任何情況下輸出不含 attack 類型動作', () => {
    const nation = baseNation({ resources: { food: 5, ore: 5, fuel: 5, money: 5 }, lastAttackedAt: 9 });
    const view = baseView({ tick: 10 });
    const actions = decideActions(nation, view, 'seed-h');
    expect(actions.every((a) => a.type !== ('attack' as never))).toBe(true);
  });
});

describe('decideActions — ④ 依短板升級建築', () => {
  it('無短缺/盈餘/攻擊時,升級存量最低的資源對應建築', () => {
    // 刻意讓 food/fuel 落在「不短缺(>=24 tick 消耗量)也不盈餘(<倉容 85%)」的區間,
    // 避免規則①②搶先觸發、蓋住這個測試想單獨驗證的規則④行為。
    const nation = baseNation({
      population: 50, // 消耗 5/tick;food>=120 才不短缺
      resources: { food: 150, ore: 10, fuel: 150, money: 1000 },
      buildQueue: [],
    });
    const actions = decideActions(nation, baseView(), 'seed-i');
    expect(actions.some((a) => a.type === 'build' && a.building === 'mine')).toBe(true);
  });

  it('佇列已滿時不再排入第④項建築動作', () => {
    const nation = baseNation({
      resources: { food: 1000, ore: 10, fuel: 1000, money: 1000 },
      buildQueue: [{ building: 'farm', completesAt: 20 }],
    });
    const actions = decideActions(nation, baseView(), 'seed-j');
    expect(actions.some((a) => a.type === 'build')).toBe(false);
  });

  it('規則④與①互斥(regression for Codex finding #10):①已觸發(走買糧路徑)時,即使④原本會判定「可負擔」也不會額外塞入建築動作', () => {
    // 刻意設計成:若④沒有嚴格互斥(actions.length===0 才執行),用剩下的 money/資源仍會誤判
    // 「還可以蓋 mine」而多塞一個 build 動作——佇列有空位、mine 的成本(money120+food10)在
    // ①買糧後的剩餘資源下確實付得起,所以這個測試在互斥修好前必定變紅,不是靠佇列已滿之類
    // 的旁路條件湊巧擋下來。
    const nation = baseNation({
      buildings: { farm: 1, mine: 0, refinery: 0, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
      buildQueue: [], // 佇列空著——若靠 queueHasRoom 以外的機制擋下④,才是真的在測互斥
      population: 30, // 消耗 3/tick,短缺門檻 24*3=72
      resources: { food: 60, ore: 5, fuel: 150, money: 1000 },
      // ore=5 < farm(level1)升級所需 ore20 → ①判定升農場付不起,走買單路徑(花掉 money,不動 ore/food)。
      // 全域最低存量是 ore(5)< food(60) < fuel(150),weakest→'mine';mine(level0)成本 money120+food10,
      // 買糧後 money=1000-300=700、food 仍是 60,若④沒被互斥擋下就會誤判付得起而蓋 mine。
      actionPoints: 99,
    });
    const actions = decideActions(nation, baseView(), 'seed-mutex');

    const buy = actions.find((a) => a.type === 'placeOrder' && a.order.side === 'buy' && a.order.kind === 'food');
    expect(buy).toBeDefined();
    expect(actions.some((a) => a.type === 'build')).toBe(false);
  });
});

describe('decideActions — wasAttacked 拒絕未來時間戳(regression for Codex finding #11)', () => {
  it('lastAttackedAt 大於 view.tick(損壞資料指向未來)時,不視為近期被攻擊過,不觸發練兵', () => {
    const nation = baseNation({
      // 資源壓在盈餘門檻(170)以下,避免規則②搶先掛出 3 筆賣單佔滿動作額度,
      // 讓「有沒有觸發練兵」單純取決於③本身的判斷,測試才真的在驗證 wasAttacked 的邊界處理。
      resources: { food: 100, ore: 100, fuel: 100, money: 100000 },
      population: 30,
      army: { size: 0 },
      lastAttackedAt: 50, // 未來
    });
    const view = baseView({ tick: 10 }); // elapsed = 10 - 50 = -40(負值)
    const actions = decideActions(nation, view, 'seed-future');
    expect(actions.some((a) => a.type === 'train')).toBe(false);
  });

  it('lastAttackedAt 恰等於 view.tick(elapsed=0)仍視為近期被攻擊過', () => {
    const nation = baseNation({
      // 資源刻意壓低於盈餘門檻(170)且高於短缺門檻,避免規則①②搶走動作額度,
      // 讓這裡專注驗證規則③在 elapsed=0 邊界仍會觸發。
      resources: { food: 100, ore: 100, fuel: 100, money: 100000 },
      population: 30,
      army: { size: 0 },
      lastAttackedAt: 10,
    });
    const view = baseView({ tick: 10 });
    const actions = decideActions(nation, view, 'seed-zero-elapsed');
    expect(actions.some((a) => a.type === 'train')).toBe(true);
  });
});

describe('decideActions — 影子狀態不透支(regression for Codex finding #24)', () => {
  it('①規則掛買單已計劃花掉的 money,④規則不可再用同一筆 money 判斷付得起升級', () => {
    const nation = baseNation({
      resources: { food: 50, ore: 10, fuel: 1000, money: 350 },
      population: 100,
      buildings: { farm: 5, mine: 0, refinery: 0, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
      buildQueue: [],
      actionPoints: 99,
    });
    const actions = decideActions(nation, baseView(), 'seed-shadow-1');

    const buy = actions.find((a) => a.type === 'placeOrder' && a.order.side === 'buy' && a.order.kind === 'food');
    expect(buy).toBeDefined(); // ①規則花掉 30*10=300 money,剩 50

    // mine 升級成本含 money:120,剩下的 50 付不起——④規則若沒看到①已經花掉的錢,會誤判付得起。
    const build = actions.find((a) => a.type === 'build' && a.building === 'mine');
    expect(build).toBeUndefined();
  });

  it('②規則掛出的賣單量會從影子庫存扣除,不會被後續規則重複視為可用存量', () => {
    const nation = baseNation({
      resources: { food: 1000, ore: 1000, fuel: 50000, money: 1000 },
      buildings: { farm: 5, mine: 5, refinery: 5, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
      buildQueue: [],
      actionPoints: 99,
    });
    const actions = decideActions(nation, baseView(), 'seed-shadow-2');
    const sellFuel = actions.filter((a) => a.type === 'placeOrder' && a.order.kind === 'fuel' && a.order.side === 'sell');
    // 同一 tick 對同一資源只應規劃賣出一次(規則②本身就是每種資源最多一筆),不會因為影子扣除後
    // 又被其他規則誤判為「還有大量盈餘」而重複掛單。
    expect(sellFuel.length).toBeLessThanOrEqual(1);
  });

  it('①規則買糧花掉的 money 會反映到③規則的練兵可負擔判斷(regression for Codex finding #13——原測試只涵蓋①④, ' +
    '在④改為與①②③嚴格互斥後①④組合已無法同時觸發,①③money 才是仍會實際互相影響、且無影子狀態會誤判的組合)', () => {
    const nation = baseNation({
      // food 短缺(觸發①);buildQueue 已滿逼①走買單(非蓋建築)路徑,才會真的扣 money。
      resources: { food: 5, ore: 100, fuel: 100, money: 320 },
      population: 30, // 消耗3/tick;短缺門檻 24*3=72,food=5 遠低於此
      army: { size: 0 },
      lastAttackedAt: 9, // 觸發③
      buildQueue: [{ building: 'mine', completesAt: 20 }],
      actionPoints: 99,
    });
    const view = baseView({ tick: 10 });
    const actions = decideActions(nation, view, 'seed-shadow-3');

    const buy = actions.find((a) => a.type === 'placeOrder' && a.order.side === 'buy' && a.order.kind === 'food');
    expect(buy).toBeDefined(); // ①花掉 30*10=300 money,剩 20

    // ③練兵成本 = TRAIN_COST_PER_UNIT.money(5) × size(cap=floor(30*0.3)=9) = 45,剩下的 20 付不起——
    // ③規則若沒看到①已經花掉的錢(仍讀 nation.resources.money=320),會誤判付得起而練兵。
    const train = actions.find((a) => a.type === 'train');
    expect(train).toBeUndefined();
  });
});

describe('decideActions — 行動點/資源不足時放棄', () => {
  it('actionPoints 為 0 時不產生任何動作', () => {
    const nation = baseNation({
      resources: { food: 5, ore: 5, fuel: 1000, money: 1000 },
      actionPoints: 0,
    });
    const actions = decideActions(nation, baseView(), 'seed-k');
    expect(actions).toHaveLength(0);
  });

  it('每 tick 動作數不超過上限常數(3)', () => {
    const nation = baseNation({
      resources: { food: 5, ore: 5, fuel: 5, money: 100000 },
      buildQueue: [],
      buildings: { farm: 5, mine: 5, refinery: 5, market: 0, barracks: 0, warehouse: 0, university: 0, wall: 0 },
      army: { size: 0 },
      actionPoints: 99,
    });
    const view = baseView({
      marches: [{ id: 'm1', attackerId: 'enemy', defenderId: 'n1', size: 20, departedAt: 5, arrivesAt: 15 }],
    });
    const actions = decideActions(nation, view, 'seed-l');
    expect(actions.length).toBeLessThanOrEqual(3);
  });

  it('資源不足以升級任何建築時,第④項不透支資源', () => {
    const nation = baseNation({
      resources: { food: 1000, ore: 1, fuel: 1000, money: 0 },
      buildQueue: [],
    });
    const actions = decideActions(nation, baseView(), 'seed-m');
    expect(actions.some((a) => a.type === 'build' && a.building === 'mine')).toBe(false);
  });
});

describe('decideActions — 確定性', () => {
  it('同輸入同 seed 必得同輸出', () => {
    const nation = baseNation({ resources: { food: 5, ore: 1000, fuel: 1000, money: 1000 } });
    const view = baseView();
    const a1 = decideActions(nation, view, 'stable-seed');
    const a2 = decideActions(nation, view, 'stable-seed');
    expect(a1).toEqual(a2);
  });

  it('不同 seed 若不影響決策路徑,結果仍一致(規則優先序不依賴 seed)', () => {
    const nation = baseNation({ resources: { food: 5, ore: 1000, fuel: 1000, money: 1000 } });
    const view = baseView();
    const a1 = decideActions(nation, view, 'seed-x');
    const a2 = decideActions(nation, view, 'seed-y');
    expect(a1.map((a) => a.type)).toEqual(a2.map((a) => a.type));
  });
});

describe('generateNpcNations', () => {
  const regions: Region[] = [
    { id: 'r1', name: 'Region 1', bonuses: {} },
    { id: 'r2', name: 'Region 2', bonuses: {} },
    { id: 'r3', name: 'Region 3', bonuses: {} },
  ];

  function unwrap(count: number, rs: Region[], seed: string) {
    const r = generateNpcNations(count, rs, seed);
    if (!r.ok) throw new Error(`setup failed: ${r.error}`);
    return r.value;
  }

  it('產生指定數量的 NPC(ownerId 為 null)', () => {
    const nations = unwrap(6, regions, 'gen-seed-a');
    expect(nations).toHaveLength(6);
    expect(nations.every((n) => n.ownerId === null)).toBe(true);
  });

  it('名字不重複', () => {
    const nations = unwrap(20, regions, 'gen-seed-b');
    const names = new Set(nations.map((n) => n.name));
    expect(names.size).toBe(nations.length);
  });

  it('分散各區:每個 region 都至少分配到一個 NPC(數量足夠時)', () => {
    const nations = unwrap(9, regions, 'gen-seed-c');
    const regionIds = new Set(nations.map((n) => n.regionId));
    expect(regionIds.size).toBe(regions.length);
  });

  it('確定性:同 seed 同輸出', () => {
    const a = unwrap(5, regions, 'gen-seed-fixed');
    const b = unwrap(5, regions, 'gen-seed-fixed');
    expect(a).toEqual(b);
  });

  it('不同 seed 產生不同結果', () => {
    const a = unwrap(5, regions, 'gen-seed-1');
    const b = unwrap(5, regions, 'gen-seed-2');
    expect(a.map((n) => n.name)).not.toEqual(b.map((n) => n.name));
  });

  it('count 為 0 時允許,回傳空陣列', () => {
    const nations = unwrap(0, regions, 'gen-seed-zero');
    expect(nations).toHaveLength(0);
  });

  it('count 為負數、NaN、非整數或超過上限 → Err(INVALID_COUNT)', () => {
    expect(generateNpcNations(-1, regions, 's')).toEqual({ ok: false, error: 'INVALID_COUNT' });
    expect(generateNpcNations(NaN, regions, 's')).toEqual({ ok: false, error: 'INVALID_COUNT' });
    expect(generateNpcNations(1.5, regions, 's')).toEqual({ ok: false, error: 'INVALID_COUNT' });
    expect(generateNpcNations(1e9, regions, 's')).toEqual({ ok: false, error: 'INVALID_COUNT' });
  });

  it('regions 為空陣列 → Err(NO_REGIONS)', () => {
    expect(generateNpcNations(3, [], 's')).toEqual({ ok: false, error: 'NO_REGIONS' });
  });
});
