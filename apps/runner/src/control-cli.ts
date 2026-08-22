import { lstat, readFile } from 'node:fs/promises';

import { CONTROL_SCOPES as ALL_CONTROL_SCOPES, HIGH_RISK_CONTROL_SCOPES } from '@agent-pool/shared';

import {
  CONTROL_API_ROUTES,
  CONTROL_PROTOCOL,
  ControlApiClient,
  ControlApiError,
  normalizeControlServer,
  type ControlApiResponse,
  type ControlRequest,
} from './control-api-client.js';
import {
  CONTROL_CLI_ACTIONS,
  CONTROL_SCOPE_PRESETS,
  RUNNER_CLI_ACTIONS,
} from './command-catalog.js';
import {
  AmbiguousOperationExpiredError,
  ControlIdempotencyStore,
  type IdempotencyOperation,
} from './control-idempotency-store.js';
import { ControlLoginStore } from './control-login-store.js';
import { ControlTokenStore } from './control-token-store.js';

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const CONTROL_SCOPES = new Set<string>(ALL_CONTROL_SCOPES);

export interface ControlOutput {
  log(message: string): void;
  error(message: string): void;
}

interface ControlApi {
  readonly server: string;
  request<T = unknown>(input: ControlRequest): Promise<ControlApiResponse<T>>;
}

interface IdempotencyStore {
  begin(
    action: string,
    request: { method: string; route: string; body?: unknown },
    explicitKey?: string,
  ): Promise<IdempotencyOperation>;
  complete(operation: IdempotencyOperation): Promise<void>;
}

export interface ControlCliDependencies {
  server: string;
  output?: ControlOutput;
  environment?: NodeJS.ProcessEnv;
  tokenStore?: ControlTokenStore;
  idempotencyStore?: IdempotencyStore;
  loginStore?: ControlLoginStore;
  apiFactory?: (server: string, token?: string) => ControlApi;
  browserOpener?: (url: string) => boolean;
  inputReader?: (source: string) => Promise<unknown>;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface CommandResult {
  action: string;
  data: unknown;
  requestId?: string;
  idempotencyKey?: string;
  idempotencyReplayed?: boolean;
  operation?: IdempotencyOperation;
}

interface ParsedOptions {
  values: Map<string, string[]>;
  booleans: Set<string>;
}

export async function runControlCli(
  argv: readonly string[],
  dependencies: ControlCliDependencies,
): Promise<number> {
  const output = dependencies.output ?? console;
  const environment = dependencies.environment ?? process.env;
  const tokenStore =
    dependencies.tokenStore ??
    new ControlTokenStore({
      stateDirectory: environment.AGENTPOOL_CONTROL_STATE_DIR || undefined,
    });
  const idempotencyStore = dependencies.idempotencyStore ?? new ControlIdempotencyStore(tokenStore);
  const loginStore = dependencies.loginStore ?? new ControlLoginStore(tokenStore);
  const apiFactory =
    dependencies.apiFactory ??
    ((server: string, token?: string) => new ControlApiClient(server, token));
  const inputReader = dependencies.inputReader ?? readJsonInput;
  const delay = dependencies.delay ?? abortableDelay;
  const browserOpener = dependencies.browserOpener ?? (() => false);
  const [bootstrapCommand, ...bootstrapArgs] = argv;
  let action = bootstrapCommand ? requestedAction(bootstrapCommand, bootstrapArgs) : 'help';

  try {
    // Normalize before even a signed-out/local-only command can echo server
    // metadata. URLs containing userinfo are rejected with a non-reflective
    // error before they reach protocol output.
    const server = normalizeControlServer(dependencies.server);
    const [command, ...args] = argv;
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      emitSuccess(output, {
        action: 'help',
        data: localDescription(),
      });
      return 0;
    }

    action = requestedAction(command, args);
    let result: CommandResult;
    switch (command) {
      case 'login':
        result = await login({
          args,
          server,
          output,
          tokenStore,
          loginStore,
          apiFactory,
          browserOpener,
          delay,
        });
        break;
      case 'status':
        result = await status(args, server, tokenStore, apiFactory);
        break;
      case 'logout':
        result = await logout(args, server, tokenStore, apiFactory);
        break;
      case 'describe':
        result = await describe(args, server, apiFactory);
        break;
      case 'dashboard':
        result = await authenticatedRequest('dashboard', args, server, tokenStore, apiFactory, {
          route: CONTROL_API_ROUTES.dashboard,
        });
        break;
      case 'network':
        result = await publicRequest('network', args, server, apiFactory, {
          route: CONTROL_API_ROUTES.network,
        });
        break;
      case 'tasks':
        result = await taskCommand({
          args,
          server,
          tokenStore,
          idempotencyStore,
          apiFactory,
          inputReader,
        });
        break;
      case 'wallet':
        result = await walletCommand({
          args,
          server,
          tokenStore,
          idempotencyStore,
          apiFactory,
        });
        break;
      case 'runners':
        result = await runnersCommand(args, server, tokenStore, apiFactory);
        break;
      case 'fleet':
        result = await fleetCommand({
          args,
          server,
          tokenStore,
          idempotencyStore,
          apiFactory,
          inputReader,
        });
        break;
      case 'profile':
        result = await profileCommand({
          args,
          server,
          tokenStore,
          idempotencyStore,
          apiFactory,
          inputReader,
        });
        break;
      case 'capacity':
        result = await capacityCommand(args, server, apiFactory, inputReader);
        break;
      case 'devices':
        result = await devicesCommand({
          args,
          server,
          tokenStore,
          apiFactory,
          inputReader,
        });
        break;
      case 'events':
        return eventsCommand({
          args,
          server,
          tokenStore,
          apiFactory,
          output,
        });
      default:
        throw new ControlCliError('UNKNOWN_COMMAND', 'Unknown control command.');
    }

    emitSuccess(output, result);
    // Once the success record is emitted, cleanup must not turn the same
    // command into a contradictory failure record. A leftover pending key is
    // safe: the next retry will reuse it.
    if (result.operation) await idempotencyStore.complete(result.operation).catch(() => undefined);
    return 0;
  } catch (error) {
    emitFailure(output, action, error);
    return 1;
  }
}

/**
 * Global CLI options are parsed before normal control dispatch. If that
 * bootstrap parsing fails, keep the response on the same control protocol and
 * derive only a known action name; never reflect the raw argument value.
 */
export function emitControlBootstrapFailure(
  argv: readonly string[],
  output: ControlOutput,
  code: string,
): number {
  const [command, ...args] = argv;
  const action = command ? requestedAction(command, args) : 'control';
  emitFailure(
    output,
    action,
    new ControlCliError(code, 'A global control option is missing or invalid.'),
  );
  return 1;
}

async function login(options: {
  args: readonly string[];
  server: string;
  output: ControlOutput;
  tokenStore: ControlTokenStore;
  loginStore: ControlLoginStore;
  apiFactory: (server: string, token?: string) => ControlApi;
  browserOpener: (url: string) => boolean;
  delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<CommandResult> {
  const flags = parseOptions(
    options.args,
    ['no-browser'],
    ['label', 'scope', 'preset', 'ttl-seconds'],
  );
  const presetName = option(flags, 'preset') ?? 'readonly';
  if (!(presetName in CONTROL_SCOPE_PRESETS)) {
    throw new ControlCliError('INVALID_PRESET', 'Unknown control login preset.');
  }
  const preset = CONTROL_SCOPE_PRESETS[presetName as keyof typeof CONTROL_SCOPE_PRESETS];
  const scopes = [...new Set([...preset, ...(flags.values.get('scope') ?? [])])].sort();
  if (!scopes.length) throw new ControlCliError('INVALID_SCOPE', 'At least one scope is required.');
  for (const [index, scope] of scopes.entries()) {
    if (!CONTROL_SCOPES.has(scope)) {
      throw new ControlCliError(
        'INVALID_SCOPE',
        `Unknown control scope at --scope occurrence ${index + 1}.`,
      );
    }
  }
  const ttlSeconds = option(flags, 'ttl-seconds');
  const body = {
    ...(option(flags, 'label') ? { label: option(flags, 'label') } : {}),
    scopes,
    ...(ttlSeconds
      ? { ttlSeconds: parseInteger(ttlSeconds, 'ttl-seconds', 3_600, 90 * 24 * 60 * 60) }
      : {}),
  };
  const api = options.apiFactory(options.server);
  const requestFingerprint = options.loginStore.fingerprint(options.server, body);
  let pending = await options.loginStore.read();
  const resumed = pending !== null;
  let requestId: string | undefined;
  if (
    pending &&
    (pending.server !== options.server || pending.requestFingerprint !== requestFingerprint)
  ) {
    throw new ControlCliError(
      'LOGIN_ALREADY_PENDING',
      'A different unexpired control login is pending. Complete it or wait for it to expire.',
    );
  }
  if (!pending) {
    // Device allocation is an unauthenticated one-time handshake, not an owner
    // mutation covered by the platform's idempotency contract.
    const started = await api.request({
      method: 'POST',
      route: CONTROL_API_ROUTES.deviceStart,
      body,
    });
    const device = requireRecord(started.data, 'INVALID_DEVICE_RESPONSE');
    const verificationUri = requireString(device, 'verificationUri', 'INVALID_DEVICE_RESPONSE');
    const expiresIn = finiteInteger(device.expiresIn, 600);
    pending = {
      version: 1,
      server: options.server,
      requestFingerprint,
      deviceCode: requireString(device, 'deviceCode', 'INVALID_DEVICE_RESPONSE'),
      userCode: requireString(device, 'userCode', 'INVALID_DEVICE_RESPONSE'),
      verificationUri,
      verificationUriComplete:
        typeof device.verificationUriComplete === 'string'
          ? device.verificationUriComplete
          : verificationUri,
      expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
      intervalSeconds: finiteInteger(device.interval, 3),
      scopes: Array.isArray(device.scopes)
        ? device.scopes.filter((scope): scope is string => typeof scope === 'string')
        : scopes,
    };
    await options.loginStore.write(pending);
    requestId = started.requestId;
  }
  const expiresIn = Math.max(1, Math.floor((Date.parse(pending.expiresAt) - Date.now()) / 1_000));
  emitSuccess(options.output, {
    action: 'login',
    data: {
      status: 'authorization_required',
      resumed,
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      expiresIn,
      scopes: pending.scopes,
    },
    requestId,
  });
  if (!flags.booleans.has('no-browser')) options.browserOpener(pending.verificationUriComplete);

  const controller = createInterruptController();
  try {
    const expiresAt = Date.parse(pending.expiresAt);
    let intervalMs = Math.max(1_000, pending.intervalSeconds * 1_000);
    let transientFailures = 0;
    while (!controller.signal.aborted && Date.now() < expiresAt) {
      await options.delay(intervalMs, controller.signal);
      if (controller.signal.aborted) break;
      try {
        const polled = await api.request({
          method: 'POST',
          route: CONTROL_API_ROUTES.deviceToken,
          body: { deviceCode: pending.deviceCode },
        });
        if (polled.status === 202 || polled.status === 204) continue;
        const data = requireRecord(polled.data, 'INVALID_DEVICE_RESPONSE');
        if (data.status === 'pending') continue;
        const accessToken = requireString(data, 'accessToken', 'INVALID_DEVICE_RESPONSE');
        await options.tokenStore.write(accessToken);
        await options.loginStore.clear();
        return {
          action: 'login',
          data: {
            status: 'authenticated',
            kind: data.kind ?? 'control',
            access: data.access ?? 'owner',
            credential: data.credential ?? null,
          },
          requestId: polled.requestId,
        };
      } catch (error) {
        if (error instanceof ControlApiError && error.options.retryable) {
          transientFailures += 1;
          intervalMs = Math.max(
            error.options.retryAfterMs ?? 0,
            Math.min(30_000, Math.max(1_000, 1_000 * 2 ** transientFailures)),
          );
          continue;
        }
        if (
          error instanceof ControlApiError &&
          [403, 404, 409, 410].includes(error.options.status ?? 0)
        ) {
          await options.loginStore.clear();
        }
        throw error;
      }
    }
    if (!controller.signal.aborted) await options.loginStore.clear();
    throw new ControlCliError(
      controller.signal.aborted ? 'INTERRUPTED' : 'DEVICE_CODE_EXPIRED',
      controller.signal.aborted ? 'Control login was interrupted.' : 'Control login code expired.',
    );
  } finally {
    controller.dispose();
  }
}

async function status(
  args: readonly string[],
  server: string,
  tokenStore: ControlTokenStore,
  apiFactory: (server: string, token?: string) => ControlApi,
): Promise<CommandResult> {
  parseOptions(args, [], []);
  const token = await tokenStore.read();
  if (!token) {
    return { action: 'status', data: { authenticated: false, server } };
  }
  try {
    const response = await apiFactory(server, token).request({ route: CONTROL_API_ROUTES.me });
    return {
      action: 'status',
      data: { authenticated: true, server, account: response.data },
      requestId: response.requestId,
    };
  } catch (error) {
    if (error instanceof ControlApiError && [401, 403].includes(error.options.status ?? 0)) {
      await tokenStore.clear();
      return {
        action: 'status',
        data: { authenticated: false, server, reason: 'credential_invalid' },
        requestId: error.options.requestId,
      };
    }
    throw error;
  }
}

async function logout(
  args: readonly string[],
  server: string,
  tokenStore: ControlTokenStore,
  apiFactory: (server: string, token?: string) => ControlApi,
): Promise<CommandResult> {
  parseOptions(args, [], []);
  const token = await tokenStore.read();
  if (!token) return { action: 'logout', data: { revoked: false, localTokenRemoved: false } };
  try {
    const response = await apiFactory(server, token).request({
      method: 'DELETE',
      route: CONTROL_API_ROUTES.me,
    });
    await tokenStore.clear();
    return {
      ...responseResult('logout', response),
      data: { authenticated: false, revoked: true, localTokenRemoved: true },
    };
  } catch (error) {
    if (error instanceof ControlApiError && error.options.status === 401) {
      await tokenStore.clear();
      return {
        action: 'logout',
        data: {
          authenticated: false,
          revoked: false,
          revokedOrExpired: true,
          localTokenRemoved: true,
        },
        requestId: error.options.requestId,
      };
    }
    throw error;
  }
}

async function describe(
  args: readonly string[],
  server: string,
  apiFactory: (server: string, token?: string) => ControlApi,
): Promise<CommandResult> {
  const flags = parseOptions(args, [], ['schema']);
  const schema = option(flags, 'schema');
  const route = schema
    ? schema === 'task'
      ? CONTROL_API_ROUTES.createTaskSchema
      : (() => {
          throw new ControlCliError('UNKNOWN_SCHEMA', 'Unknown control schema.');
        })()
    : CONTROL_API_ROUTES.capabilities;
  const response = await apiFactory(server).request({ route });
  return {
    ...responseResult(schema ? 'describe.schema' : 'describe', response),
    data: schema
      ? {
          schema: response.data,
          note: 'The schema is structural guidance. tasks validate or tasks publish is authoritative.',
          validateCommand: 'agentpool control tasks validate --input FILE|-',
        }
      : {
          platform: response.data,
          cli: {
            controlActions: CONTROL_CLI_ACTIONS,
            runnerActions: RUNNER_CLI_ACTIONS,
          },
        },
  };
}

async function taskCommand(options: {
  args: readonly string[];
  server: string;
  tokenStore: ControlTokenStore;
  idempotencyStore: IdempotencyStore;
  apiFactory: (server: string, token?: string) => ControlApi;
  inputReader: (source: string) => Promise<unknown>;
}): Promise<CommandResult> {
  const [command, ...args] = options.args;
  if (!command) throw new ControlCliError('MISSING_COMMAND', 'A tasks command is required.');
  if (command === 'list') {
    const flags = parseOptions(args, [], ['status', 'limit', 'offset']);
    return authenticatedRequest(
      'tasks.list',
      [],
      options.server,
      options.tokenStore,
      options.apiFactory,
      {
        route: withQuery(CONTROL_API_ROUTES.tasks, {
          status: option(flags, 'status'),
          limit: option(flags, 'limit'),
          offset: option(flags, 'offset'),
        }),
      },
    );
  }
  if (command === 'get') {
    const flags = parseOptions(args, [], ['task']);
    const taskId = requiredOption(flags, 'task');
    validateUuid(taskId, 'task');
    return authenticatedRequest(
      'tasks.get',
      [],
      options.server,
      options.tokenStore,
      options.apiFactory,
      { route: CONTROL_API_ROUTES.task(taskId) },
    );
  }
  if (command === 'publish' || command === 'validate') {
    const flags = parseOptions(
      args,
      [],
      command === 'publish' ? ['input', 'idempotency-key'] : ['input'],
    );
    const body = await options.inputReader(requiredOption(flags, 'input'));
    const token = await requireToken(options.tokenStore);
    if (command === 'validate') {
      const response = await options.apiFactory(options.server, token).request({
        method: 'POST',
        route: CONTROL_API_ROUTES.taskValidate,
        body,
      });
      return responseResult('tasks.validate', response);
    }
    const mutation = await mutationRequest(
      'tasks.publish',
      options.apiFactory(options.server, token),
      options.idempotencyStore,
      { method: 'POST', route: CONTROL_API_ROUTES.tasks, body },
      option(flags, 'idempotency-key'),
    );
    return mutationResult('tasks.publish', mutation);
  }
  if (command === 'launch' || command === 'cancel') {
    const flags = parseOptions(args, [], ['task', 'idempotency-key']);
    const taskId = requiredOption(flags, 'task');
    validateUuid(taskId, 'task');
    const token = await requireToken(options.tokenStore);
    const mutation = await mutationRequest(
      `tasks.${command}`,
      options.apiFactory(options.server, token),
      options.idempotencyStore,
      {
        method: 'POST',
        route:
          command === 'launch'
            ? CONTROL_API_ROUTES.taskLaunch(taskId)
            : CONTROL_API_ROUTES.taskCancel(taskId),
      },
      option(flags, 'idempotency-key'),
    );
    return mutationResult(`tasks.${command}`, mutation);
  }
  if (command === 'results') {
    const flags = parseOptions(args, [], ['task', 'status', 'limit', 'offset']);
    const taskId = requiredOption(flags, 'task');
    validateUuid(taskId, 'task');
    return authenticatedRequest(
      'tasks.results',
      [],
      options.server,
      options.tokenStore,
      options.apiFactory,
      {
        route: withQuery(CONTROL_API_ROUTES.taskResults(taskId), {
          status: option(flags, 'status'),
          limit: option(flags, 'limit'),
          offset: option(flags, 'offset'),
        }),
      },
    );
  }
  if (command === 'review') {
    const flags = parseOptions(
      args,
      ['retry'],
      ['task', 'result', 'input', 'decision', 'reason', 'idempotency-key'],
    );
    const taskId = requiredOption(flags, 'task');
    const resultId = requiredOption(flags, 'result');
    validateUuid(taskId, 'task');
    validateUuid(resultId, 'result');
    const inputSource = option(flags, 'input');
    const body = inputSource
      ? await options.inputReader(inputSource)
      : {
          decision: requiredOption(flags, 'decision'),
          retry: flags.booleans.has('retry'),
          ...(option(flags, 'reason') ? { reason: option(flags, 'reason') } : {}),
        };
    const token = await requireToken(options.tokenStore);
    const mutation = await mutationRequest(
      'tasks.review',
      options.apiFactory(options.server, token),
      options.idempotencyStore,
      {
        method: 'POST',
        route: CONTROL_API_ROUTES.taskReview(taskId, resultId),
        body,
      },
      option(flags, 'idempotency-key'),
    );
    return mutationResult('tasks.review', mutation);
  }
  throw new ControlCliError('UNKNOWN_COMMAND', 'Unknown tasks command.');
}

async function walletCommand(options: {
  args: readonly string[];
  server: string;
  tokenStore: ControlTokenStore;
  idempotencyStore: IdempotencyStore;
  apiFactory: (server: string, token?: string) => ControlApi;
}): Promise<CommandResult> {
  const [command = 'show', ...args] = options.args;
  if (command === 'show' || command === 'ledger' || command === 'withdrawals') {
    const flags = parseOptions(args, [], ['before', 'limit']);
    const route =
      command === 'show'
        ? CONTROL_API_ROUTES.wallet
        : command === 'ledger'
          ? withQuery(CONTROL_API_ROUTES.walletLedger, {
              before: option(flags, 'before'),
              limit: option(flags, 'limit'),
            })
          : CONTROL_API_ROUTES.walletWithdrawals;
    return authenticatedRequest(
      `wallet.${command}`,
      [],
      options.server,
      options.tokenStore,
      options.apiFactory,
      { route },
    );
  }
  if (command === 'topup' || command === 'withdraw') {
    const flags = parseOptions(args, [], ['credits', 'idempotency-key']);
    const body = {
      credits: parseInteger(requiredOption(flags, 'credits'), 'credits', 1, 10_000_000),
    };
    const token = await requireToken(options.tokenStore);
    const mutation = await mutationRequest(
      `wallet.${command}`,
      options.apiFactory(options.server, token),
      options.idempotencyStore,
      {
        method: 'POST',
        route:
          command === 'topup' ? CONTROL_API_ROUTES.walletTopup : CONTROL_API_ROUTES.walletWithdraw,
        body,
      },
      option(flags, 'idempotency-key'),
    );
    return mutationResult(`wallet.${command}`, mutation);
  }
  throw new ControlCliError('UNKNOWN_COMMAND', 'Unknown wallet command.');
}

async function runnersCommand(
  args: readonly string[],
  server: string,
  tokenStore: ControlTokenStore,
  apiFactory: (server: string, token?: string) => ControlApi,
): Promise<CommandResult> {
  const [command = 'list', ...rest] = args;
  if (command !== 'list') throw new ControlCliError('UNKNOWN_COMMAND', 'Unknown runners command.');
  return authenticatedRequest('runners.list', rest, server, tokenStore, apiFactory, {
    route: CONTROL_API_ROUTES.runners,
  });
}

async function fleetCommand(options: {
  args: readonly string[];
  server: string;
  tokenStore: ControlTokenStore;
  idempotencyStore: IdempotencyStore;
  apiFactory: (server: string, token?: string) => ControlApi;
  inputReader: (source: string) => Promise<unknown>;
}): Promise<CommandResult> {
  const [command = 'get', ...args] = options.args;
  if (command === 'get') {
    return authenticatedRequest(
      'fleet.get',
      args,
      options.server,
      options.tokenStore,
      options.apiFactory,
      { route: CONTROL_API_ROUTES.fleet },
    );
  }
  if (command === 'update') {
    const flags = parseOptions(args, [], ['mode', 'input', 'idempotency-key']);
    const input = option(flags, 'input');
    const body = input ? await options.inputReader(input) : { mode: requiredOption(flags, 'mode') };
    const token = await requireToken(options.tokenStore);
    const mutation = await mutationRequest(
      'fleet.update',
      options.apiFactory(options.server, token),
      options.idempotencyStore,
      { method: 'PATCH', route: CONTROL_API_ROUTES.fleet, body },
      option(flags, 'idempotency-key'),
    );
    return mutationResult('fleet.update', mutation);
  }
  throw new ControlCliError('UNKNOWN_COMMAND', 'Unknown fleet command.');
}

async function profileCommand(options: {
  args: readonly string[];
  server: string;
  tokenStore: ControlTokenStore;
  idempotencyStore: IdempotencyStore;
  apiFactory: (server: string, token?: string) => ControlApi;
  inputReader: (source: string) => Promise<unknown>;
}): Promise<CommandResult> {
  const [command = 'get', ...args] = options.args;
  if (command === 'get') {
    return authenticatedRequest(
      'profile.get',
      args,
      options.server,
      options.tokenStore,
      options.apiFactory,
      { route: CONTROL_API_ROUTES.me },
    );
  }
  if (command === 'update') {
    const flags = parseOptions(args, [], ['display-name', 'input', 'idempotency-key']);
    const input = option(flags, 'input');
    const body = input
      ? await options.inputReader(input)
      : { displayName: requiredOption(flags, 'display-name') };
    const token = await requireToken(options.tokenStore);
    const mutation = await mutationRequest(
      'profile.update',
      options.apiFactory(options.server, token),
      options.idempotencyStore,
      { method: 'PATCH', route: CONTROL_API_ROUTES.profile, body },
      option(flags, 'idempotency-key'),
    );
    return mutationResult('profile.update', mutation);
  }
  throw new ControlCliError('UNKNOWN_COMMAND', 'Unknown profile command.');
}

async function capacityCommand(
  args: readonly string[],
  server: string,
  apiFactory: (server: string, token?: string) => ControlApi,
  inputReader: (source: string) => Promise<unknown>,
): Promise<CommandResult> {
  const [command = 'catalog', ...rest] = args;
  if (command === 'catalog') {
    return publicRequest('capacity.catalog', rest, server, apiFactory, {
      route: CONTROL_API_ROUTES.capacityCatalog,
    });
  }
  if (command === 'quote') {
    const flags = parseOptions(rest, [], ['input']);
    const response = await apiFactory(server).request({
      method: 'POST',
      route: CONTROL_API_ROUTES.capacityQuote,
      body: await inputReader(requiredOption(flags, 'input')),
    });
    return responseResult('capacity.quote', response);
  }
  throw new ControlCliError('UNKNOWN_COMMAND', 'Unknown capacity command.');
}

async function devicesCommand(options: {
  args: readonly string[];
  server: string;
  tokenStore: ControlTokenStore;
  apiFactory: (server: string, token?: string) => ControlApi;
  inputReader: (source: string) => Promise<unknown>;
}): Promise<CommandResult> {
  const [command = 'list', ...args] = options.args;
  if (command === 'list') {
    return authenticatedRequest(
      'devices.list',
      args,
      options.server,
      options.tokenStore,
      options.apiFactory,
      { route: CONTROL_API_ROUTES.credentials },
    );
  }
  if (command === 'revoke') {
    const flags = parseOptions(args, [], ['credential']);
    const credentialId = requiredOption(flags, 'credential');
    validateUuid(credentialId, 'credential');
    const token = await requireToken(options.tokenStore);
    const response = await options.apiFactory(options.server, token).request({
      method: 'DELETE',
      route: CONTROL_API_ROUTES.credential(credentialId),
    });
    return responseResult('devices.revoke', response);
  }
  if (command === 'preview') {
    const flags = parseOptions(args, [], ['code']);
    const token = await requireToken(options.tokenStore);
    const response = await options.apiFactory(options.server, token).request({
      method: 'POST',
      route: CONTROL_API_ROUTES.runnerDevicePreview,
      body: { userCode: requiredOption(flags, 'code') },
    });
    return responseResult('devices.preview', response);
  }
  if (command === 'approve') {
    const flags = parseOptions(
      args,
      [],
      ['code', 'expected-client', 'expected-operator-type', 'input'],
    );
    const source = option(flags, 'input');
    const body = source
      ? await options.inputReader(source)
      : {
          userCode: requiredOption(flags, 'code'),
          expectedClient: requiredOption(flags, 'expected-client'),
          expectedOperatorType: requiredOption(flags, 'expected-operator-type'),
        };
    const token = await requireToken(options.tokenStore);
    const response = await options.apiFactory(options.server, token).request({
      method: 'POST',
      route: CONTROL_API_ROUTES.runnerDeviceApprove,
      body,
    });
    return responseResult('devices.approve', response);
  }
  throw new ControlCliError('UNKNOWN_COMMAND', 'Unknown devices command.');
}

async function eventsCommand(options: {
  args: readonly string[];
  server: string;
  tokenStore: ControlTokenStore;
  apiFactory: (server: string, token?: string) => ControlApi;
  output: ControlOutput;
}): Promise<number> {
  const args = options.args[0] === 'follow' ? options.args.slice(1) : options.args;
  const implicitFollow = options.args[0] === 'follow';
  const flags = parseOptions(args, ['follow'], ['after', 'limit', 'wait-seconds', 'max-events']);
  const follow = implicitFollow || flags.booleans.has('follow');
  const token = await requireToken(options.tokenStore);
  const api = options.apiFactory(options.server, token);
  let after = option(flags, 'after') ?? '0';
  const limit = option(flags, 'limit') ?? '100';
  const waitSeconds = option(flags, 'wait-seconds') ?? (follow ? '20' : '0');
  const maxEvents = option(flags, 'max-events')
    ? parseInteger(option(flags, 'max-events')!, 'max-events', 1, 100_000)
    : Number.POSITIVE_INFINITY;
  let emitted = 0;
  const controller = createInterruptController();
  try {
    while (!controller.signal.aborted) {
      const response = await api.request({
        route: withQuery(CONTROL_API_ROUTES.events, { after, limit, waitSeconds }),
        timeoutMs: (parseInteger(waitSeconds, 'wait-seconds', 0, 25) + 10) * 1_000,
      });
      if (!follow) {
        emitSuccess(options.output, responseResult('events', response));
        return 0;
      }
      const envelope = requireRecord(response.data, 'INVALID_EVENT_RESPONSE');
      const events = Array.isArray(envelope.events) ? envelope.events : [];
      for (const event of events) {
        emitSuccess(options.output, {
          action: 'events',
          data: event,
          requestId: response.requestId,
        });
        emitted += 1;
        if (emitted >= maxEvents) return 0;
      }
      after = eventCursor(envelope, events, after);
    }
    return 0;
  } catch (error) {
    emitFailure(options.output, 'events', error);
    return 1;
  } finally {
    controller.dispose();
  }
}

async function authenticatedRequest(
  action: string,
  args: readonly string[],
  server: string,
  tokenStore: ControlTokenStore,
  apiFactory: (server: string, token?: string) => ControlApi,
  request: ControlRequest,
): Promise<CommandResult> {
  parseOptions(args, [], []);
  const token = await requireToken(tokenStore);
  const response = await apiFactory(server, token).request(request);
  return responseResult(action, response);
}

async function publicRequest(
  action: string,
  args: readonly string[],
  server: string,
  apiFactory: (server: string, token?: string) => ControlApi,
  request: ControlRequest,
): Promise<CommandResult> {
  parseOptions(args, [], []);
  return responseResult(action, await apiFactory(server).request(request));
}

async function mutationRequest(
  action: string,
  api: ControlApi,
  store: IdempotencyStore,
  request: ControlRequest & { method: 'POST' | 'PATCH' | 'DELETE' },
  explicitKey?: string,
): Promise<{ response: ControlApiResponse; operation: IdempotencyOperation }> {
  const operation = await store.begin(
    action,
    { method: request.method, route: request.route, body: request.body },
    explicitKey,
  );
  try {
    const response = await api.request({ ...request, idempotencyKey: operation.key });
    return { response, operation };
  } catch (error) {
    if (error instanceof ControlApiError && !error.options.retryable) {
      await store.complete(operation).catch(() => undefined);
    }
    throw error;
  }
}

function mutationResult(
  action: string,
  mutation: { response: ControlApiResponse; operation: IdempotencyOperation },
  data: unknown = mutation.response.data,
): CommandResult {
  return {
    action,
    data,
    requestId: mutation.response.requestId,
    idempotencyKey: mutation.operation.key,
    idempotencyReplayed: mutation.response.idempotencyReplayed,
    operation: mutation.operation,
  };
}

function responseResult(action: string, response: ControlApiResponse): CommandResult {
  return {
    action,
    data: response.data,
    requestId: response.requestId,
    ...(response.idempotencyReplayed ? { idempotencyReplayed: true } : {}),
  };
}

function emitSuccess(output: ControlOutput, result: CommandResult): void {
  output.log(
    JSON.stringify({
      protocol: CONTROL_PROTOCOL,
      ok: true,
      action: result.action,
      data: result.data,
      meta: {
        ...(result.requestId ? { requestId: result.requestId } : {}),
        ...(result.idempotencyKey ? { idempotencyKey: result.idempotencyKey } : {}),
        ...(result.idempotencyReplayed !== undefined
          ? { idempotencyReplayed: result.idempotencyReplayed }
          : {}),
      },
    }),
  );
}

function emitFailure(output: ControlOutput, action: string, error: unknown): void {
  const normalized = normalizeError(error);
  output.log(
    JSON.stringify({
      protocol: CONTROL_PROTOCOL,
      ok: false,
      action: redactSensitiveText(action),
      error: {
        code: normalized.code,
        message: redactSensitiveText(normalized.message),
        retryable: normalized.retryable,
        ...(normalized.details === undefined
          ? {}
          : { details: sanitizeProtocolValue(normalized.details) }),
      },
      meta: {
        ...(normalized.status === undefined ? {} : { httpStatus: normalized.status }),
        ...(normalized.requestId ? { requestId: normalized.requestId } : {}),
        ...(normalized.retryAfterMs === undefined ? {} : { retryAfterMs: normalized.retryAfterMs }),
      },
    }),
  );
}

function normalizeError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  details?: unknown;
  requestId?: string;
  retryAfterMs?: number;
} {
  if (error instanceof ControlApiError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.options.retryable,
      ...(error.options.status === undefined ? {} : { status: error.options.status }),
      ...(error.options.details === undefined ? {} : { details: error.options.details }),
      ...(error.options.requestId ? { requestId: error.options.requestId } : {}),
      ...(error.options.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: error.options.retryAfterMs }),
    };
  }
  if (error instanceof ControlCliError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof AmbiguousOperationExpiredError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof SyntaxError) {
    return { code: 'INVALID_JSON', message: 'Input is not valid JSON.', retryable: false };
  }
  const message = error instanceof Error ? error.message : 'Control command failed.';
  return { code: classifyLocalError(error), message, retryable: false };
}

class ControlCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlCliError';
  }
}

function classifyLocalError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'INPUT_NOT_FOUND';
  if (code === 'EACCES' || code === 'EPERM') return 'INPUT_NOT_READABLE';
  if (error instanceof Error && error.message.includes('idempotency')) {
    return 'INVALID_IDEMPOTENCY_STATE';
  }
  return 'LOCAL_ERROR';
}

async function requireToken(tokenStore: ControlTokenStore): Promise<string> {
  const token = await tokenStore.read();
  if (!token) {
    throw new ControlCliError(
      'AUTH_REQUIRED',
      'Control login required. Run: agentpool control login',
    );
  }
  return token;
}

async function readJsonInput(source: string): Promise<unknown> {
  let text: string;
  if (source === '-') {
    text = await readStdinLimited();
  } else {
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ControlCliError('INVALID_INPUT_FILE', 'Input path must be a regular file.');
    }
    if (stat.size > MAX_INPUT_BYTES) {
      throw new ControlCliError('INPUT_TOO_LARGE', 'Input exceeds 25 MiB.');
    }
    text = await readFile(source, 'utf8');
  }
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) {
    throw new ControlCliError('INPUT_TOO_LARGE', 'Input exceeds 25 MiB.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ControlCliError('INVALID_JSON', 'Input is not valid JSON.');
  }
}

async function readStdinLimited(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_INPUT_BYTES) {
      throw new ControlCliError('INPUT_TOO_LARGE', 'Input exceeds 25 MiB.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseOptions(
  argv: readonly string[],
  booleanNames: readonly string[],
  valueNames: readonly string[],
): ParsedOptions {
  const booleans = new Set<string>();
  const values = new Map<string, string[]>();
  const allowedBooleans = new Set(booleanNames);
  const allowedValues = new Set(valueNames);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith('--')) {
      throw new ControlCliError(
        'UNEXPECTED_ARGUMENT',
        `Unexpected positional argument at position ${index + 1}.`,
      );
    }
    const separator = argument.indexOf('=');
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (name === 'token' || name === 'access-token') {
      throw new ControlCliError(
        'TOKEN_ARGUMENT_FORBIDDEN',
        'Control tokens are never accepted in command arguments.',
      );
    }
    if (allowedBooleans.has(name)) {
      if (separator !== -1) {
        throw new ControlCliError('INVALID_OPTION', `--${name} does not accept a value.`);
      }
      booleans.add(name);
      continue;
    }
    if (!allowedValues.has(name)) {
      throw new ControlCliError('UNKNOWN_OPTION', `Unknown option at position ${index + 1}.`);
    }
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith('--')) {
      throw new ControlCliError('MISSING_OPTION_VALUE', `--${name} requires a value.`);
    }
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { values, booleans };
}

function option(flags: ParsedOptions, name: string): string | undefined {
  const values = flags.values.get(name);
  if (!values?.length) return undefined;
  if (values.length > 1 && name !== 'scope') {
    throw new ControlCliError('DUPLICATE_OPTION', `--${name} may only be specified once.`);
  }
  return values.at(-1);
}

function requiredOption(flags: ParsedOptions, name: string): string {
  const value = option(flags, name);
  if (!value) throw new ControlCliError('MISSING_OPTION', `--${name} is required.`);
  return value;
}

function parseInteger(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/u.test(value)) {
    throw new ControlCliError('INVALID_VALUE', `--${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ControlCliError(
      'INVALID_VALUE',
      `--${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

function validateUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ControlCliError('INVALID_ID', `--${name} must be a UUID.`);
  }
}

function withQuery(route: string, values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, value);
  }
  const suffix = query.toString();
  return suffix ? `${route}?${suffix}` : route;
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlCliError(code, 'Platform returned an invalid control response.');
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, code: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) {
    throw new ControlCliError(code, 'Platform returned an invalid control response.');
  }
  return value;
}

function finiteInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function eventCursor(
  envelope: Record<string, unknown>,
  events: unknown[],
  fallback: string,
): string {
  if (typeof envelope.nextCursor === 'string' || typeof envelope.nextCursor === 'number') {
    return String(envelope.nextCursor);
  }
  const last = events.at(-1);
  if (last && typeof last === 'object' && !Array.isArray(last)) {
    const id = (last as Record<string, unknown>).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return fallback;
}

function localDescription(): Record<string, unknown> {
  return {
    protocol: CONTROL_PROTOCOL,
    output: 'One compact JSON object per line on stdout. Diagnostics never contain tokens.',
    discovery: {
      describe: 'agentpool control describe',
      llmsTxt: 'https://agentpool.itool.tech/llms.txt',
      skills: 'https://agentpool.itool.tech/api/meta/skills',
      skillsIndex: 'https://agentpool.itool.tech/.well-known/agent-skills/index.json',
    },
    schema:
      'agentpool control describe --schema task is structural guidance; tasks validate is authoritative',
    authentication: {
      login: 'agentpool control login',
      tokenLocation: '~/.agentpool-control/token',
      stateOverride: 'AGENTPOOL_CONTROL_STATE_DIR',
      defaultScopes: CONTROL_SCOPE_PRESETS.readonly,
      presets: CONTROL_SCOPE_PRESETS,
      highRiskScopes: HIGH_RISK_CONTROL_SCOPES,
    },
    commands: [
      'login | status | logout | describe [--schema task]',
      'dashboard | network',
      'tasks list | get | validate | publish | launch | cancel | results | review',
      'wallet show | ledger | withdrawals | topup | withdraw',
      'runners list | fleet get | fleet update | profile get | profile update',
      'capacity catalog | capacity quote',
      'devices list | revoke | preview | approve',
      'events [--follow]',
    ],
    actionCatalog: {
      control: CONTROL_CLI_ACTIONS,
      runner: RUNNER_CLI_ACTIONS,
    },
    input: 'Complex JSON uses --input FILE or --input - for stdin.',
    idempotency:
      'Supported owner mutations use a crash-safe pending Idempotency-Key automatically; --idempotency-key can supply one explicitly.',
    runnerSafety:
      'Control commands never claim work. Runner Agents use jobs --json then an explicit bounded claim.',
  };
}

function sanitizeProtocolValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (depth >= 8) return '[REDACTED_DEPTH]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeProtocolValue(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = /token|secret|password|authorization|api.?key|signature/iu.test(key)
      ? '[REDACTED_SECRET]'
      : sanitizeProtocolValue(child, depth + 1);
  }
  return sanitized;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\bap_(?:control(?:_device)?|runner|device)_[A-Za-z0-9._~+/=-]+/giu,
      '[REDACTED_TOKEN]',
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1[REDACTED]@')
    .replace(
      /((?:receipt[_-]?secret|webhook[_-]?secret|access[_-]?token|api[_-]?key|password|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/giu,
      '$1[REDACTED_SECRET]',
    );
}

function requestedAction(command: string, args: readonly string[]): string {
  const knownTopLevel = new Set([
    'login',
    'status',
    'logout',
    'describe',
    'dashboard',
    'network',
    'tasks',
    'wallet',
    'runners',
    'fleet',
    'profile',
    'capacity',
    'devices',
    'events',
  ]);
  if (!knownTopLevel.has(command)) return 'control';
  if (
    command === 'describe' &&
    args.some((argument) => argument === '--schema' || argument.startsWith('--schema='))
  ) {
    return 'describe.schema';
  }
  if (command === 'events') return 'events';
  const defaults: Record<string, string> = {
    wallet: 'show',
    runners: 'list',
    fleet: 'get',
    profile: 'get',
    capacity: 'catalog',
    devices: 'list',
  };
  const children: Record<string, ReadonlySet<string>> = {
    tasks: new Set(['list', 'get', 'validate', 'publish', 'launch', 'cancel', 'results', 'review']),
    wallet: new Set(['show', 'ledger', 'withdrawals', 'topup', 'withdraw']),
    runners: new Set(['list']),
    fleet: new Set(['get', 'update']),
    profile: new Set(['get', 'update']),
    capacity: new Set(['catalog', 'quote']),
    devices: new Set(['list', 'revoke', 'preview', 'approve']),
  };
  if (command in children) {
    const child = args[0] && !args[0].startsWith('--') ? args[0] : defaults[command];
    return child && children[command]?.has(child) ? `${command}.${child}` : command;
  }
  return command;
}

function createInterruptController(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    },
  };
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ControlCliError('INTERRUPTED', 'Control command was interrupted.'));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ControlCliError('INTERRUPTED', 'Control command was interrupted.'));
      },
      { once: true },
    );
  });
}
