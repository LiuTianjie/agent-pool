import {
  CONTROL_SCOPES,
  CONTROL_SCOPE_METADATA,
  HIGH_RISK_CONTROL_SCOPES,
  TASK_CATEGORIES,
} from '@agent-pool/shared';

import type { App } from '../types.js';

const actions = [
  {
    id: 'control.device.start',
    method: 'POST',
    path: '/api/auth/control/device/start',
    access: 'public',
  },
  {
    id: 'control.device.preview',
    method: 'POST',
    path: '/api/auth/control/device/preview',
    access: 'human_session',
  },
  {
    id: 'control.device.approve',
    method: 'POST',
    path: '/api/auth/control/device/approve',
    access: 'human_session',
  },
  {
    id: 'control.device.deny',
    method: 'POST',
    path: '/api/auth/control/device/deny',
    access: 'human_session',
  },
  {
    id: 'control.device.token',
    method: 'POST',
    path: '/api/auth/control/device/token',
    access: 'public',
  },
  { id: 'control.me', method: 'GET', path: '/api/auth/control/me', access: 'control' },
  {
    id: 'control.revokeSelf',
    method: 'DELETE',
    path: '/api/auth/control/me',
    access: 'control',
  },
  {
    id: 'control.credentials.list',
    method: 'GET',
    path: '/api/auth/control/credentials',
    access: 'owner',
    requiredScopes: ['credentials:read'],
  },
  {
    id: 'control.credentials.revoke',
    method: 'DELETE',
    path: '/api/auth/control/credentials/{id}',
    access: 'owner',
    requiredScopes: ['credentials:write'],
  },
  {
    id: 'dashboard.get',
    method: 'GET',
    path: '/api/dashboard',
    access: 'owner',
    requiredScopes: ['account:read', 'pools:read', 'wallet:read', 'runners:read', 'events:read'],
  },
  {
    id: 'profile.update',
    method: 'PATCH',
    path: '/api/settings/profile',
    access: 'owner',
    requiredScopes: ['profile:write'],
    idempotencyKey: true,
  },
  {
    id: 'pools.validate',
    method: 'POST',
    path: '/api/pools/validate',
    access: 'owner',
    requiredScopes: ['pools:write'],
    requestSchema: '/api/meta/schemas/create-pool',
    sideEffects: false,
  },
  {
    id: 'pools.create',
    method: 'POST',
    path: '/api/pools',
    access: 'owner',
    requiredScopes: ['pools:write'],
    idempotencyKey: true,
    requestSchema: '/api/meta/schemas/create-pool',
  },
  {
    id: 'pools.list',
    method: 'GET',
    path: '/api/pools',
    access: 'owner',
    requiredScopes: ['pools:read'],
  },
  {
    id: 'pools.get',
    method: 'GET',
    path: '/api/pools/{id}',
    access: 'owner',
    requiredScopes: ['pools:read'],
  },
  {
    id: 'pools.results',
    method: 'GET',
    path: '/api/pools/{id}/results',
    access: 'owner',
    requiredScopes: ['pools:read'],
  },
  {
    id: 'pools.launch',
    method: 'POST',
    path: '/api/pools/{id}/launch',
    access: 'owner',
    requiredScopes: ['pools:write'],
    idempotencyKey: true,
  },
  {
    id: 'pools.cancel',
    method: 'POST',
    path: '/api/pools/{id}/cancel',
    access: 'owner',
    requiredScopes: ['pools:write'],
    idempotencyKey: true,
  },
  {
    id: 'units.review',
    method: 'POST',
    path: '/api/pools/{id}/units/{unitId}/review',
    access: 'owner',
    requiredScopes: ['pools:write'],
    idempotencyKey: true,
  },
  {
    id: 'wallet.get',
    method: 'GET',
    path: '/api/wallet',
    access: 'owner',
    requiredScopes: ['wallet:read'],
  },
  {
    id: 'wallet.ledger',
    method: 'GET',
    path: '/api/wallet/ledger',
    access: 'owner',
    requiredScopes: ['wallet:read'],
  },
  {
    id: 'wallet.withdrawals',
    method: 'GET',
    path: '/api/wallet/withdrawals',
    access: 'owner',
    requiredScopes: ['wallet:read'],
  },
  {
    id: 'wallet.devTopup',
    method: 'POST',
    path: '/api/wallet/dev-topup',
    access: 'owner',
    requiredScopes: ['wallet:write'],
    idempotencyKey: true,
  },
  {
    id: 'wallet.devWithdraw',
    method: 'POST',
    path: '/api/wallet/dev-withdraw',
    access: 'owner',
    requiredScopes: ['wallet:write'],
    idempotencyKey: true,
  },
  {
    id: 'runners.list',
    method: 'GET',
    path: '/api/runners',
    access: 'owner',
    requiredScopes: ['runners:read'],
  },
  {
    id: 'runners.pair.preview',
    method: 'POST',
    path: '/api/auth/device/preview',
    access: 'owner',
    requiredScopes: ['runners:pair'],
  },
  {
    id: 'runners.pair.approve',
    method: 'POST',
    path: '/api/auth/device/approve',
    access: 'owner',
    requiredScopes: ['runners:pair'],
    note: 'Official pairing also requires fleet:write.',
  },
  {
    id: 'fleet.get',
    method: 'GET',
    path: '/api/official-fleet',
    access: 'owner',
    requiredScopes: ['fleet:read'],
    note: 'wallet is included only with wallet:read; ownerEmail only with account:read.',
  },
  {
    id: 'fleet.update',
    method: 'PATCH',
    path: '/api/official-fleet',
    access: 'owner',
    requiredScopes: ['fleet:write'],
    idempotencyKey: true,
    note: 'wallet is included only with wallet:read; ownerEmail only with account:read.',
  },
  {
    id: 'events.history',
    method: 'GET',
    path: '/api/events/history',
    access: 'owner',
    requiredScopes: ['events:read'],
    responseMode: 'json',
  },
  {
    id: 'events.stream',
    method: 'GET',
    path: '/api/events',
    access: 'owner',
    requiredScopes: ['events:read'],
    responseMode: 'sse',
  },
  {
    id: 'runner.claims.create',
    method: 'POST',
    path: '/api/runner/claims',
    access: 'runner',
    idempotencyKey: true,
  },
  { id: 'capacity.catalog', method: 'GET', path: '/api/capacity/catalog', access: 'public' },
  { id: 'capacity.quote', method: 'POST', path: '/api/capacity/quote', access: 'public' },
  { id: 'public.pools', method: 'GET', path: '/api/public/pools', access: 'public' },
  { id: 'public.pool.get', method: 'GET', path: '/api/public/pools/{id}', access: 'public' },
  { id: 'network.pulse', method: 'GET', path: '/api/network/pulse', access: 'public' },
] as const;

const emptyObjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: [],
} as const;

const actionContracts: Record<
  string,
  { query?: Record<string, unknown>; requestSchema?: Record<string, unknown> | null }
> = {
  'control.device.start': {
    requestSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scopes'],
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 100 },
        scopes: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { enum: CONTROL_SCOPES },
        },
        ttlSeconds: { type: 'integer', minimum: 3_600, maximum: 7_776_000, default: 2_592_000 },
      },
    },
  },
  'control.device.preview': { requestSchema: requiredStringBody('userCode', 8, 9) },
  'control.device.approve': { requestSchema: controlDeviceDecisionSchema() },
  'control.device.deny': { requestSchema: controlDeviceDecisionSchema() },
  'control.device.token': { requestSchema: requiredStringBody('deviceCode', 40, 200) },
  'profile.update': { requestSchema: requiredStringBody('displayName', 1, 80) },
  'pools.list': {
    query: queryObject({
      status: {
        enum: [
          'piloting',
          'waiting_capacity',
          'queued',
          'running',
          'paused',
          'completed',
          'cancelled',
        ],
      },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      offset: { type: 'integer', minimum: 0, maximum: 10_000, default: 0 },
    }),
  },
  'pools.results': {
    query: queryObject({
      status: { enum: ['submitted', 'accepted', 'failed'] },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      offset: { type: 'integer', minimum: 0, maximum: 20_000, default: 0 },
    }),
  },
  'pools.launch': { requestSchema: emptyObjectSchema },
  'pools.cancel': { requestSchema: emptyObjectSchema },
  'units.review': {
    requestSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['decision'],
      properties: {
        decision: { enum: ['accept', 'reject'] },
        retry: { type: 'boolean', default: false },
        reason: { type: 'string', maxLength: 500 },
      },
    },
  },
  'wallet.ledger': {
    query: queryObject({
      before: { type: 'string', format: 'uuid' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    }),
  },
  'wallet.devTopup': { requestSchema: positiveCreditsSchema() },
  'wallet.devWithdraw': { requestSchema: positiveCreditsSchema() },
  'runners.pair.preview': { requestSchema: requiredStringBody('userCode', 8, 9) },
  'runners.pair.approve': {
    requestSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['userCode', 'expectedClient', 'expectedOperatorType'],
      properties: {
        userCode: { type: 'string', minLength: 8, maxLength: 9 },
        expectedClient: { enum: ['agentpool-cli', 'agentpool-official-fleet'] },
        expectedOperatorType: { enum: ['community', 'official'] },
      },
    },
  },
  'fleet.update': {
    requestSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: { mode: { enum: ['standby', 'offline'] } },
    },
  },
  'events.history': {
    query: queryObject({
      after: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      waitSeconds: { type: 'integer', minimum: 0, maximum: 25, default: 0 },
    }),
  },
  'events.stream': {
    query: queryObject({ after: { type: 'integer', minimum: 0 } }),
  },
  'runner.claims.create': {
    requestSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['nodeId', 'poolId', 'maxUnits'],
      properties: {
        nodeId: { type: 'string', format: 'uuid' },
        poolId: { type: 'string', format: 'uuid' },
        maxUnits: { type: 'integer', minimum: 1, maximum: 20_000 },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  },
  'capacity.quote': {
    requestSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'adapter',
        'model',
        'unitCount',
        'requiredConcurrency',
        'maxUnitSeconds',
        'deadlineAt',
      ],
      properties: {
        adapter: { enum: ['codex', 'claude', 'mock'] },
        model: { type: 'string', minLength: 1, maxLength: 120 },
        deliveryMode: { enum: ['platform', 'webhook'], default: 'platform' },
        unitCount: { type: 'integer', minimum: 1, maximum: 1_000_000 },
        requiredConcurrency: { type: 'integer', minimum: 1, maximum: 10_000 },
        maxUnitSeconds: { type: 'integer', minimum: 10, maximum: 3_600 },
        deadlineAt: { type: 'string', format: 'date-time' },
      },
    },
  },
  'public.pools': {
    query: queryObject({
      category: { enum: TASK_CATEGORIES },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      offset: { type: 'integer', minimum: 0, maximum: 10_000, default: 0 },
    }),
  },
};

function decorateAction(action: (typeof actions)[number]) {
  const contract = actionContracts[action.id] ?? {};
  const pathNames = [...action.path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(
    (match) => match[1]!,
  );
  const hasIdempotency = 'idempotencyKey' in action && action.idempotencyKey;
  return {
    ...action,
    parameters: {
      path: {
        type: 'object',
        additionalProperties: false,
        required: pathNames,
        properties: Object.fromEntries(
          pathNames.map((name) => [name, { type: 'string', format: 'uuid' }]),
        ),
      },
      query: contract.query ?? emptyObjectSchema,
      headers: hasIdempotency
        ? {
            type: 'object',
            additionalProperties: true,
            required: [],
            properties: {
              'Idempotency-Key': {
                type: 'string',
                minLength: 8,
                maxLength: 128,
                pattern: '^[\\x21-\\x7E]+$',
              },
            },
          }
        : emptyObjectSchema,
    },
    requestSchema:
      'requestSchema' in action ? action.requestSchema : (contract.requestSchema ?? null),
  };
}

function queryObject(properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, required: [], properties };
}

function requiredStringBody(name: string, minLength: number, maxLength: number) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [name],
    properties: { [name]: { type: 'string', minLength, maxLength } },
  };
}

function controlDeviceDecisionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['userCode', 'approvalContext'],
    properties: {
      userCode: { type: 'string', minLength: 8, maxLength: 9 },
      approvalContext: { type: 'string', minLength: 40, maxLength: 2_000 },
    },
  };
}

function positiveCreditsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['credits'],
    properties: { credits: { type: 'integer', minimum: 1, maximum: 10_000_000 } },
  };
}

export async function registerMetaRoutes(app: App): Promise<void> {
  app.get('/api/meta/capabilities', async (_request, reply) =>
    reply.header('Cache-Control', 'public, max-age=300').send({
      protocolVersion: 'agentpool-control/1',
      auth: {
        control: {
          tokenPrefix: 'ap_control_',
          access: 'owner',
          device: {
            start: '/api/auth/control/device/start',
            preview: '/api/auth/control/device/preview',
            approve: '/api/auth/control/device/approve',
            deny: '/api/auth/control/device/deny',
            token: '/api/auth/control/device/token',
            approval: 'human_session_only',
          },
          scopes: CONTROL_SCOPES.map((name) => ({
            name,
            description: CONTROL_SCOPE_METADATA[name],
            risk: HIGH_RISK_CONTROL_SCOPES.includes(
              name as (typeof HIGH_RISK_CONTROL_SCOPES)[number],
            )
              ? 'high'
              : 'standard',
          })),
        },
        runner: {
          tokenPrefix: 'ap_runner_',
          access: 'execution',
          claimMode: 'manual_only',
        },
        userSession: { access: 'owner', intendedFor: 'human_browser' },
      },
      idempotency: {
        header: 'Idempotency-Key',
        retentionSeconds: 86_400,
        replayHeader: 'Idempotency-Replayed',
      },
      actions: actions.map(decorateAction),
      schemas: {
        createPool: '/api/meta/schemas/create-pool',
        validation: 'structural-only',
        authoritativeEndpoint: '/api/pools/validate',
      },
    }),
  );

  app.get('/api/meta/schemas/create-pool', async (_request, reply) =>
    reply.header('Cache-Control', 'public, max-age=300').send(createPoolJsonSchema),
  );
}

const createPoolJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agentpool.itool.tech/api/meta/schemas/create-pool',
  'x-agentpool-validation': 'structural-only',
  'x-agentpool-authoritative-endpoint': '/api/pools/validate',
  title: 'Create Agent Pool task batch',
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'category',
    'publicSummary',
    'requestedAgent',
    'requestedModel',
    'requiredConcurrency',
    'maxUnitSeconds',
    'deadlineAt',
    'rewardPerUnit',
  ],
  properties: {
    title: { type: 'string', minLength: 3, maxLength: 120 },
    category: { enum: TASK_CATEGORIES },
    publicSummary: { type: 'string', minLength: 8, maxLength: 300 },
    secretInstruction: { type: 'string', minLength: 8, maxLength: 20_000 },
    requestedAgent: { enum: ['codex', 'claude', 'mock'] },
    requestedModel: { type: 'string', minLength: 1, maxLength: 120 },
    requiredConcurrency: { type: 'integer', minimum: 1, maximum: 10_000 },
    maxUnitSeconds: { type: 'integer', minimum: 10, maximum: 3_600 },
    deadlineAt: { type: 'string', format: 'date-time' },
    rewardPerUnit: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    validationMode: { enum: ['auto', 'manual'], default: 'auto' },
    outputSchema: { type: 'object' },
    maxAttempts: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
    taskCapsule: { $ref: '#/$defs/taskCapsule' },
    deliveryTarget: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['mode'],
          properties: { mode: { const: 'platform' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['mode', 'url', 'receiptSecret'],
          properties: {
            mode: { const: 'webhook' },
            url: { type: 'string', format: 'uri', maxLength: 2_048 },
            receiptSecret: { type: 'string', minLength: 32, maxLength: 256 },
          },
        },
      ],
      default: { mode: 'platform' },
    },
    launchMode: { enum: ['pilot', 'immediate'], default: 'immediate' },
    pilotUnits: { type: 'integer', minimum: 1, maximum: 3, default: 3 },
    dataset: {
      default: { mode: 'inline' },
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['mode'],
          properties: { mode: { const: 'inline' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['mode', 'url'],
          properties: {
            mode: { const: 'https' },
            url: { type: 'string', format: 'uri', maxLength: 2_048 },
          },
        },
      ],
    },
    units: {
      type: 'array',
      minItems: 2,
      maxItems: 20_000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['input'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 120 },
          input: true,
          expectedOutput: true,
        },
      },
    },
  },
  anyOf: [{ required: ['taskCapsule'] }, { required: ['secretInstruction'] }],
  $defs: {
    taskCapsule: {
      type: 'object',
      additionalProperties: false,
      required: [
        'version',
        'goal',
        'inputDescription',
        'outputDescription',
        'constraints',
        'examples',
        'delivery',
        'acceptance',
      ],
      properties: {
        version: { const: 'ap-task/1' },
        goal: { type: 'string', minLength: 1, maxLength: 20_000 },
        inputDescription: { type: 'string', minLength: 1, maxLength: 20_000 },
        outputDescription: { type: 'string', minLength: 1, maxLength: 20_000 },
        constraints: {
          type: 'array',
          maxItems: 50,
          items: { type: 'string', minLength: 1, maxLength: 2_000 },
        },
        examples: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            required: ['input', 'output'],
            properties: {
              input: true,
              output: true,
              note: { type: 'string', minLength: 1, maxLength: 2_000 },
            },
          },
        },
        delivery: {
          type: 'object',
          additionalProperties: false,
          required: ['format', 'maxBytes'],
          properties: {
            format: { enum: ['text', 'json'] },
            schema: { type: 'object' },
            maxBytes: { type: 'integer', minimum: 1, maximum: 8_388_608 },
          },
        },
        acceptance: {
          type: 'object',
          additionalProperties: false,
          required: ['mode', 'criteria'],
          properties: {
            mode: {
              enum: [
                'non_empty',
                'schema',
                'hidden_exact',
                'schema_and_hidden_exact',
                'manual',
                'webhook',
              ],
            },
            criteria: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: { type: 'string', minLength: 1, maxLength: 2_000 },
            },
            normalization: {
              type: 'object',
              additionalProperties: false,
              properties: {
                trimStrings: { type: 'boolean', default: false },
                collapseWhitespace: { type: 'boolean', default: false },
                caseInsensitive: { type: 'boolean', default: false },
                numericTolerance: { type: 'number', minimum: 0, default: 0 },
              },
            },
          },
        },
      },
    },
  },
} as const;
