import { randomUUID } from 'node:crypto';

import type {
  AgentAdapter,
  BenchmarkChallenge,
  BenchmarkUnitResult,
  CapacityCertification,
  DeliveryOutcome,
  DeviceCodePoll,
  DeviceCodeStart,
  LeaseFailure,
  LeasePoll,
  LeasePayload,
  NodeRegistration,
  RegisterNodeInput,
  RunnerProgressInput,
  RunnerClaim,
  RunnerJob,
  RunnerRemoteStatus,
  CreateRunnerClaimInput,
  WebhookReceipt,
} from './types.js';
import { parseRetryAfter } from './control-api-client.js';

export const DEFAULT_SERVER = 'https://agentpool.itool.tech';

// Keep every platform route here so the runner can be reconciled with the API in one place.
export const API_ROUTES = {
  deviceStart: '/api/auth/device/start',
  deviceToken: '/api/auth/device/token',
  runnerStatus: '/api/runner/me',
  registerNode: '/api/runner/nodes',
  nodeHeartbeat: (nodeId: string) => `/api/runner/nodes/${encodeURIComponent(nodeId)}/heartbeat`,
  nodeLeases: (nodeId: string) => `/api/runner/nodes/${encodeURIComponent(nodeId)}/leases/poll`,
  nodeDisconnect: (nodeId: string) => `/api/runner/nodes/${encodeURIComponent(nodeId)}`,
  leaseProgress: (leaseId: string) => `/api/runner/leases/${encodeURIComponent(leaseId)}/progress`,
  leaseSubmit: (leaseId: string) => `/api/runner/leases/${encodeURIComponent(leaseId)}/submit`,
  leaseReceipt: (leaseId: string) => `/api/runner/leases/${encodeURIComponent(leaseId)}/receipt`,
  leaseFail: (leaseId: string) => `/api/runner/leases/${encodeURIComponent(leaseId)}/fail`,
  benchmarkStart: '/api/runner/benchmarks',
  benchmarkResults: (benchmarkId: string) =>
    `/api/runner/benchmarks/${encodeURIComponent(benchmarkId)}/results`,
  jobs: (nodeId: string) => `/api/runner/jobs?nodeId=${encodeURIComponent(nodeId)}`,
  claims: '/api/runner/claims',
  claim: (claimId: string) => `/api/runner/claims/${encodeURIComponent(claimId)}`,
  capacity: (adapter?: AgentAdapter, model?: string, nodeId?: string) => {
    const query = new URLSearchParams();
    if (adapter) query.set('adapter', adapter);
    if (model) query.set('model', model);
    if (nodeId) query.set('nodeId', nodeId);
    const suffix = query.toString();
    return `/api/runner/capacity${suffix ? `?${suffix}` : ''}`;
  },
} as const;

type Fetch = typeof globalThis.fetch;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message = `Platform request failed (HTTP ${status}).`,
    readonly metadata: {
      code?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      requestId?: string;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class RunnerTransportError extends Error {
  constructor(
    readonly code: 'REQUEST_TIMEOUT' | 'NETWORK_UNAVAILABLE' | 'AMBIGUOUS_RESPONSE',
    readonly requestId: string,
  ) {
    super(
      code === 'REQUEST_TIMEOUT'
        ? 'Platform request timed out.'
        : code === 'AMBIGUOUS_RESPONSE'
          ? 'Platform response was interrupted or invalid; the operation result is ambiguous.'
          : 'Could not reach the Agent Pool platform.',
    );
    this.name = 'RunnerTransportError';
  }
}

function normalizeServer(server: string): string {
  const url = new URL(server);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Server URL must use HTTP or HTTPS.');
  }
  const localHttpHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol === 'http:' && !localHttpHosts.has(url.hostname)) {
    throw new Error('HTTP is only allowed for a loopback development server. Use HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Server URL must not contain credentials.');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) throw new Error('Invalid platform response.');
  return value;
}

async function decodeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) {
    throw new Error('Platform response is too large.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Platform returned malformed JSON.');
  }
}

export class AgentPoolApiClient {
  readonly server: string;

  constructor(
    server = DEFAULT_SERVER,
    private readonly token?: string,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.server = normalizeServer(server);
  }

  withToken(token: string): AgentPoolApiClient {
    return new AgentPoolApiClient(this.server, token, this.fetchImpl);
  }

  private async request(
    method: string,
    route: string,
    body?: unknown,
    acceptedStatuses: readonly number[] = [200],
    timeoutMs = 20_000,
    idempotencyKey?: string,
  ): Promise<{
    status: number;
    data: unknown;
    requestId: string;
    idempotencyReplayed: boolean;
  }> {
    const localRequestId = randomUUID();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Request-Id': localRequestId,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.server}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const timedOut =
        error instanceof Error &&
        (error.name === 'AbortError' ||
          error.name === 'TimeoutError' ||
          error.message.includes('timed out'));
      throw new RunnerTransportError(
        timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_UNAVAILABLE',
        localRequestId,
      );
    }

    if (!acceptedStatuses.includes(response.status)) {
      // Only a tiny machine-error allowlist is decoded. Server messages,
      // details, task prompts, task inputs, and task outputs are never retained
      // or surfaced by the Runner CLI.
      const metadata = await decodeSafeErrorMetadata(response).catch(() => ({}));
      throw new ApiError(response.status, undefined, {
        ...metadata,
        requestId: response.headers.get('x-request-id') || localRequestId,
      });
    }
    let data: unknown;
    try {
      data = await decodeJson(response);
    } catch {
      throw new RunnerTransportError(
        'AMBIGUOUS_RESPONSE',
        response.headers.get('x-request-id') || localRequestId,
      );
    }
    return {
      status: response.status,
      data,
      requestId: response.headers.get('x-request-id') || localRequestId,
      idempotencyReplayed:
        response.headers.get('idempotency-replayed')?.trim().toLowerCase() === 'true',
    };
  }

  async startDeviceLogin(): Promise<DeviceCodeStart> {
    const { data } = await this.request(
      'POST',
      API_ROUTES.deviceStart,
      { client: 'agentpool-cli' },
      [200, 201],
    );
    if (!isRecord(data)) throw new Error('Invalid platform response.');
    return {
      deviceCode: requireString(data, 'deviceCode'),
      userCode: requireString(data, 'userCode'),
      verificationUri: requireString(data, 'verificationUri'),
      verificationUriComplete:
        typeof data.verificationUriComplete === 'string' ? data.verificationUriComplete : undefined,
      expiresIn: typeof data.expiresIn === 'number' ? data.expiresIn : 600,
      interval: typeof data.interval === 'number' ? data.interval : 5,
    };
  }

  async pollDeviceLogin(deviceCode: string): Promise<DeviceCodePoll> {
    let response: { status: number; data: unknown };
    try {
      response = await this.request(
        'POST',
        API_ROUTES.deviceToken,
        { deviceCode },
        [200, 202, 204],
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) return { status: 'expired' };
      if (error instanceof ApiError && error.status === 403) return { status: 'denied' };
      if (error instanceof ApiError && error.status === 429) return { status: 'slow_down' };
      throw error;
    }
    const { status, data } = response;
    if (status === 202 || status === 204) return { status: 'pending' };
    if (!isRecord(data) || typeof data.status !== 'string') {
      throw new Error('Invalid platform response.');
    }
    if (data.status === 'approved') {
      return { status: 'approved', token: requireString(data, 'token') };
    }
    if (data.status === 'pending' || data.status === 'slow_down') return { status: data.status };
    if (data.status === 'denied' || data.status === 'expired') return { status: data.status };
    throw new Error('Invalid platform response.');
  }

  async getStatus(): Promise<RunnerRemoteStatus> {
    const { data } = await this.request('GET', API_ROUTES.runnerStatus);
    if (!isRecord(data)) throw new Error('Invalid platform response.');
    return data as RunnerRemoteStatus;
  }

  async revokeCredential(): Promise<void> {
    await this.request('DELETE', API_ROUTES.runnerStatus, undefined, [200, 204]);
  }

  async registerNode(input: RegisterNodeInput): Promise<NodeRegistration> {
    const { data } = await this.request('POST', API_ROUTES.registerNode, input, [200, 201]);
    if (!isRecord(data)) throw new Error('Invalid platform response.');
    const node = isRecord(data.node) ? data.node : data;
    return {
      nodeId: requireString(node, 'nodeId' in node ? 'nodeId' : 'id'),
      heartbeatInterval:
        typeof data.heartbeatInterval === 'number' ? data.heartbeatInterval : undefined,
    };
  }

  async heartbeat(nodeId: string, activeLeases: number): Promise<void> {
    await this.request('POST', API_ROUTES.nodeHeartbeat(nodeId), { activeLeases }, [200, 204]);
  }

  async pollLease(
    nodeId: string,
    capability: { adapter: string; models: string[]; claimId: string },
  ): Promise<LeasePoll> {
    const { status, data } = await this.request(
      'POST',
      API_ROUTES.nodeLeases(nodeId),
      capability,
      [200, 204],
    );
    if (status === 204 || data === null) return { lease: null };
    const retryAfterMs =
      isRecord(data) &&
      typeof data.retryAfterMs === 'number' &&
      Number.isFinite(data.retryAfterMs) &&
      data.retryAfterMs >= 0
        ? Math.min(60_000, Math.floor(data.retryAfterMs))
        : undefined;
    const candidate = isRecord(data) && 'lease' in data ? data.lease : data;
    if (candidate === null) return { lease: null, retryAfterMs };
    if (!isRecord(candidate)) throw new Error('Invalid platform response.');
    return { lease: candidate as unknown as LeasePayload, retryAfterMs };
  }

  async listJobs(nodeId: string): Promise<{ jobs: RunnerJob[]; generatedAt: string }> {
    const { data } = await this.request('GET', API_ROUTES.jobs(nodeId));
    const envelope = requireRecord(data);
    if (!Array.isArray(envelope.jobs)) throw new Error('Invalid platform response.');
    return {
      jobs: envelope.jobs.map(parseRunnerJob),
      generatedAt: requireDate(envelope, 'generatedAt'),
    };
  }

  async createClaim(input: CreateRunnerClaimInput): Promise<RunnerClaim> {
    return (await this.createClaimRequest(input)).claim;
  }

  async createClaimRequest(
    input: CreateRunnerClaimInput,
    idempotencyKey?: string,
  ): Promise<{
    claim: RunnerClaim;
    requestId: string;
    idempotencyReplayed: boolean;
  }> {
    const response = await this.request(
      'POST',
      API_ROUTES.claims,
      input,
      [200, 201],
      20_000,
      idempotencyKey,
    );
    let claim: RunnerClaim;
    try {
      claim = parseClaimEnvelope(response.data);
    } catch {
      // A 2xx create response with an invalid envelope is still ambiguous: the
      // reservation may exist. Keep the pending key so the exact request can
      // be safely replayed instead of reporting a definitive local failure.
      throw new RunnerTransportError('AMBIGUOUS_RESPONSE', response.requestId);
    }
    return {
      claim,
      requestId: response.requestId,
      idempotencyReplayed: response.idempotencyReplayed,
    };
  }

  async listClaims(): Promise<RunnerClaim[]> {
    const { data } = await this.request('GET', API_ROUTES.claims);
    const envelope = requireRecord(data);
    if (!Array.isArray(envelope.claims)) throw new Error('Invalid platform response.');
    return envelope.claims.map(parseRunnerClaim);
  }

  async getClaim(claimId: string): Promise<RunnerClaim> {
    const { data } = await this.request('GET', API_ROUTES.claim(claimId));
    return parseClaimEnvelope(data);
  }

  async cancelClaim(claimId: string): Promise<RunnerClaim> {
    const { data } = await this.request('DELETE', API_ROUTES.claim(claimId));
    return parseClaimEnvelope(data);
  }

  async progress(leaseId: string, progress: RunnerProgressInput): Promise<void> {
    await this.request('POST', API_ROUTES.leaseProgress(leaseId), progress, [200, 204]);
  }

  async submit(leaseId: string, output: unknown, timeoutMs?: number): Promise<DeliveryOutcome> {
    const response = await this.request(
      'POST',
      API_ROUTES.leaseSubmit(leaseId),
      { output },
      [200, 201, 204],
      timeoutMs,
    );
    return parseDeliveryOutcome(response.data, response.status === 204 ? 'submitted' : undefined);
  }

  async receipt(
    leaseId: string,
    receipt: WebhookReceipt,
    timeoutMs?: number,
  ): Promise<DeliveryOutcome> {
    const response = await this.request(
      'POST',
      API_ROUTES.leaseReceipt(leaseId),
      receipt,
      [200, 201, 204],
      timeoutMs,
    );
    return parseDeliveryOutcome(response.data, response.status === 204 ? 'recorded' : undefined);
  }

  async fail(leaseId: string, failure: LeaseFailure): Promise<void> {
    await this.request('POST', API_ROUTES.leaseFail(leaseId), failure, [200, 204]);
  }

  async disconnect(nodeId: string): Promise<void> {
    await this.request('DELETE', API_ROUTES.nodeDisconnect(nodeId), undefined, [200, 204]);
  }

  async startBenchmark(
    adapter: AgentAdapter,
    model: string,
    requestedConcurrency: number,
    nodeId?: string,
  ): Promise<BenchmarkChallenge> {
    const { data } = await this.request(
      'POST',
      API_ROUTES.benchmarkStart,
      { nodeId, adapter, model, requestedConcurrency },
      [200, 201],
    );
    if (!isRecord(data) || !Array.isArray(data.leases)) {
      throw new Error('Invalid platform response.');
    }
    return {
      benchmarkId: requireString(data, 'benchmarkId'),
      leases: data.leases as LeasePayload[],
      expiresAt: requireString(data, 'expiresAt'),
    };
  }

  async submitBenchmark(
    benchmarkId: string,
    results: BenchmarkUnitResult[],
  ): Promise<CapacityCertification> {
    const { data } = await this.request(
      'POST',
      API_ROUTES.benchmarkResults(benchmarkId),
      { results },
      [200, 201],
    );
    return parseCertification(data);
  }

  async getCapacity(
    adapter: AgentAdapter,
    model: string,
    nodeId?: string,
  ): Promise<CapacityCertification | null> {
    try {
      const { data } = await this.request('GET', API_ROUTES.capacity(adapter, model, nodeId));
      return parseCertification(data);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async listCapacities(): Promise<CapacityCertification[]> {
    const { data } = await this.request('GET', API_ROUTES.capacity());
    if (!Array.isArray(data)) throw new Error('Invalid platform response.');
    return data.map(parseCertification);
  }
}

async function decodeSafeErrorMetadata(response: Response): Promise<{
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}> {
  const retryAfterFromHeader = parseRetryAfter(response.headers.get('retry-after'));
  const headerMetadata =
    retryAfterFromHeader === undefined ? {} : { retryAfterMs: retryAfterFromHeader };
  if (!response.body) return headerMetadata;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > 64 * 1024) {
      await reader.cancel().catch(() => undefined);
      return headerMetadata;
    }
    chunks.push(next.value);
  }
  try {
    const decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!isRecord(decoded) || !isRecord(decoded.error)) return {};
    const code = decoded.error.code;
    const retryable = decoded.error.retryable;
    const retryAfterMs = decoded.error.retryAfterMs;
    return {
      ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(code) ? { code } : {}),
      ...(typeof retryable === 'boolean' ? { retryable } : {}),
      ...(Number.isSafeInteger(retryAfterMs) && (retryAfterMs as number) >= 0
        ? { retryAfterMs: retryAfterMs as number }
        : headerMetadata),
    };
  } catch {
    return headerMetadata;
  }
}

function parseDeliveryOutcome(data: unknown, emptyStatus?: string): DeliveryOutcome {
  if (data === null && emptyStatus) return { status: emptyStatus };
  if (!isRecord(data) || typeof data.status !== 'string' || !data.status.trim()) {
    throw new Error('Invalid platform response.');
  }
  return {
    status: data.status,
    ...('validation' in data ? { validation: data.validation } : {}),
  };
}

function parseCertification(data: unknown): CapacityCertification {
  if (!isRecord(data)) throw new Error('Invalid platform response.');
  const adapter = requireString(data, 'adapter');
  if (adapter !== 'codex' && adapter !== 'claude' && adapter !== 'mock') {
    throw new Error('Invalid platform response.');
  }
  const numericFields = [data.certifiedConcurrency, data.p50Ms, data.p95Ms, data.successRate];
  if (numericFields.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Invalid platform response.');
  }
  return {
    adapter,
    model: requireString(data, 'model'),
    certified: data.certified === true,
    certifiedConcurrency: data.certifiedConcurrency as number,
    p50Ms: data.p50Ms as number,
    p95Ms: data.p95Ms as number,
    successRate: data.successRate as number,
    expiresAt: requireString(data, 'expiresAt'),
  };
}

function parseClaimEnvelope(data: unknown): RunnerClaim {
  return parseRunnerClaim(requireRecord(data).claim);
}

function parseRunnerClaim(value: unknown): RunnerClaim {
  const claim = requireRecord(value);
  const requestedAgent = requireAgent(claim, 'requestedAgent');
  const deliveryMode = claim.deliveryMode;
  const status = claim.status;
  if (
    (deliveryMode !== 'platform' && deliveryMode !== 'webhook') ||
    (status !== 'active' && status !== 'exhausted' && status !== 'expired' && status !== 'revoked')
  ) {
    throw new Error('Invalid platform response.');
  }
  const maxUnits = requireNonNegativeInteger(claim, 'maxUnits');
  const claimedUnits = requireNonNegativeInteger(claim, 'claimedUnits');
  const remainingUnits = requireNonNegativeInteger(claim, 'remainingUnits');
  if (maxUnits < 1 || claimedUnits > maxUnits || remainingUnits !== maxUnits - claimedUnits) {
    throw new Error('Invalid platform response.');
  }
  return {
    id: requireUuid(claim, 'id'),
    nodeId: requireUuid(claim, 'nodeId'),
    poolId: requireUuid(claim, 'poolId'),
    poolTitle: requireString(claim, 'poolTitle'),
    requestedAgent,
    requestedModel: requireString(claim, 'requestedModel'),
    deliveryMode,
    maxUnits,
    claimedUnits,
    remainingUnits,
    expiresAt: requireDate(claim, 'expiresAt'),
    status,
    createdAt: requireDate(claim, 'createdAt'),
  };
}

function parseRunnerJob(value: unknown): RunnerJob {
  const job = requireRecord(value);
  const deliveryMode = job.deliveryMode;
  const status = job.status;
  if (deliveryMode !== 'platform' && deliveryMode !== 'webhook') {
    throw new Error('Invalid platform response.');
  }
  if (
    status !== 'piloting' &&
    status !== 'waiting_capacity' &&
    status !== 'queued' &&
    status !== 'running'
  ) {
    throw new Error('Invalid platform response.');
  }
  const category = requireString(job, 'category');
  if (!['text', 'data', 'coding', 'research', 'math', 'vision', 'other'].includes(category)) {
    throw new Error('Invalid platform response.');
  }
  const availableUnits = requireNonNegativeInteger(job, 'availableUnits');
  const rewardPerUnit = requireNonNegativeInteger(job, 'rewardPerUnit');
  const maxUnitSeconds = requireNonNegativeInteger(job, 'maxUnitSeconds');
  const maxAttempts = requireNonNegativeInteger(job, 'maxAttempts');
  const deliveryMaxBytes = requireNonNegativeInteger(job, 'deliveryMaxBytes');
  const acceptanceMode = job.acceptanceMode;
  const deliveryFormat = job.deliveryFormat;
  const pilot = job.pilot;
  if (
    ![
      'non_empty',
      'schema',
      'hidden_exact',
      'schema_and_hidden_exact',
      'manual',
      'webhook',
    ].includes(String(acceptanceMode)) ||
    (deliveryFormat !== 'text' && deliveryFormat !== 'json') ||
    typeof pilot !== 'boolean' ||
    maxUnitSeconds < 1 ||
    maxAttempts < 1 ||
    deliveryMaxBytes < 1
  ) {
    throw new Error('Invalid platform response.');
  }
  if (availableUnits < 1 || rewardPerUnit < 1) throw new Error('Invalid platform response.');
  const callbackHost = job.callbackHost;
  if (callbackHost !== undefined && (typeof callbackHost !== 'string' || !callbackHost)) {
    throw new Error('Invalid platform response.');
  }
  return {
    id: requireUuid(job, 'id'),
    title: requireString(job, 'title'),
    status,
    category: category as RunnerJob['category'],
    publicSummary: requireString(job, 'publicSummary'),
    requestedAgent: requireAgent(job, 'requestedAgent'),
    requestedModel: requireString(job, 'requestedModel'),
    deliveryMode,
    ...(callbackHost ? { callbackHost } : {}),
    maxUnitSeconds,
    maxAttempts,
    acceptanceMode: acceptanceMode as RunnerJob['acceptanceMode'],
    deliveryFormat,
    deliveryMaxBytes,
    pilot,
    availableUnits,
    rewardPerUnit,
    claimableUntil: requireDate(job, 'claimableUntil'),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid platform response.');
  return value;
}

function requireUuid(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('Invalid platform response.');
  }
  return value;
}

function requireDate(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (!Number.isFinite(Date.parse(value))) throw new Error('Invalid platform response.');
  return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid platform response.');
  }
  return value as number;
}

function requireAgent(record: Record<string, unknown>, key: string): RunnerClaim['requestedAgent'] {
  const value = record[key];
  if (value !== 'codex' && value !== 'claude' && value !== 'mock') {
    throw new Error('Invalid platform response.');
  }
  return value;
}
