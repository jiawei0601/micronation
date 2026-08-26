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
    const r = placeOrder([], newOrder({ qty: 0 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r).toEqual({ ok: false, error: 'INVALID_ORDER' });
  });

  it('拒絕非正整數 price', () => {
    const r = placeOrder([], newOrder({ price: -5 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r).toEqual({ ok: false, error: 'INVALID_ORDER' });
  });

  it('未驗證帳號大額掛單 → UNVERIFIED', () => {
    const r = placeOrder([], newOrder({ qty: 51 }), ref(), ctx({ verified: false }), NO_TARIFF, 0);
    expect(r).toEqual({ ok: false, error: 'UNVERIFIED' });
  });

  it('未驗證帳號但在額度內 → 允許', () => {
    const r = placeOrder([], newOrder({ qty: 50 }), ref(), ctx({ verified: false }), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
  });

  it('保護期內大額掛單 → PROTECTED_LIMIT', () => {
    const r = placeOrder([], newOrder({ qty: 51 }), ref(), ctx({ protectedUntil: 200, tick: 100 }), NO_TARIFF, 0);
    expect(r).toEqual({ ok: false, error: 'PROTECTED_LIMIT' });
  });

  it('保護期內但在額度內 → 允許', () => {
    const r = placeOrder([], newOrder({ qty: 50 }), ref(), ctx({ protectedUntil: 200, tick: 100 }), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
  });

  it('保護期已過 → 不受額度限制', () => {
    const r = placeOrder([], newOrder({ qty: 1000 }), ref(), ctx({ protectedUntil: 50, tick: 100, verified: true }), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
  });

  it('價格偏離均價超過 +30% 上界 → PRICE_BAND', () => {
    // avg=10, band=30% → 上界 13,超過即拒絕
    const r = placeOrder([], newOrder({ price: 14 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r).toEqual({ ok: false, error: 'PRICE_BAND' });
  });

  it('價格恰在 +30% 邊界內 → 允許', () => {
    const r = placeOrder([], newOrder({ price: 13 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
  });

  it('價格偏離均價超過 -30% 下界 → PRICE_BAND', () => {
    // 下界 7,低於即拒絕
    const r = placeOrder([], newOrder({ price: 6 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r).toEqual({ ok: false, error: 'PRICE_BAND' });
  });

  it('價格恰在 -30% 邊界內 → 允許', () => {
    const r = placeOrder([], newOrder({ price: 7 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
  });

  it('無均價參考資料時不做價格帶檢查,且標記 unbanded:true', () => {
    const r = placeOrder([], newOrder({ kind: 'ore', price: 999 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unbanded).toBe(true);
  });

  it('有有效均價時 unbanded 為 false', () => {
    const r = placeOrder([], newOrder({ price: 10 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unbanded).toBe(false);
  });

  it('均價為非有限值(Infinity/NaN)時跳過價格帶檢查,不誤判 PRICE_BAND', () => {
    const rInf = placeOrder([], newOrder({ kind: 'ore', price: 999 }), { avgPrice: { ore: Infinity } }, ctx(), NO_TARIFF, 0);
    expect(rInf.ok).toBe(true);
    const rNaN = placeOrder([], newOrder({ kind: 'ore', price: 999 }), { avgPrice: { ore: NaN } }, ctx(), NO_TARIFF, 0);
    expect(rNaN.ok).toBe(true);
  });

  it('拒絕非有限或超出 [0,1) 的 tariffRate', () => {
    expect(placeOrder([], newOrder(), ref(), ctx(), -0.1, 0)).toEqual({ ok: false, error: 'INVALID_TARIFF' });
    expect(placeOrder([], newOrder(), ref(), ctx(), 1, 0)).toEqual({ ok: false, error: 'INVALID_TARIFF' });
    expect(placeOrder([], newOrder(), ref(), ctx(), NaN, 0)).toEqual({ ok: false, error: 'INVALID_TARIFF' });
    expect(placeOrder([], newOrder(), ref(), ctx(), Infinity, 0)).toEqual({ ok: false, error: 'INVALID_TARIFF' });
  });

  it('拒絕非安全整數或負數的 seq', () => {
    expect(placeOrder([], newOrder(), ref(), ctx(), NO_TARIFF, -1)).toEqual({ ok: false, error: 'INVALID_ORDER' });
    expect(placeOrder([], newOrder(), ref(), ctx(), NO_TARIFF, 1.5)).toEqual({ ok: false, error: 'INVALID_ORDER' });
  });
});

describe('placeOrder — 撮合前 safe-integer 驗證(regression for Codex finding #6/#9)', () => {
  it('拒絕 NaN/Infinity/小數的 qty 或 price', () => {
    expect(placeOrder([], newOrder({ qty: NaN }), ref(), ctx(), NO_TARIFF, 0)).toEqual({ ok: false, error: 'INVALID_ORDER' });
    expect(placeOrder([], newOrder({ qty: Infinity }), ref(), ctx(), NO_TARIFF, 0)).toEqual({ ok: false, error: 'INVALID_ORDER' });
    expect(placeOrder([], newOrder({ qty: 1.5 }), ref(), ctx(), NO_TARIFF, 0)).toEqual({ ok: false, error: 'INVALID_ORDER' });
    expect(placeOrder([], newOrder({ price: NaN }), ref(), ctx(), NO_TARIFF, 0)).toEqual({ ok: false, error: 'INVALID_ORDER' });
    expect(placeOrder([], newOrder({ price: Infinity }), ref(), ctx(), NO_TARIFF, 0)).toEqual({ ok: false, error: 'INVALID_ORDER' });
    expect(placeOrder([], newOrder({ price: 2.5 }), ref(), ctx(), NO_TARIFF, 0)).toEqual({ ok: false, error: 'INVALID_ORDER' });
  });

  it('拒絕超過 MAX_SAFE_INTEGER 的 qty/price', () => {
    const over = Number.MAX_SAFE_INTEGER + 10;
    expect(placeOrder([], newOrder({ qty: over }), ref(), ctx(), NO_TARIFF, 0)).toEqual({ ok: false, error: 'INVALID_ORDER' });
    expect(placeOrder([], newOrder({ price: over }), ref({ food: over / 2 }), ctx(), NO_TARIFF, 0)).toEqual({
      ok: false,
      error: 'INVALID_ORDER',
    });
  });

  it('qty 與 price 個別皆安全整數,但乘積(notional)超出安全整數範圍 → UNSAFE_NOTIONAL', () => {
    // 個別都遠小於 MAX_SAFE_INTEGER,但相乘後溢位。
    const big = 100_000_000; // 1e8,安全整數
    const book = [restingOrder({ id: 'sell-big', qty: big, price: big })];
    const r = placeOrder(
      book,
      newOrder({ qty: big, price: big }),
      { avgPrice: { food: big } },
      ctx(),
      NO_TARIFF,
      0
    );
    expect(r).toEqual({ ok: false, error: 'UNSAFE_NOTIONAL' });
  });

  it('book 中混入非安全整數 qty/price 的損壞 resting order 時,跳過該筆不撮合、不炸整個請求', () => {
    const corrupted = restingOrder({ id: 'corrupted', qty: NaN as unknown as number, price: 10 });
    const healthy = restingOrder({ id: 'healthy', qty: 5, price: 10 });
    const r = placeOrder([corrupted, healthy], newOrder({ qty: 5, price: 10 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(1);
    expect(r.value.trades[0].sellOrderId).toBe('healthy');
  });
});

describe('placeOrder — id 唯一性(seq 避免撞號)', () => {
  it('相同 book.length(空 book)但不同 seq 產生不同 order id,避免用 book.length 當序號時的撞號', () => {
    const r1 = placeOrder([], newOrder({ nationId: 'nationA' }), ref(), ctx(), NO_TARIFF, 0);
    const r2 = placeOrder([], newOrder({ nationId: 'nationA' }), ref(), ctx(), NO_TARIFF, 1);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.book[0].id).not.toBe(r2.value.book[0].id);
  });

  it('撤單後 book.length 回到相同值,但呼叫端遞增的 seq 仍確保新單不撞舊單 id', () => {
    // 情境:掛單A(seq=0)成交出清、book 又變空(length回到0);此時若用 book.length 當序號,
    // 掛單B也會得到序號0、id 與已被清空但仍存於歷史紀錄(trades/D1)的掛單A相同。改用呼叫端
    // 遞增 seq 後,只要呼叫端不重複傳同一個 seq,就不會撞號。
    const bookAfterFill: MarketOrder[] = []; // 模拟掛單A已完全成交、從 book 移除
    const r = placeOrder(bookAfterFill, newOrder({ nationId: 'nationA' }), ref(), ctx(), NO_TARIFF, 7);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.book[0].id).toContain('-7');
  });
});

describe('placeOrder — 撮合', () => {
  it('完全成交:買單吃掉單一賣單', () => {
    const book = [restingOrder({ qty: 10, price: 10 })];
    const r = placeOrder(book, newOrder({ qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(1);
    expect(r.value.trades[0].qty).toBe(10);
    expect(r.value.trades[0].price).toBe(10); // 成交於掛單方(maker)價格
    expect(r.value.book).toHaveLength(0); // 賣單被吃光,買單也全部成交,book 應清空
  });

  it('部分成交:買單數量大於單一賣單,剩餘掛回 book', () => {
    const book = [restingOrder({ id: 'sell-1', qty: 4, price: 10 })];
    const r = placeOrder(book, newOrder({ qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF, 0);
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
    const r = placeOrder(book, newOrder({ qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF, 0);
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
    const r = placeOrder(book, newOrder({ qty: 5, price: 13 }), ref(), ctx(), NO_TARIFF, 0);
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
    const r = placeOrder(book, newOrder({ qty: 5, price: 10 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades[0].sellOrderId).toBe('sell-earlier');
  });

  it('自成交:禁止同一國吃自己掛的單,跳過對手單、直接掛回 book(不成交)', () => {
    const book = [restingOrder({ id: 'sell-self', nationId: 'nationA', qty: 10, price: 10 })];
    const r = placeOrder(book, newOrder({ nationId: 'nationA', qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(0);
    // 原本的自家掛單原封不動、taker 單也整筆掛回 book
    expect(r.value.book).toHaveLength(2);
  });

  it('自成交跳過後,仍可撮合其他國家的對手單', () => {
    const book = [
      restingOrder({ id: 'sell-self', nationId: 'nationA', qty: 10, price: 10 }),
      restingOrder({ id: 'sell-other', nationId: 'nationC', qty: 10, price: 10 }),
    ];
    const r = placeOrder(book, newOrder({ nationId: 'nationA', qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(1);
    expect(r.value.trades[0].sellOrderId).toBe('sell-other');
  });

  it('無對手單時掛單直接進 book', () => {
    const r = placeOrder([], newOrder({ qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(0);
    expect(r.value.book).toHaveLength(1);
  });

  it('不同資源種類不互相撮合', () => {
    const book = [restingOrder({ id: 'sell-ore', kind: 'ore', qty: 10, price: 10 })];
    const r = placeOrder(book, newOrder({ kind: 'food', qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trades).toHaveLength(0);
    expect(r.value.book).toHaveLength(2);
  });

  it('賣單找不到夠低價的買單則不成交', () => {
    const book = [restingOrder({ id: 'buy-1', side: 'buy', qty: 10, price: 5 })];
    const r = placeOrder(book, newOrder({ side: 'sell', qty: 10, price: 10 }), ref(), ctx(), NO_TARIFF, 0);
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
