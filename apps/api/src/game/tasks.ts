// 教學任務鏈——12 步固定常數表,對應 CONTRACT §api「/api/tasks(教學任務鏈)」。
// 各步驟由對應路由於動作成功後呼叫 repository.completeTask 推進(冪等,見該函式註解)。

export interface TaskDef {
  key: string;
  order: number;
  title: string;
}

export const TASK_DEFS: TaskDef[] = [
  { key: 'register', order: 1, title: '註冊帳號' },
  { key: 'verify_email', order: 2, title: '驗證信箱' },
  { key: 'found_nation', order: 3, title: '建國' },
  { key: 'view_world', order: 4, title: '查看世界地圖' },
  { key: 'build_first', order: 5, title: '興建第一座建築' },
  { key: 'set_policy', order: 6, title: '調整一項政策' },
  { key: 'place_order', order: 7, title: '在市場掛出第一筆訂單' },
  { key: 'cancel_order', order: 8, title: '取消一筆掛單' },
  { key: 'propose_treaty', order: 9, title: '提出一份條約' },
  { key: 'accept_treaty', order: 10, title: '接受一份條約' },
  { key: 'declare_attack', order: 11, title: '發動第一次進攻' },
  { key: 'send_message', order: 12, title: '傳送第一封訊息' },
];
