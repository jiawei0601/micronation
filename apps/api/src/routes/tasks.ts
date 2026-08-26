// GET /api/tasks — 教學任務鏈進度(12 步定義見 game/tasks.ts)。

import { Hono } from 'hono';
import type { Env } from '../db/types';
import { requireSession } from '../middleware/requireSession';
import { getUserTaskRows } from '../db/repository';
import { TASK_DEFS } from '../game/tasks';

const tasksRoutes = new Hono<{ Bindings: Env }>();

tasksRoutes.get('/', requireSession, async (c) => {
  const { user } = c.get('session');
  const rows = await getUserTaskRows(c.env.DB, user.id);
  const byKey = new Map(rows.map((r) => [r.task_key, r]));

  const tasks = TASK_DEFS.map((def) => {
    const row = byKey.get(def.key);
    return {
      key: def.key,
      order: def.order,
      title: def.title,
      completed: row?.completed_at !== undefined && row?.completed_at !== null,
      completedAt: row?.completed_at ?? null,
    };
  });

  return c.json({ tasks });
});

export default tasksRoutes;
