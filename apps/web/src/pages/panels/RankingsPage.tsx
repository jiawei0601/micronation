import { Card, PanelRow } from '../../components/panel/PanelKit';
import { t } from '../../i18n/zh-Hant';
import { usePanelContext } from './context';

export function RankingsPage() {
  const { world } = usePanelContext();
  const ranked = [...(world?.nations ?? [])].sort((a, b) => b.score.total - a.score.total);

  return (
    <div>
      <h1 className="mb-4 text-lg">{t.nav.rankings}</h1>
      <Card title={t.rankings.overall}>
        {ranked.map((n, i) => (
          <PanelRow key={n.id} left={`#${i + 1} ${n.name}`} right={n.score.total} />
        ))}
        {ranked.length === 0 ? <p className="text-sm text-[#9aa4b5]">{t.common.loading}</p> : null}
      </Card>
    </div>
  );
}

export default RankingsPage;
