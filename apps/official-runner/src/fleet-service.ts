import { arch, platform } from 'node:os';

import { runBenchmark } from '../../runner/src/benchmark.js';
import { resolveCertifiedConcurrency, RunnerService } from '../../runner/src/runner-service.js';

import {
  OfficialFleetApiClient,
  OfficialFleetOfflineError,
  type OfficialClaim,
  type OfficialFleetState,
} from './api-client.js';
import { CellAdapter, CellRoutePool } from './route-pool.js';
import type { FleetCellConfig, FleetLogger, OfficialFleetConfig } from './types.js';

export interface RunClaimOptions {
  config: OfficialFleetConfig;
  api: OfficialFleetApiClient;
  claim: OfficialClaim;
  signal: AbortSignal;
  logger: FleetLogger;
  clientVersion: string;
}

export interface ClaimRunSummary {
  claimId: string;
  poolId: string;
  requestedUnits: number;
  claimedBefore: number;
  terminalStatus: OfficialClaim['status'] | 'offline' | 'unknown';
}

export interface PreparedCellNode {
  cell: FleetCellConfig;
  nodeId: string;
}

export function findCellForClaim(
  config: OfficialFleetConfig,
  claim: OfficialClaim,
): FleetCellConfig {
  const cell = config.cells.find(
    (candidate) =>
      candidate.adapter === claim.requestedAgent && candidate.model === claim.requestedModel,
  );
  if (!cell) {
    throw new Error('No configured Cell matches the claim exact adapter/model profile.');
  }
  if (claim.deliveryMode === 'webhook' && !cell.allowWebhooks) {
    throw new Error('The matching Cell does not allow direct Webhook delivery.');
  }
  return cell;
}

export async function prepareCellNode(options: {
  api: OfficialFleetApiClient;
  cell: FleetCellConfig;
  logger: FleetLogger;
  clientVersion: string;
}): Promise<PreparedCellNode> {
  const routePool = new CellRoutePool(options.cell, { logger: options.logger });
  const adapter = new CellAdapter(routePool);
  const detection = await adapter.detect();
  if (!detection.available || !detection.authenticated) {
    throw new Error('No Route in this Cell has an available, authenticated CLI.');
  }
  const concurrency = routePool.totalConcurrency();
  const scopedApi = options.api.withScope(options.cell);
  const node = await scopedApi.registerNode({
    adapter: options.cell.adapter,
    models: [options.cell.model],
    concurrency,
    adapterVersion: detection.version,
    clientVersion: options.clientVersion,
    platform: platform(),
    arch: arch(),
    supportsDirectWebhooks: options.cell.allowWebhooks,
  });
  try {
    await resolveCertifiedConcurrency({
      api: scopedApi,
      adapter: options.cell.adapter,
      models: [options.cell.model],
      requestedConcurrency: concurrency,
      nodeId: node.nodeId,
    });
    return { cell: options.cell, nodeId: node.nodeId };
  } catch (error) {
    await scopedApi.disconnect(node.nodeId).catch(() => undefined);
    throw error;
  }
}

export async function runBoundedClaim(options: RunClaimOptions): Promise<ClaimRunSummary> {
  if (options.claim.status !== 'active' || options.claim.remainingUnits < 1) {
    throw new Error('The selected claim is not active.');
  }
  const cell = findCellForClaim(options.config, options.claim);
  const routePool = new CellRoutePool(cell, { logger: options.logger });
  const adapter = new CellAdapter(routePool);
  const scopedApi = options.api.withScope(cell, {
    routeCapacity: () => routePool.availableConcurrency(),
  });

  try {
    const runner = new RunnerService({
      api: scopedApi,
      adapter,
      models: [cell.model],
      requestedConcurrency: routePool.totalConcurrency(),
      claimId: options.claim.id,
      expectedNodeId: options.claim.nodeId,
      signal: options.signal,
      logger: options.logger,
      clientVersion: options.clientVersion,
      pollIntervalMs: options.config.pollIntervalMs,
      shutdownGraceMs: 30_000,
      allowWebhooks: cell.allowWebhooks,
    });
    await runner.run();
    if (options.signal.aborted) {
      throw new Error('Official Fleet claim was interrupted.');
    }
    const finalClaim = await options.api.getClaim(options.claim.id);
    return {
      claimId: options.claim.id,
      poolId: options.claim.poolId,
      requestedUnits: options.claim.maxUnits,
      claimedBefore: options.claim.claimedUnits,
      terminalStatus: finalClaim.status,
    };
  } catch (error) {
    if (error instanceof OfficialFleetOfflineError) {
      return {
        claimId: options.claim.id,
        poolId: options.claim.poolId,
        requestedUnits: options.claim.maxUnits,
        claimedBefore: options.claim.claimedUnits,
        terminalStatus: 'offline',
      };
    }
    throw error;
  }
}

export async function benchmarkCell(options: {
  config: OfficialFleetConfig;
  api: OfficialFleetApiClient;
  cellId: string;
  concurrency?: number;
  signal: AbortSignal;
  logger: FleetLogger;
  clientVersion: string;
}) {
  const cell = options.config.cells.find((candidate) => candidate.id === options.cellId);
  if (!cell) throw new Error('Configured Cell not found.');
  const routePool = new CellRoutePool(cell, { logger: options.logger });
  const adapter = new CellAdapter(routePool);
  const detection = await adapter.detect();
  if (!detection.available || !detection.authenticated) {
    throw new Error('No Route in this Cell has an available, authenticated CLI.');
  }
  const concurrency = options.concurrency ?? routePool.totalConcurrency();
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > routePool.totalConcurrency()
  ) {
    throw new Error('Benchmark concurrency exceeds the configured Cell capacity.');
  }
  const scopedApi = options.api.withScope(cell);
  const node = await scopedApi.registerNode({
    adapter: cell.adapter,
    models: [cell.model],
    concurrency,
    adapterVersion: detection.version,
    clientVersion: options.clientVersion,
    platform: platform(),
    arch: arch(),
    supportsDirectWebhooks: cell.allowWebhooks,
  });
  try {
    return await runBenchmark({
      api: scopedApi,
      adapter,
      model: cell.model,
      concurrency,
      nodeId: node.nodeId,
      signal: options.signal,
    });
  } finally {
    await scopedApi.disconnect(node.nodeId).catch(() => undefined);
  }
}

export function requireStandby(state: OfficialFleetState): void {
  if (state.fleet.mode !== 'standby') {
    throw new Error('Official Fleet is offline. Put it in standby from the owner console first.');
  }
}
