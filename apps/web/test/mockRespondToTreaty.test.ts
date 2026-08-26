// 回歸測試(Codex 三審 finding):mock 版 POST /api/diplomacy/respond 的 action==='counter'
// 分支過去沒有切換 pendingResponderId,對齊真後端(packages/diplomacy/src/index.ts respond():
// counter 後 pendingResponderId 應翻到「非目前回應者」的一方,球才會回到對方腳下)。

import { describe, it, expect } from 'vitest';
import type { Treaty } from '@micronation/shared';
import { mockRespondToTreaty } from '../src/api/mock';

const A = 'nation-a';
const B = 'nation-b';

function treaty(pendingResponderId: string | undefined): Treaty {
  return {
    id: 'treaty-1',
    kind: 'nap',
    aId: A,
    bId: B,
    status: 'proposed',
    terms: { duration: 168, pendingResponderId },
    createdAt: 0,
  };
}

describe('mockRespondToTreaty — counter 切換 pendingResponderId', () => {
  it('flips pendingResponderId from B to A when B counters', () => {
    const [result] = mockRespondToTreaty([treaty(B)], 'treaty-1', 'counter', { duration: 200 });
    expect(result.status).toBe('countered');
    expect(result.terms.pendingResponderId).toBe(A);
    expect(result.terms.duration).toBe(200);
  });

  it('flips pendingResponderId from A back to B when A counters again', () => {
    const [result] = mockRespondToTreaty([treaty(A)], 'treaty-1', 'counter', { duration: 100 });
    expect(result.terms.pendingResponderId).toBe(B);
  });

  it('accept/reject do not touch pendingResponderId', () => {
    const [accepted] = mockRespondToTreaty([treaty(B)], 'treaty-1', 'accept');
    expect(accepted.status).toBe('active');
    expect(accepted.terms.pendingResponderId).toBe(B);

    const [rejected] = mockRespondToTreaty([treaty(B)], 'treaty-1', 'reject');
    expect(rejected.status).toBe('rejected');
    expect(rejected.terms.pendingResponderId).toBe(B);
  });
});
