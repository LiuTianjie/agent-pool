import { z } from 'zod';

export const TASK_CATEGORIES = [
  'text',
  'data',
  'coding',
  'research',
  'math',
  'vision',
  'other',
] as const;

export const taskCategorySchema = z.enum(TASK_CATEGORIES);
export type TaskCategory = z.infer<typeof taskCategorySchema>;

export const TASK_STAGES = [
  'leased',
  'starting',
  'thinking',
  'working',
  'checking',
  'submitting',
  'completed',
  'failed',
] as const;

export const taskStageSchema = z.enum(TASK_STAGES);
export type TaskStage = z.infer<typeof taskStageSchema>;

export const AGENT_ADAPTERS = ['codex', 'claude', 'mock'] as const;
export const agentAdapterSchema = z.enum(AGENT_ADAPTERS);
export type AgentAdapter = z.infer<typeof agentAdapterSchema>;

export const requestedAgentSchema = agentAdapterSchema;
export type RequestedAgent = z.infer<typeof requestedAgentSchema>;

export const runnerOperatorTypeSchema = z.enum(['community', 'official']);
export type RunnerOperatorType = z.infer<typeof runnerOperatorTypeSchema>;

export const officialFleetModeSchema = z.enum(['standby', 'offline']);
export type OfficialFleetMode = z.infer<typeof officialFleetModeSchema>;

export const CONTROL_SCOPES = [
  'account:read',
  'pools:read',
  'pools:write',
  'wallet:read',
  'wallet:write',
  'runners:read',
  'runners:pair',
  'fleet:read',
  'fleet:write',
  'profile:write',
  'events:read',
  'credentials:read',
  'credentials:write',
] as const;

export const controlScopeSchema = z.enum(CONTROL_SCOPES);
export type ControlScope = z.infer<typeof controlScopeSchema>;

export const HIGH_RISK_CONTROL_SCOPES = [
  'pools:write',
  'wallet:write',
  'runners:pair',
  'fleet:write',
  'credentials:write',
] as const satisfies readonly ControlScope[];

export const CONTROL_SCOPE_METADATA = {
  'account:read': 'Read the control credential owner identity and account summary.',
  'pools:read': 'List pools and read pool details and results.',
  'pools:write': 'Create, launch, cancel, and review pool work.',
  'wallet:read': 'Read balances, ledger entries, and withdrawal history.',
  'wallet:write': 'Perform wallet mutations, including development funding routes.',
  'runners:read': 'Read runner nodes, progress, and earnings owned by the account.',
  'runners:pair': 'Approve a Community Runner pairing; Official pairing also needs fleet:write.',
  'fleet:read': 'Read the official fleet state.',
  'fleet:write': 'Change official fleet state or approve an Official Runner pairing.',
  'profile:write': 'Change the account display name.',
  'events:read': 'Read owner event history or subscribe to the event stream.',
  'credentials:read': 'List control credential metadata. Tokens are never returned.',
  'credentials:write': 'Revoke control credentials. It cannot issue a new control credential.',
} as const satisfies Record<ControlScope, string>;

export interface OfficialFleetStatus {
  ownerId: string;
  ownerEmail: string;
  mode: OfficialFleetMode;
  updatedAt: string;
}

export const runnerClaimRequestSchema = z.object({
  nodeId: z.string().uuid(),
  poolId: z.string().uuid(),
  maxUnits: z.number().int().min(1).max(20_000),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type RunnerClaimRequest = z.infer<typeof runnerClaimRequestSchema>;

export const runnerClaimStatusSchema = z.enum(['active', 'exhausted', 'expired', 'revoked']);
export type RunnerClaimStatus = z.infer<typeof runnerClaimStatusSchema>;

export interface RunnerClaimSummary {
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

export interface RunnerJobSummary {
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
  acceptanceMode:
    'non_empty' | 'schema' | 'hidden_exact' | 'schema_and_hidden_exact' | 'manual' | 'webhook';
  deliveryFormat: 'text' | 'json';
  deliveryMaxBytes: number;
  pilot: boolean;
  availableUnits: number;
  rewardPerUnit: number;
  claimableUntil: string;
}

const capsuleTextSchema = z.string().trim().min(1).max(20_000);

export const taskAcceptanceNormalizationSchema = z.object({
  trimStrings: z.boolean().default(false),
  collapseWhitespace: z.boolean().default(false),
  caseInsensitive: z.boolean().default(false),
  numericTolerance: z.number().finite().min(0).default(0),
});

export const taskCapsuleSchema = z
  .object({
    version: z.literal('ap-task/1'),
    goal: capsuleTextSchema,
    inputDescription: capsuleTextSchema,
    outputDescription: capsuleTextSchema,
    constraints: z.array(z.string().trim().min(1).max(2_000)).max(50),
    examples: z
      .array(
        z.object({
          input: z.unknown(),
          output: z.unknown(),
          note: z.string().trim().min(1).max(2_000).optional(),
        }),
      )
      .max(20),
    delivery: z.object({
      format: z.enum(['text', 'json']),
      schema: z.record(z.unknown()).optional(),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(8 * 1024 * 1024),
    }),
    acceptance: z.object({
      mode: z.enum([
        'non_empty',
        'schema',
        'hidden_exact',
        'schema_and_hidden_exact',
        'manual',
        'webhook',
      ]),
      criteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50),
      normalization: taskAcceptanceNormalizationSchema.optional(),
    }),
  })
  .superRefine((value, context) => {
    if (value.delivery.schema && value.delivery.format !== 'json') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delivery', 'format'],
        message: 'delivery.format must be json when delivery.schema is provided',
      });
    }
    if (
      ['schema', 'schema_and_hidden_exact'].includes(value.acceptance.mode) &&
      !value.delivery.schema
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delivery', 'schema'],
        message: 'delivery.schema is required by the selected acceptance mode',
      });
    }
    if (
      value.acceptance.normalization &&
      !['hidden_exact', 'schema_and_hidden_exact'].includes(value.acceptance.mode)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptance', 'normalization'],
        message: 'normalization is only supported for hidden exact acceptance',
      });
    }
  });

export type TaskCapsule = z.infer<typeof taskCapsuleSchema>;
export type TaskAcceptanceNormalization = z.infer<typeof taskAcceptanceNormalizationSchema>;

export const deliveryTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('platform') }),
  z.object({
    mode: z.literal('webhook'),
    url: z.string().url().max(2_048),
    receiptSecret: z.string().min(32).max(256),
  }),
]);

export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;

export const webhookReceiptSchema = z.object({
  protocol: z.literal('agentpool-receipt/1'),
  leaseId: z.string().uuid(),
  unitId: z.string().uuid(),
  contractHash: z.string().regex(/^[0-9a-f]{64}$/),
  resultSha256: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.enum(['accepted', 'rejected']),
  retryable: z.boolean(),
  receiptId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(4_000).optional(),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});

export type WebhookReceipt = z.infer<typeof webhookReceiptSchema>;

export const taskUnitDraftSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  input: z.unknown(),
  expectedOutput: z.unknown().optional(),
});

export const createPoolSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    category: taskCategorySchema,
    publicSummary: z.string().trim().min(8).max(300),
    secretInstruction: z.string().trim().min(8).max(20_000).optional(),
    requestedAgent: requestedAgentSchema,
    requestedModel: z.string().trim().min(1).max(120),
    requiredConcurrency: z.number().int().min(1).max(20_000),
    maxUnitSeconds: z.number().int().min(10).max(3_600),
    deadlineAt: z.string().datetime({ offset: true }),
    rewardPerUnit: z.number().int().min(1).max(1_000_000),
    validationMode: z.enum(['auto', 'manual']).default('auto'),
    outputSchema: z.record(z.unknown()).optional(),
    taskCapsule: taskCapsuleSchema.optional(),
    deliveryTarget: deliveryTargetSchema.default({ mode: 'platform' }),
    launchMode: z.enum(['pilot', 'immediate']).default('immediate'),
    pilotUnits: z.number().int().min(1).max(3).default(3),
    units: z.array(taskUnitDraftSchema).min(2).max(20_000),
  })
  .superRefine((value, context) => {
    if (!value.taskCapsule && !value.secretInstruction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['taskCapsule'],
        message: 'taskCapsule or legacy secretInstruction is required',
      });
    }
    if (
      value.taskCapsule?.acceptance.mode === 'webhook' &&
      value.deliveryTarget.mode !== 'webhook'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deliveryTarget'],
        message: 'webhook acceptance requires a webhook delivery target',
      });
    }
    if (
      value.deliveryTarget.mode === 'webhook' &&
      value.taskCapsule?.acceptance.mode !== 'webhook'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['taskCapsule', 'acceptance', 'mode'],
        message: 'webhook delivery requires webhook acceptance',
      });
    }
  });

export type CreatePoolInput = z.infer<typeof createPoolSchema>;

export const runnerProgressSchema = z.object({
  stage: taskStageSchema,
  progress: z.number().int().min(0).max(100),
});

export type RunnerProgressInput = z.infer<typeof runnerProgressSchema>;

export const capacityQuoteRequestSchema = z.object({
  adapter: agentAdapterSchema,
  model: z.string().trim().min(1).max(120),
  deliveryMode: z.enum(['platform', 'webhook']).default('platform'),
  unitCount: z.number().int().min(1).max(20_000),
  requiredConcurrency: z.number().int().min(1).max(20_000),
  maxUnitSeconds: z.number().int().min(10).max(3_600),
  deadlineAt: z.string().datetime(),
});

export type CapacityQuoteRequest = z.infer<typeof capacityQuoteRequestSchema>;

export const certificationStartSchema = z.object({
  adapter: agentAdapterSchema,
  model: z.string().trim().min(1).max(120),
  requestedConcurrency: z.number().int().min(1).max(64),
});

export type CertificationStartInput = z.infer<typeof certificationStartSchema>;

export interface WalletSummary {
  purchasedAvailable: number;
  purchasedLocked: number;
  earnedPending: number;
  earnedAvailable: number;
}

export interface PoolSummary {
  id: string;
  title: string;
  category: TaskCategory;
  requestedAgent: RequestedAgent;
  requestedModel: string;
  deliveryMode: 'platform' | 'webhook';
  requiredConcurrency: number;
  maxUnitSeconds: number;
  deadlineAt: string;
  publicSummary: string;
  status:
    | 'draft'
    | 'piloting'
    | 'waiting_capacity'
    | 'queued'
    | 'running'
    | 'paused'
    | 'completed'
    | 'cancelled';
  rewardPerUnit: number;
  totalUnits: number;
  queuedUnits: number;
  runningUnits: number;
  submittedUnits: number;
  acceptedUnits: number;
  failedUnits: number;
  heldUnits: number;
  pilotUnits: number;
  pilotAcceptedUnits: number;
  pilotFailedUnits: number;
  pilotSubmittedUnits: number;
  contractHash: string;
  terminalReason: 'deadline' | 'cancelled_by_publisher' | null;
  createdAt: string;
}

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
  delivery?:
    | { mode: 'platform' }
    | {
        mode: 'webhook';
        url: string;
        protocol: 'agentpool-webhook/1';
        unitReference: string;
        ordinal: number;
      };
  expiresAt: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON only supports finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  throw new Error('Value is not JSON-serializable');
}

export interface RunnerAdapterStatus {
  adapter: AgentAdapter;
  available: boolean;
  authenticated: boolean;
  supportedModels?: string[];
  version?: string;
  detail?: string;
}

export interface RunnerCertification {
  id: string;
  adapter: AgentAdapter;
  model: string;
  certifiedConcurrency: number;
  p50Ms: number;
  p95Ms: number;
  successRate: number;
  certifiedAt: string;
  expiresAt: string;
}

export interface CapacityQuote {
  adapter: AgentAdapter;
  model: string;
  deliveryMode: 'platform' | 'webhook';
  certifiedNodes: number;
  onlineNodes: number;
  certifiedConcurrency: number;
  onlineConcurrency: number;
  availableConcurrency: number;
  p50Ms: number | null;
  p95Ms: number | null;
  unitCount: number;
  requiredConcurrency: number;
  maxUnitSeconds: number;
  deadlineAt: string;
  estimatedSeconds: number | null;
  feasible: boolean;
  reasons: string[];
  assurance: 'self-hosted-benchmark-not-model-attestation';
}

export interface LiveEvent {
  id: string;
  type: 'pool.updated' | 'unit.updated' | 'wallet.updated' | 'runner.updated' | 'system.pulse';
  at: string;
  data: Record<string, unknown>;
}

export function formatCredits(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}
