import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RunnerTransportError } from '../../runner/src/api-client.js';
import { OfficialAmbiguousResponseError } from '../src/api-client.js';
import { runCli, type InteractiveInput } from '../src/cli.js';

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: {
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
    },
  };
}

describe('Official Fleet CLI boundaries', () => {
  it('has no unbounded online or background serve command', async () => {
    for (const command of ['online', 'serve']) {
      const captured = capture();
      await expect(runCli([command], { output: captured.output })).resolves.toBe(1);
      expect(captured.errors.join('\n')).toMatch(/Unlimited online mode is disabled/u);
    }
  });

  it('requires an explicit Pool and bounded Unit count', async () => {
    const missing = capture();
    await expect(runCli(['claim'], { output: missing.output })).resolves.toBe(1);
    expect(missing.errors.join('\n')).toMatch(/exactly one/u);

    const noUnits = capture();
    await expect(
      runCli(['claim', '--pool', '00000000-0000-4000-8000-000000000001'], {
        output: noUnits.output,
      }),
    ).resolves.toBe(1);
    expect(noUnits.errors.join('\n')).toMatch(/--units is required/u);
  });

  it('documents one-shot claim semantics without printing secrets', async () => {
    const captured = capture();
    await expect(runCli(['help'], { output: captured.output })).resolves.toBe(0);
    const help = captured.logs.join('\n');
    expect(help).toContain('claim --pool');
    expect(help).toContain('cancel --claim');
    expect(help).toContain('no unlimited online mode');
    expect(help).not.toMatch(/API_KEY|secretEnvRefs/u);
  });

  it('explicitly cancels an active generic Claim without loading Fleet config', async () => {
    const captured = capture();
    const claimId = '00000000-0000-4000-8000-000000000099';
    const cancelClaim = async (id: string) => ({ id, status: 'revoked' });
    await expect(
      runCli(['cancel', '--claim', claimId], {
        output: captured.output,
        tokenStore: { read: async () => 'official-token' } as never,
        apiFactory: () => ({ cancelClaim }) as never,
      }),
    ).resolves.toBe(0);

    expect(captured.errors).toEqual([]);
    expect(captured.logs).toEqual([`Claim ${claimId} is revoked; remaining reservation released.`]);
  });

  it('emits a single stable JSON envelope for machine cancel/status and never echoes tokens', async () => {
    const claimId = '00000000-0000-4000-8000-000000000098';
    const cancelled = capture();
    await expect(
      runCli(['cancel', '--claim', claimId, '--json'], {
        output: cancelled.output,
        tokenStore: { read: async () => 'official-token' } as never,
        apiFactory: () =>
          ({ cancelClaim: async () => ({ id: claimId, status: 'revoked' }) }) as never,
      }),
    ).resolves.toBe(0);
    expect(cancelled.errors).toEqual([]);
    expect(JSON.parse(cancelled.logs[0] ?? '')).toMatchObject({
      protocol: 'agentpool-official/1',
      ok: true,
      action: 'claims.cancel',
      data: { claim: { id: claimId, status: 'revoked' } },
    });

    const signedOut = capture();
    await expect(
      runCli(['status', '--json'], {
        output: signedOut.output,
        tokenStore: { read: async () => null } as never,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(signedOut.logs[0] ?? '')).toMatchObject({
      protocol: 'agentpool-official/1',
      ok: true,
      action: 'runner.status',
      data: { signedIn: false },
    });

    const failure = capture();
    await expect(
      runCli(['cancel', '--json', 'ap_runner_super_secret_token'], { output: failure.output }),
    ).resolves.toBe(1);
    expect(failure.errors).toEqual([]);
    expect(failure.logs.join('\n')).not.toContain('ap_runner_super_secret_token');
    expect(JSON.parse(failure.logs[0] ?? '')).toMatchObject({
      protocol: 'agentpool-official/1',
      ok: false,
      action: 'claims.cancel',
    });
  });

  it('marks transport timeouts and ambiguous accepted responses as retryable JSON errors', async () => {
    const claimId = '00000000-0000-4000-8000-000000000097';
    const cases = [
      {
        error: new RunnerTransportError('NETWORK_UNAVAILABLE', 'req-network'),
        code: 'NETWORK_UNAVAILABLE',
        requestId: 'req-network',
      },
      {
        error: new RunnerTransportError('REQUEST_TIMEOUT', 'req-timeout'),
        code: 'REQUEST_TIMEOUT',
        requestId: 'req-timeout',
      },
      {
        error: new RunnerTransportError('AMBIGUOUS_RESPONSE', 'req-ambiguous-body'),
        code: 'AMBIGUOUS_RESPONSE',
        requestId: 'req-ambiguous-body',
      },
    ] as const;

    for (const entry of cases) {
      const captured = capture();
      await expect(
        runCli(['cancel', '--claim', claimId, '--json'], {
          output: captured.output,
          tokenStore: { read: async () => 'official-token' } as never,
          apiFactory: () => ({ cancelClaim: async () => Promise.reject(entry.error) }) as never,
        }),
      ).resolves.toBe(1);
      expect(captured.errors).toEqual([]);
      expect(JSON.parse(captured.logs[0] ?? '')).toMatchObject({
        protocol: 'agentpool-official/1',
        ok: false,
        action: 'claims.cancel',
        error: { code: entry.code, retryable: true },
        meta: { requestId: entry.requestId },
      });
    }

    const fallback = capture();
    await expect(
      runCli(['cancel', '--claim', claimId, '--json'], {
        output: fallback.output,
        tokenStore: { read: async () => 'official-token' } as never,
        apiFactory: () =>
          ({
            cancelClaim: async () => Promise.reject(new OfficialAmbiguousResponseError()),
          }) as never,
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(fallback.logs[0] ?? '')).toMatchObject({
      protocol: 'agentpool-official/1',
      ok: false,
      action: 'claims.cancel',
      error: { code: 'AMBIGUOUS_RESPONSE', retryable: true },
    });
  });

  it('keeps malformed global machine options inside the one-line JSON protocol', async () => {
    for (const option of ['--server', '--config']) {
      const captured = capture();
      await expect(runCli(['claim', '--json', option], { output: captured.output })).resolves.toBe(
        1,
      );
      expect(captured.errors).toEqual([]);
      expect(captured.logs).toHaveLength(1);
      const envelope = JSON.parse(captured.logs[0] ?? '') as Record<string, unknown>;
      expect(envelope).toMatchObject({
        protocol: 'agentpool-official/1',
        ok: false,
        action: 'claims.run',
        error: { code: 'MISSING_OPTION', retryable: false },
      });
      expect(captured.logs[0]).not.toMatch(/ap_(?:runner|control|device)_/u);
      expect(captured.logs[0]).not.toContain(process.cwd());
    }
  });

  it('lists only explicit claimable work as JSON and does not create a Claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'official-jobs-json-'));
    const configPath = join(directory, 'official-fleet.config.json');
    const nodeId = '00000000-0000-4000-8000-000000000071';
    const poolId = '00000000-0000-4000-8000-000000000072';
    await writeFile(
      configPath,
      JSON.stringify({
        version: 'agentpool-official-fleet/1',
        pollIntervalMs: 3_000,
        cells: [
          {
            id: 'mock-cell',
            adapter: 'mock',
            model: 'mock-v1',
            allowWebhooks: false,
            routes: [
              {
                id: 'mock-route',
                kind: 'mock',
                concurrency: 1,
                environment: {},
                secretEnvRefs: {},
              },
            ],
          },
        ],
      }),
    );
    const createClaim = vi.fn();
    const api = {
      withScope: () => api,
      getOfficialFleet: async () => ({
        operatorType: 'official',
        fleet: { ownerId: nodeId, mode: 'standby', updatedAt: new Date().toISOString() },
      }),
      registerNode: async () => ({ nodeId }),
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
            id: poolId,
            title: 'Public job',
            status: 'queued' as const,
            category: 'text' as const,
            publicSummary: 'public contract only',
            requestedAgent: 'mock' as const,
            requestedModel: 'mock-v1',
            deliveryMode: 'platform' as const,
            maxUnitSeconds: 60,
            maxAttempts: 1,
            acceptanceMode: 'non_empty' as const,
            deliveryFormat: 'text' as const,
            deliveryMaxBytes: 65_536,
            pilot: false,
            availableUnits: 2,
            rewardPerUnit: 1,
            claimableUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      }),
      disconnect: async () => undefined,
      createClaim,
    };
    const captured = capture();
    try {
      await expect(
        runCli(['--config', configPath, 'jobs', '--json'], {
          output: captured.output,
          tokenStore: { read: async () => 'official-token' } as never,
          apiFactory: () => api as never,
        }),
      ).resolves.toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(createClaim).not.toHaveBeenCalled();
    expect(captured.errors).toEqual([]);
    expect(captured.logs).toHaveLength(1);
    expect(JSON.parse(captured.logs[0] ?? '')).toMatchObject({
      protocol: 'agentpool-official/1',
      ok: true,
      action: 'tasks.list',
      data: {
        claimMode: 'manual_bounded_only',
        cells: [{ cell: { id: 'mock-cell' }, jobs: [{ id: poolId }] }],
      },
    });
  });

  it('replays a bounded Claim from its idempotency key without relisting the reserved Pool', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'official-claim-replay-'));
    const configPath = join(directory, 'official-fleet.config.json');
    const nodeId = '00000000-0000-4000-8000-000000000061';
    const poolId = '00000000-0000-4000-8000-000000000062';
    const claimId = '00000000-0000-4000-8000-000000000063';
    await writeFile(
      configPath,
      JSON.stringify({
        version: 'agentpool-official-fleet/1',
        pollIntervalMs: 3_000,
        cells: [
          {
            id: 'mock-cell',
            adapter: 'mock',
            model: 'mock-v1',
            allowWebhooks: false,
            routes: [
              {
                id: 'mock-route',
                kind: 'mock',
                concurrency: 1,
                environment: {},
                secretEnvRefs: {},
              },
            ],
          },
        ],
      }),
    );
    const activeClaim = {
      id: claimId,
      nodeId,
      poolId,
      poolTitle: 'Public pool title',
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
    const createClaim = vi.fn(async () => activeClaim);
    const api = {
      withScope: () => api,
      getOfficialFleet: async () => ({
        operatorType: 'official',
        fleet: { ownerId: nodeId, mode: 'standby', updatedAt: new Date().toISOString() },
      }),
      registerNode: async () => ({ nodeId }),
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
      heartbeat: async () => undefined,
      createClaim,
      pollLease: async () => ({ lease: null, retryAfterMs: 1 }),
      getClaim: async () => ({
        ...activeClaim,
        claimedUnits: 1,
        remainingUnits: 0,
        status: 'exhausted' as const,
      }),
      progress: async () => undefined,
      submit: async () => ({ status: 'accepted' }),
      receipt: async () => ({ status: 'accepted' }),
      fail: async () => undefined,
      disconnect: async () => undefined,
      cancelClaim: async () => ({ ...activeClaim, status: 'revoked' as const }),
    };
    const store = {
      begin: vi.fn(async () => ({
        fingerprint: 'claim',
        key: 'recoverable-claim-01',
        automatic: true,
        recovered: true,
      })),
      complete: vi.fn(async () => undefined),
    };
    const captured = capture();
    try {
      await expect(
        runCli(['--config', configPath, 'claim', '--pool', poolId, '--units', '1', '--json'], {
          output: captured.output,
          tokenStore: { read: async () => 'official-token' } as never,
          apiFactory: () => api as never,
          claimIdempotencyStore: store,
        }),
      ).resolves.toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(createClaim).toHaveBeenCalledOnce();
    expect(store.begin).toHaveBeenCalledOnce();
    expect(captured.errors).toEqual([]);
    expect(JSON.parse(captured.logs[0] ?? '')).toMatchObject({
      protocol: 'agentpool-official/1',
      ok: true,
      action: 'claims.run',
      meta: { idempotencyKey: 'recoverable-claim-01' },
    });
  });

  it('interactively picks sanitized public work and heartbeats before creating the Claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'official-pick-'));
    const configPath = join(directory, 'official-fleet.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 'agentpool-official-fleet/1',
        pollIntervalMs: 3_000,
        cells: [
          {
            id: 'mock-cell',
            adapter: 'mock',
            model: 'mock-v1',
            allowWebhooks: false,
            routes: [
              {
                id: 'mock-route',
                kind: 'mock',
                concurrency: 1,
                environment: {},
                secretEnvRefs: {},
              },
            ],
          },
        ],
      }),
    );
    const nodeId = '00000000-0000-4000-8000-000000000081';
    const poolId = '00000000-0000-4000-8000-000000000082';
    const claimId = '00000000-0000-4000-8000-000000000083';
    const events: string[] = [];
    const activeClaim = {
      id: claimId,
      nodeId,
      poolId,
      poolTitle: 'Visible Pool',
      requestedAgent: 'mock' as const,
      requestedModel: 'mock-v1',
      deliveryMode: 'platform' as const,
      maxUnits: 2,
      claimedUnits: 0,
      remainingUnits: 2,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'active' as const,
      createdAt: new Date().toISOString(),
    };
    const api = {
      withScope: () => api,
      getOfficialFleet: async () => ({
        operatorType: 'official',
        fleet: {
          ownerId: '00000000-0000-4000-8000-000000000084',
          mode: 'standby',
          updatedAt: new Date().toISOString(),
        },
      }),
      registerNode: async () => ({ nodeId, heartbeatInterval: 60 }),
      getCapacity: async () => ({
        adapter: 'mock' as const,
        model: 'mock-v1',
        certified: true,
        certifiedConcurrency: 1,
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
            title: '\u001b[31mVisible\u202e Pool\u2066\u001b[0m',
            status: 'queued' as const,
            category: 'text' as const,
            publicSummary: 'Only\u200b public\u202d summary\ufeff\nsecond line',
            requestedAgent: 'mock' as const,
            requestedModel: 'mock-v1',
            deliveryMode: 'platform' as const,
            maxUnitSeconds: 60,
            maxAttempts: 2,
            acceptanceMode: 'non_empty' as const,
            deliveryFormat: 'text' as const,
            deliveryMaxBytes: 65_536,
            pilot: false,
            availableUnits: 2,
            rewardPerUnit: 8,
            claimableUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      }),
      heartbeat: async () => {
        events.push('heartbeat');
      },
      createClaim: async () => {
        events.push('create');
        return activeClaim;
      },
      pollLease: async () => ({ lease: null, retryAfterMs: 3_000 }),
      getClaim: async () => ({
        ...activeClaim,
        claimedUnits: 2,
        remainingUnits: 0,
        status: 'exhausted' as const,
      }),
      progress: async () => undefined,
      submit: async () => ({ status: 'accepted' }),
      receipt: async () => ({ status: 'accepted' }),
      fail: async () => undefined,
      disconnect: async () => undefined,
      cancelClaim: async () => ({ ...activeClaim, status: 'revoked' as const }),
    };
    const answers = ['1', '2', 'yes'];
    const interactive: InteractiveInput = {
      isTTY: true,
      question: async () => answers.shift() ?? 'no',
    };
    const captured = capture();

    try {
      await expect(
        runCli(['--config', configPath, 'pick'], {
          output: captured.output,
          interactive,
          tokenStore: { read: async () => 'official-token' } as never,
          apiFactory: () => api as never,
        }),
      ).resolves.toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(captured.errors).toEqual([]);
    expect(events.slice(0, 2)).toEqual(['heartbeat', 'create']);
    expect(captured.logs.join('\n')).toContain('8 Credits/Unit');
    expect(captured.logs.join('\n')).not.toContain('\u001b');
    expect(captured.logs.join('\n')).not.toContain('\nsecond line');
    expect(captured.logs.join('\n')).not.toMatch(
      /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u,
    );
    expect(captured.logs).toContain('Confirm bounded Claim:');
    expect(captured.logs).toContain(`  Pool UUID: ${poolId}`);
    expect(captured.logs).toContain('  Title: Visible Pool');
    expect(captured.logs).toContain('  Exact agent/model: mock/mock-v1');
    expect(captured.logs).toContain('  Reward: 8 Credits/Unit');
    expect(captured.logs).toContain('  Delivery: platform');
    expect(captured.logs).toContain('  Units: 2');
  });

  it('never scans or claims from Official pick without a TTY', async () => {
    const captured = capture();
    let connected = false;
    await expect(
      runCli(['pick'], {
        output: captured.output,
        interactive: { isTTY: false, question: async () => 'yes' },
        apiFactory: () => {
          connected = true;
          throw new Error('must not connect');
        },
      }),
    ).resolves.toBe(1);

    expect(connected).toBe(false);
    expect(captured.errors.join('\n')).toContain('interactive TTY');
  });

  it('maps an interrupted Official prompt and never creates a Claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'official-pick-abort-'));
    const configPath = join(directory, 'official-fleet.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 'agentpool-official-fleet/1',
        pollIntervalMs: 3_000,
        cells: [
          {
            id: 'mock-cell',
            adapter: 'mock',
            model: 'mock-v1',
            allowWebhooks: false,
            routes: [
              {
                id: 'mock-route',
                kind: 'mock',
                concurrency: 1,
                environment: {},
                secretEnvRefs: {},
              },
            ],
          },
        ],
      }),
    );
    const createClaim = vi.fn();
    const nodeId = '00000000-0000-4000-8000-000000000091';
    const poolId = '00000000-0000-4000-8000-000000000092';
    const api = {
      withScope: () => api,
      getOfficialFleet: async () => ({
        operatorType: 'official',
        fleet: {
          ownerId: '00000000-0000-4000-8000-000000000093',
          mode: 'standby',
          updatedAt: new Date().toISOString(),
        },
      }),
      registerNode: async () => ({ nodeId, heartbeatInterval: 60 }),
      getCapacity: async () => ({
        adapter: 'mock' as const,
        model: 'mock-v1',
        certified: true,
        certifiedConcurrency: 1,
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
            title: 'Visible Pool',
            status: 'queued' as const,
            category: 'text' as const,
            publicSummary: 'Public only',
            requestedAgent: 'mock' as const,
            requestedModel: 'mock-v1',
            deliveryMode: 'platform' as const,
            maxUnitSeconds: 60,
            maxAttempts: 2,
            acceptanceMode: 'non_empty' as const,
            deliveryFormat: 'text' as const,
            deliveryMaxBytes: 65_536,
            pilot: false,
            availableUnits: 1,
            rewardPerUnit: 1,
            claimableUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      }),
      disconnect: async () => undefined,
      createClaim,
    };
    const captured = capture();
    let receivedSignal: AbortSignal | undefined;

    try {
      await expect(
        runCli(['--config', configPath, 'pick'], {
          output: captured.output,
          interactive: {
            isTTY: true,
            question: async (_prompt, signal) => {
              receivedSignal = signal;
              const error = new Error('aborted');
              error.name = 'AbortError';
              throw error;
            },
          },
          tokenStore: { read: async () => 'official-token' } as never,
          apiFactory: () => api as never,
        }),
      ).resolves.toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(createClaim).not.toHaveBeenCalled();
    expect(captured.errors).toEqual(['Official Fleet Claim selection interrupted.']);
  });
});
