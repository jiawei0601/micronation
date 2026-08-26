import type { MarketOrder, NewOrder, PriceRef, NationCtx, Id, Trade, ResourceKind } from '@micronation/shared';
import { ok, err, makeId, PRICE_BAND, UNVERIFIED_ORDER_QTY_CAP, PROTECTED_ORDER_QTY_CAP } from '@micronation/shared';
import type { Result } from '@micronation/shared';

const RESOURCE_KINDS: ResourceKind[] = ['food', 'ore', 'fuel', 'money'];

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

// 產生決定性 id(book 為純函式輸入,不可用 Date.now/crypto)——走 shared.makeId。
function nextOrderId(ctx: NationCtx, o: NewOrder, book: MarketOrder[]): Id {
  return makeId('order', ctx.tick, o.nationId, o.kind, o.side, book.length);
}

function tradeId(buyOrderId: Id, sellOrderId: Id, index: number): Id {
  return makeId('trade', buyOrderId, sellOrderId, index);
}

export function placeOrder(
  book: MarketOrder[],
  o: NewOrder,
  ref: PriceRef,
  ctx: NationCtx,
  tariffRate: number
): Result<{ book: MarketOrder[]; trades: Trade[] }> {
  // ---- 驗證 ----
  if (!isPositiveInteger(o.qty) || !isPositiveInteger(o.price)) {
    return err('INVALID_ORDER');
  }
  if (!RESOURCE_KINDS.includes(o.kind)) {
    return err('INVALID_ORDER');
  }
  if (o.side !== 'buy' && o.side !== 'sell') {
    return err('INVALID_ORDER');
  }

  if (!ctx.verified && o.qty > UNVERIFIED_ORDER_QTY_CAP) {
    return err('UNVERIFIED');
  }

  if (ctx.tick < ctx.protectedUntil && o.qty > PROTECTED_ORDER_QTY_CAP) {
    return err('PROTECTED_LIMIT');
  }

  const avg = ref.avgPrice[o.kind];
  if (avg !== undefined && avg > 0) {
    const deviation = Math.abs(o.price - avg) / avg;
    if (deviation > PRICE_BAND) {
      return err('PRICE_BAND');
    }
  }

  // ---- 撮合 ----
  const takerId = nextOrderId(ctx, o, book);
  let remaining = o.qty;
  const trades: Trade[] = [];
  const nextBook: MarketOrder[] = [...book];

  const isMatch = (resting: MarketOrder): boolean =>
    resting.kind === o.kind &&
    resting.side !== o.side &&
    (o.side === 'buy' ? resting.price <= o.price : resting.price >= o.price);

  // 候選:同 kind、對邊、價格符合;排序=價格優先(對 taker 最有利者優先)→時間優先(createdAt 早者優先)
  const candidateIndexes = nextBook
    .map((order, idx) => ({ order, idx }))
    .filter(({ order }) => isMatch(order))
    .sort((a, b) => {
      const priceCompare =
        o.side === 'buy' ? a.order.price - b.order.price : b.order.price - a.order.price;
      if (priceCompare !== 0) return priceCompare;
      return a.order.createdAt - b.order.createdAt;
    });

  for (const { idx } of candidateIndexes) {
    if (remaining <= 0) break;
    const resting = nextBook[idx];
    if (!resting || resting.qty <= 0) continue;

    const fillQty = Math.min(remaining, resting.qty);
    const tradePrice = resting.price; // 吃單方成交於掛單方(maker)價格

    const buyOrderId = o.side === 'buy' ? takerId : resting.id;
    const sellOrderId = o.side === 'buy' ? resting.id : takerId;
    const buyerId = o.side === 'buy' ? o.nationId : resting.nationId;
    const sellerId = o.side === 'buy' ? resting.nationId : o.nationId;

    trades.push({
      id: tradeId(buyOrderId, sellOrderId, trades.length),
      buyOrderId,
      sellOrderId,
      buyerId,
      sellerId,
      kind: o.kind,
      qty: fillQty,
      price: tradePrice,
      tariff: Math.round(fillQty * tradePrice * tariffRate),
      tick: ctx.tick,
    });

    remaining -= fillQty;
    const updatedResting: MarketOrder = { ...resting, qty: resting.qty - fillQty };
    if (updatedResting.qty <= 0) {
      nextBook[idx] = null as unknown as MarketOrder; // 標記待移除
    } else {
      nextBook[idx] = updatedResting;
    }
  }

  const finalBook = nextBook.filter((order): order is MarketOrder => order !== null);

  if (remaining > 0) {
    finalBook.push({
      id: takerId,
      nationId: o.nationId,
      kind: o.kind,
      side: o.side,
      qty: remaining,
      price: o.price,
      createdAt: ctx.tick,
    });
  }

  return ok({ book: finalBook, trades });
}

export function cancelOrder(book: MarketOrder[], orderId: Id, nationId: Id): Result<{ book: MarketOrder[] }> {
  const target = book.find((o) => o.id === orderId);
  if (!target) {
    return err('NOT_FOUND');
  }
  if (target.nationId !== nationId) {
    return err('FORBIDDEN');
  }
  return ok({ book: book.filter((o) => o.id !== orderId) });
}
