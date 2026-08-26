// Codex 六審 apps/api findings 回歸測試:auth/service.ts resendVerification 併發競態。
// 修復前(cleanupVerificationTokensKeepingLatest 不分 pending/delivered、一律以 seq 排序砍到
// 剩最新 keepMax 筆)這裡的第一個案例會紅。

import { describe, it, expect } from 'vitest';
import { createTestD1 } from './support/sqliteD1Adapter';
import {
  insertVerificationTokenAtomic,
  markVerificationTokenDelivered,
  cleanupVerificationTokensKeepingLatest,
  deleteVerificationTokenByHash,
  findVerificationToken,
  VERIFICATION_TOKEN_KEEP_MAX,
} from '../src/db/repository';
import { verifyEmail } from '../src/auth/service';
import { sha256Hex } from '../src/auth/password';

describe('Codex 六審 — 併發 resend 競態:pending token 不會被其他並發 resend 的 cap cleanup 誤刪', () => {
  it('A 插入 token 但寄信延遲(仍 pending)期間,另外 5 次 resend 完成並各自 cleanup:A 的 token 仍存在且 verifyEmail 可用', async () => {
    const db = createTestD1();
    await db
      .prepare(
        'INSERT INTO users (id, email, password_hash, password_salt, password_iterations, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind('user-race', 'race@example.com', 'h', 's', 1, 0, 0)
      .run();

    // A:插入 token,但寄信卡住,還沒有 markVerificationTokenDelivered——維持 pending 狀態。
    // verifyEmail 收的是明文 token、內部自行 sha256 後查表,插入時要落地雜湊值,不是明文。
    const tokenAPlain = 'tok-A-pending';
    const tokenA = await sha256Hex(tokenAPlain);
    await insertVerificationTokenAtomic(db, { token_hash: tokenA, user_id: 'user-race', expires_at: 999_999, created_at: 0 }, 0);

    // 期間發生 VERIFICATION_TOKEN_KEEP_MAX 次(=5)以上的 resend,每次都寄信成功並立刻 cleanup。
    // 若 cleanup 不分 pending/delivered,依 seq 排序保留最新 keepMax 筆,A(seq 最舊)會被砍掉。
    for (let i = 1; i <= VERIFICATION_TOKEN_KEEP_MAX; i++) {
      const hash = `tok-concurrent-${i}`;
      await insertVerificationTokenAtomic(db, { token_hash: hash, user_id: 'user-race', expires_at: 999_999, created_at: i }, i);
      await markVerificationTokenDelivered(db, hash, i);
      await cleanupVerificationTokensKeepingLatest(db, 'user-race', hash);
    }

    // A 的 token(仍是 pending)必須還在——不因為它比其他 5 筆 delivered token 舊就被淘汰。
    const rowA = await findVerificationToken(db, tokenA);
    expect(rowA).not.toBeNull();
    expect(rowA?.delivered_at ?? null).toBeNull();

    // A 的信終於寄達,使用者點連結——verifyEmail 對仍是 pending 的 token 一樣要接受。
    const verifyResult = await verifyEmail(db, tokenAPlain, 10);
    expect(verifyResult).toEqual({ ok: true, value: { userId: 'user-race' } });
  });

  it('A 寄信成功後標記 delivered 再 cleanup:行為與修復前一致,正常淘汰超過 keepMax 的舊 delivered token', async () => {
    const db = createTestD1();
    await db
      .prepare(
        'INSERT INTO users (id, email, password_hash, password_salt, password_iterations, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind('user-normal', 'normal@example.com', 'h', 's', 1, 0, 0)
      .run();

    let lastHash = '';
    for (let i = 0; i < VERIFICATION_TOKEN_KEEP_MAX + 2; i++) {
      lastHash = `tok-normal-${i}`;
      await insertVerificationTokenAtomic(db, { token_hash: lastHash, user_id: 'user-normal', expires_at: 999_999, created_at: i }, i);
      await markVerificationTokenDelivered(db, lastHash, i);
      await cleanupVerificationTokensKeepingLatest(db, 'user-normal', lastHash);
    }

    const rows = await db
      .prepare('SELECT token_hash FROM verification_tokens WHERE user_id = ?')
      .bind('user-normal')
      .all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(VERIFICATION_TOKEN_KEEP_MAX);
    const kept = new Set(rows.results.map((r) => r.token_hash));
    expect(kept.has('tok-normal-0')).toBe(false);
    expect(kept.has(lastHash)).toBe(true);

    // 寄信失敗的孤兒 token 仍照舊被立即刪除,不受這次改動影響。
    const orphanHash = 'tok-normal-orphan';
    await insertVerificationTokenAtomic(db, { token_hash: orphanHash, user_id: 'user-normal', expires_at: 999_999, created_at: 999 }, 999);
    await deleteVerificationTokenByHash(db, orphanHash);
    expect(await findVerificationToken(db, orphanHash)).toBeNull();
  });
});
