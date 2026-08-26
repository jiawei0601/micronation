import { Bar, Card, PanelRow, Tag } from '../../components/panel/PanelKit';
import { t } from '../../i18n/zh-Hant';

const TASKS = [
  '開國:建立第一座農場',
  '學會建設佇列',
  '學會市場掛單',
  '學會出兵與行軍',
  '簽署首個貿易協定',
];

export function TasksPage() {
  return (
    <div>
      <h1 className="mb-4 text-lg">{t.tasks.title}</h1>
      <Card title="進度 11/15">
        <Bar percent={(11 / 15) * 100} color="#3fb950" />
        {TASKS.map((task, i) => (
          <PanelRow key={task} left={task} right={i < 4 ? <Tag tone="ok">{t.tasks.completed}</Tag> : <Tag>進行中</Tag>} />
        ))}
      </Card>
    </div>
  );
}

export default TasksPage;
