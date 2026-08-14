import { access, stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { MockAdapter } from '../src/adapters/mock.js';
import {
  resolvePollDelay,
  resolveCertifiedConcurrency,
  RunnerService,
  type RunnerApi,
} from '../src/runner-service.js';
import { taskCapsuleHash } from '../src/task-contract.js';
import type {
  AgentAdapterDriver,
  CapacityCertification,
  DeliveryOutcome,
  LeaseFailure,
  LeasePayload,
  RegisterNodeInput,
  RunnerClaim,
  RunnerProgressInput,
  TaskCapsule,
  WebhookReceipt,
} from '../src/types.js';

function certification(concurrency: number, model = 'mock-v1'): CapacityCertification {
  return {
    adapter: 'mock',
    model,
    certified: true,
    certifiedConcurrency: concurrency,
    p50Ms: 1,
    p95Ms: 2,
    successRate: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function workLease(): LeasePayload {
  return {
    leaseId: 'lease-private',
    unitId: 'unit-private',
    poolId: 'pool-private',
    category: 'text',
    requestedAgent: 'mock',
    requestedModel: 'mock-v1',
    reward: 5,
    instruction: 'DO NOT PRINT THIS PRIVATE PROMPT',
    input: { __mockOutput: 'DO NOT PRINT THIS PRIVATE OUTPUT' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function outcome(status = 'accepted'): DeliveryOutcome {
  return { status };
}

function exhaustedClaim(nodeId = 'node-1'): RunnerClaim {
  return {
    id: 'claim-1',
    nodeId,
    poolId: 'pool-private',
    poolTitle: 'Private Pool',
    requestedAgent: 'mock',
    requestedModel: 'mock-v1',
    deliveryMode: 'platform',
    maxUnits: 1,
    claimedUnits: 1,
    remainingUnits: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'exhausted',
    createdAt: new Date().toISOString(),
  };
}

function webhookLease(): LeasePayload {
  const taskCapsule: TaskCapsule = {
    version: 'ap-task/1',
    goal: 'Return the requested JSON object.',
    inputDescription: 'One test record.',
    outputDescription: 'Return one JSON object.',
    constraints: [],
    examples: [],
    delivery: { format: 'json', maxBytes: 1_024 },
    acceptance: { mode: 'webhook', criteria: ['The receiver decides acceptance.'] },
  };
  return {
    ...workLease(),
    leaseId: '11111111-1111-4111-8111-111111111111',
    unitId: '22222222-2222-4222-8222-222222222222',
    input: { __mockOutput: { answer: 42 } },
    taskCapsule,
    contractHash: taskCapsuleHash(taskCapsule),
    delivery: {
      mode: 'webhook',
      url: 'https://receiver.example/PRIVATE-PATH',
      protocol: 'agentpool-webhook/1',
      unitReference: 'PRIVATE-REFERENCE',
      ordinal: 0,
    },
  };
}

describe('RunnerService', () => {
  it('uses at least three seconds and honors a longer server retry delay', () => {
    expect(resolvePollDelay()).toBe(3_000);
    expect(resolvePollDelay(1, 100)).toBe(3_000);
    expect(resolvePollDelay(3_000, 7_500)).toBe(7_500);
    expect(resolvePollDelay(10_000, 7_500)).toBe(10_000);
    expect(resolvePollDelay(60_000, 120_000)).toBe(60_000);
  });

  it('runs a cost-free sealed unit once without exposing task content', async () => {
    const lease = workLease();
    let polled = false;
    let registration: RegisterNodeInput | undefined;
    let submitted: unknown;
    const progress: RunnerProgressInput[] = [];
    const failures: LeaseFailure[] = [];
    const api: RunnerApi = {
      getCapacity: async () => certification(4),
      registerNode: async (input) => {
        registration = input;
        return { nodeId: 'node-1', heartbeatInterval: 60 };
      },
      heartbeat: async () => undefined,
      pollLease: async () => {
        if (polled) return { lease: null, retryAfterMs: 3_000 };
        polled = true;
        return { lease };
      },
      getClaim: async () => exhaustedClaim(),
      progress: async (_leaseId, value) => {
        progress.push(value);
      },
      submit: async (_leaseId, output) => {
        submitted = output;
        return outcome();
      },
      receipt: async () => outcome(),
      fail: async (_leaseId, failure) => {
        failures.push(failure);
      },
      disconnect: async () => undefined,
    };
    const log: string[] = [];
    const service = new RunnerService({
      api,
      adapter: new MockAdapter(),
      models: ['mock-v1'],
      requestedConcurrency: 8,
      claimId: 'claim-1',
      expectedNodeId: 'node-1',
      signal: new AbortController().signal,
      logger: {
        info: (value) => log.push(value),
        warn: (value) => log.push(value),
        error: (value) => log.push(value),
      },
      clientVersion: 'test',
      pollIntervalMs: 1,
    });

    await service.run();

    expect(registration?.models).toEqual(['mock-v1']);
    expect(registration?.adapter).toBe('mock');
    expect(registration?.concurrency).toBe(8);
    expect(registration?.supportsDirectWebhooks).toBe(false);
    expect(submitted).toBe('DO NOT PRINT THIS PRIVATE OUTPUT');
    expect(failures).toEqual([]);
    expect(progress.at(-1)).toEqual({ stage: 'completed', progress: 100 });
    expect(log.join('\n')).not.toContain('DO NOT PRINT');
    expect(log.join('\n')).not.toContain('lease-private');
  });

  it('drains already-leased work after the bounded Claim becomes exhausted', async () => {
    const lease = workLease();
    let pollCount = 0;
    const submitted: unknown[] = [];
    const failures: LeaseFailure[] = [];
    const adapter: AgentAdapterDriver = {
      name: 'mock',
      defaultModels: ['mock-v1'],
      detect: async () => ({ adapter: 'mock', available: true, authenticated: true }),
      run: async ({ signal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve('slow-but-valid-output');
          }, 100);
          const abort = (): void => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          };
          signal.addEventListener('abort', abort, { once: true });
        }),
    };
    const api: RunnerApi = {
      getCapacity: async () => certification(2),
      registerNode: async () => ({ nodeId: 'node-1', heartbeatInterval: 60 }),
      heartbeat: async () => undefined,
      pollLease: async () => {
        pollCount += 1;
        return pollCount === 1 ? { lease } : { lease: null };
      },
      getClaim: async () => exhaustedClaim(),
      progress: async () => undefined,
      submit: async (_leaseId, output) => {
        submitted.push(output);
        return outcome();
      },
      receipt: async () => outcome(),
      fail: async (_leaseId, failure) => {
        failures.push(failure);
      },
      disconnect: async () => undefined,
    };
    const service = new RunnerService({
      api,
      adapter,
      models: ['mock-v1'],
      requestedConcurrency: 2,
      claimId: 'claim-1',
      expectedNodeId: 'node-1',
      signal: new AbortController().signal,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      clientVersion: 'test',
      shutdownGraceMs: 20,
    });

    await service.run();

    expect(submitted).toEqual(['slow-but-valid-output']);
    expect(failures).toEqual([]);
  });

  it('caps concurrency to the lowest current exact-model certification', async () => {
    const capacities = new Map([
      ['model-a', certification(7, 'model-a')],
      ['model-b', certification(3, 'model-b')],
    ]);
    const result = await resolveCertifiedConcurrency({
      api: { getCapacity: async (_adapter, model) => capacities.get(model) ?? null },
      adapter: 'mock',
      models: ['model-a', 'model-b'],
      requestedConcurrency: 10,
    });
    expect(result.concurrency).toBe(3);
  });

  it('rejects expired or missing capacity certification', async () => {
    await expect(
      resolveCertifiedConcurrency({
        api: { getCapacity: async () => null },
        adapter: 'codex',
        models: ['exact-model'],
        requestedConcurrency: 1,
      }),
    ).rejects.toThrow('benchmark');
  });

  it('declines webhook leases without opt-in before running the agent or callback', async () => {
    let registration: RegisterNodeInput | undefined;
    const failures: LeaseFailure[] = [];
    const webhookDeliverer = vi.fn();
    const adapter = new MockAdapter();
    const run = vi.spyOn(adapter, 'run');
    let polled = false;
    const api: RunnerApi = {
      getCapacity: async () => certification(1),
      registerNode: async (input) => {
        registration = input;
        return { nodeId: 'node-1', heartbeatInterval: 60 };
      },
      heartbeat: async () => undefined,
      pollLease: async () => {
        if (polled) return { lease: null };
        polled = true;
        return { lease: webhookLease() };
      },
      getClaim: async () => exhaustedClaim(),
      progress: async () => undefined,
      submit: async () => outcome(),
      receipt: async () => outcome(),
      fail: async (_leaseId, failure) => {
        failures.push(failure);
      },
      disconnect: async () => undefined,
    };
    const service = new RunnerService({
      api,
      adapter,
      models: ['mock-v1'],
      requestedConcurrency: 1,
      claimId: 'claim-1',
      expectedNodeId: 'node-1',
      signal: new AbortController().signal,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      clientVersion: 'test',
      webhookDeliverer,
    });

    await service.run();

    expect(registration?.supportsDirectWebhooks).toBe(false);
    expect(failures).toEqual([{ code: 'model_mismatch', retryable: true }]);
    expect(run).not.toHaveBeenCalled();
    expect(webhookDeliverer).not.toHaveBeenCalled();
  });

  it('rejects a mismatched capsule hash before running the agent or callback', async () => {
    const work = { ...webhookLease(), contractHash: '0'.repeat(64) };
    const adapter = new MockAdapter();
    const run = vi.spyOn(adapter, 'run');
    const webhookDeliverer = vi.fn();
    const api: RunnerApi = {
      getCapacity: async () => certification(1),
      registerNode: async () => ({ nodeId: 'node-1', heartbeatInterval: 60 }),
      heartbeat: async () => undefined,
      pollLease: async () => ({ lease: work }),
      getClaim: async () => exhaustedClaim(),
      progress: async () => undefined,
      submit: async () => outcome(),
      receipt: async () => outcome(),
      fail: async () => undefined,
      disconnect: async () => undefined,
    };
    const service = new RunnerService({
      api,
      adapter,
      models: ['mock-v1'],
      requestedConcurrency: 1,
      claimId: 'claim-1',
      expectedNodeId: 'node-1',
      signal: new AbortController().signal,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      clientVersion: 'test',
      allowWebhooks: true,
      webhookDeliverer,
    });

    await expect(service.run()).rejects.toThrow('Invalid lease payload');
    expect(run).not.toHaveBeenCalled();
    expect(webhookDeliverer).not.toHaveBeenCalled();
  });

  it('forwards a callback receipt without submitting the private result to the platform', async () => {
    const work = webhookLease();
    const callbackReceipt: WebhookReceipt = {
      protocol: 'agentpool-receipt/1',
      leaseId: work.leaseId,
      unitId: work.unitId,
      contractHash: work.contractHash!,
      resultSha256: 'b'.repeat(64),
      decision: 'accepted',
      retryable: false,
      receiptId: 'receipt-private',
      signature: 'c'.repeat(64),
    };
    const submit = vi.fn(async () => outcome());
    const receipt = vi.fn(async () => outcome());
    const webhookDeliverer = vi.fn(async () => callbackReceipt);
    let registration: RegisterNodeInput | undefined;
    let polled = false;
    const api: RunnerApi = {
      getCapacity: async () => certification(1),
      registerNode: async (input) => {
        registration = input;
        return { nodeId: 'node-1', heartbeatInterval: 60 };
      },
      heartbeat: async () => undefined,
      pollLease: async () => {
        if (polled) return { lease: null };
        polled = true;
        return { lease: work };
      },
      getClaim: async () => exhaustedClaim(),
      progress: async () => undefined,
      submit,
      receipt,
      fail: async () => undefined,
      disconnect: async () => undefined,
    };
    const logs: string[] = [];
    const service = new RunnerService({
      api,
      adapter: new MockAdapter(),
      models: ['mock-v1'],
      requestedConcurrency: 1,
      claimId: 'claim-1',
      expectedNodeId: 'node-1',
      signal: new AbortController().signal,
      logger: {
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
      clientVersion: 'test',
      allowWebhooks: true,
      webhookDeliverer,
    });

    await service.run();

    expect(registration?.supportsDirectWebhooks).toBe(true);
    expect(webhookDeliverer).toHaveBeenCalledWith(work, { answer: 42 });
    expect(receipt).toHaveBeenCalledWith(work.leaseId, callbackReceipt, expect.any(Number));
    expect(submit).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain('PRIVATE-PATH');
    expect(logs.join('\n')).not.toContain('PRIVATE-REFERENCE');
    expect(logs.join('\n')).not.toContain('receipt-private');
  });

  it('retries the same platform result after a transient submission failure', async () => {
    const work = workLease();
    let polled = false;
    const outputs: unknown[] = [];
    let submissionAttempt = 0;
    const api: RunnerApi = {
      getCapacity: async () => certification(1),
      registerNode: async () => ({ nodeId: 'node-1', heartbeatInterval: 60 }),
      heartbeat: async () => undefined,
      pollLease: async () => {
        if (polled) return { lease: null };
        polled = true;
        return { lease: work };
      },
      getClaim: async () => exhaustedClaim(),
      progress: async () => undefined,
      submit: async (_leaseId, output) => {
        outputs.push(output);
        submissionAttempt += 1;
        if (submissionAttempt === 1) throw Object.assign(new Error('temporary'), { status: 500 });
        return outcome();
      },
      receipt: async () => outcome(),
      fail: async () => undefined,
      disconnect: async () => undefined,
    };
    const service = new RunnerService({
      api,
      adapter: new MockAdapter(),
      models: ['mock-v1'],
      requestedConcurrency: 1,
      claimId: 'claim-1',
      expectedNodeId: 'node-1',
      signal: new AbortController().signal,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      clientVersion: 'test',
    });

    await service.run();

    expect(outputs).toEqual([
      'DO NOT PRINT THIS PRIVATE OUTPUT',
      'DO NOT PRINT THIS PRIVATE OUTPUT',
    ]);
  });
});
