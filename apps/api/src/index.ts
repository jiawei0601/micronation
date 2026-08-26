// Hono app 骨架——/api/auth/* + M7 全路由薄殼(nation/world/build/policy/market/military/
// diplomacy/messages/rankings/tasks)。薄殼:驗 session→組 ctx→呼叫純模塊→寫 DB。
// 錯誤格式統一 { error: string } + 4xx。

import { Hono } from 'hono';
import type { Env } from './db/types';
import { register, login, logout, verifyEmail } from './auth/service';
import { ConsoleMailSender } from './auth/mail';
import { buildSessionCookie, buildClearSessionCookie, parseSessionTokenFromCookieHeader } from './auth/session';
import { requireSession } from './middleware/requireSession';
import { completeTask } from './db/repository';
import nationRoutes from './routes/nation';
import worldRoutes from './routes/world';
import buildRoutes from './routes/build';
import policyRoutes from './routes/policy';
import marketRoutes from './routes/market';
import militaryRoutes from './routes/military';
import diplomacyRoutes from './routes/diplomacy';
import messagesRoutes from './routes/messages';
import rankingsRoutes from './routes/rankings';
import tasksRoutes from './routes/tasks';

const app = new Hono<{ Bindings: Env }>();
const mailSender = new ConsoleMailSender();

app.post('/api/auth/register', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as never);
  if (!body.email || !body.password) return c.json({ error: 'INVALID_BODY' }, 400);

  const now = Date.now();
  const result = await register(c.env.DB, mailSender, body.email, body.password, now);
  if (!result.ok) return c.json({ error: result.error }, 400);
  await completeTask(c.env.DB, result.value.userId, 'register', now);
  return c.json({ userId: result.value.userId }, 201);
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as never);
  if (!body.email || !body.password) return c.json({ error: 'INVALID_BODY' }, 400);

  const result = await login(c.env.DB, body.email, body.password, Date.now());
  if (!result.ok) return c.json({ error: result.error }, 401);

  c.header('Set-Cookie', buildSessionCookie(result.value.sessionToken, result.value.expiresAt));
  return c.json({ userId: result.value.userId });
});

app.post('/api/auth/logout', async (c) => {
  const token = parseSessionTokenFromCookieHeader(c.req.header('Cookie'));
  if (token) await logout(c.env.DB, token);
  c.header('Set-Cookie', buildClearSessionCookie());
  return c.json({ ok: true });
});

app.post('/api/auth/verify', async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as never);
  if (!body.token) return c.json({ error: 'INVALID_BODY' }, 400);

  const now = Date.now();
  const result = await verifyEmail(c.env.DB, body.token, now);
  if (!result.ok) return c.json({ error: result.error }, 400);
  await completeTask(c.env.DB, result.value.userId, 'verify_email', now);
  return c.json({ ok: true });
});

// 範例受保護路由,示範 requireSession 用法(供其他路由沿用)。
app.get('/api/auth/me', requireSession, async (c) => {
  const { user } = c.get('session');
  return c.json({ userId: user.id, email: user.email, verified: !!user.verified });
});

app.route('/api/nation', nationRoutes);
app.route('/api/world', worldRoutes);
app.route('/api/build', buildRoutes);
app.route('/api/policy', policyRoutes);
app.route('/api/market', marketRoutes);
app.route('/api/military', militaryRoutes);
app.route('/api/diplomacy', diplomacyRoutes);
app.route('/api/messages', messagesRoutes);
app.route('/api/rankings', rankingsRoutes);
app.route('/api/tasks', tasksRoutes);

export default app;

// 保留給既有測試/呼叫端引用的 placeholder(M2 scaffold 遺留)。
export function placeholder(): string {
  return 'apps/api scaffold — M7 全路由薄殼已上線,M8 待接 tick-cron';
}
