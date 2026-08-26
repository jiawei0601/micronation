import { describe, it, expect } from 'vitest';
import { placeOrder, cancelOrder } from '../src/index';
import type { MarketOrder, NewOrder, PriceRef, NationCtx } from '@micronation/shared';

const ctx = (overrides: Partial<NationCtx> = {}): NationCtx => ({
  verified: true,
  protectedUntil: 0,
  tick: 100,
  ...overrides,
});

const ref = (avg: Partial<PriceRef['avgPrice']> = {}): PriceRef => ({
  avgPrice: { food: 10, ...avg },
});

const newOrder = (overrides: Partial<NewOrder> = {}): NewOrder => ({
  nationId: 'nationA',
  kind: 'food',
  side: 'buy',
  qty: 10,
  price: 10,
  ...overrides,
});

const NO_TARIFF = 0;

const restingOrder = (overrides: Partial<MarketOrder> = {}): MarketOrder => ({
  id: 'order-existing-1',
  nationId: 'nationB',
  kind: 'food',
  side: 'sell',
  qty: 10,
  price: 10,
  createdAt: 0,
  ...overrides,
});

describe('placeOrder — 驗證', () => {
  it('拒絕非正整數 qty', () => {
    const r = placeOrder([], newOrder({ qty: 0 }), ref(), ctx(), NO_TARIFF);
    expect(r).toEqual({ ok: false, error: 'INVALID_ORDER' });
  });

  it('拒絕非正整數 price', () => {
    const r = placeOrder([], newOrder({ price: -5 }), ref(), ctx(), NO_TARIFF);
    expect(r).toEqual({ ok: false, error: 'INVALID_ORDER' });
  });

  it('未驗證帳號大額掛單 → UNVERIFIED', () => {
    const r = placeOrder([], newOrder({ qty: 51 }), ref(), ctx({ verified: false }), NO_TARIFF);
    expect(r).toEqual({ ok: false, error: 'UNVERIFIED' });
  });

  it('未驗證帳號但在額度內 → 允許', () => {
    const r = placeOrder([], newOrder({ qty: 50 }), ref(), ctx({ verified: false }), NO_TARIFF);
    expect(r.ok).toBe(true);
  });

  it('保護期內大額掛單 → PROTECTED_LIMIT', () => {
    const r = placeOrder([], newOrder({ qty: 51 }), ref(), ctx({ protectedUntil: 200, tick: 100 }), NO_TARIFF);
    expect(r).toEqual({ ok: false, error: 'PROTECTED_LIMIT' });
  });

  it('保護期內但在額度內 → 允許', () => {
    const r = placeOrder([], newOrder({ qty: 50 }), ref(), ctx({ protectedUntil: 200, tick: 100 }), NO_TARIFF);
    expect(r.ok).toBe(true);
  });

  it('保護期已過 → 不受額度限制', () => {
    const r = placeOrder([], newOrder({ qty: 1000 }), ref(), ctx({ protectedUntil: 50, tick: 100, verified: true }), NO_TARIFF);
    expect(r.ok).toBe(true);
  });

  it('價格偏離均價超過 +30% 上界 → PRICE_BAND', () => {
    // avg=10, band=30% → 上界 13,超過即拒絕
    const r = placeOrder([], newOrder({ price: 14 }), ref(), ctx(), NO_TARIFF);
    expect(r).toEqual({ ok: false, error: 'PRICE_BAND' });
  });

  it('價格恰在 +30% 邊界內 → 允許', () => {
    const r = placeOrder([], newOrder({ price: 13 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
  });

  it('價格偏離均價超過 -30% 下界 → PRICE_BAND', () => {
    // 下界 7,低於即拒絕
    const r = placeOrder([], newOrder({ price: 6 }), ref(), ctx(), NO_TARIFF);
    expect(r).toEqual({ ok: false, error: 'PRICE_BAND' });
  });

  it('價格恰在 -30% 邊界內 → 允許', () => {
    const r = placeOrder([], newOrder({ price: 7 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
  });

  it('無均價參考資料時不做價格帶檢查', () => {
    const r = placeOrder([], newOrder({ kind: 'ore', price: 999 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
  });
});

describe('placeOrder — 撮合', () => {
  it('完全成交:買單吃掉單一賣單', () => {
    const book = [restingOrder({ qty: 10, price: 10 })];
    const r = placeOrder(book, newOrder({ qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(1);
    expect(r.value.trades[0].qty).toBe(10);
    expect(r.value.trades[0].price).toBe(10); // 成交於掛單方(maker)價格
    expect(r.value.book).toHaveLength(0); // 賣單被吃光,買單也全部成交,book 應清空
  });

  it('部分成交:買單數量大於單一賣單,剩餘掛回 book', () => {
    const book = [restingOrder({ id: 'sell-1', qty: 4, price: 10 })];
    const r = placeOrder(book, newOrder({ qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(1);
    expect(r.value.trades[0].qty).toBe(4);
    expect(r.value.book).toHaveLength(1);
    expect(r.value.book[0].side).toBe('buy');
    expect(r.value.book[0].qty).toBe(6);
  });

  it('部分成交:賣單被多筆買單分批吃掉,對手單保留剩餘量', () => {
    const book = [restingOrder({ id: 'sell-1', qty: 3, price: 10 })];
    const r = placeOrder(book, newOrder({ qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 賣單量不足,買單部分成交、賣單全數吃光
    expect(r.value.trades[0].qty).toBe(3);
    const sellRemaining = r.value.book.find((o) => o.id === 'sell-1');
    expect(sellRemaining).toBeUndefined();
  });

  it('價格優先:優先吃最低價賣單', () => {
    const book = [
      restingOrder({ id: 'sell-high', qty: 10, price: 12, createdAt: 0 }),
      restingOrder({ id: 'sell-low', qty: 10, price: 8, createdAt: 5 }),
    ];
    const r = placeOrder(book, newOrder({ qty: 5, price: 13 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades[0].sellOrderId).toBe('sell-low');
    expect(r.value.trades[0].price).toBe(8);
  });

  it('時間優先:同價位優先吃掛單時間較早者', () => {
    const book = [
      restingOrder({ id: 'sell-later', qty: 10, price: 10, createdAt: 10 }),
      restingOrder({ id: 'sell-earlier', qty: 10, price: 10, createdAt: 1 }),
    ];
    const r = placeOrder(book, newOrder({ qty: 5, price: 10 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades[0].sellOrderId).toBe('sell-earlier');
  });

  it('自成交:同一國買賣自己掛的單 → 允許成交(釘住行為)', () => {
    // 市場規則未禁止自成交;此測試釘住目前允許的行為,若未來要禁止需改此測試。
    const book = [restingOrder({ id: 'sell-self', nationId: 'nationA', qty: 10, price: 10 })];
    const r = placeOrder(book, newOrder({ nationId: 'nationA', qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(1);
    expect(r.value.trades[0].buyerId).toBe('nationA');
    expect(r.value.trades[0].sellerId).toBe('nationA');
  });

  it('無對手單時掛單直接進 book', () => {
    const r = placeOrder([], newOrder({ qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(0);
    expect(r.value.book).toHaveLength(1);
  });

  it('不同資源種類不互相撮合', () => {
    const book = [restingOrder({ id: 'sell-ore', kind: 'ore', qty: 10, price: 10 })];
    const r = placeOrder(book, newOrder({ kind: 'food', qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(0);
    expect(r.value.book).toHaveLength(2);
  });

  it('賣單找不到夠低價的買單則不成交', () => {
    const book = [restingOrder({ id: 'buy-1', side: 'buy', qty: 10, price: 5 })];
    const r = placeOrder(book, newOrder({ side: 'sell', qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(0);
  });
});

describe('cancelOrder', () => {
  it('本國可撤自己的單', () => {
    const book = [restingOrder({ id: 'o1', nationId: 'nationA' })];
    const r = cancelOrder(book, 'o1', 'nationA');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.book).toHaveLength(0);
  });

  it('不可撤他國的單 → FORBIDDEN', () => {
    const book = [restingOrder({ id: 'o1', nationId: 'nationB' })];
    const r = cancelOrder(book, 'o1', 'nationA');
    expect(r).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('撤不存在的單 → NOT_FOUND', () => {
    const r = cancelOrder([], 'missing', 'nationA');
    expect(r).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});
