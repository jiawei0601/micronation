// Hono app 骨架——/api/auth/* + M7 全路由薄殼(nation/world/build/policy/market/military/
// diplomacy/messages/rankings/tasks)+ M8 /api/admin/season + Cron Trigger scheduled handler。
// 薄殼:驗 session→組 ctx→呼叫純模塊→寫 DB。錯誤格式統一 { error: string } + 4xx。

import { Hono } from 'hono';
import type { Env } from './db/types';
import { register, login, logout, verifyEmail, resendVerification } from './auth/service';
import { ConsoleMailSender } from './auth/mail';
import { buildSessionCookie, buildClearSessionCookie, parseSessionTokenFromCookieHeader } from './auth/session';
import { requireSession } from './middleware/requireSession';
import { completeTask } from './db/repository';
import { CorruptRowError } from './db/rows';
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
import adminRoutes from './routes/admin';
import { runTick } from './tick/run';

const app = new Hono<{ Bindings: Env }>();
// export:整合測試(game.test.ts/tick.test.ts)用來取得最近一次寄出的驗證信明文 token——
// register 之後 DB 只存 SHA-256 雜湊(finding #1/#13),測試沒有真的信箱可以收信。
export const mailSender = new ConsoleMailSender();

app.post('/api/auth/register', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as never);
  if (!body.email || !body.password) return c.json({ error: 'INVALID_BODY' }, 400);

  const now = Date.now();
  const result = await register(c.env.DB, mailSender, body.email, body.password, now);
  if (!result.ok) return c.json({ error: result.error }, 400);
  await completeTask(c.env.DB, result.value.userId, 'register', now);
  return c.json({ userId: result.value.userId, mailSent: result.value.mailSent }, 201);
});

// finding #16:register 寄信失敗時仍會成功建立帳號(mailSent:false)——這個端點讓使用者能
// 重新觸發寄信。冪等:找不到帳號/已驗證都直接回應,不因重複呼叫而報錯或建立額外狀態。
app.post('/api/auth/resend', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as never);
  if (!body.email) return c.json({ error: 'INVALID_BODY' }, 400);

  const result = await resendVerification(c.env.DB, mailSender, body.email, Date.now());
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ mailSent: result.value.mailSent });
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as never);
  if (!body.email || !body.password) return c.json({ error: 'INVALID_BODY' }, 400);

  const now = Date.now();
  const result = await login(c.env.DB, body.email, body.password, now);
  if (!result.ok) return c.json({ error: result.error }, 401);

  // finding #20:cookie 的 Max-Age 與 session 過期時間都用同一個 `now`,不再各自呼叫
  // Date.now() 兩次(login() 內算 expiresAt 用的 now,和原本 buildSessionCookie 內部另外取的
  // now,理論上會差請求處理耗時的幾毫秒,量級雖小但語意上就是兩個不同的「現在」)。
  c.header('Set-Cookie', buildSessionCookie(result.value.sessionToken, result.value.expiresAt, now));
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
app.route('/api/admin', adminRoutes);

// finding #4:rows.ts 的解碼層對壞資料(手改 DB/未來 migration bug 等)丟 CorruptRowError,
// 這裡統一攔截、記 log(附 table/rowId/field 供人工排查)、fail fast 回 500,不讓壞資料
// 帶著看似合法的型別繼續流進業務邏輯。其餘未預期例外一律 500 INTERNAL_ERROR,不洩漏堆疊細節。
app.onError((err, c) => {
  if (err instanceof CorruptRowError) {
    console.error(`[db] corrupt row: table=${err.table} id=${err.rowId} field=${err.field}`, err);
    return c.json({ error: 'CORRUPT_ROW', table: err.table, rowId: err.rowId, field: err.field }, 500);
  }
  console.error('[unhandled]', err);
  return c.json({ error: 'INTERNAL_ERROR' }, 500);
});

export { app };

// Cron Trigger 入口(wrangler.toml [triggers] crons)——每小時整點呼叫 runTick 做一次
// 「讀-算-寫」:NPC 決策 → engine.resolveTick → 差異寫回 + events → 推進 tick;賽季到期時
// 額外寫名人堂並標記 ended。ScheduledController/ExecutionContext 型別依 duck typing 放寬,
// 理由同 db/types.ts D1Database(不依賴 @cloudflare/workers-types 也能通過型別檢查)。
export async function scheduled(
  _event: { cron?: string; scheduledTime?: number },
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void }
): Promise<void> {
  const now = Date.now();
  ctx.waitUntil(
    runTick(env.DB, { now }).then((result) => {
      if (!result.ranTick) {
        console.log(`[tick] skipped: ${result.skippedReason}`);
      } else {
        console.log(`[tick] season ${result.seasonId} advanced, ${result.eventCount} events${result.seasonEnded ? ' (season ended)' : ''}`);
      }
    })
  );
}

export default {
  fetch: app.fetch.bind(app),
  scheduled,
};

// 保留給既有測試/呼叫端引用的 placeholder(M2 scaffold 遺留)。
export function placeholder(): string {
  return 'apps/api scaffold — M7 全路由薄殼 + M8 tick-cron 已上線';
}
