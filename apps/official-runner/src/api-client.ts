import { arch, platform } from 'node:os';

import {
  AgentPoolApiClient,
  API_ROUTES,
  ApiError,
  DEFAULT_SERVER,
  RunnerTransportError,
} from '../../runner/src/api-client.js';
import { parseRetryAfter } from '../../runner/src/control-api-client.js';
import type {
  BenchmarkUnitResult,
  CapacityCertification,
  CreateRunnerClaimInput,
  DeliveryOutcome,
  DeviceCodePoll,
  DeviceCodeStart,
  LeaseFailure,
  NodeRegistration,
  RegisterNodeInput,
  RunnerClaim,
  RunnerJob,
  RunnerProgressInput,
  RunnerRemoteStatus,
  WebhookReceipt,
} from '../../runner/src/types.js';

import { validatePublicServiceUrl } from './config.js';
import type { FleetCellConfig } from './types.js';

export type OfficialFleetMode = 'standby' | 'offline';
export type OfficialClaim = RunnerClaim;

export class OfficialFleetOfflineError extends Error {
  constructor() {
    super('Official Fleet was taken offline.');
    this.name = 'OfficialFleetOfflineError';
  }
}

/** A 2xx response whose body could not be safely read is ambiguous. */
export class OfficialAmbiguousResponseError extends Error {
  readonly code = 'AMBIGUOUS_RESPONSE';

  constructor() {
    super('Platform response was interrupted after the request was accepted.');
    this.name = 'OfficialAmbiguousResponseError';
  }
}

export interface OfficialFleetState {
  operatorType: 'official';
  fleet: {
    ownerId: string;
    mode: OfficialFleetMode;
    updatedAt: string;
  };
}

type Fetch = typeof globalThis.fetch;

export interface OfficialFleetApiOptions {
  server?: string;
  token?: string;
  fetchImpl?: Fetch;
  cell?: FleetCellConfig;
  clientVersion: string;
  routeCapacity?: () => number;
}

export class OfficialFleetApiClient {
  readonly server: string;
  private readonly base: AgentPoolApiClient;
  private readonly fetchImpl: Fetch;
  private readonly token?: string;

  constructor(private readonly options: OfficialFleetApiOptions) {
    const validated = validatePublicServiceUrl(options.server ?? DEFAULT_SERVER);
    this.server = validated.toString().replace(/\/$/u, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.base = new AgentPoolApiClient(this.server, options.token, this.fetchImpl);
  }

  withScope(
    cell: FleetCellConfig,
    runtime?: Pick<OfficialFleetApiOptions, 'routeCapacity'>,
  ): OfficialFleetApiClient {
    return new OfficialFleetApiClient({ ...this.options, cell, ...runtime });
  }

  async startDeviceLogin(): Promise<DeviceCodeStart> {
    const { data } = await this.request(
      'POST',
      API_ROUTES.deviceStart,
      { client: 'agentpool-official-fleet' },
      [200, 201],
      false,
    );
    const record = requireRecord(data);
    return {
      deviceCode: requireString(record, 'deviceCode'),
      userCode: requireString(record, 'userCode'),
      verificationUri: requireString(record, 'verificationUri'),
      ...(typeof record.verificationUriComplete === 'string'
        ? { verificationUriComplete: record.verificationUriComplete }
        : {}),
      expiresIn: finiteNumber(record.expiresIn, 600),
      interval: finiteNumber(record.interval, 3),
    };
  }

  async pollDeviceLogin(deviceCode: string): Promise<DeviceCodePoll> {
    try {
      const { status, data } = await this.request(
        'POST',
        API_ROUTES.deviceToken,
        { deviceCode },
        [200, 202, 204],
        false,
      );
      if (status === 202 || status === 204) return { status: 'pending' };
      const record = requireRecord(data);
      if (record.status === 'approved') {
        if (record.operatorType !== 'official') {
          throw new Error('Platform did not issue an Official Fleet credential.');
        }
        return { status: 'approved', token: requireString(record, 'token') };
      }
      if (record.status === 'pending' || record.status === 'slow_down') {
        return { status: record.status };
      }
      if (record.status === 'denied' || record.status === 'expired') {
        return { status: record.status };
      }
      throw new Error('Invalid platform response.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) return { status: 'expired' };
      if (error instanceof ApiError && error.status === 403) return { status: 'denied' };
      if (error instanceof ApiError && error.status === 429) return { status: 'slow_down' };
      throw error;
    }
  }

  async getOfficialFleet(): Promise<OfficialFleetState> {
    const { data } = await this.request('GET', '/api/runner/official-fleet');
    return parseFleetState(data);
  }

  async listJobs(nodeId: string): Promise<{ jobs: RunnerJob[]; generatedAt: string }> {
    return this.base.listJobs(nodeId);
  }

  async createClaim(input: CreateRunnerClaimInput): Promise<OfficialClaim> {
    return (await this.createClaimRequest(input)).claim;
  }

  /**
   * A Claim is the only stateful operation the Official Runner can create.
   * Keep the idempotency metadata so a supervising Agent can safely resume
   * after a lost response without creating a second bounded Claim.
   */
  async createClaimRequest(
    input: CreateRunnerClaimInput,
    idempotencyKey?: string,
  ): Promise<{
    claim: OfficialClaim;
    requestId: string;
    idempotencyReplayed: boolean;
  }> {
    try {
      return await this.base.createClaimRequest(input, idempotencyKey);
    } catch (error) {
      if (error instanceof ApiError || error instanceof RunnerTransportError) throw error;
      // A create request can have committed before a body stream interruption,
      // malformed 2xx envelope, or a proxy truncation is observed locally. Do
      // not classify it as definitive: the CLI keeps its pending key and asks
      // the platform to replay the same operation on the next invocation.
      throw new OfficialAmbiguousResponseError();
    }
  }

  async listClaims(): Promise<OfficialClaim[]> {
    return this.base.listClaims();
  }

  async getClaim(claimId: string): Promise<OfficialClaim> {
    const [claim, fleet] = await Promise.all([
      this.base.getClaim(claimId),
      this.getOfficialFleet(),
    ]);
    if (fleet.fleet.mode === 'offline') throw new OfficialFleetOfflineError();
    return claim;
  }

  async cancelClaim(claimId: string): Promise<OfficialClaim> {
    return this.base.cancelClaim(claimId);
  }

  async getStatus(): Promise<RunnerRemoteStatus> {
    return this.base.getStatus();
  }

  async revokeCredential(): Promise<void> {
    return this.base.revokeCredential();
  }

  async registerNode(input: RegisterNodeInput): Promise<NodeRegistration> {
    const cell = this.requireCell();
    if (
      input.adapter !== cell.adapter ||
      input.models.length !== 1 ||
      input.models[0] !== cell.model
    ) {
      throw new Error('Official Fleet attempted to register a different execution profile.');
    }
    const { data } = await this.request(
      'POST',
      API_ROUTES.registerNode,
      {
        name: `official-fleet:${cell.id}`,
        platform: `${platform()}/${arch()}`,
        runnerVersion: this.options.clientVersion,
        maxConcurrency: input.concurrency,
        supportsDirectWebhooks: cell.allowWebhooks,
        adapters: [
          {
            adapter: cell.adapter,
            supportedModels: [cell.model],
            ...(input.adapterVersion ? { version: input.adapterVersion } : {}),
          },
        ],
      },
      [200, 201],
    );
    const record = requireRecord(data);
    const node = isRecord(record.node) ? record.node : record;
    return {
      nodeId: requireString(node, 'nodeId' in node ? 'nodeId' : 'id'),
      ...(typeof record.heartbeatInterval === 'number'
        ? { heartbeatInterval: record.heartbeatInterval }
        : {}),
    };
  }

  async heartbeat(nodeId: string, activeLeases: number): Promise<void> {
    await this.base.heartbeat(nodeId, activeLeases);
  }

  async pollLease(
    nodeId: string,
    capability: { adapter: string; models: string[]; claimId: string },
  ): Promise<{ lease: unknown | null; retryAfterMs?: number }> {
    if ((this.options.routeCapacity?.() ?? 1) < 1) {
      return { lease: null, retryAfterMs: 3_000 };
    }
    const { status, data } = await this.request(
      'POST',
      API_ROUTES.nodeLeases(nodeId),
      capability,
      [200, 204],
    );
    if (status === 204 || data === null) {
      return { lease: null, retryAfterMs: 3_000 };
    }
    const record = isRecord(data) ? data : undefined;
    const retryAfterMs =
      record && typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)
        ? Math.max(0, Math.min(60_000, Math.floor(record.retryAfterMs)))
        : undefined;
    const candidate = record && 'lease' in record ? record.lease : data;
    if (candidate === null) {
      return { lease: null, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    }
    if (!isRecord(candidate)) throw new Error('Invalid platform response.');
    return { lease: candidate, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }

  async progress(leaseId: string, progress: RunnerProgressInput): Promise<void> {
    await this.base.progress(leaseId, progress);
  }

  async submit(leaseId: string, output: unknown, timeoutMs?: number): Promise<DeliveryOutcome> {
    return this.base.submit(leaseId, output, timeoutMs);
  }

  async receipt(
    leaseId: string,
    receipt: WebhookReceipt,
    timeoutMs?: number,
  ): Promise<DeliveryOutcome> {
    return this.base.receipt(leaseId, receipt, timeoutMs);
  }

  async fail(leaseId: string, failure: LeaseFailure): Promise<void> {
    await this.base.fail(leaseId, failure);
  }

  async disconnect(nodeId: string): Promise<void> {
    await this.base.disconnect(nodeId);
  }

  async startBenchmark(
    adapter: 'codex' | 'claude' | 'mock',
    model: string,
    requestedConcurrency: number,
    nodeId?: string,
  ) {
    return this.base.startBenchmark(adapter, model, requestedConcurrency, nodeId);
  }

  async submitBenchmark(
    benchmarkId: string,
    results: BenchmarkUnitResult[],
  ): Promise<CapacityCertification> {
    return this.base.submitBenchmark(benchmarkId, results);
  }

  async getCapacity(
    adapter: 'codex' | 'claude' | 'mock',
    model: string,
    nodeId?: string,
  ): Promise<CapacityCertification | null> {
    return this.base.getCapacity(adapter, model, nodeId);
  }

  async listCapacities(): Promise<CapacityCertification[]> {
    return this.base.listCapacities();
  }

  private requireCell(): FleetCellConfig {
    if (!this.options.cell) throw new Error('Official Fleet API is not scoped to a Cell.');
    return this.options.cell;
  }

  private async request(
    method: string,
    route: string,
    body?: unknown,
    acceptedStatuses: readonly number[] = [200],
    authenticated = true,
  ): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      if (!this.token) throw new Error('Official Fleet is signed out.');
      headers.Authorization = `Bearer ${this.token}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.server}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
    } catch {
      throw new Error('Could not reach the Agent Pool platform.');
    }
    if (!acceptedStatuses.includes(response.status)) {
      // Do not retain or surface arbitrary platform error bodies: a task
      // capsule or delivery artifact must never become terminal output.
      const metadata = await readSafeErrorMetadata(response);
      throw new ApiError(response.status, undefined, metadata);
    }
    const text = await response.text();
    if (!text) return { status: response.status, data: null };
    if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) {
      throw new Error('Platform response is too large.');
    }
    try {
      return { status: response.status, data: JSON.parse(text) as unknown };
    } catch {
      throw new Error('Platform returned malformed JSON.');
    }
  }
}

async function readSafeErrorMetadata(response: Response): Promise<{
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  requestId?: string;
}> {
  const headerRetryAfter = parseRetryAfter(response.headers.get('retry-after'));
  const fallback = {
    ...(headerRetryAfter === undefined ? {} : { retryAfterMs: headerRetryAfter }),
    ...(response.headers.get('x-request-id')
      ? { requestId: response.headers.get('x-request-id')! }
      : {}),
  };
  if (!response.body) return fallback;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > 64 * 1024) {
      await reader.cancel().catch(() => undefined);
      return fallback;
    }
    chunks.push(part.value);
  }
  try {
    const decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!isRecord(decoded) || !isRecord(decoded.error)) return fallback;
    const error = decoded.error;
    const retryAfterMs = error.retryAfterMs;
    return {
      ...(typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.code)
        ? { code: error.code }
        : {}),
      ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      ...(Number.isSafeInteger(retryAfterMs) && (retryAfterMs as number) >= 0
        ? { retryAfterMs: retryAfterMs as number }
        : headerRetryAfter === undefined
          ? {}
          : { retryAfterMs: headerRetryAfter }),
      ...(response.headers.get('x-request-id')
        ? { requestId: response.headers.get('x-request-id')! }
        : {}),
    };
  } catch {
    return fallback;
  }
}

function parseFleetState(value: unknown): OfficialFleetState {
  const envelope = requireRecord(value);
  const fleet = requireRecord(envelope.fleet);
  if (
    envelope.operatorType !== 'official' ||
    (fleet.mode !== 'standby' && fleet.mode !== 'offline')
  ) {
    throw new Error('Invalid platform response.');
  }
  return {
    operatorType: 'official',
    fleet: {
      ownerId: requireString(fleet, 'ownerId'),
      mode: fleet.mode,
      updatedAt: requireDate(fleet, 'updatedAt'),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid platform response.');
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) throw new Error('Invalid platform response.');
  return value;
}

function requireDate(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (!Number.isFinite(Date.parse(value))) throw new Error('Invalid platform response.');
  return value;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
