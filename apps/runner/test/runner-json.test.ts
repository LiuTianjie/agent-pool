import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentPoolApiClient, RunnerTransportError } from '../src/api-client.js';
import { runCli } from '../src/cli.js';
import { TokenStore } from '../src/token-store.js';

const claimId = '11111111-1111-4111-8111-111111111111';
const nodeId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Runner JSON protocol', () => {
  it('lists claimable work without claiming anything', async () => {
    const logs: string[] = [];
    const createClaim = vi.fn();
    const api = {
      registerNode: async () => ({ nodeId, heartbeatInterval: 60 }),
      getCapacity: async () => ({
        adapter: 'mock' as const,
        model: 'mock-v1',
        certified: true,
        certifiedConcurrency: 1,
        p50Ms: 1,
        p95Ms: 1,
        successRate: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      listJobs: async () => ({
        generatedAt: new Date().toISOString(),
        jobs: [
          {
            id: taskId,
            title: 'Visible work',
            status: 'queued' as const,
            category: 'text' as const,
            publicSummary: 'Visible summary only',
            requestedAgent: 'mock' as const,
            requestedModel: 'mock-v1',
            deliveryMode: 'platform' as const,
            maxUnitSeconds: 60,
            maxAttempts: 2,
            acceptanceMode: 'non_empty' as const,
            deliveryFormat: 'text' as const,
            deliveryMaxBytes: 1024,
            pilot: false,
            availableUnits: 4,
            rewardPerUnit: 3,
            claimableUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      }),
      disconnect: async () => undefined,
      createClaim,
    };

    const exitCode = await runCli(['jobs', '--json', '--agent', 'mock', '--model', 'mock-v1'], {
      tokenStore: { read: async () => 'ap_runner_json_test' } as never,
      apiFactory: () => api as never,
      profileLocks: { acquire: async () => ({ release: async () => undefined }) } as never,
      output: { log: (message) => logs.push(message), error: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(createClaim).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({
      protocol: 'agentpool-runner/1',
      ok: true,
      action: 'tasks.list',
      data: {
        tasks: [{ id: taskId, availableUnits: 4 }],
        claimMode: 'manual_bounded_only',
      },
    });
  });

  it.each([
    [401, 'RUNNER_CREDENTIAL_INVALID', false, undefined],
    [409, 'CLAIM_ALREADY_FINAL', false, undefined],
    [429, 'RATE_LIMITED', true, 2_500],
  ] as const)(
    'returns safe typed metadata for HTTP %s',
    async (status, code, retryable, retryAfterMs) => {
      const logs: string[] = [];
      const errors: string[] = [];
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code,
                message: 'PRIVATE SERVER MESSAGE MUST NOT APPEAR',
                details: { taskInput: 'PRIVATE TASK INPUT' },
                retryable,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
              },
            }),
            { status, headers: { 'x-request-id': `server-request-${status}` } },
          ),
      );

      const exitCode = await runCli(['cancel', '--json', '--claim', claimId], {
        tokenStore: { read: async () => 'ap_runner_json_test' } as never,
        apiFactory: (server, token) => new AgentPoolApiClient(server, token, fetch),
        output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
      });

      expect(exitCode).toBe(1);
      expect(errors).toEqual([]);
      expect(logs.join('\n')).not.toContain('PRIVATE');
      expect(JSON.parse(logs[0]!)).toMatchObject({
        protocol: 'agentpool-runner/1',
        ok: false,
        action: 'claims.cancel',
        error: { code, retryable },
        meta: {
          httpStatus: status,
          requestId: `server-request-${status}`,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      });
    },
  );

  it('reports signed-out status as JSON without opening an execution session', async () => {
    const logs: string[] = [];
    expect(
      await runCli(['status', '--json'], {
        tokenStore: { read: async () => null } as never,
        output: { log: (message) => logs.push(message), error: () => undefined },
      }),
    ).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      protocol: 'agentpool-runner/1',
      ok: true,
      action: 'runner.status',
      data: { authenticated: false },
    });
  });

  it('recovers an ambiguous Claim create with the same persisted idempotency key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-runner-json-'));
    directories.push(directory);
    const tokenStore = new TokenStore({ stateDirectory: directory });
    await tokenStore.write('ap_runner_claim_json');
    const keys: string[] = [];
    let creates = 0;
    let jobLists = 0;
    const activeClaim = {
      id: claimId,
      nodeId,
      poolId: taskId,
      poolTitle: 'Not printed',
      requestedAgent: 'mock' as const,
      requestedModel: 'mock-v1',
      deliveryMode: 'platform' as const,
      maxUnits: 1,
      claimedUnits: 0,
      remainingUnits: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'active' as const,
      createdAt: new Date().toISOString(),
    };
    const exhaustedClaim = {
      ...activeClaim,
      claimedUnits: 1,
      remainingUnits: 0,
      status: 'exhausted' as const,
    };
    const api = {
      registerNode: async () => ({ nodeId, heartbeatInterval: 60 }),
      getCapacity: async () => ({
        adapter: 'mock' as const,
        model: 'mock-v1',
        certified: true,
        certifiedConcurrency: 1,
        p50Ms: 1,
        p95Ms: 1,
        successRate: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      listJobs: async () => {
        jobLists += 1;
        return {
          generatedAt: new Date().toISOString(),
          jobs:
            jobLists === 1
              ? [
                  {
                    id: taskId,
                    title: 'Safe public title',
                    status: 'queued' as const,
                    category: 'text' as const,
                    publicSummary: 'Safe summary',
                    requestedAgent: 'mock' as const,
                    requestedModel: 'mock-v1',
                    deliveryMode: 'platform' as const,
                    maxUnitSeconds: 60,
                    maxAttempts: 2,
                    acceptanceMode: 'non_empty' as const,
                    deliveryFormat: 'text' as const,
                    deliveryMaxBytes: 1024,
                    pilot: false,
                    availableUnits: 1,
                    rewardPerUnit: 1,
                    claimableUntil: new Date(Date.now() + 60_000).toISOString(),
                  },
                ]
              : [],
        };
      },
      createClaimRequest: async (_input: unknown, key: string) => {
        keys.push(key);
        creates += 1;
        if (creates === 1) throw new RunnerTransportError('NETWORK_UNAVAILABLE', 'lost-response');
        return {
          claim: activeClaim,
          requestId: 'claim-created',
          idempotencyReplayed: true,
        };
      },
      createClaim: async () => activeClaim,
      pollLease: async () => ({ lease: null }),
      getClaim: async () => exhaustedClaim,
      heartbeat: async () => undefined,
      progress: async () => undefined,
      submit: async () => ({ status: 'accepted' as const }),
      receipt: async () => ({ status: 'accepted' as const }),
      fail: async () => undefined,
      disconnect: async () => undefined,
      cancelClaim: async () => ({ ...activeClaim, status: 'revoked' as const }),
    };
    const args = ['once', '--json', '--pool', taskId, '--agent', 'mock', '--model', 'mock-v1'];
    const firstLogs: string[] = [];
    expect(
      await runCli(args, {
        tokenStore,
        apiFactory: () => api as never,
        profileLocks: { acquire: async () => ({ release: async () => undefined }) } as never,
        output: { log: (message) => firstLogs.push(message), error: () => undefined },
      }),
    ).toBe(1);
    expect(JSON.parse(firstLogs[0]!)).toMatchObject({
      action: 'claims.run',
      error: { code: 'NETWORK_UNAVAILABLE', retryable: true },
      meta: { requestId: 'lost-response' },
    });

    const secondLogs: string[] = [];
    expect(
      await runCli(args, {
        tokenStore,
        apiFactory: () => api as never,
        profileLocks: { acquire: async () => ({ release: async () => undefined }) } as never,
        output: { log: (message) => secondLogs.push(message), error: () => undefined },
      }),
    ).toBe(0);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(jobLists).toBe(1);
    expect(secondLogs).toHaveLength(1);
    expect(JSON.parse(secondLogs[0]!)).toMatchObject({
      protocol: 'agentpool-runner/1',
      ok: true,
      action: 'claims.run',
      data: { claim: { id: claimId, status: 'exhausted' }, execution: 'finished' },
      meta: {
        requestId: 'claim-created',
        idempotencyKey: keys[0],
        idempotencyReplayed: true,
      },
    });
  });

  it('keeps malformed machine invocations in JSON and never reflects pasted tokens', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    expect(
      await runCli(['claim', '--json', 'ap_runner_private_mistake'], {
        output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
      }),
    ).toBe(1);
    expect(errors).toEqual([]);
    expect(logs.join('\n')).not.toContain('private_mistake');
    expect(JSON.parse(logs[0]!)).toMatchObject({
      protocol: 'agentpool-runner/1',
      ok: false,
      action: 'claims.run',
    });
  });
});
