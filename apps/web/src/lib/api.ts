import type {
  CapacityQuote,
  LiveEvent,
  PoolSummary,
  TaskCapsule,
  WalletSummary,
} from '@agent-pool/shared';
import type { CreatePoolWebInput, DeliveryTarget } from './taskContract';
import type {
  CapacityCatalogItem,
  ApiErrorBody,
  ControlCredential,
  ControlDevicePreview,
  DashboardData,
  DeviceApprovalResult,
  LedgerEntry,
  NetworkPulse,
  OfficialFleetMode,
  OfficialFleetView,
  PoolDetail,
  PoolUnit,
  RunnerMarketPool,
  RunnerNodePublic,
  RunnerDevicePreview,
  User,
} from './types';

const API_ROOT = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  readonly code?: string;

  constructor(message: string, status: number, details?: unknown, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  const contentType = response.headers.get('content-type') || '';
  const body: unknown = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const errorBody = typeof body === 'object' ? (body as ApiErrorBody) : undefined;
    const nestedError =
      errorBody?.error && typeof errorBody.error === 'object' ? errorBody.error : undefined;
    const flatError = typeof errorBody?.error === 'string' ? errorBody.error : undefined;
    throw new ApiError(
      nestedError?.message ||
        errorBody?.message ||
        flatError ||
        (typeof body === 'string' && body) ||
        '请求失败',
      response.status,
      nestedError?.details || errorBody?.details,
      nestedError?.code,
    );
  }

  return body as T;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}

interface DashboardEnvelope {
  wallet: WalletSummary;
  pools: {
    total: number;
    live: number;
    completed: number;
    totalUnits: number;
    acceptedUnits: number;
  };
  runners: { total: number; online: number; activeLeases: number };
}

interface NetworkPulseEnvelope {
  onlineNodes: number;
  certifiedConcurrency: number;
  activeLeases: number;
  queuedUnits: number;
  acceptedToday: number;
  creditsEarnedToday: number;
  at: string;
}

interface OwnedPoolView extends PoolSummary {
  secretInstruction?: string;
  validationMode: 'auto' | 'manual';
  outputSchema?: Record<string, unknown>;
  maxAttempts?: number;
  updatedAt?: string;
  capsule?: TaskCapsule;
  taskCapsule?: TaskCapsule;
  deliveryTarget?:
    | Extract<DeliveryTarget, { mode: 'platform' }>
    | { mode: 'webhook'; hostname?: string; url?: string };
  launchMode?: 'pilot' | 'immediate';
}

interface PoolEnvelope {
  pool: OwnedPoolView;
}

interface PoolListEnvelope {
  pools: PoolSummary[];
  total: number;
  limit: number;
  offset: number;
}

interface ResultRow {
  id: string;
  ordinal: number;
  label?: string;
  input: unknown;
  result?: unknown;
  status: PoolUnit['status'];
  attemptCount: number;
  validation?: unknown;
  failureReason?: string;
  submittedAt?: string | null;
  acceptedAt?: string | null;
  isPilot?: boolean;
  externalReceipt?: {
    receiptId: string;
    resultSha256?: string | null;
    decision?: 'accepted' | 'rejected' | null;
    retryable?: boolean | null;
    reason?: string;
    attempt?: number | null;
    createdAt?: string | null;
  };
  agent?: PoolUnit['agent'];
  model?: string;
}

interface ResultsEnvelope {
  results: ResultRow[];
  total: number;
  limit: number;
  offset: number;
}

interface RawLedgerEntry {
  id: string;
  bucket: string;
  delta: number;
  kind: string;
  referenceType?: string | null;
  referenceId?: string | null;
  createdAt: string;
}

interface RunnersEnvelope {
  nodes: Array<
    Omit<RunnerNodePublic, 'activeJobs'> & {
      activeJobs?: Array<{ stage: string; progress: number; reward: number }>;
    }
  >;
  privacyBoundary: {
    taskInstructionsVisible: false;
    taskInputsVisible: false;
    taskResultsVisible: false;
    visibleTelemetry: string[];
  };
}

type RunnerNodeEnvelope = Omit<RunnerNodePublic, 'activeJobs'> & {
  activeJobs?: Array<{ stage: string; progress: number; reward: number }>;
};

interface OfficialFleetEnvelope {
  fleet: {
    ownerId: string;
    ownerEmail: string;
    mode: OfficialFleetMode;
    updatedAt: string;
  };
  nodes: {
    total: number;
    online: number;
    activeLeases: number;
  };
  wallet: WalletSummary;
}

function runnerNodeFromEnvelope(node: RunnerNodeEnvelope): RunnerNodePublic {
  return {
    id: node.id,
    name: node.name,
    status: node.status,
    platform: node.platform,
    runnerVersion: node.runnerVersion,
    maxConcurrency: node.maxConcurrency,
    activeLeases: node.activeLeases,
    lastSeenAt: node.lastSeenAt,
    operatorType: node.operatorType,
    supportsDirectWebhooks: node.supportsDirectWebhooks,
    completedToday: node.completedToday,
    earnedToday: node.earnedToday,
    certifications: (node.certifications || []).map((certification) => ({
      adapter: certification.adapter,
      model: certification.model,
      certifiedConcurrency: certification.certifiedConcurrency,
      p50Ms: certification.p50Ms,
      p95Ms: certification.p95Ms,
      successRate: certification.successRate,
      expiresAt: certification.expiresAt,
    })),
    activeJobs: (node.activeJobs || []).map(({ stage, progress, reward }) => ({
      stage,
      progress,
      reward,
    })),
  };
}

function officialFleetFromEnvelope(result: OfficialFleetEnvelope): OfficialFleetView {
  return {
    ...result.fleet,
    nodeSummary: result.nodes,
    wallet: result.wallet,
  };
}

function normalizeNetwork(value: NetworkPulseEnvelope, activePools = 0): NetworkPulse {
  return {
    onlineNodes: value.onlineNodes,
    busyNodes: value.activeLeases,
    activePools,
    queuedUnits: value.queuedUnits,
    completedToday: value.acceptedToday,
    updatedAt: value.at,
  };
}

function ledgerBucket(bucket: string): keyof WalletSummary {
  const map: Record<string, keyof WalletSummary> = {
    purchased_available: 'purchasedAvailable',
    purchased_locked: 'purchasedLocked',
    earned_pending: 'earnedPending',
    earned_available: 'earnedAvailable',
  };
  return map[bucket] || 'purchasedAvailable';
}

function ledgerKind(kind: string): LedgerEntry['kind'] {
  if (kind === 'dev_topup') return 'topup';
  if (kind === 'pool_lock') return 'lock';
  if (kind.includes('refund') || kind.includes('unlock')) return 'unlock';
  if (kind === 'unit_settlement') return 'earning_pending';
  if (kind === 'earning_release') return 'earning_settled';
  if (kind === 'dev_withdrawal') return 'withdrawal';
  if (kind === 'self_settlement') return 'self_settlement';
  return 'adjustment';
}

function ledgerDescription(row: RawLedgerEntry): string {
  const labels: Record<string, string> = {
    dev_topup: '增加开发态可消费积分',
    pool_lock: '任务预算流动',
    unit_settlement: '任务验收结算',
    earning_release: '收益释放为可提现积分',
    dev_withdrawal: '开发态模拟提现',
    pool_refund: '未执行任务预算退回',
    self_settlement: '自己跑完，积分已消耗、不计入收益',
  };
  return labels[row.kind] || row.kind.replaceAll('_', ' ');
}

function unitFromResult(row: ResultRow, fallbackAt: string): PoolUnit {
  let score: number | undefined;
  if (row.validation && typeof row.validation === 'object' && 'score' in row.validation) {
    const candidate = Number((row.validation as { score?: unknown }).score);
    if (Number.isFinite(candidate)) score = candidate;
  }
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    input: row.input,
    output: row.result,
    score,
    rejectionReason: row.failureReason,
    submittedAt: row.submittedAt || undefined,
    updatedAt: row.acceptedAt || row.submittedAt || fallbackAt,
    attemptCount: row.attemptCount,
    isPilot: row.isPilot,
    validation:
      row.validation && typeof row.validation === 'object'
        ? (row.validation as PoolUnit['validation'])
        : undefined,
    externalReceipt: row.externalReceipt,
    agent: row.agent,
    model: row.model,
  };
}

export interface CapacityQuoteWebRequest {
  adapter: PoolSummary['requestedAgent'];
  model: string;
  deliveryMode: DeliveryTarget['mode'];
  unitCount: number;
  requiredConcurrency: number;
  maxUnitSeconds: number;
  deadlineAt: string;
}

export interface ValidatePoolResult {
  valid: true;
  totalUnits: number;
  totalCost: number;
  dataset:
    | { mode: 'inline' }
    | { mode: 'https'; url: string; host: string }
    | {
        mode: 'work';
        url: string;
        host: string;
        packageHost?: string;
        answersHost?: string | null;
      };
  workPackage?: {
    title: string;
    category: string;
    publicSummary: string;
    adapter: string;
    model: string;
    urlHost: string;
    unitsHost: string;
    answersHost: string | null;
    acceptance: string;
  };
  taskCapsule?: TaskCapsule;
  capacityQuote?: CapacityQuote;
}

async function requestCapacityQuote(input: CapacityQuoteWebRequest): Promise<CapacityQuote> {
  return (await request<{ quote: CapacityQuote }>('/capacity/quote', json('POST', input))).quote;
}

async function requestPoolResults(
  id: string,
  options: { status?: 'submitted' | 'accepted' | 'failed'; offset?: number; limit?: number } = {},
): Promise<{ units: PoolUnit[]; total: number }> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 100),
    offset: String(options.offset ?? 0),
  });
  if (options.status) params.set('status', options.status);
  const result = await request<ResultsEnvelope>(
    `/pools/${encodeURIComponent(id)}/results?${params.toString()}`,
  );
  return {
    units: result.results.map((row) => unitFromResult(row, new Date().toISOString())),
    total: result.total,
  };
}

async function requestPoolDetail(id: string): Promise<PoolDetail> {
  const encoded = encodeURIComponent(id);
  const { pool } = await request<PoolEnvelope>(`/pools/${encoded}`);
  const remaining = pool.queuedUnits + pool.runningUnits + pool.submittedUnits;
  const [results, quote] = await Promise.all([
    requestPoolResults(id, { limit: 100 }),
    remaining > 0
      ? requestCapacityQuote({
          adapter: pool.requestedAgent,
          model: pool.requestedModel,
          deliveryMode: pool.deliveryTarget?.mode || 'platform',
          unitCount: remaining,
          requiredConcurrency: Math.min(pool.requiredConcurrency, remaining),
          maxUnitSeconds: pool.maxUnitSeconds,
          deadlineAt: pool.deadlineAt,
        })
      : Promise.resolve<CapacityQuote | undefined>(undefined),
  ]);
  return {
    ...pool,
    units: results.units,
    resultTotal: results.total,
    activeConcurrency: pool.runningUnits,
    capacityQuote: quote,
    estimatedCompletionAt:
      quote?.estimatedSeconds === null || quote?.estimatedSeconds === undefined
        ? undefined
        : new Date(Date.now() + quote.estimatedSeconds * 1000).toISOString(),
    deadlineRisk: quote ? !quote.feasible : false,
    deadlineRiskReason: quote?.reasons.join(' · '),
  };
}

export const api = {
  session: () => request<{ user: User }>('/auth/me'),
  login: (input: { email: string; password: string }) =>
    request<{ user: User }>('/auth/login', json('POST', input)),
  register: (input: { displayName: string; email: string; password: string }) =>
    request<{ user: User }>('/auth/register', json('POST', input)),
  logout: () => request<void>('/auth/logout', json('POST')),

  dashboard: async (): Promise<DashboardData> => {
    const [dashboard, pools, pulse] = await Promise.all([
      request<DashboardEnvelope>('/dashboard'),
      request<PoolListEnvelope>('/pools?limit=100&offset=0'),
      request<NetworkPulseEnvelope>('/network/pulse'),
    ]);
    return {
      wallet: dashboard.wallet,
      pools: pools.pools,
      network: normalizeNetwork(pulse, dashboard.pools.live),
    };
  },
  networkPulse: async (): Promise<NetworkPulse> =>
    normalizeNetwork(await request<NetworkPulseEnvelope>('/network/pulse')),
  capacityCatalog: async (): Promise<CapacityCatalogItem[]> => {
    const result = await request<{
      capacity: Array<{ adapter: CapacityCatalogItem['adapter']; model: string }>;
      generatedAt: string;
    }>('/capacity/catalog');
    const grouped = new Map<CapacityCatalogItem['adapter'], Set<string>>();
    for (const item of result.capacity) {
      const models = grouped.get(item.adapter) || new Set<string>();
      models.add(item.model);
      grouped.set(item.adapter, models);
    }
    return [...grouped.entries()].map(([adapter, models]) => ({ adapter, models: [...models] }));
  },
  capacityQuote: requestCapacityQuote,

  listPools: async () => (await request<PoolListEnvelope>('/pools?limit=100&offset=0')).pools,
  validatePool: (input: CreatePoolWebInput) =>
    request<ValidatePoolResult>('/pools/validate', json('POST', input)),
  createPool: async (input: CreatePoolWebInput) =>
    (
      await request<{ pool: PoolSummary; capacityQuote: CapacityQuote; wallet: WalletSummary }>(
        '/pools',
        json('POST', input),
      )
    ).pool,
  getPool: requestPoolDetail,
  poolResults: requestPoolResults,
  cancelPool: async (id: string) => {
    await request<{ refunded: number; pool: PoolSummary; wallet: WalletSummary }>(
      `/pools/${encodeURIComponent(id)}/cancel`,
      json('POST'),
    );
    return requestPoolDetail(id);
  },
  launchPool: async (id: string) => {
    await request<{ pool?: unknown }>(`/pools/${encodeURIComponent(id)}/launch`, json('POST'));
    return requestPoolDetail(id);
  },
  reviewUnit: async (
    poolId: string,
    unitId: string,
    decision: 'accept' | 'retry' | 'reject',
    reason?: string,
  ) => {
    await request<{ reviewed: true }>(
      `/pools/${encodeURIComponent(poolId)}/units/${encodeURIComponent(unitId)}/review`,
      json('POST', {
        decision: decision === 'accept' ? 'accept' : 'reject',
        retry: decision === 'retry',
        reason,
      }),
    );
    return requestPoolDetail(poolId);
  },

  wallet: async () => (await request<{ wallet: WalletSummary }>('/wallet')).wallet,
  ledger: async (): Promise<LedgerEntry[]> => {
    const result = await request<{ entries: RawLedgerEntry[]; nextCursor: string | null }>(
      '/wallet/ledger',
    );
    return result.entries.map((row) => ({
      id: row.id,
      kind: ledgerKind(row.kind),
      amount: row.delta,
      balanceBucket: ledgerBucket(row.bucket),
      description: ledgerDescription(row),
      referenceId: row.referenceId || undefined,
      createdAt: row.createdAt,
    }));
  },
  devTopUp: async (credits: number) =>
    (await request<{ wallet: WalletSummary }>('/wallet/dev-topup', json('POST', { credits })))
      .wallet,
  devWithdraw: async (credits: number) => {
    const result = await request<{
      wallet: WalletSummary;
      withdrawal: { id: string; status: 'simulated_paid' };
    }>('/wallet/dev-withdraw', json('POST', { credits }));
    return {
      wallet: result.wallet,
      status: result.withdrawal.status,
      withdrawalId: result.withdrawal.id,
    };
  },

  createNodeClaim: async (nodeId: string, input: { poolId: string; maxUnits: number }) =>
    request<{
      claim: {
        id: string;
        poolId: string;
        nodeId: string;
        maxUnits: number;
        remainingUnits: number;
        expiresAt: string;
        status: string;
      };
      executeCommand: string;
    }>(`/runners/${encodeURIComponent(nodeId)}/claims`, json('POST', input)),

  runners: async (): Promise<RunnerNodePublic[]> => {
    const { nodes } = await request<RunnersEnvelope>('/runners');
    return nodes.map(runnerNodeFromEnvelope);
  },
  officialFleet: async (): Promise<OfficialFleetView> =>
    officialFleetFromEnvelope(await request<OfficialFleetEnvelope>('/official-fleet')),
  updateOfficialFleet: async (mode: OfficialFleetMode): Promise<OfficialFleetView> =>
    officialFleetFromEnvelope(
      await request<OfficialFleetEnvelope>('/official-fleet', json('PATCH', { mode })),
    ),
  runnerMarketPools: async (): Promise<RunnerMarketPool[]> =>
    (
      await request<{ pools: RunnerMarketPool[]; limit: number; offset: number }>(
        '/public/pools?limit=100&offset=0',
      )
    ).pools,
  previewRunnerDevice: async (userCode: string): Promise<RunnerDevicePreview> => ({
    ...(await request<Omit<RunnerDevicePreview, 'kind'>>(
      '/auth/device/preview',
      json('POST', { userCode }),
    )),
    kind: 'runner',
  }),
  approveRunnerDevice: async (
    userCode: string,
    expected: {
      client: 'agentpool-cli' | 'agentpool-official-fleet';
      operatorType: 'community' | 'official';
    },
  ): Promise<DeviceApprovalResult> => {
    const result = await request<{
      approved: true;
      label: string;
      operatorType: 'community' | 'official';
    }>(
      '/auth/device/approve',
      json('POST', {
        userCode,
        expectedClient: expected.client,
        expectedOperatorType: expected.operatorType,
      }),
    );
    return { ...result, kind: 'runner' };
  },

  previewControlDevice: (userCode: string): Promise<ControlDevicePreview> =>
    request<ControlDevicePreview>('/auth/control/device/preview', json('POST', { userCode })),
  approveControlDevice: (
    userCode: string,
    approvalContext: string,
  ): Promise<DeviceApprovalResult> =>
    request<DeviceApprovalResult>(
      '/auth/control/device/approve',
      json('POST', { userCode, approvalContext }),
    ),
  denyControlDevice: (userCode: string, approvalContext: string) =>
    request<{ denied: true; label: string; kind: 'control' }>(
      '/auth/control/device/deny',
      json('POST', { userCode, approvalContext }),
    ),
  controlCredentials: async (): Promise<ControlCredential[]> =>
    (await request<{ credentials: ControlCredential[] }>('/auth/control/credentials')).credentials,
  revokeControlCredential: (credentialId: string) =>
    request<{ revoked: true; credentialId: string }>(
      `/auth/control/credentials/${encodeURIComponent(credentialId)}`,
      json('DELETE'),
    ),

  updateProfile: (input: { displayName: string }) =>
    request<{ user: User }>('/settings/profile', json('PATCH', input)),
};

export function normalizeList<T>(value: T[]): T[] {
  return value;
}

export function liveEventsUrl(cursor?: string): string {
  const params = new URLSearchParams();
  if (cursor) params.set('after', cursor);
  const query = params.toString();
  return `${API_ROOT}/events${query ? `?${query}` : ''}`;
}

export function parseLiveEvent(event: MessageEvent<string>): LiveEvent | null {
  try {
    const parsed = JSON.parse(event.data) as LiveEvent;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
