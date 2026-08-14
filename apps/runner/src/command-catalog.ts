import { CONTROL_SCOPES, HIGH_RISK_CONTROL_SCOPES } from '@agent-pool/shared';

export interface CliOptionDescriptor {
  name: string;
  type: 'string' | 'integer' | 'boolean' | 'uuid' | 'path-or-stdin' | 'enum';
  required: boolean;
  enum?: readonly string[];
  default?: unknown;
  description: string;
  sensitive?: boolean;
  repeatable?: boolean;
  expansions?: Readonly<Record<string, readonly string[]>>;
}

export interface CliActionDescriptor {
  action: string;
  command: string;
  requiredScopes: readonly string[];
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'LOCAL' | 'MULTI';
  path: string | null;
  inputSource: 'none' | 'flags' | 'json-file-or-stdin';
  options: readonly CliOptionDescriptor[];
  idempotent: boolean;
  outputMode: 'json' | 'jsonl';
  claimMode?: 'manual_bounded_only';
}

const READONLY_CONTROL_SCOPES = [
  'account:read',
  'pools:read',
  'wallet:read',
  'runners:read',
  'fleet:read',
  'events:read',
  'credentials:read',
] as const;

export const CONTROL_SCOPE_PRESETS = {
  readonly: [...READONLY_CONTROL_SCOPES],
  publisher: [...READONLY_CONTROL_SCOPES, 'pools:write'],
  operator: [
    ...READONLY_CONTROL_SCOPES,
    'pools:write',
    'profile:write',
    'fleet:write',
    'runners:pair',
  ],
} as const;

const option = (
  name: string,
  type: CliOptionDescriptor['type'],
  required: boolean,
  description: string,
  extra: Partial<CliOptionDescriptor> = {},
): CliOptionDescriptor => ({ name, type, required, description, ...extra });

const input = option('input', 'path-or-stdin', true, 'JSON file path, or - for stdin.');
const task = option('task', 'uuid', true, 'Task batch id.');
const result = option('result', 'uuid', true, 'Delivered result id.');
const idempotency = option(
  'idempotency-key',
  'string',
  false,
  'Caller-stable key; otherwise a crash-safe pending key is generated.',
);

function descriptor(
  action: string,
  command: string,
  method: CliActionDescriptor['method'],
  path: string | null,
  requiredScopes: readonly string[] = [],
  options: readonly CliOptionDescriptor[] = [],
  settings: Partial<
    Pick<CliActionDescriptor, 'inputSource' | 'idempotent' | 'outputMode' | 'claimMode'>
  > = {},
): CliActionDescriptor {
  return {
    action,
    command,
    requiredScopes,
    method,
    path,
    inputSource: settings.inputSource ?? 'none',
    options,
    idempotent: settings.idempotent ?? false,
    outputMode: settings.outputMode ?? 'json',
    ...(settings.claimMode ? { claimMode: settings.claimMode } : {}),
  };
}

export const CONTROL_CLI_ACTIONS: readonly CliActionDescriptor[] = [
  descriptor('help', 'agentpool control help', 'LOCAL', null),
  descriptor(
    'login',
    'agentpool control login',
    'MULTI',
    '/api/auth/control/device/*',
    [],
    [
      option('preset', 'enum', false, 'Scope preset; explicit --scope values are merged.', {
        enum: ['readonly', 'publisher', 'operator'],
        default: 'readonly',
        expansions: CONTROL_SCOPE_PRESETS,
      }),
      option('scope', 'enum', false, 'Additional scope.', {
        enum: CONTROL_SCOPES,
        repeatable: true,
      }),
      option('label', 'string', false, 'Credential label.'),
      option('ttl-seconds', 'integer', false, 'Credential lifetime, 3600-7776000.'),
      option('no-browser', 'boolean', false, 'Do not open the approval URL.'),
    ],
    { outputMode: 'jsonl' },
  ),
  descriptor('status', 'agentpool control status', 'GET', '/api/auth/control/me'),
  descriptor('logout', 'agentpool control logout', 'DELETE', '/api/auth/control/me'),
  descriptor('describe', 'agentpool control describe', 'GET', '/api/meta/capabilities'),
  descriptor(
    'describe.schema',
    'agentpool control describe --schema task',
    'GET',
    '/api/meta/schemas/create-pool',
    [],
    [option('schema', 'enum', true, 'Schema name.', { enum: ['task'] })],
  ),
  descriptor('dashboard', 'agentpool control dashboard', 'GET', '/api/dashboard', [
    'account:read',
    'pools:read',
    'wallet:read',
    'runners:read',
    'events:read',
  ]),
  descriptor('network', 'agentpool control network', 'GET', '/api/network/pulse'),
  descriptor(
    'tasks.list',
    'agentpool control tasks list',
    'GET',
    '/api/pools',
    ['pools:read'],
    [
      option('status', 'string', false, 'Filter by task status.'),
      option('limit', 'integer', false, 'Page size.', { default: 30 }),
      option('offset', 'integer', false, 'Page offset.', { default: 0 }),
    ],
  ),
  descriptor(
    'tasks.get',
    'agentpool control tasks get --task ID',
    'GET',
    '/api/pools/{id}',
    ['pools:read'],
    [task],
  ),
  descriptor(
    'tasks.validate',
    'agentpool control tasks validate --input FILE|-',
    'POST',
    '/api/pools/validate',
    ['pools:write'],
    [input],
    { inputSource: 'json-file-or-stdin' },
  ),
  descriptor(
    'tasks.publish',
    'agentpool control tasks publish --input FILE|-',
    'POST',
    '/api/pools',
    ['pools:write'],
    [input, idempotency],
    { inputSource: 'json-file-or-stdin', idempotent: true },
  ),
  ...(['launch', 'cancel'] as const).map((verb) =>
    descriptor(
      `tasks.${verb}`,
      `agentpool control tasks ${verb} --task ID`,
      'POST',
      `/api/pools/{id}/${verb}`,
      ['pools:write'],
      [task, idempotency],
      { inputSource: 'flags', idempotent: true },
    ),
  ),
  descriptor(
    'tasks.results',
    'agentpool control tasks results --task ID',
    'GET',
    '/api/pools/{id}/results',
    ['pools:read'],
    [
      task,
      option('status', 'string', false, 'Filter result status.'),
      option('limit', 'integer', false, 'Page size.', { default: 100 }),
      option('offset', 'integer', false, 'Page offset.', { default: 0 }),
    ],
  ),
  descriptor(
    'tasks.review',
    'agentpool control tasks review --task ID --result ID --decision accept|reject',
    'POST',
    '/api/pools/{id}/units/{unitId}/review',
    ['pools:write'],
    [
      task,
      result,
      option('decision', 'enum', false, 'Review decision when --input is omitted.', {
        enum: ['accept', 'reject'],
      }),
      option('retry', 'boolean', false, 'Queue a rejected result for retry.'),
      option('reason', 'string', false, 'Review reason.'),
      option('input', 'path-or-stdin', false, 'Alternative JSON review body.'),
      idempotency,
    ],
    { inputSource: 'flags', idempotent: true },
  ),
  descriptor('wallet.show', 'agentpool control wallet show', 'GET', '/api/wallet', ['wallet:read']),
  descriptor(
    'wallet.ledger',
    'agentpool control wallet ledger',
    'GET',
    '/api/wallet/ledger',
    ['wallet:read'],
    [
      option('before', 'uuid', false, 'Cursor from the previous page.'),
      option('limit', 'integer', false, 'Page size.', { default: 50 }),
    ],
  ),
  descriptor(
    'wallet.withdrawals',
    'agentpool control wallet withdrawals',
    'GET',
    '/api/wallet/withdrawals',
    ['wallet:read'],
  ),
  ...(['topup', 'withdraw'] as const).map((verb) =>
    descriptor(
      `wallet.${verb}`,
      `agentpool control wallet ${verb} --credits N`,
      'POST',
      verb === 'topup' ? '/api/wallet/dev-topup' : '/api/wallet/dev-withdraw',
      ['wallet:write'],
      [option('credits', 'integer', true, 'Credit amount.'), idempotency],
      { inputSource: 'flags', idempotent: true },
    ),
  ),
  descriptor('runners.list', 'agentpool control runners list', 'GET', '/api/runners', [
    'runners:read',
  ]),
  descriptor('fleet.get', 'agentpool control fleet get', 'GET', '/api/official-fleet', [
    'fleet:read',
  ]),
  descriptor(
    'fleet.update',
    'agentpool control fleet update --mode standby|offline',
    'PATCH',
    '/api/official-fleet',
    ['fleet:write'],
    [
      option('mode', 'enum', false, 'Fleet mode when --input is omitted.', {
        enum: ['standby', 'offline'],
      }),
      option('input', 'path-or-stdin', false, 'Alternative JSON body.'),
      idempotency,
    ],
    { inputSource: 'flags', idempotent: true },
  ),
  descriptor('profile.get', 'agentpool control profile get', 'GET', '/api/auth/control/me'),
  descriptor(
    'profile.update',
    'agentpool control profile update --display-name NAME',
    'PATCH',
    '/api/settings/profile',
    ['profile:write'],
    [
      option('display-name', 'string', false, 'New display name when --input is omitted.'),
      option('input', 'path-or-stdin', false, 'Alternative JSON body.'),
      idempotency,
    ],
    { inputSource: 'flags', idempotent: true },
  ),
  descriptor(
    'capacity.catalog',
    'agentpool control capacity catalog',
    'GET',
    '/api/capacity/catalog',
  ),
  descriptor(
    'capacity.quote',
    'agentpool control capacity quote --input FILE|-',
    'POST',
    '/api/capacity/quote',
    [],
    [input],
    { inputSource: 'json-file-or-stdin' },
  ),
  descriptor(
    'devices.list',
    'agentpool control devices list',
    'GET',
    '/api/auth/control/credentials',
    ['credentials:read'],
  ),
  descriptor(
    'devices.revoke',
    'agentpool control devices revoke --credential ID',
    'DELETE',
    '/api/auth/control/credentials/{id}',
    ['credentials:write'],
    [option('credential', 'uuid', true, 'Control credential id.')],
    { inputSource: 'flags' },
  ),
  descriptor(
    'devices.preview',
    'agentpool control devices preview --code CODE',
    'POST',
    '/api/auth/device/preview',
    ['runners:pair'],
    [option('code', 'string', true, 'Runner pairing code.', { sensitive: true })],
    { inputSource: 'flags' },
  ),
  descriptor(
    'devices.approve',
    'agentpool control devices approve --input FILE|-',
    'POST',
    '/api/auth/device/approve',
    ['runners:pair'],
    [
      option('code', 'string', false, 'Runner pairing code.', { sensitive: true }),
      option('expected-client', 'string', false, 'Client from preview.'),
      option('expected-operator-type', 'enum', false, 'Operator type from preview.', {
        enum: ['community', 'official'],
      }),
      option(
        'input',
        'path-or-stdin',
        false,
        'Alternative JSON approval body. Official pairing additionally requires fleet:write.',
      ),
    ],
    { inputSource: 'flags' },
  ),
  descriptor(
    'events',
    'agentpool control events [--follow]',
    'GET',
    '/api/events/history',
    ['events:read'],
    [
      option('after', 'integer', false, 'Event cursor.', { default: 0 }),
      option('limit', 'integer', false, 'Page size.', { default: 100 }),
      option('wait-seconds', 'integer', false, 'Long-poll wait, 0-25.'),
      option(
        'follow',
        'boolean',
        false,
        'Repeat long polls and emit JSONL; without it, emit one JSON response.',
      ),
      option('max-events', 'integer', false, 'Stop follow mode after N events.'),
    ],
    { outputMode: 'jsonl' },
  ),
];

export const RUNNER_CLI_ACTIONS: readonly CliActionDescriptor[] = [
  descriptor(
    'help',
    'agentpool help --json',
    'LOCAL',
    null,
    [],
    [option('json', 'boolean', true, 'Enable agentpool-runner/1 output.')],
  ),
  descriptor(
    'agents.list',
    'agentpool agents --json',
    'LOCAL',
    null,
    [],
    [option('json', 'boolean', true, 'Enable agentpool-runner/1 output.')],
    { claimMode: 'manual_bounded_only' },
  ),
  descriptor(
    'tasks.list',
    'agentpool jobs --json --agent A --model M',
    'GET',
    '/api/runner/jobs',
    [],
    [
      option('agent', 'enum', true, 'Exact local Agent.', {
        enum: ['codex', 'claude', 'mock'],
      }),
      option('model', 'string', true, 'Exact model id.'),
      option('concurrency', 'integer', false, 'Requested concurrency.', { default: 1 }),
      option('allow-webhooks', 'boolean', false, 'Include direct callback tasks.'),
      option('json', 'boolean', true, 'Enable agentpool-runner/1 output.'),
    ],
    { claimMode: 'manual_bounded_only' },
  ),
  ...(['claim', 'once'] as const).map((verb) =>
    descriptor(
      'claims.run',
      `agentpool ${verb} --json --pool ID${verb === 'claim' ? ' --units N' : ''} --agent A --model M`,
      'MULTI',
      '/api/runner/claims',
      [],
      [
        option('pool', 'uuid', true, 'Explicit task id.'),
        option('units', 'integer', verb === 'claim', 'Bounded work count.', {
          default: verb === 'once' ? 1 : undefined,
        }),
        option('agent', 'enum', true, 'Exact local Agent.', { enum: ['codex', 'claude', 'mock'] }),
        option('model', 'string', true, 'Exact model id.'),
        idempotency,
        option('json', 'boolean', true, 'Enable agentpool-runner/1 output.'),
      ],
      { inputSource: 'flags', idempotent: true, claimMode: 'manual_bounded_only' },
    ),
  ),
  descriptor(
    'claims.cancel',
    'agentpool cancel --json --claim ID',
    'DELETE',
    '/api/runner/claims/{id}',
    [],
    [
      option('claim', 'uuid', true, 'Bounded Claim id.'),
      option('json', 'boolean', true, 'Enable agentpool-runner/1 output.'),
    ],
    { claimMode: 'manual_bounded_only' },
  ),
  descriptor(
    'runner.status',
    'agentpool status --json',
    'MULTI',
    '/api/runner/*',
    [],
    [option('json', 'boolean', true, 'Enable agentpool-runner/1 output.')],
    { claimMode: 'manual_bounded_only' },
  ),
];

export const HIGH_RISK_SCOPE_NAMES = HIGH_RISK_CONTROL_SCOPES;
