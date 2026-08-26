import type { MiddlewareHandler } from 'hono';
import type { Env } from '../db/types';
import { parseSessionTokenFromCookieHeader } from '../auth/session';
import { resolveSession, type SessionContext } from '../auth/service';

declare module 'hono' {
  interface ContextVariableMap {
    session: SessionContext;
  }
}

/** 驗 session cookie,失敗回 401 { error }。通過後 c.get('session') 可取 { session, user }。 */
export const requireSession: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = parseSessionTokenFromCookieHeader(c.req.header('Cookie'));
  const ctx = await resolveSession(c.env.DB, token, Date.now());
  if (!ctx) return c.json({ error: 'UNAUTHORIZED' }, 401);
  c.set('session', ctx);
  await next();
};
