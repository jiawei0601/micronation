import { describe, it, expect } from 'vitest';
import { createTestD1 } from './support/sqliteD1Adapter';
import { createSeason, loadWorldState, saveWorldState } from '../src/db/repository';
import { makeWorld, makeNation, makeTreaty, makeMarch, makeOrder } from './support/fixtures';

describe('repository — world round-trip', () => {
  it('存入 WorldState 讀回 deep-equal(含 nations 全欄位)', async () => {
    const db = createTestD1();
    const world = makeWorld({
      nations: [makeNation()],
      treaties: [makeTreaty()],
      marches: [makeMarch()],
      orders: [makeOrder()],
    });

    await createSeason(db, 'Season 1', world, 1000);
    const loaded = await loadWorldState(db, world.seasonId);

    expect(loaded).toEqual(world);
  });

  it('nation 缺 lastAttackedAt(optional)round-trip 仍正確', async () => {
    const db = createTestD1();
    const nation = makeNation();
    delete nation.lastAttackedAt;
    const world = makeWorld({ nations: [nation] });

    await createSeason(db, 'Season 1', world, 0);
    const loaded = await loadWorldState(db, world.seasonId);

    expect(loaded?.nations[0]).toEqual(nation);
    expect(loaded?.nations[0].lastAttackedAt).toBeUndefined();
  });

  it('saveWorldState 差異寫回:新增/變更/刪除都正確反映', async () => {
    const db = createTestD1();
    const n1 = makeNation({ id: 'nation-1' });
    const world0 = makeWorld({ nations: [n1], nextMarchSeq: 0 });
    await createSeason(db, 'Season 1', world0, 0);

    // tick 1:n1 資源變了(變更)、新增 n2、無刪除
    const n1Changed = makeNation({ id: 'nation-1', resources: { food: 999, ore: 20, fuel: 30, money: 40 } });
    const n2 = makeNation({ id: 'nation-2', ownerId: 'user-2' });
    const world1 = makeWorld({ tick: 1, nations: [n1Changed, n2], nextMarchSeq: 1 });
    await saveWorldState(db, world0, world1, [], 0);

    const afterTick1 = await loadWorldState(db, world0.seasonId);
    expect(afterTick1?.tick).toBe(1);
    expect(afterTick1?.nations).toHaveLength(2);
    expect(afterTick1?.nations.find((n) => n.id === 'nation-1')?.resources.food).toBe(999);

    // tick 2:n1 被滅(刪除),只剩 n2
    const world2 = makeWorld({ tick: 2, nations: [n2], nextMarchSeq: 1 });
    await saveWorldState(db, world1, world2, [], 0);

    const afterTick2 = await loadWorldState(db, world0.seasonId);
    expect(afterTick2?.nations).toHaveLength(1);
    expect(afterTick2?.nations[0].id).toBe('nation-2');
  });

  it('saveWorldState 寫入的 events 可查回(events 只增不改)', async () => {
    const db = createTestD1();
    const world0 = makeWorld();
    await createSeason(db, 'Season 1', world0, 0);

    await saveWorldState(db, world0, { ...world0, tick: 1 }, [
      { tick: 1, type: 'production_tick', nationIds: ['nation-1'], payload: { foo: 'bar' } },
    ], 500);

    const rows = await db.prepare('SELECT * FROM events WHERE season_id = ?').bind(world0.seasonId).all();
    expect(rows.results).toHaveLength(1);
    const row = rows.results[0] as { type: string; payload: string; tick: number };
    expect(row.type).toBe('production_tick');
    expect(row.tick).toBe(1);
    expect(JSON.parse(row.payload)).toEqual({ foo: 'bar' });
  });

  it('loadWorldState 對不存在的 seasonId 回傳 null', async () => {
    const db = createTestD1();
    expect(await loadWorldState(db, 'no-such-season')).toBeNull();
  });
});
