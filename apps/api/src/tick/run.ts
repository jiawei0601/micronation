// M8 tick-cron 核心——每小時一次:讀 active season 的 WorldState → NPC 決策(逐國,走與
// 玩家 route 相同的內部處理函式,見 ../game/actions.ts)→ engine.resolveTick → 差異寫回 +
// events → 推進 seasons.tick;賽季到期時額外寫名人堂並標記 ended。
//
// ⚠️競態緩解與殘餘風險(CONTRACT §db/auth/api/tick-cron 交辦第 4 點):
// - runTick 開頭讀 seasons.tick_running,若已是 true 則直接跳過本輪並 log,不重入。
// - 玩家寫入路由(build/policy/market/military/diplomacy/nation)在 loadActiveWorld 後、
//   套用變更前檢查同一旗標,進行中回 503 { error: 'TICK_IN_PROGRESS' }。
// - 殘餘風險(TOCTOU):旗標檢查與實際寫入之間仍有間隙——玩家路由讀到 tickRunning=false
//   後、真正呼叫 persistWorld 前,tick-cron 有極小機率插隊完成一整輪(setSeasonTickRunning(true)
//   → runTick 主體 → setSeasonTickRunning(false))並覆蓋掉玩家這筆請求所依據的舊快照,導致玩家
//   的 diff 寫回把 tick 已經算出的新狀態覆蓋回去。真正解法需要 D1 原生 transaction 或樂觀鎖
//   version 欄位(game/state.ts persistWorld 註解已提過同類限制),留待流量證實有感前不處理。
// - runTick 本身非單一 D1 transaction:NPC 動作套用中每筆 placeOrder 都有獨立的 seq/trades
//   DB 呼叫(沿用 routes/market.ts 既有模式),只有最終 saveWorldState 是單一 batch。若 runTick
//   中途拋例外,已發生的 seq 遞增/trades 寫入不會回滾,但 finally 仍會清 tick_running 旗標,
//   避免旗標卡死鎖住整個賽季——即使代價是可能留下少量不一致的 seq/trades(下次 tick 或人工
//   排查再處理,非本次任務範圍)。

import type { Id, Nation, NpcAction, ScoreBreakdown, WorldState } from '@micronation/shared';
import { toPublicWorldView } from '@micronation/shared';
import { decideActions } from '@micronation/npc';
import { resolveTick } from '@micronation/engine';
import type { D1Database } from '../db/types';
import {
  getActiveSeasonId,
  loadWorldState,
  saveWorldState,
  getSeasonTickRunning,
  setSeasonTickRunning,
  markSeasonEnded,
  insertHallOfFameEntries,
  type HallOfFameEntry,
} from '../db/repository';
import { applyBuild, applyPlaceOrder, applyTrain } from '../game/actions';
import { SEASON_LENGTH_TICKS } from '../game/constants';

export interface RunTickOptions {
  now: number;
}

export interface RunTickResult {
  ranTick: boolean;
  seasonId?: Id;
  skippedReason?: 'NO_ACTIVE_SEASON' | 'TICK_IN_PROGRESS';
  seasonEnded?: boolean;
  eventCount?: number;
}

/** 套用單一 NpcAction,走與玩家 route 完全相同的 game/actions.ts 函式——不複製任何驗證/扣款邏輯。
 * 動作不合法(資源不足/佇列已滿等)時安全略過、不中斷本 tick 其餘動作,呼應 npc.decideActions
 * 本身已用影子狀態確保「這批動作合計可行」,這裡的 Err 分支理論上不該常態觸發。 */
async function applyNpcAction(
  db: D1Database,
  state: WorldState,
  seasonId: Id,
  nation: Nation,
  action: NpcAction
): Promise<WorldState> {
  switch (action.type) {
    case 'build': {
      const result = applyBuild(state, nation, action.building);
      return result.ok ? result.value.state : state;
    }
    case 'placeOrder': {
      // NPC 視為 verified:true——市場的未驗證量上限是防真人小額帳號亂掛單的反濫用機制,
      // 不適用於治理規則固定、無法「驗證信箱」的 NPC(NPC 的 protectedUntil 恆為 0,亦不受
      // 保護期量上限限制)。
      const result = await applyPlaceOrder(db, state, seasonId, nation, action.order, true);
      return result.ok ? result.value.state : state;
    }
    case 'train': {
      const result = applyTrain(state, nation, action.size);
      return result.ok ? result.value.state : state;
    }
    case 'setPolicy':
      // decideActions(packages/npc)目前四條規則不會產生 setPolicy——NpcAction 型別聯集
      // 保留它是為了與玩家 API 語意對齊、供未來擴充,這裡安全忽略而非拋錯。
      return state;
    default:
      return state;
  }
}

async function writeHallOfFame(db: D1Database, seasonId: Id, nations: Nation[], now: number): Promise<void> {
  if (nations.length === 0) return;

  const entries: HallOfFameEntry[] = [];

  const byTotal = [...nations].sort((a, b) => b.score.total - a.score.total).slice(0, 3);
  byTotal.forEach((n, i) => {
    entries.push({
      seasonId,
      nationId: n.id,
      nationName: n.name,
      ownerId: n.ownerId,
      finalScore: n.score,
      rank: i + 1,
      category: null,
    });
  });

  const categories: (keyof ScoreBreakdown)[] = ['economy', 'warfare', 'tech', 'diplomacy'];
  for (const category of categories) {
    const winner = [...nations].sort((a, b) => b.score[category] - a.score[category])[0];
    entries.push({
      seasonId,
      nationId: winner.id,
      nationName: winner.name,
      ownerId: winner.ownerId,
      finalScore: winner.score,
      rank: 1,
      category,
    });
  }

  await insertHallOfFameEntries(db, entries, now);
}

/** tick-cron 唯一入口——Cron Trigger(見 wrangler.toml `scheduled`)與測試都呼叫這個函式。
 * 一次「讀-算-寫」:NPC 決策套用在讀到的 prev 快照之上,resolveTick 之後單一 saveWorldState
 * 差異寫回。 */
export async function runTick(db: D1Database, opts: RunTickOptions): Promise<RunTickResult> {
  const seasonId = await getActiveSeasonId(db);
  if (!seasonId) return { ranTick: false, skippedReason: 'NO_ACTIVE_SEASON' };

  const alreadyRunning = await getSeasonTickRunning(db, seasonId);
  if (alreadyRunning) {
    console.log(`[tick] season ${seasonId} already has a tick in progress — skipping this run`);
    return { ranTick: false, seasonId, skippedReason: 'TICK_IN_PROGRESS' };
  }

  await setSeasonTickRunning(db, seasonId, true);
  try {
    const prev = await loadWorldState(db, seasonId);
    if (!prev) return { ranTick: false, seasonId, skippedReason: 'NO_ACTIVE_SEASON' };

    let working = prev;
    const seed = `${seasonId}:${prev.tick}`;

    // NPC 決策——逐國執行,每個動作都立即套用到 working,讓下一個 NPC/下一個動作看到最新狀態
    // (與玩家連續請求時每筆都各自 loadActiveWorld 的即時性一致)。
    const npcNations = working.nations.filter((n) => n.ownerId === null);
    for (const npc of npcNations) {
      const view = toPublicWorldView(working, npc.id);
      const actions = decideActions(npc, view, seed);
      for (const action of actions) {
        const currentNation = working.nations.find((n) => n.id === npc.id);
        if (!currentNation) break; // 資料不一致防禦性跳過,不阻斷其他 NPC
        working = await applyNpcAction(db, working, seasonId, currentNation, action);
      }
    }

    const { state: resolved, events } = resolveTick(working, seed);

    let seasonEnded = false;
    if (resolved.tick >= SEASON_LENGTH_TICKS) {
      seasonEnded = true;
      await writeHallOfFame(db, seasonId, resolved.nations, opts.now);
      await markSeasonEnded(db, seasonId, opts.now);
    }

    await saveWorldState(db, prev, resolved, events, opts.now);

    return { ranTick: true, seasonId, seasonEnded, eventCount: events.length };
  } finally {
    await setSeasonTickRunning(db, seasonId, false);
  }
}
