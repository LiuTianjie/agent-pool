import { describe, expect, it, vi } from 'vitest';

import { runCli, type InteractiveInput } from '../src/cli.js';
import type { RunnerClaim } from '../src/types.js';

const nodeId = '11111111-1111-4111-8111-111111111111';
const poolId = '22222222-2222-4222-8222-222222222222';
const claimId = '33333333-3333-4333-8333-333333333333';

function interactiveAnswers(answers: string[]): InteractiveInput & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    isTTY: true,
    prompts,
    question: async (prompt) => {
      prompts.push(prompt);
      const answer = answers.shift();
      if (answer === undefined) throw new Error('No injected answer available.');
      return answer;
    },
  };
}

function claim(status: RunnerClaim['status']): RunnerClaim {
  return {
    id: claimId,
    nodeId,
    poolId,
    poolTitle: 'Safe title',
    requestedAgent: 'mock',
    requestedModel: 'mock-v1',
    deliveryMode: 'platform',
    maxUnits: 2,
    claimedUnits: status === 'exhausted' ? 2 : 0,
    remainingUnits: status === 'exhausted' ? 0 : 2,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status,
    createdAt: new Date().toISOString(),
  };
}

function fakeApi() {
  const events: string[] = [];
  const createClaim = vi.fn(async () => {
    events.push('create');
    return claim('active');
  });
  const pollLease = vi.fn(async () => ({ lease: null, retryAfterMs: 3_000 }));
  const cancelClaim = vi.fn(async () => ({ ...claim('active'), status: 'revoked' as const }));
  return {
    createClaim,
    pollLease,
    cancelClaim,
    api: {
      registerNode: async () => ({ nodeId, heartbeatInterval: 60 }),
      getCapacity: async () => ({
        adapter: 'mock' as const,
        model: 'mock-v1',
        certified: true,
        certifiedConcurrency: 2,
        p50Ms: 1,
        p95Ms: 2,
        successRate: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      listJobs: async () => ({
        generatedAt: new Date().toISOString(),
        jobs: [
          {
            id: poolId,
            title: '\u001b[31mVisible\u202e title\u2066\u001b[0m',
            status: 'queued' as const,
            category: 'text' as const,
            publicSummary: 'Safe\u200b public\u202d summary\ufeff\nwith a second line',
            requestedAgent: 'mock' as const,
            requestedModel: 'mock-v1',
            deliveryMode: 'platform' as const,
            maxUnitSeconds: 60,
            maxAttempts: 2,
            acceptanceMode: 'non_empty' as const,
            deliveryFormat: 'text' as const,
            deliveryMaxBytes: 65_536,
            pilot: false,
            availableUnits: 3,
            rewardPerUnit: 9,
            claimableUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      }),
      createClaim,
      pollLease,
      getClaim: async () => claim('exhausted'),
      heartbeat: async () => {
        events.push('heartbeat');
      },
      progress: async () => undefined,
      submit: async () => ({ status: 'accepted' }),
      receipt: async () => ({ status: 'accepted' }),
      fail: async () => undefined,
      disconnect: async () => undefined,
      cancelClaim,
    },
    events,
  };
}

describe('interactive pick', () => {
  it('shows only sanitized public fields and creates the confirmed bounded Claim', async () => {
    const fake = fakeApi();
    const interactive = interactiveAnswers(['1', '2', 'yes']);
    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCli(
      ['pick', '--agent', 'mock', '--model', 'mock-v1', '--concurrency', '2'],
      {
        interactive,
        tokenStore: { read: async () => 'runner-token' } as never,
        apiFactory: () => fake.api as never,
        output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
      },
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(interactive.prompts).toHaveLength(3);
    expect(fake.createClaim).toHaveBeenCalledWith({ nodeId, poolId, maxUnits: 2 });
    expect(fake.events.slice(0, 2)).toEqual(['heartbeat', 'create']);
    expect(fake.pollLease).toHaveBeenCalledWith(nodeId, {
      adapter: 'mock',
      models: ['mock-v1'],
      claimId,
    });
    expect(fake.cancelClaim).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('9 Credits/Unit');
    expect(logs.join('\n')).toContain('3 available');
    expect(logs.join('\n')).not.toContain('\u001b');
    expect(logs.join('\n')).not.toContain('\nwith a second line');
    expect(logs.join('\n')).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u);
    expect(logs).toContain('Confirm bounded Claim:');
    expect(logs).toContain(`  Pool UUID: ${poolId}`);
    expect(logs).toContain('  Title: Visible title');
    expect(logs).toContain('  Exact agent/model: mock/mock-v1');
    expect(logs).toContain('  Reward: 9 Credits/Unit');
    expect(logs).toContain('  Delivery: platform');
    expect(logs).toContain('  Units: 2');
  });

  it('never claims in non-TTY mode', async () => {
    const connected = vi.fn();
    const errors: string[] = [];
    const exitCode = await runCli(['pick', '--agent', 'mock', '--model', 'mock-v1'], {
      interactive: { isTTY: false, question: async () => 'yes' },
      apiFactory: () => {
        connected();
        throw new Error('must not connect');
      },
      output: { log: () => undefined, error: (message) => errors.push(message) },
    });

    expect(exitCode).toBe(1);
    expect(connected).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('Use agentpool jobs');
  });

  it('does not create a Claim without explicit confirmation', async () => {
    const fake = fakeApi();
    const logs: string[] = [];
    const exitCode = await runCli(['pick', '--agent', 'mock', '--model', 'mock-v1'], {
      interactive: interactiveAnswers(['1', '1', 'no']),
      tokenStore: { read: async () => 'runner-token' } as never,
      apiFactory: () => fake.api as never,
      output: { log: (message) => logs.push(message), error: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(fake.createClaim).not.toHaveBeenCalled();
    expect(fake.pollLease).not.toHaveBeenCalled();
    expect(logs).toContain('No Claim created.');
  });

  it('maps an interrupted prompt and never creates a Claim', async () => {
    const fake = fakeApi();
    const errors: string[] = [];
    let receivedSignal: AbortSignal | undefined;
    const exitCode = await runCli(['pick', '--agent', 'mock', '--model', 'mock-v1'], {
      interactive: {
        isTTY: true,
        question: async (_prompt, signal) => {
          receivedSignal = signal;
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        },
      },
      tokenStore: { read: async () => 'runner-token' } as never,
      apiFactory: () => fake.api as never,
      output: { log: () => undefined, error: (message) => errors.push(message) },
    });

    expect(exitCode).toBe(1);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(errors).toEqual(['Claim selection interrupted.']);
    expect(fake.createClaim).not.toHaveBeenCalled();
  });
});
