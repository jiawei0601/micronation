// Hono app 骨架——/api/auth/* + M7 全路由薄殼(nation/world/build/policy/market/military/
// diplomacy/messages/rankings/tasks)+ M8 /api/admin/season + Cron Trigger scheduled handler。
// 薄殼:驗 session→組 ctx→呼叫純模塊→寫 DB。錯誤格式統一 { error: string } + 4xx。

import { Hono } from 'hono';
import type { Env } from './db/types';
import { register, login, logout, verifyEmail, resendVerification } from './auth/service';
import { ConsoleMailSender, ResendMailSender, type MailSender } from './auth/mail';
import { buildSessionCookie, buildClearSessionCookie, parseSessionTokenFromCookieHeader } from './auth/session';
import { requireSession } from './middleware/requireSession';
import { safeCompleteTask, ConflictError } from './db/repository';
import { CorruptRowError } from './db/rows';
import { parseJsonBody, asTrimmedString, asString } from './lib/parseBody';
import { checkRateLimit, clientIp } from './lib/rateLimit';
import { TICK_INTERVAL_MS } from './game/constants';
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
// register 之後 DB 只存 SHA-256 雜湊(finding #1/#13),測試沒有真的信箱可以收信。此為
// 開發/測試預設值;正式環境若設定 env.RESEND_API_KEY,實際寄信會改走 ResendMailSender
// (見下方 getMailSender,finding #21)。
export const mailSender = new ConsoleMailSender();

function getMailSender(env: Env): MailSender {
  return env.RESEND_API_KEY ? new ResendMailSender(env.RESEND_API_KEY) : mailSender;
}

// ③-2(mail fail-closed 反轉):原本只有 ENVIRONMENT==='production' 才要求 RESEND_API_KEY,
// 其餘一律(包含 ENVIRONMENT 完全沒設定的情況)靜默落回 ConsoleMailSender——這代表
// wrangler.toml/secret 設定漏掉 ENVIRONMENT=production 這一步時(部署設定疏漏,非刻意選擇),
// 正式環境的使用者會拿到一個「看起來成功、實際上信根本沒寄出」的假象(ConsoleMailSender 只是
// console.log,使用者永遠收不到驗證信)。改成白名單制:只有明確標示自己是 development 或
// test 環境時才允許用 ConsoleMailSender,其餘所有情況(含忘記設定 ENVIRONMENT 這種最危險的
// 疏漏)一律 fail closed——沒有 RESEND_API_KEY 就直接 500 MAIL_NOT_CONFIGURED,不放行任何
// 一個請求去用假寄信器蒙混過去。
const DEV_ENVIRONMENTS = new Set(['development', 'test']);
app.use('*', async (c, next) => {
  const isDevLike = c.env.ENVIRONMENT !== undefined && DEV_ENVIRONMENTS.has(c.env.ENVIRONMENT);
  if (!isDevLike && !c.env.RESEND_API_KEY) {
    throw new Error('MAIL_NOT_CONFIGURED: RESEND_API_KEY is required unless ENVIRONMENT is development or test');
  }
  await next();
});

// finding #22:register/login/verify/resend 皆為未登入可打的公開端點,是暴力嘗試/濫用最常見
// 的目標——每 IP 簡單計數,超限 429。門檻刻意設得比合理誤操作寬鬆(不希望正常使用者被誤擋),
// 只擋明顯的自動化嘗試。
const AUTH_RATE_LIMIT = { windowMs: 60_000, max: 20 };

function authRateLimited(c: { req: { header(name: string): string | undefined } }, action: string): boolean {
  const key = `${action}:${clientIp((name) => c.req.header(name))}`;
  return !checkRateLimit(key, AUTH_RATE_LIMIT);
}

app.post('/api/auth/register', async (c) => {
  if (authRateLimited(c, 'register')) return c.json({ error: 'RATE_LIMITED' }, 429);
  const body = await parseJsonBody<{ email?: string; password?: string }>(c.req);
  // ②-3/②-8/②-18:email/password 先確認 typeof==='string' 才繼續——原本的 `!body.email` 只擋
  // falsy 值,像 `{ email: 12345 }` 這種 truthy 的非字串值會直接流進 register(),normalizeEmail
  // 內部呼叫 `.trim()` 對非字串丟未預期 TypeError(500,而非乾淨的 400 INVALID_BODY)。
  const email = body ? asTrimmedString(body.email) : undefined;
  const password = body ? asString(body.password) : undefined;
  if (!email || !password) return c.json({ error: 'INVALID_BODY' }, 400);

  const now = Date.now();
  const result = await register(c.env.DB, getMailSender(c.env), email, password, now);
  if (!result.ok) return c.json({ error: result.error }, 400);
  await safeCompleteTask(c.env.DB, result.value.userId, 'register', now);
  // 註冊成功即發 session——否則前端 register→/founding 會 401(2026-08-26 上線首日實測)。
  // 重用 login() 建 session(多一次 PBKDF2 驗證,換取不繞過任何既有安全路徑)。
  const session = await login(c.env.DB, email, password, now);
  if (session.ok) {
    c.header('Set-Cookie', buildSessionCookie(session.value.sessionToken, session.value.expiresAt, now));
  }
  return c.json({ userId: result.value.userId, mailSent: result.value.mailSent }, 201);
});

// finding #16:register 寄信失敗時仍會成功建立帳號(mailSent:false)——這個端點讓使用者能
// 重新觸發寄信。冪等:找不到帳號/已驗證都直接回應,不因重複呼叫而報錯或建立額外狀態。
app.post('/api/auth/resend', async (c) => {
  if (authRateLimited(c, 'resend')) return c.json({ error: 'RATE_LIMITED' }, 429);
  const body = await parseJsonBody<{ email?: string }>(c.req);
  const email = body ? asTrimmedString(body.email) : undefined;
  if (!email) return c.json({ error: 'INVALID_BODY' }, 400);

  // ②-5:回應統一為 202,不因「帳號不存在/已驗證/剛重寄成功」而有可觀察差異——resendVerification
  // 內部邏輯不變(USER_NOT_FOUND 等仍照跑),但這裡刻意不把 err 分支轉譯成不同的 HTTP 狀態碼,
  // 避免這個公開端點被拿來當「這個 email 是否已註冊」的探測工具(user enumeration)。
  await resendVerification(c.env.DB, getMailSender(c.env), email, Date.now());
  return c.json({ ok: true }, 202);
});

app.post('/api/auth/login', async (c) => {
  if (authRateLimited(c, 'login')) return c.json({ error: 'RATE_LIMITED' }, 429);
  const body = await parseJsonBody<{ email?: string; password?: string }>(c.req);
  const email = body ? asTrimmedString(body.email) : undefined;
  const password = body ? asString(body.password) : undefined;
  if (!email || !password) return c.json({ error: 'INVALID_BODY' }, 400);

  const now = Date.now();
  const result = await login(c.env.DB, email, password, now);
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
  if (authRateLimited(c, 'verify')) return c.json({ error: 'RATE_LIMITED' }, 429);
  const body = await parseJsonBody<{ token?: string }>(c.req);
  const token = body ? asTrimmedString(body.token) : undefined;
  if (!token) return c.json({ error: 'INVALID_BODY' }, 400);

  const now = Date.now();
  const result = await verifyEmail(c.env.DB, token, now);
  if (!result.ok) return c.json({ error: result.error }, 400);
  await safeCompleteTask(c.env.DB, result.value.userId, 'verify_email', now);
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

// finding #25:統一 404——未匹配任何路由(含打錯路徑/方法)一律回同樣的 { error } 格式,
// 不落回 Hono 預設的純文字 404 body(與全站其餘錯誤回應格式不一致)。
app.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404));

// finding #4:rows.ts 的解碼層對壞資料(手改 DB/未來 migration bug 等)丟 CorruptRowError,
// 這裡統一攔截、記 log(附 table/rowId/field 供人工排查)、fail fast 回 500,不讓壞資料
// 帶著看似合法的型別繼續流進業務邏輯。其餘未預期例外一律 500 INTERNAL_ERROR,不洩漏堆疊細節。
// ②-6:回應本體一律只給 generic error + requestId,細節(table/rowId/field、完整 stack 等)
// 只寫進 console.error——原本 CorruptRowError 分支把 table/rowId/field 直接回給呼叫端,等於把
// 內部 schema 細節暴露給 HTTP 客戶端。requestId 讓維運端能把「使用者回報的這次請求」和 log 裡
// 對應的詳細錯誤兜起來,不用靠時間戳硬猜。
app.onError((err, c) => {
  const requestId = crypto.randomUUID();
  if (err instanceof ConflictError) {
    console.warn(`[conflict] ${err.message} requestId=${requestId}`);
    return c.json({ error: 'CONFLICT', requestId, retry: true }, 409);
  }
  if (err instanceof CorruptRowError) {
    console.error(`[db] corrupt row: table=${err.table} id=${err.rowId} field=${err.field} requestId=${requestId}`, err);
    return c.json({ error: 'INTERNAL_ERROR', requestId }, 500);
  }
  console.error(`[unhandled] requestId=${requestId}`, err);
  return c.json({ error: 'INTERNAL_ERROR', requestId }, 500);
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
  // finding #23/#29:用 Cron Trigger 提供的 scheduledTime(不是 Date.now())換算出「這次觸發
  // 對應哪一個整點時槽」,runTick 內部比對 seasons.last_tick_slot,同一時槽已經跑過就跳過
  // ——Cloudflare 對 scheduled handler 偶發重試(同一次觸發呼叫兩次)時不會讓 tick 多跑一次。
  const scheduledSlot =
    _event.scheduledTime !== undefined ? Math.floor(_event.scheduledTime / TICK_INTERVAL_MS) * TICK_INTERVAL_MS : undefined;
  ctx.waitUntil(
    runTick(env.DB, { now, scheduledSlot }).then((result) => {
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
