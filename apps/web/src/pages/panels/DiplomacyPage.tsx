import { Link } from 'react-router-dom';
import { Card, PanelRow, Tag } from '../../components/panel/PanelKit';
import { t } from '../../i18n/zh-Hant';
import { usePanelContext } from './context';

export function DiplomacyPage() {
  const { world, nation } = usePanelContext();
  // 只列自己涉入的條約(aId/bId 其一是自己),不是全世界的條約清單。
  const treaties = (world?.treaties ?? []).filter((tr) => nation && (tr.aId === nation.id || tr.bId === nation.id));

  return (
    <div>
      <h1 className="mb-4 text-lg">{t.nav.diplomacy}</h1>
      <Card title={t.diplomacy.reputation}>
        <PanelRow left={t.diplomacy.breaches} right={nation?.reputation.breaches ?? '—'} />
      </Card>
      <div className="mt-3">
        <Card title="條約清單">
          {treaties.length === 0 ? <p className="text-sm text-[#9aa4b5]">尚無條約</p> : null}
          {treaties.map((tr) => (
            <PanelRow
              key={tr.id}
              left={
                <Link to={`/treaty/${tr.id}`} className="underline decoration-dotted">
                  {t.diplomacy.kinds[tr.kind]} · {tr.aId} ↔ {tr.bId}
                </Link>
              }
              right={<Tag tone={tr.status === 'active' ? 'ok' : tr.status === 'breached' ? 'war' : 'default'}>{t.diplomacy.status[tr.status]}</Tag>}
            />
          ))}
        </Card>
      </div>
    </div>
  );
}

export default DiplomacyPage;
