// POST /api/admin/season — 開新賽季(M8)。簡單 bearer token 保護(env.ADMIN_TOKEN),
// 不走玩家 session 系統。同時只允許一個 active 賽季——DB 條件式唯一索引
// (idx_seasons_one_active,見 migrations/0005_hardening2.sql)為最終防線,擋住併發開季
// (finding #10);isAuthorized 這裡的既有 in-memory 檢查只是提早失敗、省一次 DB 寫入,
// 不是唯一的正確性保證來源。

import { Hono } from 'hono';
import type { WorldState } from '@micronation/shared';
import { makeId } from '@micronation/shared';
import { generateNpcNations } from '@micronation/npc';
import type { Env } from '../db/types';
import { createSeason, getActiveSeasonId, SeasonAlreadyActiveError } from '../db/repository';
import { buildDefaultRegions, DEFAULT_NPC_COUNT } from '../game/constants';
import { parseJsonBody } from '../lib/parseBody';

const adminRoutes = new Hono<{ Bindings: Env }>();

/** finding #11:原本 `token === c.env.ADMIN_TOKEN` 是短路字元比較——長度或內容一有差異就
 * 提早 return,平均比較時間隨「與正確值相符的前綴長度」變化,理論上可被計時攻擊逐字元試出
 * token。改用固定時間比較:先比較長度(長度不同本來就不可能是同一個字串,不需要防時序—
 * 長度洩漏不算有意義的資訊),長度相同時逐字元 XOR 累加,全部比較完才判斷結果,執行時間不
 * 依賴「第幾個字元不同」。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(c: { env: Env; req: { header(name: string): string | undefined } }): boolean {
  if (!c.env.ADMIN_TOKEN) return false; // 未設定 token → 一律拒絕,不可能「沒設定就開放」
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (token === undefined) return false;
  return timingSafeEqual(token, c.env.ADMIN_TOKEN);
}

adminRoutes.post('/season', async (c) => {
  if (!isAuthorized(c)) return c.json({ error: 'UNAUTHORIZED' }, 401);

  const existing = await getActiveSeasonId(c.env.DB);
  if (existing) return c.json({ error: 'SEASON_ALREADY_ACTIVE' }, 409);

  const body = (await parseJsonBody<{ name?: string; npcCount?: number }>(c.req)) ?? {};
  const npcCount = Number.isSafeInteger(body.npcCount) && (body.npcCount as number) >= 0 ? (body.npcCount as number) : DEFAULT_NPC_COUNT;

  const now = Date.now();
  const seasonId = makeId('season', now);
  const regions = buildDefaultRegions(seasonId);
  const npcResult = generateNpcNations(npcCount, regions, `season-npc:${now}`);
  if (!npcResult.ok) return c.json({ error: npcResult.error }, 400);

  const state: WorldState = {
    seasonId,
    tick: 0,
    regions,
    nations: npcResult.value,
    marches: [],
    treaties: [],
    orders: [],
    nextMarchSeq: 0,
  };

  try {
    await createSeason(c.env.DB, body.name ?? `Season ${now}`, state, now);
  } catch (e) {
    // finding #10:in-memory 的 existing 檢查有 TOCTOU 窗口——並發請求都可能通過上面那次
    // getActiveSeasonId 檢查,真正的把關在 DB 唯一索引,這裡把它翻譯回同樣的 API 錯誤格式。
    if (e instanceof SeasonAlreadyActiveError) return c.json({ error: 'SEASON_ALREADY_ACTIVE' }, 409);
    throw e;
  }

  return c.json({ seasonId }, 201);
});

export default adminRoutes;
