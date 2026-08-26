import { Card, PanelRow, Tag } from '../../components/panel/PanelKit';
import { t } from '../../i18n/zh-Hant';
import { usePanelContext } from './context';
import { formatTicksAsDuration } from '../../lib/format';

export function MilitaryPage() {
  const { world, player } = usePanelContext();
  const marches = world?.marches ?? [];

  return (
    <div>
      <h1 className="mb-4 text-lg">{t.nav.military}</h1>
      <Card title={t.military.armySize} extra={<Tag>{player?.armySizeTier ?? '—'}</Tag>}>
        <PanelRow left={t.military.train} right="10 兵力 / money 50" />
      </Card>
      <div className="mt-3">
        <Card title={t.military.inTransit}>
          {marches.length === 0 ? <p className="text-sm text-[#9aa4b5]">無行軍中的部隊</p> : null}
          {marches.map((m) => (
            <PanelRow
              key={m.id}
              left={`${m.attackerId} → ${m.defenderId}`}
              right={
                <span>
                  {'size' in m && m.size !== undefined ? `${m.size} 兵` : m.sizeTier} ·{' '}
                  {formatTicksAsDuration(Math.max(0, m.arrivesAt - (world?.tick ?? m.arrivesAt)))}
                </span>
              }
            />
          ))}
        </Card>
      </div>
    </div>
  );
}

export default MilitaryPage;
