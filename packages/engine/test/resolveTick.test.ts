import { describe, it, expect } from 'vitest';
import { resolveTick, projectProduction, previewBattle } from '../src/index';
import { makeNation, makeRegion, makeWorld } from './fixtures';
import { EVENT, ACTION_POINTS_MAX, MAX_BUILDING_LEVEL } from '@micronation/shared';

describe('resolveTick determinism', () => {
  it('same (state, seed) yields the same output', () => {
    const world = makeWorld({
      nations: [makeNation({ buildings: { ...makeNation().buildings, farm: 2 } })],
    });
    const r1 = resolveTick(world, 'season-1-tick-0');
    const r2 = resolveTick(world, 'season-1-tick-0');
    expect(r1).toEqual(r2);
  });

  it('different seeds can yield different battle outcomes but not resource production (deterministic formula)', () => {
    const nation = makeNation({ buildings: { ...makeNation().buildings, farm: 3 } });
    const world = makeWorld({ nations: [nation] });
    const r1 = resolveTick(world, 'seed-a');
    const r2 = resolveTick(world, 'seed-b');
    expect(r1.state.nations[0].resources.food).toEqual(r2.state.nations[0].resources.food);
  });
});

describe('production formula (region bonus × policy × building level)', () => {
  it('projectProduction applies region bonus on top of base building output', () => {
    const nationNoBonus = makeNation({ buildings: { ...makeNation().buildings, farm: 1 }, policies: { tax: 'mid', economy: 'commerce', conscription: 'volunteer', openness: 'neutral' } });
    const flatRegion = makeRegion({ bonuses: {} });
    const bonusRegion = makeRegion({ bonuses: { food: 0.5 } });
    const base = projectProduction(nationNoBonus, flatRegion);
    const boosted = projectProduction(nationNoBonus, bonusRegion);
    expect(boosted.food).toBeGreaterThan(base.food);
  });

  it('economy policy tier changes output mix (agri boosts food, industry boosts ore)', () => {
    const region = makeRegion();
    const agriNation = makeNation({
      buildings: { ...makeNation().buildings, farm: 2, mine: 2 },
      policies: { tax: 'mid', economy: 'agri', conscription: 'volunteer', openness: 'neutral' },
    });
    const industryNation = makeNation({
      buildings: { ...makeNation().buildings, farm: 2, mine: 2 },
      policies: { tax: 'mid', economy: 'industry', conscription: 'volunteer', openness: 'neutral' },
    });
    const agriOut = projectProduction(agriNation, region);
    const industryOut = projectProduction(industryNation, region);
    expect(agriOut.food).toBeGreaterThan(industryOut.food);
    expect(industryOut.ore).toBeGreaterThan(agriOut.ore);
  });

  it('a building at level 0 contributes no output', () => {
    const nation = makeNation(); // all buildings level 0
    const out = projectProduction(nation, makeRegion());
    expect(out).toEqual({ food: 0, ore: 0, fuel: 0, money: 0 });
  });

  it('resolveTick adds produced resources into nation.resources', () => {
    const nation = makeNation({ buildings: { ...makeNation().buildings, mine: 1 } });
    const world = makeWorld({ nations: [nation] });
    const { state } = resolveTick(world, 'seed-x');
    expect(state.nations[0].resources.ore).toBeGreaterThan(0);
  });
});

describe('population growth / death spiral', () => {
  it('food surplus grows population and raises morale', () => {
    const nation = makeNation({
      population: 100,
      morale: 50,
      resources: { food: 1000, ore: 0, fuel: 0, money: 0 },
      buildings: { ...makeNation().buildings, farm: 1 },
    });
    const world = makeWorld({ nations: [nation] });
    const { state, events } = resolveTick(world, 'seed-pop-up');
    const updated = state.nations[0];
    expect(updated.population).toBeGreaterThan(100);
    expect(updated.morale).toBeGreaterThanOrEqual(50);
    expect(events.some((e) => e.type === EVENT.POPULATION_CHANGE)).toBe(true);
  });

  it('food shortage shrinks population and morale, and food floors at 0', () => {
    const nation = makeNation({ population: 1000, morale: 50, resources: { food: 0, ore: 0, fuel: 0, money: 0 } });
    const world = makeWorld({ nations: [nation] });
    const { state } = resolveTick(world, 'seed-pop-down');
    const updated = state.nations[0];
    expect(updated.population).toBeLessThan(1000);
    expect(updated.morale).toBeLessThan(50);
    expect(updated.resources.food).toBe(0);
  });

  it('death spiral floors at MIN_POPULATION and never goes below it, even after many starving ticks', () => {
    let nation = makeNation({ population: 50, morale: 10, resources: { food: 0, ore: 0, fuel: 0, money: 0 } });
    let world = makeWorld({ nations: [nation] });
    for (let i = 0; i < 50; i++) {
      const result = resolveTick(world, `seed-spiral-${i}`);
      world = { ...result.state, tick: world.tick + 1 };
    }
    expect(world.nations[0].population).toBeGreaterThanOrEqual(10);
    expect(world.nations[0].population).toBeGreaterThan(0);
  });
});

describe('build queue completion', () => {
  it('completes a queued build when completesAt <= tick and increments the building level', () => {
    const nation = makeNation({ buildQueue: [{ building: 'farm', completesAt: 5 }] });
    const world = makeWorld({ tick: 5, nations: [nation] });
    const { state, events } = resolveTick(world, 'seed-build');
    expect(state.nations[0].buildings.farm).toBe(1);
    expect(state.nations[0].buildQueue).toHaveLength(0);
    expect(events.some((e) => e.type === EVENT.BUILD_COMPLETED)).toBe(true);
  });

  it('leaves a queued build untouched when completesAt is still in the future', () => {
    const nation = makeNation({ buildQueue: [{ building: 'farm', completesAt: 10 }] });
    const world = makeWorld({ tick: 5, nations: [nation] });
    const { state } = resolveTick(world, 'seed-build-future');
    expect(state.nations[0].buildings.farm).toBe(0);
    expect(state.nations[0].buildQueue).toHaveLength(1);
  });

  it('build level is capped at MAX_BUILDING_LEVEL', () => {
    const nation = makeNation({
      buildings: { ...makeNation().buildings, farm: MAX_BUILDING_LEVEL },
      buildQueue: [{ building: 'farm', completesAt: 0 }],
    });
    const world = makeWorld({ tick: 0, nations: [nation] });
    const { state } = resolveTick(world, 'seed-build-cap');
    expect(state.nations[0].buildings.farm).toBe(MAX_BUILDING_LEVEL);
  });
});

describe('battle resolution', () => {
  it('previewBattle without a seed is deterministic and symmetric (neutral estimate)', () => {
    const strong = makeNation({ army: { size: 100 }, tech: 5, morale: 100 });
    const weak = makeNation({ army: { size: 10 }, tech: 0, morale: 50 });
    const p1 = previewBattle(strong, weak);
    const p2 = previewBattle(strong, weak);
    expect(p1).toEqual(p2);
    expect(p1.attackerWins).toBe(true);
  });

  it('resolveTick resolves an arrived march into a battle and removes the march', () => {
    const attacker = makeNation({ army: { size: 200 }, tech: 5, morale: 90 });
    const defender = makeNation({ army: { size: 10 }, tech: 0, morale: 10, resources: { food: 1000, ore: 0, fuel: 0, money: 0 } });
    const world = makeWorld({
      tick: 10,
      nations: [attacker, defender],
      marches: [{ id: 'march-1', attackerId: attacker.id, defenderId: defender.id, size: 200, departedAt: 5, arrivesAt: 10 }],
    });
    const { state, events } = resolveTick(world, 'seed-battle');
    expect(state.marches).toHaveLength(0);
    expect(events.some((e) => e.type === EVENT.BATTLE_RESOLVED)).toBe(true);
    expect(events.some((e) => e.type === EVENT.MARCH_ARRIVED)).toBe(true);
  });

  it('a march that has not arrived yet stays in state.marches untouched', () => {
    const attacker = makeNation({ army: { size: 50 } });
    const defender = makeNation({ army: { size: 50 } });
    const march = { id: 'march-2', attackerId: attacker.id, defenderId: defender.id, size: 50, departedAt: 5, arrivesAt: 20 };
    const world = makeWorld({ tick: 10, nations: [attacker, defender], marches: [march] });
    const { state } = resolveTick(world, 'seed-inflight');
    expect(state.marches).toEqual([march]);
  });

  it('loser resource loss is capped by BATTLE_LOSS_RATE_MAX and never exceeds ~25% of exposed resources', () => {
    const attacker = makeNation({ army: { size: 500 }, tech: 5, morale: 100 });
    const defender = makeNation({
      army: { size: 1 },
      tech: 0,
      morale: 0,
      resources: { food: 1000, ore: 1000, fuel: 1000, money: 1000 },
      buildings: { ...makeNation().buildings, warehouse: 0 },
    });
    const world = makeWorld({
      tick: 10,
      nations: [attacker, defender],
      marches: [{ id: 'march-3', attackerId: attacker.id, defenderId: defender.id, size: 500, departedAt: 5, arrivesAt: 10 }],
    });
    const { state } = resolveTick(world, 'seed-loss-cap');
    const updatedDefender = state.nations.find((n) => n.id === defender.id)!;
    // 損失率上限 0.25 → 至少要保留 75% 以上的初始資源
    expect(updatedDefender.resources.food).toBeGreaterThanOrEqual(1000 * 0.75 - 1);
  });

  it('warehouse-protected resources are shielded from battle loss', () => {
    const attacker = makeNation({ army: { size: 500 }, tech: 5, morale: 100 });
    const defenderUnprotected = makeNation({
      army: { size: 1 },
      population: 0, // 讓糧食消耗為 0,避免與人口耗糧混在一起干擾戰鬥損失比較
      resources: { food: 100, ore: 0, fuel: 0, money: 0 },
      buildings: { ...makeNation().buildings, warehouse: 0 },
    });
    const defenderProtected = makeNation({
      army: { size: 1 },
      population: 0,
      resources: { food: 100, ore: 0, fuel: 0, money: 0 },
      buildings: { ...makeNation().buildings, warehouse: 5 },
    });
    const worldA = makeWorld({
      tick: 10,
      nations: [attacker, defenderUnprotected],
      marches: [{ id: 'm-a', attackerId: attacker.id, defenderId: defenderUnprotected.id, size: 500, departedAt: 5, arrivesAt: 10 }],
    });
    const worldB = makeWorld({
      tick: 10,
      nations: [{ ...attacker }, defenderProtected],
      marches: [{ id: 'm-b', attackerId: attacker.id, defenderId: defenderProtected.id, size: 500, departedAt: 5, arrivesAt: 10 }],
    });
    const resA = resolveTick(worldA, 'seed-protect');
    const resB = resolveTick(worldB, 'seed-protect');
    const unprotectedFood = resA.state.nations.find((n) => n.id === defenderUnprotected.id)!.resources.food;
    const protectedFood = resB.state.nations.find((n) => n.id === defenderProtected.id)!.resources.food;
    expect(protectedFood).toBeGreaterThan(unprotectedFood);
    expect(protectedFood).toBe(100); // 全額在保護額度內,毫無損失
  });

  it('attacker pays fuel cost and suffers army losses after a battle', () => {
    const attacker = makeNation({ army: { size: 100 }, resources: { food: 0, ore: 0, fuel: 500, money: 0 }, tech: 5, morale: 90 });
    const defender = makeNation({ army: { size: 10 }, tech: 0, morale: 10 });
    const world = makeWorld({
      tick: 10,
      nations: [attacker, defender],
      marches: [{ id: 'march-4', attackerId: attacker.id, defenderId: defender.id, size: 100, departedAt: 5, arrivesAt: 10 }],
    });
    const { state } = resolveTick(world, 'seed-fuel');
    const updatedAttacker = state.nations.find((n) => n.id === attacker.id)!;
    expect(updatedAttacker.resources.fuel).toBeLessThan(500);
    expect(updatedAttacker.army.size).toBeLessThan(100);
  });

  it('cannot wipe out a nation: population stays >= MIN_POPULATION and a defeated building floors at level 1, not 0', () => {
    const attacker = makeNation({ army: { size: 1000 }, tech: 10, morale: 100 });
    const defender = makeNation({
      army: { size: 1 },
      tech: 0,
      morale: 0,
      population: 20,
      buildings: { ...makeNation().buildings, farm: 1 },
      resources: { food: 5000, ore: 0, fuel: 0, money: 0 },
    });
    const world = makeWorld({
      tick: 10,
      nations: [attacker, defender],
      marches: [{ id: 'march-5', attackerId: attacker.id, defenderId: defender.id, size: 1000, departedAt: 5, arrivesAt: 10 }],
    });
    const { state } = resolveTick(world, 'seed-no-wipe');
    const updatedDefender = state.nations.find((n) => n.id === defender.id)!;
    expect(updatedDefender.population).toBeGreaterThanOrEqual(10);
    expect(updatedDefender.buildings.farm).toBeGreaterThanOrEqual(1);
  });

  it('a protected (protectedUntil in the future) nation is still resolved by engine if a march lands — protection enforcement is military\'s job, not engine\'s', () => {
    // engine 只管抵達後的戰鬥解算;保護期檢查在 military.declareAttack 出征前完成。
    const attacker = makeNation({ army: { size: 50 } });
    const defender = makeNation({ army: { size: 50 }, protectedUntil: 999 });
    const world = makeWorld({
      tick: 10,
      nations: [attacker, defender],
      marches: [{ id: 'march-6', attackerId: attacker.id, defenderId: defender.id, size: 50, departedAt: 5, arrivesAt: 10 }],
    });
    const { events } = resolveTick(world, 'seed-protected-arrival');
    expect(events.some((e) => e.type === EVENT.BATTLE_RESOLVED)).toBe(true);
  });
});

describe('treaty expiry', () => {
  it('expires an active treaty once createdAt + duration <= tick', () => {
    const treaty = { id: 't-1', kind: 'nap' as const, aId: 'n1', bId: 'n2', status: 'active' as const, terms: { duration: 10 }, createdAt: 0 };
    const world = makeWorld({ tick: 10, treaties: [treaty] });
    const { state, events } = resolveTick(world, 'seed-treaty');
    expect(state.treaties[0].status).toBe('expired');
    expect(events.some((e) => e.type === EVENT.TREATY_EXPIRED)).toBe(true);
  });

  it('does not touch a treaty that has not yet reached its duration', () => {
    const treaty = { id: 't-2', kind: 'nap' as const, aId: 'n1', bId: 'n2', status: 'active' as const, terms: { duration: 10 }, createdAt: 5 };
    const world = makeWorld({ tick: 10, treaties: [treaty] });
    const { state } = resolveTick(world, 'seed-treaty-2');
    expect(state.treaties[0].status).toBe('active');
  });

  it('leaves a non-active treaty (e.g. proposed) untouched', () => {
    const treaty = { id: 't-3', kind: 'nap' as const, aId: 'n1', bId: 'n2', status: 'proposed' as const, terms: { duration: 10 }, createdAt: 0 };
    const world = makeWorld({ tick: 10, treaties: [treaty] });
    const { state } = resolveTick(world, 'seed-treaty-3');
    expect(state.treaties[0].status).toBe('proposed');
  });
});

describe('action points', () => {
  it('grants action points each tick up to ACTION_POINTS_MAX', () => {
    const nation = makeNation({ actionPoints: 0 });
    const world = makeWorld({ nations: [nation] });
    const { state, events } = resolveTick(world, 'seed-ap');
    expect(state.nations[0].actionPoints).toBe(1);
    expect(events.some((e) => e.type === EVENT.ACTION_POINTS_GRANTED)).toBe(true);
  });

  it('does not exceed ACTION_POINTS_MAX', () => {
    const nation = makeNation({ actionPoints: ACTION_POINTS_MAX });
    const world = makeWorld({ nations: [nation] });
    const { state, events } = resolveTick(world, 'seed-ap-cap');
    expect(state.nations[0].actionPoints).toBe(ACTION_POINTS_MAX);
    expect(events.some((e) => e.type === EVENT.ACTION_POINTS_GRANTED)).toBe(false);
  });
});

describe('scoring: warfare (win strong > win weak, farming trends to zero, NPC halved)', () => {
  function battleWorld(attackerSize: number, defenderSize: number, defenderOwnerId: string | null) {
    const attacker = makeNation({ army: { size: attackerSize }, tech: 5, morale: 90 });
    const defender = makeNation({ army: { size: defenderSize }, tech: 0, morale: 10, ownerId: defenderOwnerId });
    const world = makeWorld({
      tick: 10,
      nations: [attacker, defender],
      marches: [{ id: `m-${attackerSize}-${defenderSize}`, attackerId: attacker.id, defenderId: defender.id, size: attackerSize, departedAt: 5, arrivesAt: 10 }],
    });
    return { world, attacker, defender };
  }

  it('beating a much stronger enemy grants more warfare score than beating a much weaker one', () => {
    const strongFight = battleWorld(120, 100, 'user-owner'); // close fight, attacker still wins due to tech/morale
    const farmFight = battleWorld(1000, 5, 'user-owner'); // farming: defender trivially weak
    const r1 = resolveTick(strongFight.world, 'seed-score-strong');
    const r2 = resolveTick(farmFight.world, 'seed-score-farm');
    const scoreStrong = r1.state.nations.find((n) => n.id === strongFight.attacker.id)!.score.warfare;
    const scoreFarm = r2.state.nations.find((n) => n.id === farmFight.attacker.id)!.score.warfare;
    expect(scoreStrong).toBeGreaterThan(scoreFarm);
  });

  it('farming (defender power far below FARM_RATIO) yields warfare score close to zero', () => {
    const { world, attacker } = battleWorld(2000, 1, 'user-owner');
    const { state } = resolveTick(world, 'seed-score-farm-2');
    const score = state.nations.find((n) => n.id === attacker.id)!.score.warfare;
    expect(score).toBeLessThan(5);
  });

  it('beating an NPC grants half the warfare score of beating an equally strong player', () => {
    const vsPlayer = battleWorld(150, 100, 'user-owner');
    const vsNpc = battleWorld(150, 100, null);
    const r1 = resolveTick(vsPlayer.world, 'seed-score-vs-player');
    const r2 = resolveTick(vsNpc.world, 'seed-score-vs-npc');
    const scorePlayer = r1.state.nations.find((n) => n.id === vsPlayer.attacker.id)!.score.warfare;
    const scoreNpc = r2.state.nations.find((n) => n.id === vsNpc.attacker.id)!.score.warfare;
    expect(scoreNpc).toBeLessThan(scorePlayer);
    expect(Math.abs(scoreNpc - scorePlayer / 2)).toBeLessThanOrEqual(1); // 五折,容許四捨五入誤差
  });

  it('total score is the sum of the four breakdown components', () => {
    const nation = makeNation({ buildings: { ...makeNation().buildings, farm: 2 }, tech: 3 });
    const world = makeWorld({ nations: [nation] });
    const { state } = resolveTick(world, 'seed-score-sum');
    const s = state.nations[0].score;
    expect(s.total).toBe(s.economy + s.warfare + s.tech + s.diplomacy);
  });
});
