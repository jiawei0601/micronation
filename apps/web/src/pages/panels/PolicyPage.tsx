import { Card, PanelRow, Tag } from '../../components/panel/PanelKit';
import { t } from '../../i18n/zh-Hant';
import { usePanelContext } from './context';

type Axis = keyof typeof t.policy.axes;

const AXIS_TIERS: Record<Axis, string[]> = {
  tax: ['low', 'mid', 'high'],
  economy: ['agri', 'industry', 'commerce'],
  conscription: ['volunteer', 'draft'],
  openness: ['closed', 'neutral', 'free'],
};

export function PolicyPage() {
  const { player } = usePanelContext();

  return (
    <div>
      <h1 className="mb-4 text-lg">{t.nav.policy}</h1>
      <div className="grid grid-cols-2 gap-3">
        {(Object.keys(AXIS_TIERS) as Axis[]).map((axis) => (
          <Card key={axis} title={t.policy.axes[axis]} extra={<Tag>{t.policy.cooldown}: 無</Tag>}>
            {AXIS_TIERS[axis].map((tier) => (
              <PanelRow
                key={tier}
                left={tier}
                right={player?.policies[axis as keyof typeof player.policies] === tier ? <Tag tone="ok">現行</Tag> : <Tag>可選</Tag>}
              />
            ))}
          </Card>
        ))}
      </div>
    </div>
  );
}

export default PolicyPage;
