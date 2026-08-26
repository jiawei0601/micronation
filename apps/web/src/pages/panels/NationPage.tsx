import { Card, Kpi, PanelRow, Tag } from '../../components/panel/PanelKit';
import { formatDelta, formatInt } from '../../lib/format';
import { t } from '../../i18n/zh-Hant';
import { usePanelContext } from './context';

export function NationPage() {
  const { world, player } = usePanelContext();

  return (
    <div>
      <h1 className="mb-4 text-lg">{t.nav.nation}</h1>
      <div className="grid grid-cols-5 gap-3">
        <Kpi label={t.resources.food} value={formatInt(12480)} delta={formatDelta(312)} />
        <Kpi label={t.resources.ore} value={formatInt(6102)} delta={formatDelta(188)} />
        <Kpi label={t.resources.fuel} value={formatInt(1845)} delta={formatDelta(-42)} />
        <Kpi label={t.resources.money} value={formatInt(28930)} delta={formatDelta(540)} />
        <Kpi label={t.resources.tech} value={formatInt(742)} delta={formatDelta(15)} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-3">
          <Card title={t.nation.population} extra={<Tag tone="ok">{t.nation.morale} 良好</Tag>}>
            <PanelRow left={`${t.nation.population} 45,210(+0.8%/tick)`} right="徵兵上限 4,500" />
          </Card>
          <Card title={t.nation.currentPolicy}>
            <PanelRow left={t.policy.axes.tax} right={<Tag>{player?.policies.tax ?? '—'}</Tag>} />
            <PanelRow left={t.policy.axes.economy} right={<Tag>{player?.policies.economy ?? '—'}</Tag>} />
            <PanelRow left={t.policy.axes.conscription} right={<Tag>{player?.policies.conscription ?? '—'}</Tag>} />
            <PanelRow left={t.policy.axes.openness} right={<Tag>{player?.policies.openness ?? '—'}</Tag>} />
          </Card>
        </div>
        <div className="space-y-3">
          <Card title={t.nation.events}>
            <PanelRow left="⚔ 鄰國動態" right={<Tag tone="war">警戒</Tag>} />
            <PanelRow left="🕊 條約提案" right={<Tag>待回覆</Tag>} />
          </Card>
          <Card title={t.nation.progress}>
            <PanelRow left="任務 11/15" right={`${t.common.tick} ${world?.tick ?? '—'}`} />
          </Card>
        </div>
      </div>
    </div>
  );
}

export default NationPage;
