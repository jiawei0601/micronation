import { Card, PanelRow, StatusNotice } from '../../components/panel/PanelKit';
import { t } from '../../i18n/zh-Hant';
import { useRankings } from '../../api/useRankings';

export function RankingsPage() {
  const { rankings, loading, error } = useRankings();
  const ranked = rankings.overall;

  return (
    <div>
      <h1 className="mb-4 text-lg">{t.nav.rankings}</h1>
      <Card title={t.rankings.overall}>
        {error ? <StatusNotice kind="error" message={error} /> : null}
        {!error && loading ? <StatusNotice kind="loading" message={t.common.loading} /> : null}
        {!error && !loading && ranked.length === 0 ? <StatusNotice kind="not-found" message="尚無排行資料" /> : null}
        {ranked.map((n, i) => (
          <PanelRow key={n.id} left={`#${i + 1} ${n.name}`} right={n.score.total} />
        ))}
      </Card>
    </div>
  );
}

export default RankingsPage;
