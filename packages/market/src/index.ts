import type { MarketOrder, NewOrder, PriceRef, NationCtx, Id, Trade, ResourceKind } from '@micronation/shared';
import { ok, err, makeId, PRICE_BAND, UNVERIFIED_ORDER_QTY_CAP, PROTECTED_ORDER_QTY_CAP } from '@micronation/shared';
import type { Result } from '@micronation/shared';

const RESOURCE_KINDS: ResourceKind[] = ['food', 'ore', 'fuel', 'money'];

function isPositiveInteger(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

// 產生決定性 id(book 為純函式輸入,不可用 Date.now/crypto)——走 shared.makeId。
// 用 book.length 當序號會撞號(cancel/成交移除訂單後,length 會回頭重複用過的值),
// 改由呼叫端傳入單調遞增的 seq(例如 D1 的 autoincrement 或全域計數器)。
function nextOrderId(ctx: NationCtx, o: NewOrder, seq: number): Id {
  return makeId('order', ctx.tick, o.nationId, o.kind, o.side, seq);
}

function tradeId(buyOrderId: Id, sellOrderId: Id, index: number): Id {
  return makeId('trade', buyOrderId, sellOrderId, index);
}

export function placeOrder(
  book: MarketOrder[],
  o: NewOrder,
  ref: PriceRef,
  ctx: NationCtx,
  tariffRate: number,
  seq: number
): Result<{ book: MarketOrder[]; trades: Trade[]; unbanded: boolean }> {
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
  if (!Number.isSafeInteger(seq) || seq < 0) {
    return err('INVALID_ORDER');
  }
  if (!Number.isFinite(tariffRate) || tariffRate < 0 || tariffRate >= 1) {
    return err('INVALID_TARIFF');
  }

  if (!ctx.verified && o.qty > UNVERIFIED_ORDER_QTY_CAP) {
    return err('UNVERIFIED');
  }

  if (ctx.tick < ctx.protectedUntil && o.qty > PROTECTED_ORDER_QTY_CAP) {
    return err('PROTECTED_LIMIT');
  }

  // 無有效參考價(缺值、非有限、或 <=0)時,無法判斷是否偏離「近期均價」,跳過價格帶檢查,
  // 並在回傳標記 unbanded:true,交由呼叫端決定要不要額外提示/限制。
  const avg = ref.avgPrice[o.kind];
  let unbanded = true;
  if (avg !== undefined && Number.isFinite(avg) && avg > 0) {
    unbanded = false;
    const deviation = Math.abs(o.price - avg) / avg;
    if (deviation > PRICE_BAND) {
      return err('PRICE_BAND');
    }
  }

  // ---- 撮合 ----
  const takerId = nextOrderId(ctx, o, seq);
  let remaining = o.qty;
  const trades: Trade[] = [];
  const nextBook: MarketOrder[] = [...book];

  const isMatch = (resting: MarketOrder): boolean =>
    resting.kind === o.kind &&
    resting.side !== o.side &&
    resting.nationId !== o.nationId && // 禁止自我對敲:同一國家的買賣單互相跳過,不成交
    // resting order 的 qty/price 使用前同驗(finding #6)——book 若含損壞資料(理論上不該發生,
    // 但防禦性處理),直接視為不可撮合對象跳過,不炸整個請求。
    isPositiveInteger(resting.qty) &&
    isPositiveInteger(resting.price) &&
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

    // 成交前算 notional 與 tariff,個別安全但乘積可能不安全(finding #6/#9)——
    // 非 Number.isSafeInteger 即拒絕整筆請求,不做部分撮合後再失敗那種半吊子狀態。
    const notional = fillQty * tradePrice;
    if (!Number.isSafeInteger(notional)) return err('UNSAFE_NOTIONAL');
    const tariff = Math.round(notional * tariffRate);
    if (!Number.isSafeInteger(tariff)) return err('UNSAFE_NOTIONAL');

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
      tariff,
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

  return ok({ book: finalBook, trades, unbanded });
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
