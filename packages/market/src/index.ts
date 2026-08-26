import type { MarketOrder, NewOrder, PriceRef, NationCtx, Id, Trade } from '@micronation/shared';
import { ok } from '@micronation/shared';
import type { Result } from '@micronation/shared';

// TODO(M1): 實作依 CONTRACT.md §market——價格優先→時間優先撮合;偏離均價 ±30% → Err('PRICE_BAND');
// 未驗證/保護期大額 → Err;部分成交允許。

export function placeOrder(
  book: MarketOrder[],
  _o: NewOrder,
  _ref: PriceRef,
  _ctx: NationCtx
): Result<{ book: MarketOrder[]; trades: Trade[] }> {
  return ok({ book, trades: [] });
}

export function cancelOrder(book: MarketOrder[], _orderId: Id, _nationId: Id): Result<{ book: MarketOrder[] }> {
  return ok({ book });
}
