// GET /api/rankings — 綜合 + 4 分項排行(匿名可讀,走 PublicWorldView 不洩漏私密欄位)。

import { Hono } from 'hono';
import { toPublicWorldView, type PublicNation } from '@micronation/shared';
import type { Env } from '../db/types';
import { loadActiveWorld } from '../game/state';

const TOP_N = 20;

// finding #26:同分時原本排序不穩定(Array.sort 對相等元素的相對順序在部分引擎/資料量下不保證,
// 且每次請求 nations 陣列序可能因 DB 讀取順序而抖動)——加 nation id 當 tie-breaker,讓排行榜
// 結果在同分情況下也是決定性的(同一份資料多次請求排序一致)。
function topBy(nations: readonly PublicNation[], key: keyof PublicNation['score']): PublicNation[] {
  return [...nations]
    .sort((a, b) => b.score[key] - a.score[key] || a.id.localeCompare(b.id))
    .slice(0, TOP_N);
}

const rankingsRoutes = new Hono<{ Bindings: Env }>();

rankingsRoutes.get('/', async (c) => {
  const world = await loadActiveWorld(c.env.DB);
  if (!world) return c.json({ error: 'NO_ACTIVE_SEASON' }, 400);
  const view = toPublicWorldView(world.state, null);

  return c.json({
    overall: topBy(view.nations, 'total'),
    economy: topBy(view.nations, 'economy'),
    warfare: topBy(view.nations, 'warfare'),
    tech: topBy(view.nations, 'tech'),
    diplomacy: topBy(view.nations, 'diplomacy'),
  });
});

export default rankingsRoutes;
