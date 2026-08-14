import { describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock.js';
import type { LeasePayload } from '../src/types.js';

describe('MockAdapter', () => {
  it('solves the hidden benchmark transform without model usage', async () => {
    const lease: LeasePayload = {
      leaseId: 'lease',
      unitId: 'unit',
      poolId: 'pool',
      category: 'other',
      requestedAgent: 'mock',
      requestedModel: 'mock-v1',
      reward: 0,
      instruction: 'hidden',
      input: { text: 'abcdefg', nonce: 'opaque' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const result = await new MockAdapter().run({
      lease,
      taskDirectory: '/unused',
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(result).toEqual({
      reversed: 'gfedcba',
      uppercase: 'ABCDEFG',
      grouped: 'abc-def-g',
      length: 7,
    });
  });
});
