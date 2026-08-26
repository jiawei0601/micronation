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
  loadWorldStateVersioned,
  saveWorldState,
  claimTickLease,
  releaseTickLease,
  claimTickSlot,
  finalizeSeasonStmts,
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

/** ②-16:空國家列表防禦——理論上賽季到期時至少會有 NPC 國家,但防禦性地處理「這個賽季一個
 * 國家都沒有」的邊界情況(例如測試直接建一個沒有任何 nation 的賽季就跑到 SEASON_LENGTH_TICKS)。
 * 原本 `sortByScoreDesc(...)[0]` 在空陣列時回傳 undefined,後面 `winner.id` 會直接丟未預期的
 * TypeError,讓賽季結算整個中斷、名人堂完全沒寫入。改成沒有國家時直接回空陣列——名人堂本來就
 * 沒有任何名次可寫,合理的結果就是「沒有條目」,不是讓 runTick 拋例外。 */
function buildHallOfFameEntries(seasonId: Id, nations: Nation[]): HallOfFameEntry[] {
  if (nations.length === 0) return [];

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

  // ③-5:順序改成「先搶 tick lease,成功後才認領時槽」——原本先 claimTickSlot 再 claimTickLease
  // 時,若這次觸發搶到了時槽(標記「這個時槽已處理」)、但緊接著搶 lease 失敗(另一個 runTick
  // 呼叫,例如人工觸發與 cron 幾乎同時)返回 TICK_IN_PROGRESS,這個時槽已經被標記處理過、但
  // 其實這次呼叫完全沒有真正跑 tick——等於白白燒掉一個時槽,而真正在跑的那個呼叫的結果也不會
  // 補標記這個時槽(它認的是自己那次觸發對應的 slot,不一定是同一個值)。改成先確保拿到 lease、
  // 確定自己是唯一在跑的這一個,才去認領時槽——lease 沒搶到就直接跳過,不動 last_tick_slot;
  // slot 認領失敗(該時槽已被處理過)則釋放剛搶到的 lease 後跳過,不繼續往下跑。
  const ownerId = `owner-${Math.random().toString(36).slice(2)}-${opts.now}`;
  const claimedLease = await claimTickLease(db, seasonId, ownerId, opts.now, TICK_RUNNING_STALE_MS);
  if (!claimedLease) {
    console.log(`[tick] season ${seasonId} already has a tick in progress — skipping this run`);
    return { ranTick: false, seasonId, skippedReason: 'TICK_IN_PROGRESS' };
  }

  if (opts.scheduledSlot !== undefined) {
    const claimed = await claimTickSlot(db, seasonId, opts.scheduledSlot);
    if (!claimed) {
      // ③-5:時槽已被處理過——這次呼叫不會真正跑 tick,把剛搶到的 lease 讓出來,不留給
      // finally 塊(finally 只在進入 try 之後才會執行,這裡尚未進入 try)。
      await releaseTickLease(db, seasonId, ownerId);
      return { ranTick: false, seasonId, skippedReason: 'ALREADY_PROCESSED_SLOT' };
    }
  }

  try {
    // ③-1/③-8:state 與 prevVersion 出自同一次 season row 讀取,不再分開呼叫 getSeasonVersion。
    const loaded = await loadWorldStateVersioned(db, seasonId);
    if (!loaded) return { ranTick: false, seasonId, skippedReason: 'NO_ACTIVE_SEASON' };
    const prev = loaded.state;
    const prevVersion = loaded.version;

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

    // finding #27/②-15:「最後一 tick 的狀態落地」與「名人堂 + ended 標記」原本是兩次獨立的
    // runBatch 呼叫(即使已經調整過順序,兩次呼叫之間仍有極小窗口)。現在 saveWorldState 支援
    // extraStmts,賽季到期時把 finalizeSeasonStmts(hall_of_fame 寫入 + status='ended')併入
    // 同一個 batch,一次性原子提交——不會出現「tick 狀態已存但名人堂沒寫」或反過來的不一致。
    const seasonEnded = resolved.tick >= SEASON_LENGTH_TICKS;
    const extraStmts = seasonEnded
      ? finalizeSeasonStmts(db, seasonId, buildHallOfFameEntries(seasonId, resolved.nations), opts.now)
      : [];
    await saveWorldState(db, prev, resolved, events, opts.now, collectedTrades, prevVersion, extraStmts);

    return { ranTick: true, seasonId, seasonEnded, eventCount: events.length };
  } finally {
    // ①-7:只清除 owner 與自己相符的旗標(見 claimTickLease/releaseTickLease 註解)——若這把鎖
    // 已經因為 stale-takeover 被別的 runTick 接管,這裡不該誤放行接管者尚未跑完的那一輪。
    await releaseTickLease(db, seasonId, ownerId);
  }
}
