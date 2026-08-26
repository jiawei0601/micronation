// GameEvent.type 常數表——集中管理,避免各模塊各寫各的字串。

export const EVENT = {
  PRODUCTION_TICK: 'production_tick',
  POPULATION_CHANGE: 'population_change',
  MORALE_CHANGE: 'morale_change',
  BUILD_QUEUED: 'build_queued',
  BUILD_COMPLETED: 'build_completed',
  MARCH_DEPARTED: 'march_departed',
  MARCH_ARRIVED: 'march_arrived',
  BATTLE_RESOLVED: 'battle_resolved',
  FARMING_BLOCKED: 'farming_blocked',
  TREATY_PROPOSED: 'treaty_proposed',
  TREATY_COUNTERED: 'treaty_countered',
  TREATY_ACTIVATED: 'treaty_activated',
  TREATY_EXPIRED: 'treaty_expired',
  TREATY_BREACHED: 'treaty_breached',
  TREATY_REJECTED: 'treaty_rejected',
  ORDER_PLACED: 'order_placed',
  ORDER_CANCELLED: 'order_cancelled',
  TRADE_EXECUTED: 'trade_executed',
  ACTION_POINTS_GRANTED: 'action_points_granted',
  SCORE_UPDATED: 'score_updated',
  PROTECTION_EXPIRED: 'protection_expired',
} as const;

export type EventType = (typeof EVENT)[keyof typeof EVENT];
