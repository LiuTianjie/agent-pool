export type AgentAdapter = 'codex' | 'claude' | 'mock';
export type RequestedAgent = AgentAdapter;
export type TaskCategory = 'text' | 'data' | 'coding' | 'research' | 'math' | 'vision' | 'other';
export type TaskStage =
  | 'leased'
  | 'starting'
  | 'thinking'
  | 'working'
  | 'checking'
  | 'submitting'
  | 'completed'
  | 'failed';

export type DeliveryFormat = 'text' | 'json';
export type TaskAcceptanceMode =
  'non_empty' | 'schema' | 'hidden_exact' | 'schema_and_hidden_exact' | 'manual' | 'webhook';

export interface TaskAcceptanceNormalization {
  trimStrings: boolean;
  collapseWhitespace: boolean;
  caseInsensitive: boolean;
  numericTolerance: number;
}

export interface TaskCapsule {
  version: 'ap-task/1';
  goal: string;
  inputDescription: string;
  outputDescription: string;
  constraints: string[];
  examples: Array<{ input: unknown; output: unknown; note?: string }>;
  delivery: {
    format: DeliveryFormat;
    schema?: Record<string, unknown>;
    maxBytes: number;
  };
  acceptance: {
    mode: TaskAcceptanceMode;
    criteria: string[];
    normalization?: TaskAcceptanceNormalization;
  };
}

export type LeaseDelivery =
  | { mode: 'platform' }
  | {
      mode: 'webhook';
      url: string;
      protocol: 'agentpool-webhook/1';
      unitReference: string;
      ordinal: number;
    };

export interface LeasePayload {
  leaseId: string;
  unitId: string;
  poolId: string;
  category: TaskCategory;
  requestedAgent: RequestedAgent;
  requestedModel: string;
  reward: number;
  instruction: string;
  input: unknown;
  outputSchema?: Record<string, unknown>;
  taskCapsule?: TaskCapsule;
  contractHash?: string;
  attemptFeedback?: {
    attempt: number;
    reason: string;
    validation?: Record<string, unknown>;
  };
  delivery?: LeaseDelivery;
  expiresAt: string;
}

export interface LeasePoll {
  lease: LeasePayload | null;
  retryAfterMs?: number;
}

export type RunnerClaimStatus = 'active' | 'exhausted' | 'expired' | 'revoked';

export interface RunnerJob {
  id: string;
  title: string;
  status: 'piloting' | 'waiting_capacity' | 'queued' | 'running';
  category: TaskCategory;
  publicSummary: string;
  requestedAgent: RequestedAgent;
  requestedModel: string;
  deliveryMode: 'platform' | 'webhook';
  callbackHost?: string;
  maxUnitSeconds: number;
  maxAttempts: number;
  acceptanceMode: TaskAcceptanceMode;
  deliveryFormat: DeliveryFormat;
  deliveryMaxBytes: number;
  pilot: boolean;
  availableUnits: number;
  rewardPerUnit: number;
  claimableUntil: string;
}

export interface RunnerClaim {
  id: string;
  nodeId: string;
  poolId: string;
  poolTitle: string;
  requestedAgent: RequestedAgent;
  requestedModel: string;
  deliveryMode: 'platform' | 'webhook';
  maxUnits: number;
  claimedUnits: number;
  remainingUnits: number;
  expiresAt: string;
  status: RunnerClaimStatus;
  createdAt: string;
}

export interface RunnerAdapterStatus {
  adapter: AgentAdapter;
  available: boolean;
  authenticated: boolean;
  supportedModels?: string[];
  version?: string;
  detail?: string;
}

export interface RunnerProgressInput {
  stage: TaskStage;
  progress: number;
}

export interface CommandOptions {
  cwd?: string;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  maxOutputBytes?: number;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut: boolean;
}

export type CommandExecutor = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export interface AdapterRunOptions {
  lease: LeasePayload;
  taskDirectory: string;
  signal: AbortSignal;
  onProgress: (progress: RunnerProgressInput) => Promise<void> | void;
}

export interface AgentAdapterDriver {
  readonly name: AgentAdapter;
  readonly defaultModels: readonly string[];
  detect(): Promise<RunnerAdapterStatus>;
  run(options: AdapterRunOptions): Promise<unknown>;
}

export interface NodeRegistration {
  nodeId: string;
  heartbeatInterval?: number;
}

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval?: number;
}

export type DeviceCodePoll =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; token: string };

export interface RunnerRemoteStatus {
  user?: { displayName?: string };
  wallet?: {
    earnedAvailable?: number;
    earnedPending?: number;
  };
  activeNodes?: number;
  activeLeases?: number;
  nodes?: unknown[];
}

export interface RegisterNodeInput {
  adapter: AgentAdapter;
  models: string[];
  concurrency: number;
  adapterVersion?: string;
  clientVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  supportsDirectWebhooks: boolean;
}

export interface CreateRunnerClaimInput {
  nodeId: string;
  poolId: string;
  maxUnits: number;
  expiresAt?: string;
}

export interface DeliveryOutcome {
  status: string;
  validation?: unknown;
}

export interface WebhookReceipt {
  protocol: 'agentpool-receipt/1';
  leaseId: string;
  unitId: string;
  contractHash: string;
  resultSha256: string;
  decision: 'accepted' | 'rejected';
  retryable: boolean;
  receiptId: string;
  reason?: string;
  signature: string;
}

export interface LeaseFailure {
  code: 'agent_error' | 'invalid_output' | 'lease_expired' | 'model_mismatch' | 'shutdown';
  retryable: boolean;
}

export interface BenchmarkChallenge {
  benchmarkId: string;
  leases: LeasePayload[];
  expiresAt: string;
}

export interface BenchmarkUnitResult {
  leaseId: string;
  output?: unknown;
  durationMs: number;
  success: boolean;
}

export interface CapacityCertification {
  adapter: AgentAdapter;
  model: string;
  certified: boolean;
  certifiedConcurrency: number;
  p50Ms: number;
  p95Ms: number;
  successRate: number;
  expiresAt: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
