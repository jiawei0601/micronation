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
  it('存在以本國為目標的行軍時,練兵至人口比例上限', () => {
    const nation = baseNation({
      resources: { food: 100, ore: 100, fuel: 100, money: 100000 },
      population: 10,
      army: { size: 0 },
    });
    const view = baseView({
      marches: [{ id: 'm1', attackerId: 'enemy', defenderId: 'n1', size: 20, departedAt: 5, arrivesAt: 15 }],
    });
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

  it('不主動攻擊玩家:任何情況下輸出不含 attack 類型動作', () => {
    const nation = baseNation({ resources: { food: 5, ore: 5, fuel: 5, money: 5 } });
    const view = baseView({
      marches: [{ id: 'm1', attackerId: 'enemy', defenderId: 'n1', size: 20, departedAt: 5, arrivesAt: 15 }],
    });
    const actions = decideActions(nation, view, 'seed-h');
    expect(actions.every((a) => a.type !== ('attack' as never))).toBe(true);
  });
});

describe('decideActions — ④ 依短板升級建築', () => {
  it('無短缺/盈餘/攻擊時,升級存量最低的資源對應建築', () => {
    const nation = baseNation({
      resources: { food: 1000, ore: 10, fuel: 1000, money: 1000 },
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

  it('產生指定數量的 NPC(ownerId 為 null)', () => {
    const nations = generateNpcNations(6, regions, 'gen-seed-a');
    expect(nations).toHaveLength(6);
    expect(nations.every((n) => n.ownerId === null)).toBe(true);
  });

  it('名字不重複', () => {
    const nations = generateNpcNations(20, regions, 'gen-seed-b');
    const names = new Set(nations.map((n) => n.name));
    expect(names.size).toBe(nations.length);
  });

  it('分散各區:每個 region 都至少分配到一個 NPC(數量足夠時)', () => {
    const nations = generateNpcNations(9, regions, 'gen-seed-c');
    const regionIds = new Set(nations.map((n) => n.regionId));
    expect(regionIds.size).toBe(regions.length);
  });

  it('確定性:同 seed 同輸出', () => {
    const a = generateNpcNations(5, regions, 'gen-seed-fixed');
    const b = generateNpcNations(5, regions, 'gen-seed-fixed');
    expect(a).toEqual(b);
  });

  it('不同 seed 產生不同結果', () => {
    const a = generateNpcNations(5, regions, 'gen-seed-1');
    const b = generateNpcNations(5, regions, 'gen-seed-2');
    expect(a.map((n) => n.name)).not.toEqual(b.map((n) => n.name));
  });
});
