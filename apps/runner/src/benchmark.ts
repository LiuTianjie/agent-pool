import { performance } from 'node:perf_hooks';
import { combineAbortSignals } from './abort.js';
import { AdapterExecutionError } from './adapters/common.js';
import { leaseMatchesCapability, validateLease } from './lease.js';
import { withTaskDirectory } from './task-directory.js';
import type {
  AgentAdapter,
  AgentAdapterDriver,
  BenchmarkUnitResult,
  CapacityCertification,
} from './types.js';

export interface BenchmarkApi {
  startBenchmark(
    adapter: AgentAdapter,
    model: string,
    requestedConcurrency: number,
    nodeId?: string,
  ): Promise<{ benchmarkId: string; leases: unknown[]; expiresAt: string }>;
  submitBenchmark(
    benchmarkId: string,
    results: BenchmarkUnitResult[],
  ): Promise<CapacityCertification>;
}

export async function runBenchmark(options: {
  api: BenchmarkApi;
  adapter: AgentAdapterDriver;
  model: string;
  concurrency: number;
  nodeId: string;
  signal: AbortSignal;
  onFailure?: (detail: string) => void;
}): Promise<CapacityCertification> {
  const { api, adapter, model, concurrency, nodeId, signal } = options;
  const challenge = await api.startBenchmark(adapter.name, model, concurrency, nodeId);
  const leases = challenge.leases.map(validateLease);
  if (
    leases.some(
      (lease) =>
        !leaseMatchesCapability(lease, adapter.name, [model]) || lease.requestedModel !== model,
    )
  ) {
    throw new Error('The platform returned a benchmark for a different agent or model.');
  }

  const results = await mapConcurrent(leases, concurrency, async (lease) => {
    const startedAt = performance.now();
    const leaseAbort = new AbortController();
    const expiresIn = Date.parse(lease.expiresAt) - Date.now();
    if (expiresIn <= 0) {
      return {
        leaseId: lease.leaseId,
        output: null,
        durationMs: 1,
        success: false,
      } satisfies BenchmarkUnitResult;
    }
    const expiryTimer = setTimeout(() => leaseAbort.abort(), Math.min(expiresIn, 2_147_000_000));
    expiryTimer.unref();
    const combinedSignal = combineAbortSignals([signal, leaseAbort.signal]);
    try {
      const output = await withTaskDirectory(async (taskDirectory) =>
        adapter.run({
          lease,
          taskDirectory,
          signal: combinedSignal.signal,
          onProgress: () => undefined,
        }),
      );
      return {
        leaseId: lease.leaseId,
        output: normalizeBenchmarkOutput(output),
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
        success: true,
      } satisfies BenchmarkUnitResult;
    } catch (error) {
      if (signal.aborted) throw error;
      const detail =
        error instanceof AdapterExecutionError
          ? (error.detail ?? error.message)
          : error instanceof Error
            ? error.message
            : 'unknown error';
      options.onFailure?.(detail);
      return {
        leaseId: lease.leaseId,
        output: null,
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
        success: false,
      } satisfies BenchmarkUnitResult;
    } finally {
      clearTimeout(expiryTimer);
      combinedSignal.dispose();
    }
  });

  if (signal.aborted) throw new Error('Benchmark interrupted.');
  return await api.submitBenchmark(challenge.benchmarkId, results);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await work(value);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

function normalizeBenchmarkOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output;
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return output;
  }
}
