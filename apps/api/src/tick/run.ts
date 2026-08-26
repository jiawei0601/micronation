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

import type { Id, Nation, NpcAction, ScoreBreakdown, Trade, WorldState } from '@micronation/shared';
import { toPublicWorldView } from '@micronation/shared';
import { decideActions } from '@micronation/npc';
import { resolveTick } from '@micronation/engine';
import type { D1Database } from '../db/types';
import {
  getActiveSeasonId,
  loadWorldState,
  saveWorldState,
  getSeasonTickRunningState,
  setSeasonTickRunning,
  finalizeSeason,
  getSeasonLastTickSlot,
  setSeasonLastTickSlot,
  TICK_RUNNING_STALE_MS,
  type HallOfFameEntry,
} from '../db/repository';
import { applyBuild, applyPlaceOrder, applyTrain } from '../game/actions';
import { SEASON_LENGTH_TICKS } from '../game/constants';

export interface RunTickOptions {
  now: number;
  /** finding #23/#29:Cron Trigger 的 scheduledTime 換算出的「目標 tick 時槽」——同一時槽已經
   * 跑過就跳過(冪等),避免 Cloudflare 對同一次觸發偶發重試造成一小時內跑兩次 tick。
   * 未提供(例如測試直接呼叫 runTick)時不做這項冪等檢查,行為與原本相同。 */
  scheduledSlot?: number;
}

export interface RunTickResult {
  ranTick: boolean;
  seasonId?: Id;
  skippedReason?: 'NO_ACTIVE_SEASON' | 'TICK_IN_PROGRESS' | 'ALREADY_PROCESSED_SLOT';
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
): Promise<{ state: WorldState; trades: Trade[] }> {
  switch (action.type) {
    case 'build': {
      const result = applyBuild(state, nation, action.building);
      return { state: result.ok ? result.value.state : state, trades: [] };
    }
    case 'placeOrder': {
      // NPC 視為 verified:true——市場的未驗證量上限是防真人小額帳號亂掛單的反濫用機制,
      // 不適用於治理規則固定、無法「驗證信箱」的 NPC(NPC 的 protectedUntil 恆為 0,亦不受
      // 保護期量上限限制)。
      const result = await applyPlaceOrder(db, state, seasonId, nation, action.order, true);
      return result.ok ? { state: result.value.state, trades: result.value.trades } : { state, trades: [] };
    }
    case 'train': {
      const result = applyTrain(state, nation, action.size);
      return { state: result.ok ? result.value.state : state, trades: [] };
    }
    case 'setPolicy':
      // decideActions(packages/npc)目前四條規則不會產生 setPolicy——NpcAction 型別聯集
      // 保留它是為了與玩家 API 語意對齊、供未來擴充,這裡安全忽略而非拋錯。
      return { state, trades: [] };
    default:
      return { state, trades: [] };
  }
}

/** finding #32:同分時的名次(尤其 total 常見同分,例如都還是初始值)須決定性排序,
 * 否則同一批資料兩次結算可能排出不同的第一名——加 nation id 當 tie-breaker(呼應
 * routes/rankings.ts finding #26 的同一原則)。 */
function sortByScoreDesc<T extends { id: Id }>(nations: T[], key: (n: T) => number): T[] {
  return [...nations].sort((a, b) => key(b) - key(a) || a.id.localeCompare(b.id));
}

function buildHallOfFameEntries(seasonId: Id, nations: Nation[]): HallOfFameEntry[] {
  const entries: HallOfFameEntry[] = [];

  const byTotal = sortByScoreDesc(nations, (n) => n.score.total).slice(0, 3);
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
    const winner = sortByScoreDesc(nations, (n) => n.score[category])[0];
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

  return entries;
}

/** tick-cron 唯一入口——Cron Trigger(見 wrangler.toml `scheduled`)與測試都呼叫這個函式。
 * 一次「讀-算-寫」:NPC 決策套用在讀到的 prev 快照之上,resolveTick 之後單一 saveWorldState
 * 差異寫回。 */
export async function runTick(db: D1Database, opts: RunTickOptions): Promise<RunTickResult> {
  const seasonId = await getActiveSeasonId(db);
  if (!seasonId) return { ranTick: false, skippedReason: 'NO_ACTIVE_SEASON' };

  // finding #23/#29:同一 Cron 時槽已經跑過就跳過(冪等)——在拿 tick_running 鎖之前先判斷,
  // 避免 Cloudflare 偶發重試同一次觸發時白搶一次鎖又立刻放掉。
  if (opts.scheduledSlot !== undefined) {
    const lastSlot = await getSeasonLastTickSlot(db, seasonId);
    if (lastSlot !== null && lastSlot >= opts.scheduledSlot) {
      return { ranTick: false, seasonId, skippedReason: 'ALREADY_PROCESSED_SLOT' };
    }
  }

  // finding #28:tick_running 旗標若已在跑「且未逾時」才視為重入,擋下本輪；若旗標雖然是 true
  // 但已超過 TICK_RUNNING_STALE_MS 沒更新(前一輪 runTick 中途被強制終止、finally 沒機會清
  // 旗標),視為 stale、本輪可以接管——否則旗標會卡死,永遠擋住後續所有 tick 與玩家寫入路由。
  const { running, since } = await getSeasonTickRunningState(db, seasonId);
  const stale = running && since !== null && opts.now - since > TICK_RUNNING_STALE_MS;
  if (running && !stale) {
    console.log(`[tick] season ${seasonId} already has a tick in progress — skipping this run`);
    return { ranTick: false, seasonId, skippedReason: 'TICK_IN_PROGRESS' };
  }
  if (stale) {
    console.warn(`[tick] season ${seasonId} tick_running flag was stale (since=${since}) — taking over`);
  }

  await setSeasonTickRunning(db, seasonId, true, opts.now);
  try {
    const prev = await loadWorldState(db, seasonId);
    if (!prev) return { ranTick: false, seasonId, skippedReason: 'NO_ACTIVE_SEASON' };

    let working = prev;
    const seed = `${seasonId}:${prev.tick}`;
    const collectedTrades: Trade[] = [];

    // NPC 決策——逐國執行,每個動作都立即套用到 working,讓下一個 NPC/下一個動作看到最新狀態
    // (與玩家連續請求時每筆都各自 loadActiveWorld 的即時性一致)。
    // finding #30:npcNations 只用來取得「有哪些 NPC id」這份清單本身不變,但每個 NPC 決策
    // (decideActions)與套用動作前都要重新從 working 撈最新的 Nation 物件——不能沿用迴圈開頭
    // filter 出的舊 nation 參照,那份參照是「本 tick 開始前」的快照,前面其他 NPC 的動作(例如
    // 市場成交影響到這個 NPC 的資源)不會反映在裡面。
    const npcIds = working.nations.filter((n) => n.ownerId === null).map((n) => n.id);
    for (const npcId of npcIds) {
      const currentNation = working.nations.find((n) => n.id === npcId);
      if (!currentNation) continue; // 資料不一致防禦性跳過,不阻斷其他 NPC
      const view = toPublicWorldView(working, currentNation.id);
      const actions = decideActions(currentNation, view, seed);
      for (const action of actions) {
        const latestNation = working.nations.find((n) => n.id === npcId);
        if (!latestNation) break; // 資料不一致防禦性跳過,不阻斷其他 NPC
        const result = await applyNpcAction(db, working, seasonId, latestNation, action);
        working = result.state;
        collectedTrades.push(...result.trades);
      }
    }

    const { state: resolved, events } = resolveTick(working, seed);

    // finding #27:先把「最後一 tick 的狀態」落地(saveWorldState),成功之後才寫名人堂+標記
    // ended——原本順序反過來時,若 saveWorldState 中途失敗,DB 會出現「名人堂已經寫了,但
    // 對應的最終分數/資源其實沒真的存進去」這種不一致。hall_of_fame 寫入與
    // seasons.status='ended' 合成單一 batch(finalizeSeason)一起原子提交。
    await saveWorldState(db, prev, resolved, events, opts.now, collectedTrades);
    if (opts.scheduledSlot !== undefined) await setSeasonLastTickSlot(db, seasonId, opts.scheduledSlot);

    let seasonEnded = false;
    if (resolved.tick >= SEASON_LENGTH_TICKS) {
      seasonEnded = true;
      const entries = buildHallOfFameEntries(seasonId, resolved.nations);
      await finalizeSeason(db, seasonId, entries, opts.now);
    }

    return { ranTick: true, seasonId, seasonEnded, eventCount: events.length };
  } finally {
    await setSeasonTickRunning(db, seasonId, false, opts.now);
  }
}
