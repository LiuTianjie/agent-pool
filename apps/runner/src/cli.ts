import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';

import {
  AgentPoolApiClient,
  ApiError,
  DEFAULT_SERVER,
  RunnerTransportError,
} from './api-client.js';
import { createAdapter, detectAllAdapters } from './adapters/index.js';
import { runBenchmark } from './benchmark.js';
import { openBrowser } from './browser.js';
import { emitControlBootstrapFailure, runControlCli } from './control-cli.js';
import { normalizeControlServer } from './control-api-client.js';
import { RUNNER_CLI_ACTIONS } from './command-catalog.js';
import {
  AmbiguousOperationExpiredError,
  ControlIdempotencyStore,
  type IdempotencyOperation,
} from './control-idempotency-store.js';
import { normalizeAllowedModels } from './lease.js';
import {
  communityProfileLockKey,
  profileLockManagerForTokenStore,
  type RunnerProfileLock,
  type RunnerProfileLockManager,
} from './profile-lock.js';
import { resolveCertifiedConcurrency, RunnerService } from './runner-service.js';
import { RunnerLoginStore } from './runner-login-store.js';
import { TokenStore } from './token-store.js';
import type {
  AgentAdapter,
  AgentAdapterDriver,
  Logger,
  NodeRegistration,
  CreateRunnerClaimInput,
  RunnerClaim,
} from './types.js';

export const RUNNER_VERSION = '0.1.0';

interface Output {
  log(message: string): void;
  error(message: string): void;
}

export interface InteractiveInput {
  isTTY: boolean;
  question(prompt: string, signal?: AbortSignal): Promise<string>;
}

interface ParsedFlags {
  values: Map<string, string[]>;
  booleans: Set<string>;
}

interface ClaimIdempotencyStore {
  begin(
    action: string,
    request: { method: string; route: string; body?: unknown },
    explicitKey?: string,
  ): Promise<IdempotencyOperation>;
  complete(operation: IdempotencyOperation): Promise<void>;
}

class MemoryClaimIdempotencyStore implements ClaimIdempotencyStore {
  private readonly entries = new Map<string, IdempotencyOperation>();

  async begin(
    action: string,
    request: { method: string; route: string; body?: unknown },
    explicitKey?: string,
  ): Promise<IdempotencyOperation> {
    const fingerprint = JSON.stringify([
      action,
      request.method,
      request.route,
      request.body ?? null,
    ]);
    if (explicitKey) {
      return { fingerprint, key: explicitKey, automatic: false, recovered: true };
    }
    const current = this.entries.get(fingerprint);
    if (current) return { ...current, recovered: true };
    const operation = {
      fingerprint,
      key: `apclaim-${randomUUID()}`,
      automatic: true,
      recovered: false,
    };
    this.entries.set(fingerprint, operation);
    return operation;
  }

  async complete(operation: IdempotencyOperation): Promise<void> {
    if (this.entries.get(operation.fingerprint)?.key === operation.key) {
      this.entries.delete(operation.fingerprint);
    }
  }
}

const HELP = `Agent Pool Runner ${RUNNER_VERSION}

Usage:
  agentpool login [--no-browser] [--server URL]
  agentpool agents [--json] [--server URL]
  agentpool benchmark --agent <codex|claude|mock> --model <exact> [--concurrency N]
  agentpool test --agent <codex|claude|mock> --model <exact> [--concurrency N]
  agentpool jobs --agent <agent> --model <exact> [--concurrency N] [--allow-webhooks] [--json]
  agentpool pick --agent <agent> --model <exact> [--concurrency N] [--allow-webhooks]
  agentpool claim --pool <uuid> --units N --agent <agent> --model <exact> [--concurrency N] [--allow-webhooks] [--json]
  agentpool claim --claim <uuid> [--concurrency N] [--allow-webhooks] [--json]
  agentpool once --pool <uuid> --agent <agent> --model <exact> [--allow-webhooks] [--json]
  agentpool cancel --claim <uuid> [--json]
  agentpool status [--json] [--server URL]
  agentpool logout [--server URL]
  agentpool control <command> [--server URL]

Agent-facing owner control:
  agentpool control describe
  agentpool control login
  agentpool control tasks list
  agentpool control tasks publish --input task.json
  agentpool control events --follow

Global server default: ${DEFAULT_SERVER}
AGENTPOOL_SERVER can override the default. --server has highest priority.
AGENTPOOL_STATE_DIR isolates the platform token from the default ~/.agentpool directory.
AGENTPOOL_CONTROL_STATE_DIR keeps owner-control state separate from Runner state.
Use a different OS user or machine when task processes must not be able to inspect it.

Every run is a bounded, explicit Claim. The Runner never scans the marketplace in
the background and stops when that Claim is exhausted, expired, or revoked.

Task prompts and outputs are never printed. Each task runs in a fresh temporary
directory and a nonpersistent agent session. On an ordinary owner-controlled
host this is operational isolation, not cryptographic secrecy or model attestation.`;

export interface CliDependencies {
  output?: Output;
  tokenStore?: TokenStore;
  apiFactory?: (server: string, token?: string) => AgentPoolApiClient;
  browserOpener?: (url: string) => boolean;
  environment?: NodeJS.ProcessEnv;
  interactive?: InteractiveInput;
  profileLocks?: RunnerProfileLockManager;
  claimIdempotencyStore?: ClaimIdempotencyStore;
  loginStore?: RunnerLoginStore;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? console;
  const environment = dependencies.environment ?? process.env;
  const tokenStore =
    dependencies.tokenStore ??
    new TokenStore({
      stateDirectory: environment.AGENTPOOL_STATE_DIR || undefined,
    });
  const apiFactory =
    dependencies.apiFactory ??
    ((server: string, token?: string) => new AgentPoolApiClient(server, token));
  const browserOpener = dependencies.browserOpener ?? openBrowser;
  const runnerDelay = dependencies.delay ?? delay;
  const interactive = dependencies.interactive ?? defaultInteractiveInput();
  const profileLocks =
    dependencies.profileLocks ?? profileLockManagerForTokenStore(tokenStore, 'agentpool-locks');

  let claimIdempotencyStore: ClaimIdempotencyStore | undefined = dependencies.claimIdempotencyStore;
  const getClaimIdempotencyStore = (): ClaimIdempotencyStore => {
    if (claimIdempotencyStore) return claimIdempotencyStore;
    claimIdempotencyStore =
      typeof (tokenStore as { directory?: unknown }).directory === 'string'
        ? new ControlIdempotencyStore(tokenStore)
        : new MemoryClaimIdempotencyStore();
    return claimIdempotencyStore;
  };
  let runnerJsonAction: string | undefined = detectRunnerJsonAction(argv);
  const rawControlArgs = controlArgumentsFromRawArgv(argv);
  try {
    const parsed = extractGlobalServer(argv);
    const [command, ...commandArgs] = parsed.argv;
    const configuredServer = parsed.server ?? environment.AGENTPOOL_SERVER ?? DEFAULT_SERVER;
    if (command === 'control') {
      return runControlCli(commandArgs, {
        server: configuredServer,
        output,
        environment,
        browserOpener,
      });
    }
    const server = normalizeControlServer(configuredServer);
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      const flags = parseFlags(commandArgs, ['json'], []);
      if (flags.booleans.has('json')) {
        emitRunnerJson(output, 'help', {
          version: RUNNER_VERSION,
          protocol: RUNNER_PROTOCOL,
          claimMode: 'manual_bounded_only',
          actions: RUNNER_CLI_ACTIONS,
          controlDiscovery: 'agentpool control help',
        });
        return 0;
      }
      output.log(HELP);
      return 0;
    }
    if (command === '--version' || command === '-v' || command === 'version') {
      output.log(RUNNER_VERSION);
      return 0;
    }

    switch (command) {
      case 'login': {
        const flags = parseFlags(commandArgs, ['no-browser'], []);
        const api = apiFactory(server);
        const loginStore = dependencies.loginStore ?? new RunnerLoginStore(tokenStore);
        let pending = await loginStore.read();
        if (pending && pending.server !== server) {
          throw new Error('A Runner login for a different server is already pending.');
        }
        if (!pending) {
          const device = await api.startDeviceLogin();
          pending = {
            version: 1,
            server,
            deviceCode: device.deviceCode,
            userCode: device.userCode,
            verificationUri: device.verificationUri,
            verificationUriComplete: device.verificationUriComplete ?? device.verificationUri,
            expiresAt: new Date(Date.now() + device.expiresIn * 1_000).toISOString(),
            intervalSeconds: device.interval ?? 5,
          };
          await loginStore.write(pending);
        }
        output.log(`Open ${pending.verificationUri}`);
        output.log(`Enter code: ${pending.userCode}`);
        if (!flags.booleans.has('no-browser')) {
          browserOpener(pending.verificationUriComplete);
        }
        const controller = createInterruptController();
        try {
          const expiresAt = Date.parse(pending.expiresAt);
          let intervalMs = Math.max(1_000, pending.intervalSeconds * 1_000);
          let transientFailures = 0;
          while (!controller.signal.aborted && Date.now() < expiresAt) {
            await runnerDelay(intervalMs, controller.signal);
            if (controller.signal.aborted) break;
            try {
              const result = await api.pollDeviceLogin(pending.deviceCode);
              if (result.status === 'approved') {
                await tokenStore.write(result.token);
                await loginStore.clear();
                output.log('Agent Pool login complete.');
                return 0;
              }
              if (result.status === 'denied' || result.status === 'expired') {
                await loginStore.clear();
                throw new Error(
                  result.status === 'denied' ? 'Login was denied.' : 'Login code expired.',
                );
              }
              if (result.status === 'slow_down') intervalMs = Math.min(30_000, intervalMs + 2_000);
              transientFailures = 0;
            } catch (error) {
              if (isRetryableRunnerError(error)) {
                transientFailures += 1;
                intervalMs = Math.max(
                  error instanceof ApiError ? (error.metadata.retryAfterMs ?? 0) : 0,
                  Math.min(30_000, Math.max(1_000, 1_000 * 2 ** transientFailures)),
                );
                continue;
              }
              if (error instanceof ApiError && [403, 404, 409, 410].includes(error.status)) {
                await loginStore.clear();
              }
              throw error;
            }
          }
          if (!controller.signal.aborted) await loginStore.clear();
          throw new Error(controller.signal.aborted ? 'Login interrupted.' : 'Login code expired.');
        } finally {
          controller.dispose();
        }
      }

      case 'agents': {
        const flags = parseFlags(commandArgs, ['json'], []);
        const json = flags.booleans.has('json');
        if (json) runnerJsonAction = 'agents.list';
        const statuses = await detectAllAdapters();
        if (json) {
          emitRunnerJson(output, 'agents.list', {
            agents: statuses,
            modelSelection: 'exact_model_required',
          });
          return 0;
        }
        for (const status of statuses) {
          const state = !status.available
            ? 'not installed'
            : status.authenticated
              ? 'ready'
              : 'login required';
          output.log(
            `${status.adapter.padEnd(7)} ${state.padEnd(14)} ${status.version ?? ''}`.trimEnd(),
          );
          if (status.supportedModels?.length) {
            output.log(`         built-in test models: ${status.supportedModels.join(', ')}`);
          }
        }
        output.log(
          'Real model identifiers are declared explicitly when benchmarking or claiming work.',
        );
        return 0;
      }

      case 'benchmark':
      case 'test': {
        const flags = parseFlags(commandArgs, [], ['agent', 'model', 'concurrency']);
        const agent = parseAgent(requireOne(flags, 'agent'));
        const model = normalizeAllowedModels([requireOne(flags, 'model')])[0];
        if (!model) throw new Error('An exact --model is required.');
        const concurrency = parseInteger(
          optionOne(flags, 'concurrency') ?? '1',
          'concurrency',
          1,
          64,
        );
        const token = await requireToken(tokenStore);
        const profileLock = await profileLocks.acquire(communityProfileLockKey(agent, model));
        try {
          const adapter = createAdapter(agent);
          const detection = await adapter.detect();
          if (!detection.available || !detection.authenticated) {
            throw new Error(`${agent} is not installed and authenticated.`);
          }
          const controller = createInterruptController();
          try {
            const api = apiFactory(server, token);
            const node = await api.registerNode({
              adapter: agent,
              models: [model],
              concurrency,
              adapterVersion: detection.version,
              clientVersion: RUNNER_VERSION,
              platform: process.platform,
              arch: process.arch,
              supportsDirectWebhooks: false,
            });
            let certification;
            let failureHint: string | undefined;
            try {
              certification = await runBenchmark({
                api,
                adapter,
                model,
                concurrency,
                nodeId: node.nodeId,
                signal: controller.signal,
                onFailure: (detail) => {
                  failureHint ??= detail;
                },
              });
            } finally {
              await api.disconnect(node.nodeId).catch(() => undefined);
            }
            output.log(certification.certified ? 'CERTIFIED' : 'NOT CERTIFIED');
            output.log(`certifiedConcurrency: ${certification.certifiedConcurrency}`);
            output.log(`P50: ${Math.round(certification.p50Ms)} ms`);
            output.log(`P95: ${Math.round(certification.p95Ms)} ms`);
            output.log(`successRate: ${formatPercent(certification.successRate)}`);
            output.log(`expiry: ${certification.expiresAt}`);
            if (failureHint && !certification.certified) {
              output.error(`failure: ${failureHint}`);
            }
            return certification.certified ? 0 : 2;
          } finally {
            controller.dispose();
          }
        } finally {
          await profileLock.release();
        }
      }

      case 'online':
      case 'serve':
        throw new Error(
          'Unlimited online mode is disabled. Use jobs, claim --pool/--units, or claim --claim.',
        );

      case 'jobs': {
        const flags = parseFlags(
          commandArgs,
          ['allow-webhooks', 'json'],
          ['agent', 'adapter', 'model', 'allow-model', 'concurrency'],
        );
        const json = flags.booleans.has('json');
        if (json) runnerJsonAction = 'tasks.list';
        const profile = parseExecutionProfile(flags);
        const token = await requireToken(tokenStore);
        const profileLock = await profileLocks.acquire(
          communityProfileLockKey(profile.agent, profile.model),
        );
        const api = apiFactory(server, token);
        let prepared: PreparedNode | undefined;
        try {
          prepared = await prepareNode(api, profile, flags.booleans.has('allow-webhooks'));
          const result = await api.listJobs(prepared.node.nodeId);
          if (json) {
            emitRunnerJson(output, 'tasks.list', {
              tasks: result.jobs,
              generatedAt: result.generatedAt,
              claimMode: 'manual_bounded_only',
              next: 'Choose a task id, then run claim --pool <id> --units <N> with the same exact agent/model.',
            });
            return 0;
          }
          if (!result.jobs.length) {
            output.log(`No claimable Pools for ${profile.agent}/${profile.model} right now.`);
          }
          for (const job of result.jobs) {
            output.log(
              `${job.id}  ${terminalText(job.title, 160)}  ${job.availableUnits} Unit${job.availableUnits === 1 ? '' : 's'} × ${job.rewardPerUnit} Credits  ${job.deliveryMode}`,
            );
            output.log(`  ${terminalText(job.publicSummary, 500)}`);
            output.log(
              `  ${job.acceptanceMode}  ${job.deliveryFormat}/${job.deliveryMaxBytes} bytes max  ${job.maxUnitSeconds}s/Unit  ${job.maxAttempts} attempts${job.pilot ? '  PILOT' : ''}`,
            );
            if (job.callbackHost) {
              output.log(`  callback host ${terminalText(job.callbackHost, 160)}`);
            }
          }
          return 0;
        } finally {
          if (prepared) await api.disconnect(prepared.node.nodeId).catch(() => undefined);
          await profileLock.release();
        }
      }

      case 'pick': {
        if (!interactive.isTTY) {
          throw new Error(
            'pick requires an interactive TTY. Use agentpool jobs, then agentpool claim --pool/--units.',
          );
        }
        const flags = parseFlags(
          commandArgs,
          ['allow-webhooks'],
          ['agent', 'adapter', 'model', 'allow-model', 'concurrency', 'poll-interval'],
        );
        const profile = parseExecutionProfile(flags);
        const pollIntervalMs = parseInteger(
          optionOne(flags, 'poll-interval') ?? '3000',
          'poll-interval',
          3_000,
          60_000,
        );
        const token = await requireToken(tokenStore);
        const api = apiFactory(server, token);
        const profileLock = await profileLocks.acquire(
          communityProfileLockKey(profile.agent, profile.model),
        );
        const controller = createInterruptController();
        const logger = createLogger(output);
        const allowWebhooks = flags.booleans.has('allow-webhooks');
        let prepared: PreparedNode | undefined;
        let claim: RunnerClaim | undefined;
        let createdByCli = false;
        let claimOperation: IdempotencyOperation | undefined;
        try {
          prepared = await prepareNode(api, profile, allowWebhooks);
          if (controller.signal.aborted) throw new Error('Claim run interrupted.');
          const { jobs } = await api.listJobs(prepared.node.nodeId);
          if (!jobs.length) {
            output.log(`No claimable Pools for ${profile.agent}/${profile.model} right now.`);
            return 0;
          }
          output.log(`Claimable Pools for ${profile.agent}/${profile.model}:`);
          for (const [index, job] of jobs.entries()) {
            output.log(
              `${index + 1}) ${terminalText(job.title, 160)}  ·  ${job.rewardPerUnit} Credits/Unit  ·  ${job.availableUnits} available`,
            );
            output.log(
              `   ${terminalText(job.publicSummary, 500)}  ·  deadline ${job.claimableUntil}  ·  ${job.deliveryMode}${job.callbackHost ? ` → ${terminalText(job.callbackHost, 160)}` : ''}`,
            );
            output.log(
              `   contract ${job.acceptanceMode}  ·  ${job.deliveryFormat}/${job.deliveryMaxBytes} bytes max  ·  ${job.maxUnitSeconds}s/Unit  ·  ${job.maxAttempts} attempts${job.pilot ? '  ·  PILOT' : ''}`,
            );
          }
          const selectedNumber = await chooseNumber(
            interactive,
            output,
            `Select a Pool [1-${jobs.length}] or q to quit: `,
            jobs.length,
            controller.signal,
          );
          if (selectedNumber === null) {
            output.log('No Claim created.');
            return 0;
          }
          const job = jobs[selectedNumber - 1];
          if (!job) throw new Error('Selected Pool is no longer available.');
          const units = await chooseNumber(
            interactive,
            output,
            `Units for this bounded Claim [1-${job.availableUnits}] or q to quit: `,
            job.availableUnits,
            controller.signal,
          );
          if (units === null) {
            output.log('No Claim created.');
            return 0;
          }
          output.log('Confirm bounded Claim:');
          output.log(`  Pool UUID: ${job.id}`);
          output.log(`  Title: ${terminalText(job.title, 160)}`);
          output.log(
            `  Exact agent/model: ${terminalText(job.requestedAgent, 40)}/${terminalText(job.requestedModel, 120)}`,
          );
          output.log(`  Reward: ${job.rewardPerUnit} Credits/Unit`);
          output.log(`  Delivery: ${job.deliveryMode}`);
          if (job.callbackHost)
            output.log(`  Callback host: ${terminalText(job.callbackHost, 160)}`);
          output.log(`  Acceptance: ${job.acceptanceMode}`);
          output.log(`  Output: ${job.deliveryFormat}, max ${job.deliveryMaxBytes} bytes`);
          output.log(
            `  Runtime / retries: ${job.maxUnitSeconds}s per Unit / ${job.maxAttempts} attempts`,
          );
          output.log(`  Phase: ${job.pilot ? 'pilot' : 'full batch'}`);
          output.log(`  Units: ${units}`);
          output.log(
            '  Notice: title and summary are publisher-provided; the sealed Task Capsule and Unit input are revealed only after this bounded Claim.',
          );
          if (job.acceptanceMode === 'manual' || job.acceptanceMode === 'webhook') {
            output.log(
              '  Notice: the publisher or callback can reject delivery under the stated contract.',
            );
          }
          const confirmation = (
            await askInteractive(
              interactive,
              'Type yes to create this Claim and run it now [y/N]: ',
              controller.signal,
            )
          )
            .trim()
            .toLowerCase();
          if (confirmation !== 'y' && confirmation !== 'yes') {
            output.log('No Claim created.');
            return 0;
          }
          if (controller.signal.aborted) throw new Error('Claim run interrupted.');
          await api.heartbeat(prepared.node.nodeId, 0);
          if (controller.signal.aborted) throw new Error('Claim run interrupted.');
          const claimInput = {
            nodeId: prepared.node.nodeId,
            poolId: job.id,
            maxUnits: units,
          } satisfies CreateRunnerClaimInput;
          const claimStore = getClaimIdempotencyStore();
          claimOperation = await claimStore.begin('runner.claims.create', {
            method: 'POST',
            route: '/api/runner/claims',
            body: claimInput,
          });
          try {
            claim = (await createClaimWithMetadata(api, claimInput, claimOperation.key)).claim;
          } catch (error) {
            if (isDefinitiveRunnerError(error)) await claimStore.complete(claimOperation);
            throw error;
          }
          createdByCli = true;
          if (controller.signal.aborted) throw new Error('Claim run interrupted.');
          output.log(
            `Bounded Claim ${claim.id} created for ${units} Unit${units === 1 ? '' : 's'}.`,
          );
          const runner = new RunnerService({
            api,
            adapter: prepared.adapter,
            models: [claim.requestedModel],
            requestedConcurrency: profile.concurrency,
            claimId: claim.id,
            expectedNodeId: claim.nodeId,
            signal: controller.signal,
            logger,
            clientVersion: RUNNER_VERSION,
            pollIntervalMs,
            allowWebhooks,
          });
          await runner.run();
          if (controller.signal.aborted) throw new Error('Claim run interrupted.');
          if (claimOperation) await claimStore.complete(claimOperation).catch(() => undefined);
          return 0;
        } catch (error) {
          if (createdByCli && claim?.status === 'active') {
            await api.cancelClaim(claim.id).catch(() => undefined);
          }
          if (claimOperation && createdByCli) {
            await getClaimIdempotencyStore()
              .complete(claimOperation)
              .catch(() => undefined);
          }
          throw error;
        } finally {
          if (prepared) await api.disconnect(prepared.node.nodeId).catch(() => undefined);
          controller.dispose();
          await profileLock.release();
        }
      }

      case 'claim':
      case 'once': {
        const flags = parseFlags(
          commandArgs,
          ['allow-webhooks', 'json'],
          [
            'agent',
            'adapter',
            'allow-model',
            'model',
            'concurrency',
            'poll-interval',
            'pool',
            'units',
            'claim',
            'expires-at',
            'idempotency-key',
          ],
        );
        const json = flags.booleans.has('json');
        if (json) runnerJsonAction = 'claims.run';
        const existingClaimId = optionOne(flags, 'claim');
        const poolId = optionOne(flags, 'pool');
        if ((existingClaimId ? 1 : 0) + (poolId ? 1 : 0) !== 1) {
          throw new Error('Select exactly one of --pool or --claim.');
        }
        if (existingClaimId) requireUuid(existingClaimId, 'claim');
        if (poolId) requireUuid(poolId, 'pool');
        if (command === 'once' && !poolId) {
          throw new Error('once requires --pool; use claim --claim to resume an existing Claim.');
        }
        if (command === 'once' && optionOne(flags, 'units')) {
          throw new Error('once always claims exactly one Unit; remove --units.');
        }
        const concurrency = parseInteger(
          optionOne(flags, 'concurrency') ?? '1',
          'concurrency',
          1,
          64,
        );
        const pollIntervalMs = parseInteger(
          optionOne(flags, 'poll-interval') ?? '3000',
          'poll-interval',
          3_000,
          60_000,
        );
        const units = command === 'once' ? 1 : parseUnits(optionOne(flags, 'units'), !!poolId);
        const expiresAt = parseOptionalDate(optionOne(flags, 'expires-at'));
        if (existingClaimId && expiresAt) {
          throw new Error('--expires-at is only valid when creating a Claim with --pool.');
        }
        if (existingClaimId && optionOne(flags, 'idempotency-key')) {
          throw new Error('--idempotency-key is only valid when creating a Claim with --pool.');
        }
        const token = await requireToken(tokenStore);
        const controller = createInterruptController();
        const logger = json ? silentLogger() : createLogger(output);
        const api = apiFactory(server, token);
        const allowWebhooks = flags.booleans.has('allow-webhooks');
        let prepared: PreparedNode | undefined;
        let claim: RunnerClaim | undefined;
        let profileLock: RunnerProfileLock | undefined;
        let createdByCli = false;
        let claimOperation: IdempotencyOperation | undefined;
        let claimRequestId: string | undefined;
        let claimReplayed = false;
        try {
          if (poolId) {
            const profile = parseExecutionProfile(flags, concurrency);
            profileLock = await profileLocks.acquire(
              communityProfileLockKey(profile.agent, profile.model),
            );
            prepared = await prepareNode(api, profile, allowWebhooks);
            if (controller.signal.aborted) throw new Error('Claim run interrupted.');
            const claimInput = {
              nodeId: prepared.node.nodeId,
              poolId,
              maxUnits: units,
              ...(expiresAt ? { expiresAt } : {}),
            } satisfies CreateRunnerClaimInput;
            const claimStore = getClaimIdempotencyStore();
            claimOperation = await claimStore.begin(
              'runner.claims.create',
              { method: 'POST', route: '/api/runner/claims', body: claimInput },
              optionOne(flags, 'idempotency-key'),
            );
            if (!claimOperation.recovered) {
              try {
                const jobs = await api.listJobs(prepared.node.nodeId);
                const job = jobs.jobs.find((candidate) => candidate.id === poolId);
                if (!job) {
                  throw new Error(
                    `Pool is not claimable by this exact ${profile.agent}/${profile.model} Runner node.`,
                  );
                }
                if (job.deliveryMode === 'webhook' && !allowWebhooks) {
                  throw new Error('This Pool uses direct Webhook delivery. Add --allow-webhooks.');
                }
                if (units > job.availableUnits) {
                  throw new Error(
                    `--units exceeds the ${job.availableUnits} currently available Units.`,
                  );
                }
              } catch (error) {
                await claimStore.complete(claimOperation);
                throw error;
              }
            }
            if (controller.signal.aborted) throw new Error('Claim run interrupted.');
            try {
              const created = await createClaimWithMetadata(api, claimInput, claimOperation.key);
              claim = created.claim;
              claimRequestId = created.requestId;
              claimReplayed = created.idempotencyReplayed;
            } catch (error) {
              if (isDefinitiveRunnerError(error)) await claimStore.complete(claimOperation);
              throw error;
            }
            createdByCli = true;
            if (claim.deliveryMode === 'webhook' && !allowWebhooks) {
              await api.cancelClaim(claim.id).catch(() => undefined);
              await claimStore.complete(claimOperation).catch(() => undefined);
              throw new Error(
                'The recovered Claim uses direct Webhook delivery; rerun with --allow-webhooks.',
              );
            }
            if (controller.signal.aborted) throw new Error('Claim run interrupted.');
            if (!json) {
              output.log(
                `Bounded Claim ${claim.id} created for ${units} Unit${units === 1 ? '' : 's'}.`,
              );
            }
          } else {
            claim = await api.getClaim(existingClaimId!);
            if (claim.status !== 'active' || claim.remainingUnits < 1) {
              throw new Error(`Claim ${claim.id} is ${claim.status} and cannot be resumed.`);
            }
            if (claim.deliveryMode === 'webhook' && !allowWebhooks) {
              throw new Error('This Claim uses direct Webhook delivery. Add --allow-webhooks.');
            }
            rejectProfileFlagsWhenResuming(flags);
            profileLock = await profileLocks.acquire(
              communityProfileLockKey(claim.requestedAgent, claim.requestedModel),
            );
            prepared = await prepareNode(
              api,
              {
                agent: claim.requestedAgent,
                model: claim.requestedModel,
                concurrency,
              },
              allowWebhooks,
            );
            if (prepared.node.nodeId !== claim.nodeId) {
              throw new Error(
                'This Claim belongs to a different Runner node. Revoke it and create a new Claim on this node.',
              );
            }
          }

          const runner = new RunnerService({
            api,
            adapter: prepared.adapter,
            models: [claim.requestedModel],
            requestedConcurrency: concurrency,
            claimId: claim.id,
            expectedNodeId: claim.nodeId,
            signal: controller.signal,
            logger,
            clientVersion: RUNNER_VERSION,
            pollIntervalMs,
            allowWebhooks,
          });
          await runner.run();
          if (controller.signal.aborted) throw new Error('Claim run interrupted.');
          if (json) {
            const finalClaim = await api.getClaim(claim.id).catch(() => claim!);
            emitRunnerJson(
              output,
              'claims.run',
              { claim: finalClaim, execution: 'finished' },
              {
                ...(claimRequestId ? { requestId: claimRequestId } : {}),
                ...(claimOperation
                  ? {
                      idempotencyKey: claimOperation.key,
                      idempotencyReplayed: claimReplayed,
                    }
                  : {}),
              },
            );
          }
          if (claimOperation) {
            await getClaimIdempotencyStore()
              .complete(claimOperation)
              .catch(() => undefined);
          }
          return 0;
        } catch (error) {
          if (createdByCli && claim?.status === 'active') {
            await api.cancelClaim(claim.id).catch(() => undefined);
          }
          if (claimOperation && createdByCli) {
            await getClaimIdempotencyStore()
              .complete(claimOperation)
              .catch(() => undefined);
          }
          throw error;
        } finally {
          if (prepared) await api.disconnect(prepared.node.nodeId).catch(() => undefined);
          controller.dispose();
          if (profileLock) await profileLock.release();
        }
      }

      case 'cancel': {
        const flags = parseFlags(commandArgs, ['json'], ['claim']);
        const json = flags.booleans.has('json');
        if (json) runnerJsonAction = 'claims.cancel';
        const claimId = requireOne(flags, 'claim');
        requireUuid(claimId, 'claim');
        const token = await requireToken(tokenStore);
        const claim = await apiFactory(server, token).cancelClaim(claimId);
        if (json) {
          emitRunnerJson(output, 'claims.cancel', { claim });
          return 0;
        }
        output.log(`Claim ${claim.id} is ${claim.status}; remaining reservation released.`);
        return 0;
      }

      case 'status': {
        const flags = parseFlags(commandArgs, ['json'], []);
        const json = flags.booleans.has('json');
        if (json) runnerJsonAction = 'runner.status';
        const token = await tokenStore.read();
        if (!token) {
          if (json) {
            emitRunnerJson(output, 'runner.status', {
              authenticated: false,
              server,
              privacy: runnerPrivacySummary(),
            });
            return 0;
          }
          output.log('Platform: signed out');
        } else {
          const api = apiFactory(server, token);
          const status = await api.getStatus();
          const capacities = await api.listCapacities().catch(() => []);
          const claims = await api.listClaims().catch(() => []);
          if (json) {
            emitRunnerJson(output, 'runner.status', {
              authenticated: true,
              server,
              status,
              capacities,
              claims,
              privacy: runnerPrivacySummary(),
            });
            return 0;
          }
          output.log(`Platform: connected to ${server}`);
          if (status.user?.displayName) output.log(`Account: ${status.user.displayName}`);
          if (status.wallet) {
            output.log(
              `Earned: available ${status.wallet.earnedAvailable ?? 0}, pending ${status.wallet.earnedPending ?? 0}`,
            );
          }
          output.log(`Active nodes: ${status.activeNodes ?? status.nodes?.length ?? 0}`);
          for (const capacity of capacities) {
            output.log(
              `Certified ${capacity.adapter}/${capacity.model}: concurrency ${capacity.certifiedConcurrency}, expires ${capacity.expiresAt}`,
            );
          }
          for (const claim of claims) {
            output.log(
              `Claim ${claim.id}: ${claim.status}, ${claim.remainingUnits}/${claim.maxUnits} remaining, ${claim.requestedAgent}/${claim.requestedModel}`,
            );
          }
        }
        output.log(
          'Privacy: fresh nonpersistent sessions hide task contents from normal CLI/UI output. A host owner or administrator can still inspect local processes; model identity is not cryptographically attested on ordinary hosts.',
        );
        return 0;
      }

      case 'logout': {
        parseFlags(commandArgs, [], []);
        const token = await tokenStore.read();
        if (!token) {
          output.log('Already signed out.');
          return 0;
        }
        await apiFactory(server, token).revokeCredential();
        await tokenStore.clear();
        output.log('Agent Pool session revoked and local token removed.');
        return 0;
      }

      default:
        throw new Error('Unknown command. Run agentpool help for supported commands.');
    }
  } catch (error) {
    if (rawControlArgs) {
      return emitControlBootstrapFailure(
        rawControlArgs,
        output,
        error instanceof GlobalOptionError ? error.code : 'INVALID_GLOBAL_OPTION',
      );
    }
    if (runnerJsonAction) {
      emitRunnerJsonError(output, runnerJsonAction, error);
      return 1;
    }
    output.error(redactRunnerText(error instanceof Error ? error.message : 'Runner failed.'));
    return 1;
  }
}

const RUNNER_PROTOCOL = 'agentpool-runner/1' as const;

function emitRunnerJson(
  output: Output,
  action: string,
  data: unknown,
  meta?: Record<string, unknown>,
): void {
  output.log(
    JSON.stringify({
      protocol: RUNNER_PROTOCOL,
      ok: true,
      action,
      data,
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    }),
  );
}

function emitRunnerJsonError(output: Output, action: string, error: unknown): void {
  const message = redactRunnerText(
    error instanceof Error ? error.message : 'Runner command failed.',
  );
  const apiError = error instanceof ApiError ? error : undefined;
  const transportError = error instanceof RunnerTransportError ? error : undefined;
  output.log(
    JSON.stringify({
      protocol: RUNNER_PROTOCOL,
      ok: false,
      action,
      error: {
        code: runnerErrorCode(error),
        message,
        retryable:
          transportError !== undefined ||
          (apiError?.metadata.retryable ?? retryableRunnerStatus(apiError?.status)),
      },
      ...(apiError || transportError
        ? {
            meta: {
              ...(apiError ? { httpStatus: apiError.status } : {}),
              ...(apiError?.metadata.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: apiError.metadata.retryAfterMs }),
              ...((apiError?.metadata.requestId ?? transportError?.requestId)
                ? { requestId: apiError?.metadata.requestId ?? transportError?.requestId }
                : {}),
            },
          }
        : {}),
    }),
  );
}

function runnerErrorCode(error: unknown): string {
  if (error instanceof AmbiguousOperationExpiredError) return error.code;
  if (error instanceof RunnerTransportError) return error.code;
  if (error instanceof ApiError) return error.metadata.code ?? `HTTP_${error.status}`;
  if (error instanceof Error && error.message.includes('login')) return 'AUTH_REQUIRED';
  if (error instanceof Error && error.message.includes('UUID')) return 'INVALID_ID';
  if (error instanceof Error && error.message.includes('required')) return 'MISSING_OPTION';
  return 'RUNNER_COMMAND_FAILED';
}

function retryableRunnerStatus(status: number | undefined): boolean {
  return (
    status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)
  );
}

function detectRunnerJsonAction(argv: readonly string[]): string | undefined {
  if (!argv.some((value) => value === '--json' || value === '--json=true')) return undefined;
  const filtered: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--server') {
      index += 1;
      continue;
    }
    if (value?.startsWith('--server=')) continue;
    if (value !== undefined) filtered.push(value);
  }
  const command = filtered[0];
  if (command === 'agents') return 'agents.list';
  if (command === 'help' || command === '--help' || command === '-h') return 'help';
  if (command === 'jobs') return 'tasks.list';
  if (command === 'claim' || command === 'once') return 'claims.run';
  if (command === 'cancel') return 'claims.cancel';
  if (command === 'status') return 'runner.status';
  return 'runner';
}

function redactRunnerText(value: string): string {
  return value
    .replace(
      /\bap_(?:control(?:_device)?|runner|device)_[A-Za-z0-9._~+/=-]+/giu,
      '[REDACTED_TOKEN]',
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1[REDACTED]@');
}

function runnerPrivacySummary(): Record<string, unknown> {
  return {
    taskContentPrinted: false,
    taskOutputPrinted: false,
    sessionPersistence: false,
    hostConfidentiality: 'operational_not_cryptographic',
  };
}

function extractGlobalServer(argv: readonly string[]): { server?: string; argv: string[] } {
  let server: string | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--server') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new GlobalOptionError('MISSING_SERVER_VALUE', '--server requires a URL.');
      }
      server = next;
      index += 1;
    } else if (value?.startsWith('--server=')) {
      const inline = value.slice('--server='.length);
      if (!inline) {
        throw new GlobalOptionError('MISSING_SERVER_VALUE', '--server requires a URL.');
      }
      server = inline;
    } else if (value !== undefined) {
      remaining.push(value);
    }
  }
  return { server, argv: remaining };
}

class GlobalOptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GlobalOptionError';
  }
}

function controlArgumentsFromRawArgv(argv: readonly string[]): readonly string[] | null {
  const controlIndex = argv.indexOf('control');
  if (controlIndex < 0) return null;
  const prefix = argv.slice(0, controlIndex);
  for (let index = 0; index < prefix.length; index += 1) {
    const value = prefix[index];
    if (value === '--server') {
      index += 1;
      continue;
    }
    if (value?.startsWith('--server=')) continue;
    return null;
  }
  return argv.slice(controlIndex + 1);
}

function parseFlags(
  argv: readonly string[],
  booleanNames: readonly string[],
  valueNames: readonly string[],
): ParsedFlags {
  const booleans = new Set<string>();
  const values = new Map<string, string[]>();
  const booleansAllowed = new Set(booleanNames);
  const valuesAllowed = new Set(valueNames);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith('--')) {
      throw new Error(`Unexpected positional argument at position ${index + 1}.`);
    }
    const separator = argument.indexOf('=');
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (booleansAllowed.has(name)) {
      if (separator !== -1) throw new Error(`--${name} does not accept a value.`);
      booleans.add(name);
      continue;
    }
    if (!valuesAllowed.has(name)) throw new Error(`Unknown option at position ${index + 1}.`);
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value.`);
    const entries = values.get(name) ?? [];
    entries.push(value);
    values.set(name, entries);
  }
  return { values, booleans };
}

function optionOne(flags: ParsedFlags, name: string): string | undefined {
  const values = flags.values.get(name);
  if (!values?.length) return undefined;
  if (values.length > 1) {
    throw new Error(`--${name} may only be specified once.`);
  }
  return values[values.length - 1];
}

function requireOne(flags: ParsedFlags, name: string): string {
  const value = optionOne(flags, name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

interface ExecutionProfile {
  agent: AgentAdapter;
  model: string;
  concurrency: number;
}

interface PreparedNode {
  adapter: AgentAdapterDriver;
  node: NodeRegistration;
}

function parseExecutionProfile(flags: ParsedFlags, concurrencyOverride?: number): ExecutionProfile {
  const explicitAgent = optionOne(flags, 'agent');
  const adapterAlias = optionOne(flags, 'adapter');
  if (explicitAgent && adapterAlias && explicitAgent !== adapterAlias) {
    throw new Error('--agent and --adapter cannot select different adapters.');
  }
  const agentValue = explicitAgent ?? adapterAlias;
  if (!agentValue) throw new Error('An explicit --agent is required.');
  const models = normalizeAllowedModels([
    ...(flags.values.get('allow-model') ?? []),
    ...(flags.values.get('model') ?? []),
  ]);
  if (models.length !== 1) {
    throw new Error('Select exactly one model for a bounded Claim.');
  }
  return {
    agent: parseAgent(agentValue),
    model: models[0]!,
    concurrency:
      concurrencyOverride ??
      parseInteger(optionOne(flags, 'concurrency') ?? '1', 'concurrency', 1, 64),
  };
}

async function prepareNode(
  api: AgentPoolApiClient,
  profile: ExecutionProfile,
  allowWebhooks: boolean,
): Promise<PreparedNode> {
  const adapter = createAdapter(profile.agent);
  const detection = await adapter.detect();
  if (!detection.available || !detection.authenticated) {
    throw new Error(`${profile.agent} is not installed and authenticated.`);
  }
  const node = await api.registerNode({
    adapter: profile.agent,
    models: [profile.model],
    concurrency: profile.concurrency,
    adapterVersion: detection.version,
    clientVersion: RUNNER_VERSION,
    platform: process.platform,
    arch: process.arch,
    supportsDirectWebhooks: allowWebhooks,
  });
  try {
    await resolveCertifiedConcurrency({
      api,
      adapter: profile.agent,
      models: [profile.model],
      requestedConcurrency: profile.concurrency,
      nodeId: node.nodeId,
    });
    return { adapter, node };
  } catch (error) {
    await api.disconnect(node.nodeId).catch(() => undefined);
    throw error;
  }
}

function rejectProfileFlagsWhenResuming(flags: ParsedFlags): void {
  for (const name of ['agent', 'adapter', 'model', 'allow-model', 'units'] as const) {
    if (flags.values.has(name)) {
      throw new Error(`--${name} cannot override an existing Claim.`);
    }
  }
}

function parseUnits(value: string | undefined, required: boolean): number {
  if (!value) {
    if (required) throw new Error('--units is required with --pool.');
    return 1;
  }
  return parseInteger(value, 'units', 1, 20_000);
}

function parseOptionalDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error('--expires-at must be a future ISO 8601 date-time.');
  }
  return new Date(timestamp).toISOString();
}

function requireUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`--${name} must be a UUID.`);
  }
}

function parseAgent(value: string): AgentAdapter {
  if (value !== 'codex' && value !== 'claude' && value !== 'mock') {
    throw new Error('--agent must be codex, claude, or mock.');
  }
  return value;
}

function parseInteger(value: string, name: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

async function requireToken(tokenStore: TokenStore): Promise<string> {
  const token = await tokenStore.read();
  if (!token) throw new Error('Not signed in. Run agentpool login first.');
  return token;
}

function createLogger(output: Output): Logger {
  return {
    info: (message) => output.log(message),
    warn: (message) => output.log(message),
    error: (message) => output.error(message),
  };
}

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

async function createClaimWithMetadata(
  api: AgentPoolApiClient,
  input: CreateRunnerClaimInput,
  idempotencyKey: string,
): Promise<{
  claim: RunnerClaim;
  requestId?: string;
  idempotencyReplayed: boolean;
}> {
  // Structural fakes from older embedders can still exercise the CLI; the
  // packaged client always takes the idempotent metadata path.
  const candidate = api as AgentPoolApiClient & {
    createClaimRequest?: AgentPoolApiClient['createClaimRequest'];
  };
  if (typeof candidate.createClaimRequest === 'function') {
    return candidate.createClaimRequest(input, idempotencyKey);
  }
  return { claim: await api.createClaim(input), idempotencyReplayed: false };
}

function isDefinitiveRunnerError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return !(error.metadata.retryable ?? retryableRunnerStatus(error.status));
}

function isRetryableRunnerError(error: unknown): boolean {
  return (
    error instanceof RunnerTransportError ||
    (error instanceof ApiError && (error.metadata.retryable ?? retryableRunnerStatus(error.status)))
  );
}

function createInterruptController(): AbortController & { dispose(): void } {
  const controller = new AbortController() as AbortController & { dispose(): void };
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  controller.dispose = () => {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  };
  return controller;
}

function defaultInteractiveInput(): InteractiveInput {
  return {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    question: async (prompt, signal) => {
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      const local = new AbortController();
      const abortLocal = (): void => local.abort();
      reader.once('SIGINT', abortLocal);
      if (signal?.aborted) local.abort();
      else signal?.addEventListener('abort', abortLocal, { once: true });
      try {
        return await reader.question(prompt, { signal: local.signal });
      } finally {
        reader.removeListener('SIGINT', abortLocal);
        signal?.removeEventListener('abort', abortLocal);
        reader.close();
      }
    },
  };
}

async function chooseNumber(
  interactive: InteractiveInput,
  output: Output,
  prompt: string,
  maximum: number,
  signal: AbortSignal,
): Promise<number | null> {
  for (;;) {
    const answer = (await askInteractive(interactive, prompt, signal)).trim().toLowerCase();
    if (answer === 'q' || answer === 'quit') return null;
    const value = Number(answer);
    if (Number.isSafeInteger(value) && value >= 1 && value <= maximum) return value;
    output.log(`Enter a whole number from 1 to ${maximum}, or q to quit.`);
  }
}

async function askInteractive(
  interactive: InteractiveInput,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await interactive.question(prompt, signal);
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted'))
    ) {
      throw new Error('Claim selection interrupted.');
    }
    throw error;
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function formatPercent(value: number): string {
  const percent = value <= 1 ? value * 100 : value;
  return `${percent.toFixed(1)}%`;
}

function terminalText(value: string, maxLength: number): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b[ -/]*[@-~]/gu, '')
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu,
      ' ',
    )
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}
