import { describe, expect, it } from 'vitest';
import { leaseMatchesCapability, normalizeAllowedModels } from '../src/lease.js';
import type { LeasePayload } from '../src/types.js';

const lease: LeasePayload = {
  leaseId: 'lease',
  unitId: 'unit',
  poolId: 'pool',
  category: 'text',
  requestedAgent: 'codex',
  requestedModel: 'gpt-exact',
  reward: 1,
  instruction: 'private',
  input: {},
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe('capability matching', () => {
  it('requires both requested adapter and exact model', () => {
    expect(leaseMatchesCapability(lease, 'codex', ['gpt-exact'])).toBe(true);
    expect(leaseMatchesCapability(lease, 'claude', ['gpt-exact'])).toBe(false);
    expect(leaseMatchesCapability(lease, 'codex', ['gpt-other'])).toBe(false);
  });

  it('rejects the removed any-agent capability', async () => {
    const { validateLease } = await import('../src/lease.js');
    expect(() => validateLease({ ...lease, requestedAgent: 'any' })).toThrow(
      'Invalid lease payload',
    );
  });

  it('rejects wildcard allowlists and deduplicates exact models', () => {
    expect(normalizeAllowedModels([' model-a ', 'model-a', 'model-b'])).toEqual([
      'model-a',
      'model-b',
    ]);
    expect(() => normalizeAllowedModels(['*'])).toThrow('Wildcard');
    expect(() => normalizeAllowedModels([])).toThrow('At least one');
  });
});
