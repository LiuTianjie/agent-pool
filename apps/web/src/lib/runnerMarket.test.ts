import { describe, expect, it } from 'vitest';
import type { RunnerMarketPool, RunnerNodePublic } from './types';
import { runnerClaimCommand, runnerMatchesPool, runnerPickCommand } from './runnerMarket';

const NOW = Date.parse('2026-08-14T10:00:00.000Z');

function node(input: Partial<RunnerNodePublic> = {}): RunnerNodePublic {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'Runner',
    status: 'offline',
    maxConcurrency: 4,
    activeLeases: 0,
    activeJobs: [],
    lastSeenAt: '2026-08-14T09:00:00.000Z',
    operatorType: 'community',
    supportsDirectWebhooks: false,
    completedToday: 0,
    earnedToday: 0,
    certifications: [
      {
        adapter: 'codex',
        model: 'gpt-5.6',
        certifiedConcurrency: 4,
        p50Ms: 1_000,
        p95Ms: 2_000,
        successRate: 1,
        expiresAt: '2026-08-14T11:00:00.000Z',
      },
    ],
    ...input,
  };
}

function pool(input: Partial<RunnerMarketPool> = {}): RunnerMarketPool {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    title: 'Pool',
    category: 'data',
    requestedAgent: 'codex',
    requestedModel: 'gpt-5.6',
    requiredConcurrency: 20,
    maxUnitSeconds: 30,
    deadlineAt: '2026-08-14T12:00:00.000Z',
    publicSummary: 'Public metadata',
    status: 'queued',
    rewardPerUnit: 100,
    totalUnits: 50,
    queuedUnits: 40,
    runningUnits: 0,
    submittedUnits: 0,
    acceptedUnits: 10,
    failedUnits: 0,
    heldUnits: 0,
    pilotUnits: 0,
    pilotAcceptedUnits: 0,
    pilotFailedUnits: 0,
    pilotSubmittedUnits: 0,
    contractHash: 'hash',
    terminalReason: null,
    createdAt: '2026-08-14T09:00:00.000Z',
    deliveryMode: 'platform',
    ...input,
  };
}

describe('runner claim market', () => {
  it('matches a valid certification exactly even when the node is currently offline', () => {
    expect(runnerMatchesPool(node(), pool(), NOW)).toBe(true);
    expect(runnerMatchesPool(node(), pool({ requestedModel: 'gpt-5.6-mini' }), NOW)).toBe(false);
    expect(runnerMatchesPool(node(), pool({ maxUnitSeconds: 1 }), NOW)).toBe(false);
  });

  it('requires explicit direct-webhook capability', () => {
    expect(runnerMatchesPool(node(), pool({ deliveryMode: 'webhook' }), NOW)).toBe(false);
    expect(
      runnerMatchesPool(
        node({ supportsDirectWebhooks: true }),
        pool({ deliveryMode: 'webhook' }),
        NOW,
      ),
    ).toBe(true);
  });

  it('generates a bounded manual command for the selected operator type', () => {
    expect(runnerClaimCommand(node(), pool(), 80)).toBe(
      'agentpool claim --pool 20000000-0000-4000-8000-000000000001 --units 40 --agent codex --model gpt-5.6',
    );
    expect(
      runnerClaimCommand(
        node({ operatorType: 'official', supportsDirectWebhooks: true }),
        pool({ deliveryMode: 'webhook', requestedModel: 'model with space' }),
        3,
      ),
    ).toBe('agentpool-official claim --pool 20000000-0000-4000-8000-000000000001 --units 3');
    expect(runnerPickCommand(node(), pool({ requestedModel: 'model with space' }))).toBe(
      "agentpool pick --agent codex --model 'model with space'",
    );
    expect(runnerPickCommand(node(), pool({ deliveryMode: 'webhook' }))).toBe(
      'agentpool pick --agent codex --model gpt-5.6 --allow-webhooks',
    );
    expect(runnerPickCommand(node({ operatorType: 'official' }), pool())).toBe(
      'agentpool-official pick',
    );
  });
});
