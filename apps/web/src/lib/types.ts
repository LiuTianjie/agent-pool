import type {
  CapacityQuote,
  PoolSummary,
  RequestedAgent,
  TaskCategory,
  TaskStage,
  WalletSummary,
} from '@agent-pool/shared';
import type { DeliveryTarget, LaunchMode, TaskCapsule } from './taskContract';

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt?: string;
}

export interface NetworkPulse {
  onlineNodes: number;
  busyNodes: number;
  activePools: number;
  queuedUnits: number;
  completedToday: number;
  updatedAt: string;
}

export interface DashboardData {
  wallet: WalletSummary;
  pools: PoolSummary[];
  network: NetworkPulse;
}

export type UnitStatus =
  'queued' | 'leased' | 'running' | 'submitted' | 'accepted' | 'rejected' | 'failed' | 'cancelled';

export interface PoolUnit {
  id: string;
  label?: string;
  status: UnitStatus;
  input?: unknown;
  output?: unknown;
  score?: number;
  rejectionReason?: string;
  agent?: RequestedAgent;
  model?: string;
  submittedAt?: string;
  updatedAt: string;
  attemptCount?: number;
  isPilot?: boolean;
  validation?: {
    valid?: boolean;
    mode?: string;
    checks?: Record<string, unknown>;
    errors?: Array<{ check?: string; message: string; path?: string }>;
  };
  externalReceipt?: {
    receiptId: string;
    resultSha256?: string | null;
    decision?: 'accepted' | 'rejected' | null;
    retryable?: boolean | null;
    reason?: string;
    attempt?: number | null;
    createdAt?: string | null;
  };
}

export type PoolDetail = Omit<PoolSummary, 'status'> & {
  status: PoolSummary['status'] | 'piloting';
  validationMode: 'auto' | 'manual';
  secretInstruction?: string;
  outputSchema?: Record<string, unknown>;
  units: PoolUnit[];
  activeConcurrency?: number;
  capacityQuote?: CapacityQuote;
  estimatedCompletionAt?: string;
  deadlineRisk?: boolean;
  deadlineRiskReason?: string;
  resultTotal?: number;
  capsule?: TaskCapsule;
  taskCapsule?: TaskCapsule;
  deliveryTarget?:
    | Extract<DeliveryTarget, { mode: 'platform' }>
    | { mode: 'webhook'; hostname?: string; url?: string };
  launchMode?: LaunchMode;
  contractVersion?: number;
};

export interface CapacityCatalogItem {
  adapter: 'codex' | 'claude' | 'mock';
  models: string[];
}

export interface RunnerNodePublic {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'paused';
  platform?: string;
  runnerVersion?: string;
  maxConcurrency: number;
  activeLeases: number;
  activeJobs: RunnerJobTelemetry[];
  lastSeenAt: string;
  operatorType: 'community' | 'official';
  supportsDirectWebhooks: boolean;
  completedToday: number;
  earnedToday: number;
  certifications: RunnerCertificationPublic[];
}

export interface RunnerCertificationPublic {
  adapter: RequestedAgent;
  model: string;
  certifiedConcurrency: number;
  p50Ms: number;
  p95Ms: number;
  successRate: number;
  expiresAt: string;
}

export interface RunnerJobTelemetry {
  stage: string;
  progress: number;
  reward: number;
}

export type OfficialFleetMode = 'standby' | 'offline';

export type RunnerMarketPool = PoolSummary;

export interface OfficialFleetView {
  ownerId: string;
  ownerEmail: string;
  mode: OfficialFleetMode;
  updatedAt: string;
  nodeSummary: {
    total: number;
    online: number;
    activeLeases: number;
  };
  wallet: WalletSummary;
}

export interface LedgerEntry {
  id: string;
  kind:
    | 'topup'
    | 'lock'
    | 'unlock'
    | 'earning_pending'
    | 'earning_settled'
    | 'withdrawal'
    | 'adjustment';
  amount: number;
  balanceBucket: keyof WalletSummary;
  description: string;
  referenceId?: string;
  createdAt: string;
}

export interface DeviceApprovalRequest {
  code: string;
  nodeName?: string;
  adapter?: 'codex' | 'claude' | 'mock';
  model?: string;
}

export interface DeviceApprovalInfo {
  code: string;
  nodeName: string;
  clientVersion?: string;
  adapter?: 'codex' | 'claude' | 'mock';
  model?: string;
  expiresAt: string;
}

export type ControlScope =
  | 'account:read'
  | 'pools:read'
  | 'pools:write'
  | 'wallet:read'
  | 'wallet:write'
  | 'runners:read'
  | 'runners:pair'
  | 'fleet:read'
  | 'fleet:write'
  | 'profile:write'
  | 'events:read'
  | 'credentials:read'
  | 'credentials:write';

export interface RunnerDevicePreview {
  kind: 'runner';
  label: string;
  client: 'agentpool-cli' | 'agentpool-official-fleet';
  operatorType: 'community' | 'official';
  expiresAt: string;
}

export interface ControlDevicePreview {
  kind: 'control';
  approvalContext: string;
  label: string;
  access: 'owner';
  scopes: ControlScope[];
  requestedTtlSeconds: number;
  expiresAt: string;
}

export type DevicePreview = RunnerDevicePreview | ControlDevicePreview;

export interface DeviceApprovalResult {
  approved: true;
  label: string;
  kind: 'runner' | 'control';
  operatorType?: 'community' | 'official';
  access?: 'owner';
  scopes?: ControlScope[];
  requestedTtlSeconds?: number;
}

export interface ControlCredential {
  id: string;
  label: string;
  scopes: ControlScope[];
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface PageResult<T> {
  items: T[];
  total?: number;
  nextCursor?: string;
}

export interface ApiErrorBody {
  error?:
    | string
    | {
        code?: string;
        message?: string;
        details?: unknown;
      };
  message?: string;
  details?: unknown;
}
