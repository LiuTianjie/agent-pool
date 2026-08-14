import { access, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runBenchmark } from '../src/benchmark.js';
import type {
  AgentAdapterDriver,
  BenchmarkUnitResult,
  CapacityCertification,
  LeasePayload,
} from '../src/types.js';

function challengeLease(index: number): LeasePayload {
  return {
    leaseId: `benchmark-${index}`,
    unitId: `unit-${index}`,
    poolId: 'hidden-benchmark',
    category: 'text',
    requestedAgent: 'mock',
    requestedModel: 'mock-v1',
    reward: 0,
    instruction: `hidden prompt ${index}`,
    input: { __mockOutput: `hidden output ${index}` },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe('runBenchmark', () => {
  it('uses exact adapter/model, bounded concurrency, fresh directories, and submits durations', async () => {
    let active = 0;
    let maximumActive = 0;
    const taskDirectories: string[] = [];
    const adapter: AgentAdapterDriver = {
      name: 'mock',
      defaultModels: ['mock-v1'],
      detect: async () => ({ adapter: 'mock', available: true, authenticated: true }),
      run: async ({ lease, taskDirectory }) => {
        expect(lease.requestedModel).toBe('mock-v1');
        expect((await stat(taskDirectory)).mode & 0o777).toBe(0o700);
        taskDirectories.push(taskDirectory);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return (lease.input as { __mockOutput: string }).__mockOutput;
      },
    };
    const certification: CapacityCertification = {
      adapter: 'mock',
      model: 'mock-v1',
      certified: true,
      certifiedConcurrency: 2,
      p50Ms: 10,
      p95Ms: 12,
      successRate: 1,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    let submitted: BenchmarkUnitResult[] = [];
    const api = {
      startBenchmark: async () => ({
        benchmarkId: 'benchmark-id',
        leases: Array.from({ length: 5 }, (_, index) => challengeLease(index)),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      submitBenchmark: async (_id: string, results: BenchmarkUnitResult[]) => {
        submitted = results;
        return certification;
      },
    };

    const result = await runBenchmark({
      api,
      adapter,
      model: 'mock-v1',
      concurrency: 2,
      nodeId: 'node-id',
      signal: new AbortController().signal,
    });

    expect(result).toEqual(certification);
    expect(maximumActive).toBe(2);
    expect(new Set(taskDirectories).size).toBe(5);
    expect(submitted).toHaveLength(5);
    expect(submitted.every((item) => item.success && item.durationMs >= 0)).toBe(true);
    for (const directory of taskDirectories) await expect(access(directory)).rejects.toThrow();
  });
});
