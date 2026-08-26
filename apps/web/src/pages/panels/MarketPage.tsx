import { useState } from 'react';
import { Card, PanelRow, StatusNotice, Tag } from '../../components/panel/PanelKit';
import { t } from '../../i18n/zh-Hant';
import { usePanelContext } from './context';
import { formatInt } from '../../lib/format';

const PAGE_SIZE = 100;

export function MarketPage() {
  const { world } = usePanelContext();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const orders = world?.orders ?? [];
  const visible = orders.slice(0, visibleCount);
  const hasMore = orders.length > visible.length;

  return (
    <div>
      <h1 className="mb-4 text-lg">{t.nav.market}</h1>
      <Card title={t.market.book}>
        {world === null ? <StatusNotice kind="loading" message={t.common.loading} /> : null}
        {world !== null && orders.length === 0 ? <StatusNotice kind="not-found" message="目前無掛單" /> : null}
        {visible.map((o) => (
          <PanelRow
            key={o.id}
            left={`${t.resources[o.kind]} · ${o.side === 'buy' ? t.market.buy : t.market.sell}`}
            right={
              <span>
                {formatInt(o.qty)} @ {formatInt(o.price)} <Tag tone={o.side === 'buy' ? 'ok' : 'war'}>{o.side}</Tag>
              </span>
            }
          />
        ))}
        {hasMore ? (
          <button
            type="button"
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            className="mt-2 w-full rounded border border-[#232a38] py-1.5 text-xs text-[#9aa4b5]"
          >
            更多(還有 {orders.length - visible.length} 筆)
          </button>
        ) : null}
      </Card>
    </div>
  );
}

export default MarketPage;
