import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type InteractiveInput } from '../src/cli.js';
import { TokenStore } from '../src/token-store.js';
import type { RegisterNodeInput, RunnerClaim } from '../src/types.js';

const claimId = '11111111-1111-4111-8111-111111111111';
const poolId = '22222222-2222-4222-8222-222222222222';
const nodeV1 = '33333333-3333-4333-8333-333333333333';
const nodeV2 = '44444444-4444-4444-8444-444444444444';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Public CLI profile exclusion', () => {
  it('keeps an active Claim from being overwritten by jobs, benchmark, or pick', async () => {
    const stateDirectory = await authenticatedStateDirectory();
    const environment = { ...process.env, AGENTPOOL_STATE_DIR: stateDirectory };
    const pollStarted = deferred<void>();
    const finishClaim = deferred<void>();
    let terminal = false;
    let registrations = 0;
    let disconnects = 0;
    const api = {
      registerNode: async (input: RegisterNodeInput) => {
        registrations += 1;
        return { nodeId: input.models[0] === 'mock-v2' ? nodeV2 : nodeV1, heartbeatInterval: 60 };
      },
      getCapacity: async (_agent: string, model: string) => certification(model),
      getClaim: async () => runnerClaim(terminal ? 'exhausted' : 'active'),
      pollLease: async () => {
        pollStarted.resolve();
        await finishClaim.promise;
        return { lease: null, retryAfterMs: 3_000 };
      },
      heartbeat: async () => undefined,
      progress: async () => undefined,
      submit: async () => ({ status: 'accepted' }),
      receipt: async () => ({ status: 'accepted' }),
      fail: async () => undefined,
      listJobs: async () => ({ generatedAt: new Date().toISOString(), jobs: [] }),
      disconnect: async () => {
        disconnects += 1;
      },
    };
    const active = runCli(['claim', '--claim', claimId], {
      environment,
      apiFactory: () => api as never,
      output: silentOutput(),
    });
    await pollStarted.promise;
    const before = { registrations, disconnects };

    for (const command of [
      ['jobs', '--agent', 'mock', '--model', 'mock-v1'],
      ['benchmark', '--agent', 'mock', '--model', 'mock-v1'],
      ['pick', '--agent', 'mock', '--model', 'mock-v1'],
    ]) {
      const errors: string[] = [];
      await expect(
        runCli(command, {
          environment,
          interactive: { isTTY: true, question: async () => 'q' },
          apiFactory: () => api as never,
          output: { log: () => undefined, error: (message) => errors.push(message) },
        }),
      ).resolves.toBe(1);
      expect(errors).toEqual([
        'Runner profile is busy in another Agent Pool CLI process. Wait for it to finish or interrupt that command first.',
      ]);
      expect({ registrations, disconnects }).toEqual(before);
    }

    await expect(
      runCli(['jobs', '--agent', 'mock', '--model', 'mock-v2'], {
        environment,
        apiFactory: () => api as never,
        output: silentOutput(),
      }),
    ).resolves.toBe(0);
    expect(registrations).toBe(before.registrations + 1);
    expect(disconnects).toBe(before.disconnects + 1);

    terminal = true;
    finishClaim.resolve();
    await expect(active).resolves.toBe(0);
    await expect(
      runCli(['jobs', '--agent', 'mock', '--model', 'mock-v1'], {
        environment,
        apiFactory: () => api as never,
        output: silentOutput(),
      }),
    ).resolves.toBe(0);
  });

  it('releases the profile after an exceptional command exit', async () => {
    const stateDirectory = await authenticatedStateDirectory();
    const environment = { ...process.env, AGENTPOOL_STATE_DIR: stateDirectory };
    let calls = 0;
    const api = basicJobsApi(async () => {
      calls += 1;
      if (calls === 1) throw new Error('synthetic jobs failure');
      return { generatedAt: new Date().toISOString(), jobs: [] };
    });

    await expect(
      runCli(['jobs', '--agent', 'mock', '--model', 'mock-v1'], {
        environment,
        apiFactory: () => api as never,
        output: silentOutput(),
      }),
    ).resolves.toBe(1);
    await expect(
      runCli(['jobs', '--agent', 'mock', '--model', 'mock-v1'], {
        environment,
        apiFactory: () => api as never,
        output: silentOutput(),
      }),
    ).resolves.toBe(0);
  });

  it('releases the profile after SIGINT aborts interactive selection', async () => {
    const stateDirectory = await authenticatedStateDirectory();
    const environment = { ...process.env, AGENTPOOL_STATE_DIR: stateDirectory };
    const prompted = deferred<void>();
    const api = basicJobsApi(async () => ({
      generatedAt: new Date().toISOString(),
      jobs: [runnerJob()],
    }));
    const interactive: InteractiveInput = {
      isTTY: true,
      question: async (_prompt, signal) => {
        prompted.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
        return 'q';
      },
    };
    const interrupted = runCli(['pick', '--agent', 'mock', '--model', 'mock-v1'], {
      environment,
      interactive,
      apiFactory: () => api as never,
      output: silentOutput(),
    });
    await prompted.promise;
    process.emit('SIGINT', 'SIGINT');
    await expect(interrupted).resolves.toBe(1);

    await expect(
      runCli(['jobs', '--agent', 'mock', '--model', 'mock-v1'], {
        environment,
        apiFactory: () => api as never,
        output: silentOutput(),
      }),
    ).resolves.toBe(0);
  });
});

async function authenticatedStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentpool-profile-cli-'));
  temporaryDirectories.push(directory);
  await new TokenStore({ stateDirectory: directory }).write('runner-test-token');
  return directory;
}

function basicJobsApi(listJobs: () => Promise<unknown>) {
  return {
    registerNode: async () => ({ nodeId: nodeV1, heartbeatInterval: 60 }),
    getCapacity: async () => certification('mock-v1'),
    listJobs,
    disconnect: async () => undefined,
  };
}

function certification(model: string) {
  return {
    adapter: 'mock' as const,
    model,
    certified: true,
    certifiedConcurrency: 1,
    p50Ms: 1,
    p95Ms: 2,
    successRate: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function runnerClaim(status: RunnerClaim['status']): RunnerClaim {
  return {
    id: claimId,
    nodeId: nodeV1,
    poolId,
    poolTitle: 'Profile lock Pool',
    requestedAgent: 'mock',
    requestedModel: 'mock-v1',
    deliveryMode: 'platform',
    maxUnits: 1,
    claimedUnits: status === 'exhausted' ? 1 : 0,
    remainingUnits: status === 'exhausted' ? 0 : 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status,
    createdAt: new Date().toISOString(),
  };
}

function runnerJob() {
  return {
    id: poolId,
    title: 'Profile lock Pool',
    status: 'queued' as const,
    category: 'text' as const,
    publicSummary: 'Public summary',
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
  };
}

function silentOutput() {
  return { log: () => undefined, error: () => undefined };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
