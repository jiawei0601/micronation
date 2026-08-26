import { Card, PanelRow, Tag } from '../../components/panel/PanelKit';
import { t } from '../../i18n/zh-Hant';
import { usePanelContext } from './context';
import { formatInt } from '../../lib/format';

export function MarketPage() {
  const { world } = usePanelContext();

  return (
    <div>
      <h1 className="mb-4 text-lg">{t.nav.market}</h1>
      <Card title={t.market.book}>
        {(world?.orders ?? []).map((o) => (
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
        {(world?.orders ?? []).length === 0 ? <p className="text-sm text-[#9aa4b5]">{t.common.loading}</p> : null}
      </Card>
    </div>
  );
}

export default MarketPage;
