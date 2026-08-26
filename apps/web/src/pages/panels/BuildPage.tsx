import { Bar, Card, PanelRow } from '../../components/panel/PanelKit';
import { t } from '../../i18n/zh-Hant';

const BUILDINGS = [
  { key: 'farm', label: '農場', level: 3 },
  { key: 'mine', label: '礦場', level: 2 },
  { key: 'refinery', label: '煉油廠', level: 1 },
  { key: 'market', label: '市場', level: 1 },
  { key: 'barracks', label: '兵營', level: 5 },
  { key: 'warehouse', label: '倉庫', level: 3 },
  { key: 'university', label: '大學', level: 4 },
  { key: 'wall', label: '城牆', level: 0 },
];

export function BuildPage() {
  return (
    <div>
      <h1 className="mb-4 text-lg">{t.nav.build}</h1>
      <div className="grid grid-cols-2 gap-3">
        {BUILDINGS.map((b) => (
          <Card key={b.key} title={`${b.label} Lv.${b.level}`}>
            <Bar percent={(b.level / 5) * 100} />
            <PanelRow left="升級所需" right="money 600 / ore 60" />
            <PanelRow left="耗時" right="12 tick" />
          </Card>
        ))}
      </div>
    </div>
  );
}

export default BuildPage;
