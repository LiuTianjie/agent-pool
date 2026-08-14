import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';

import { DEFAULT_SERVER } from '../../runner/src/api-client.js';
import { openBrowser } from '../../runner/src/browser.js';
import {
  officialCellProfileLockKey,
  profileLockManagerForTokenStore,
  type RunnerProfileLock,
  type RunnerProfileLockManager,
} from '../../runner/src/profile-lock.js';
import { TokenStore } from '../../runner/src/token-store.js';
import type { CreateRunnerClaimInput, RunnerJob } from '../../runner/src/types.js';
import {
  ControlIdempotencyStore,
  type IdempotencyOperation,
} from '../../runner/src/control-idempotency-store.js';
import { ApiError, RunnerTransportError } from '../../runner/src/api-client.js';

import {
  OfficialAmbiguousResponseError,
  OfficialFleetApiClient,
  type OfficialClaim,
} from './api-client.js';
import { loadFleetConfig } from './config.js';
import {
  benchmarkCell,
  findCellForClaim,
  prepareCellNode,
  requireStandby,
  runBoundedClaim,
  type PreparedCellNode,
} from './fleet-service.js';
import type { FleetLogger } from './types.js';

export const OFFICIAL_FLEET_VERSION = '0.1.0';
export const OFFICIAL_FLEET_CLIENT = `agentpool-official-fleet/${OFFICIAL_FLEET_VERSION}`;
const OFFICIAL_RUNNER_PROTOCOL = 'agentpool-official/1' as const;

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

interface PickEntry {
  job: RunnerJob;
  prepared: PreparedCellNode;
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
    if (explicitKey) {
      // Delegate validation to the durable helper only when it is available;
      // test doubles do not have a filesystem-backed token store.
      if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(explicitKey)) {
        throw new Error('Idempotency key must be 8-128 safe characters.');
      }
      return {
        fingerprint: `${action}:${request.route}`,
        key: explicitKey,
        automatic: false,
        recovered: true,
      };
    }
    const fingerprint = `${action}:${request.method}:${request.route}:${JSON.stringify(request.body ?? null)}`;
    const current = this.entries.get(fingerprint);
    if (current) return current;
    const operation = {
      fingerprint,
      key: `apofficial-${randomUUID()}`,
      automatic: true,
      recovered: false,
    };
    this.entries.set(fingerprint, operation);
    return operation;
  }

  async complete(operation: IdempotencyOperation): Promise<void> {
    if (operation.automatic && this.entries.get(operation.fingerprint)?.key === operation.key) {
      this.entries.delete(operation.fingerprint);
    }
  }
}

export interface CliDependencies {
  output?: Output;
  environment?: NodeJS.ProcessEnv;
  tokenStore?: TokenStore;
  apiFactory?: (server: string, token?: string) => OfficialFleetApiClient;
  browserOpener?: (url: string) => boolean;
  interactive?: InteractiveInput;
  profileLocks?: RunnerProfileLockManager;
  claimIdempotencyStore?: ClaimIdempotencyStore;
}

const HELP = `Agent Pool Official Fleet ${OFFICIAL_FLEET_VERSION}

Usage:
  agentpool-official login [--no-browser] [--server URL]
  agentpool-official jobs --json [--config FILE]
  agentpool-official claim --pool <uuid> --units N [--config FILE] [--idempotency-key KEY] [--json]
  agentpool-official claim --claim <uuid> [--config FILE] [--json]
  agentpool-official pick [--config FILE]
  agentpool-official once --pool <uuid> [--config FILE] [--idempotency-key KEY] [--json]
  agentpool-official cancel --claim <uuid> [--json]
  agentpool-official benchmark --cell <id> [--concurrency N] [--config FILE]
  agentpool-official status [--config FILE] [--json]
  agentpool-official logout

claim is intentionally bounded: it executes only the selected Pool and exits after the
grant is exhausted, expired, revoked, interrupted, or the Fleet is taken offline. There
is no unlimited online mode and no background marketplace scan.

Configuration defaults to ./official-fleet.config.json. AGENTPOOL_OFFICIAL_CONFIG,
AGENTPOOL_SERVER, and AGENTPOOL_OFFICIAL_STATE_DIR override their respective defaults.`;

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? console;
  let officialJsonAction = detectOfficialJsonAction(argv);

  try {
    const environment = dependencies.environment ?? process.env;
    const tokenStore =
      dependencies.tokenStore ??
      new TokenStore({
        stateDirectory:
          environment.AGENTPOOL_OFFICIAL_STATE_DIR ?? join(homedir(), '.agentpool-official-fleet'),
      });
    const parsedGlobal = extractGlobals(argv);
    const server = parsedGlobal.server ?? environment.AGENTPOOL_SERVER ?? DEFAULT_SERVER;
    const configPath =
      parsedGlobal.config ?? environment.AGENTPOOL_OFFICIAL_CONFIG ?? 'official-fleet.config.json';
    const apiFactory =
      dependencies.apiFactory ??
      ((targetServer: string, token?: string) =>
        new OfficialFleetApiClient({
          server: targetServer,
          token,
          clientVersion: OFFICIAL_FLEET_CLIENT,
        }));
    const browserOpener = dependencies.browserOpener ?? openBrowser;
    const interactive = dependencies.interactive ?? defaultInteractiveInput();
    const profileLocks =
      dependencies.profileLocks ??
      profileLockManagerForTokenStore(tokenStore, 'agentpool-official-locks');
    let claimIdempotencyStore = dependencies.claimIdempotencyStore;
    const getClaimIdempotencyStore = (): ClaimIdempotencyStore => {
      if (claimIdempotencyStore) return claimIdempotencyStore;
      claimIdempotencyStore =
        typeof (tokenStore as { directory?: unknown }).directory === 'string'
          ? new ControlIdempotencyStore(tokenStore)
          : new MemoryClaimIdempotencyStore();
      return claimIdempotencyStore;
    };
    const [command, ...commandArgs] = parsedGlobal.argv;

    if (!command || command === 'help' || command === '--help' || command === '-h') {
      output.log(HELP);
      return 0;
    }
    if (command === 'version' || command === '--version' || command === '-v') {
      output.log(OFFICIAL_FLEET_VERSION);
      return 0;
    }
    if (command === 'online' || command === 'serve') {
      throw new Error(
        'Unlimited online mode is disabled. Use claim --pool/--units or claim --claim.',
      );
    }

    switch (command) {
      case 'login': {
        const flags = parseFlags(commandArgs, ['no-browser'], []);
        const api = apiFactory(server);
        const device = await api.startDeviceLogin();
        output.log(`Open ${device.verificationUri}`);
        output.log(`Enter code: ${device.userCode}`);
        if (!flags.booleans.has('no-browser')) {
          browserOpener(device.verificationUriComplete ?? device.verificationUri);
        }
        const controller = createInterruptController();
        try {
          const expiresAt = Date.now() + device.expiresIn * 1_000;
          let intervalMs = Math.max(1_000, (device.interval ?? 3) * 1_000);
          while (!controller.signal.aborted && Date.now() < expiresAt) {
            await wait(intervalMs, controller.signal);
            if (controller.signal.aborted) break;
            let result;
            try {
              result = await api.pollDeviceLogin(device.deviceCode);
            } catch (error) {
              // Device codes are valid for a bounded period. A transient
              // transport failure must not force the operator to mint another
              // code (or accidentally run a second login flow).
              if (!(error instanceof ApiError) || isRetryableOfficialError(error)) continue;
              throw error;
            }
            if (result.status === 'approved') {
              await tokenStore.write(result.token);
              output.log('Official Fleet login complete.');
              return 0;
            }
            if (result.status === 'denied') throw new Error('Login was denied.');
            if (result.status === 'expired') throw new Error('Login code expired.');
            if (result.status === 'slow_down') intervalMs += 2_000;
          }
          throw new Error(controller.signal.aborted ? 'Login interrupted.' : 'Login code expired.');
        } finally {
          controller.dispose();
        }
      }

      case 'jobs': {
        const flags = parseFlags(commandArgs, ['json'], []);
        if (!flags.booleans.has('json')) {
          throw new Error('jobs is machine-readable only. Run agentpool-official jobs --json.');
        }
        officialJsonAction = 'tasks.list';
        const token = await requireToken(tokenStore);
        const api = apiFactory(server, token);
        requireStandby(await api.getOfficialFleet());
        const config = await loadFleetConfig(configPath);
        const profileLock = await profileLocks.acquireMany(
          config.cells.map(officialCellProfileLockKey),
        );
        const prepared: PreparedCellNode[] = [];
        try {
          const result: Array<{
            cell: Pick<PreparedCellNode['cell'], 'id' | 'adapter' | 'model'>;
            jobs: RunnerJob[];
            generatedAt: string;
          }> = [];
          for (const cell of config.cells) {
            let node: PreparedCellNode | undefined;
            try {
              node = await prepareCellNode({
                api,
                cell,
                logger: silentLogger(),
                clientVersion: OFFICIAL_FLEET_CLIENT,
              });
              prepared.push(node);
              const listing = await api.listJobs(node.nodeId);
              result.push({
                cell: { id: cell.id, adapter: cell.adapter, model: cell.model },
                jobs: listing.jobs,
                generatedAt: listing.generatedAt,
              });
            } catch (error) {
              // A temporarily unavailable Cell must not make listing another
              // Cell's explicit jobs impossible. Its private CLI output is
              // deliberately not returned to the supervising Agent.
              if (isRetryableOfficialError(error)) continue;
              throw error;
            }
          }
          emitOfficialJson(output, 'tasks.list', {
            cells: result,
            claimMode: 'manual_bounded_only',
            next: 'Choose a pool id, then run claim --pool <id> --units <N> explicitly.',
          });
          return 0;
        } finally {
          await Promise.all(
            prepared.map((node) => api.disconnect(node.nodeId).catch(() => undefined)),
          );
          await profileLock.release();
        }
      }

      case 'pick': {
        if (!interactive.isTTY) {
          throw new Error(
            'pick requires an interactive TTY. Use agentpool-official claim --pool/--units or --claim.',
          );
        }
        parseFlags(commandArgs, [], []);
        const token = await requireToken(tokenStore);
        const api = apiFactory(server, token);
        requireStandby(await api.getOfficialFleet());
        const config = await loadFleetConfig(configPath);
        const profileLock = await profileLocks.acquireMany(
          config.cells.map(officialCellProfileLockKey),
        );
        const logger = createLogger(output);
        const controller = createInterruptController();
        const preparedNodes: PreparedCellNode[] = [];
        const entries: PickEntry[] = [];
        let claim: OfficialClaim | undefined;
        let createdByCli = false;
        try {
          for (const cell of config.cells) {
            if (controller.signal.aborted) {
              throw new Error('Official Fleet Claim selection interrupted.');
            }
            let candidate: PreparedCellNode | undefined;
            let retained = false;
            try {
              candidate = await prepareCellNode({
                api,
                cell,
                logger,
                clientVersion: OFFICIAL_FLEET_CLIENT,
              });
              const { jobs } = await api.listJobs(candidate.nodeId);
              if (jobs.length) {
                retained = true;
                preparedNodes.push(candidate);
                for (const job of jobs) entries.push({ job, prepared: candidate });
              }
            } catch (error) {
              if (controller.signal.aborted) throw error;
              output.log(`Skipped unavailable or uncertified Cell ${terminalText(cell.id, 100)}.`);
            } finally {
              if (candidate && !retained) {
                await api.disconnect(candidate.nodeId).catch(() => undefined);
              }
            }
          }
          if (!entries.length) {
            output.log('No claimable Pools for the configured Official Cells right now.');
            return 0;
          }
          output.log('Claimable Pools for Official Fleet:');
          for (const [index, entry] of entries.entries()) {
            output.log(
              `${index + 1}) ${terminalText(entry.job.title, 160)}  ·  ${entry.job.rewardPerUnit} Credits/Unit  ·  ${entry.job.availableUnits} available`,
            );
            output.log(
              `   ${terminalText(entry.job.publicSummary, 500)}  ·  ${entry.prepared.cell.adapter}/${terminalText(entry.prepared.cell.model, 120)}  ·  deadline ${entry.job.claimableUntil}  ·  ${entry.job.deliveryMode}${entry.job.callbackHost ? ` → ${terminalText(entry.job.callbackHost, 160)}` : ''}`,
            );
            output.log(
              `   contract ${entry.job.acceptanceMode}  ·  ${entry.job.deliveryFormat}/${entry.job.deliveryMaxBytes} bytes max  ·  ${entry.job.maxUnitSeconds}s/Unit  ·  ${entry.job.maxAttempts} attempts${entry.job.pilot ? '  ·  PILOT' : ''}`,
            );
          }
          const selectedNumber = await chooseNumber(
            interactive,
            output,
            `Select a Pool [1-${entries.length}] or q to quit: `,
            entries.length,
            controller.signal,
          );
          if (selectedNumber === null) {
            output.log('No Claim created.');
            return 0;
          }
          const selected = entries[selectedNumber - 1];
          if (!selected) throw new Error('Selected Pool is no longer available.');
          const units = await chooseNumber(
            interactive,
            output,
            `Units for this bounded Claim [1-${selected.job.availableUnits}] or q to quit: `,
            selected.job.availableUnits,
            controller.signal,
          );
          if (units === null) {
            output.log('No Claim created.');
            return 0;
          }
          output.log('Confirm bounded Claim:');
          output.log(`  Pool UUID: ${selected.job.id}`);
          output.log(`  Title: ${terminalText(selected.job.title, 160)}`);
          output.log(
            `  Exact agent/model: ${terminalText(selected.job.requestedAgent, 40)}/${terminalText(selected.job.requestedModel, 120)}`,
          );
          output.log(`  Reward: ${selected.job.rewardPerUnit} Credits/Unit`);
          output.log(`  Delivery: ${selected.job.deliveryMode}`);
          if (selected.job.callbackHost) {
            output.log(`  Callback host: ${terminalText(selected.job.callbackHost, 160)}`);
          }
          output.log(`  Acceptance: ${selected.job.acceptanceMode}`);
          output.log(
            `  Output: ${selected.job.deliveryFormat}, max ${selected.job.deliveryMaxBytes} bytes`,
          );
          output.log(
            `  Runtime / retries: ${selected.job.maxUnitSeconds}s per Unit / ${selected.job.maxAttempts} attempts`,
          );
          output.log(`  Phase: ${selected.job.pilot ? 'pilot' : 'full batch'}`);
          output.log(`  Units: ${units}`);
          output.log(
            '  Notice: title and summary are publisher-provided; the sealed Task Capsule and Unit input are revealed only after this bounded Claim.',
          );
          if (
            selected.job.acceptanceMode === 'manual' ||
            selected.job.acceptanceMode === 'webhook'
          ) {
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
          await api.heartbeat(selected.prepared.nodeId, 0);
          if (controller.signal.aborted) {
            throw new Error('Official Fleet Claim selection interrupted.');
          }
          claim = await api.createClaim({
            nodeId: selected.prepared.nodeId,
            poolId: selected.job.id,
            maxUnits: units,
          });
          createdByCli = true;
          if (controller.signal.aborted) {
            throw new Error('Official Fleet Claim selection interrupted.');
          }
          output.log(
            `Bounded Claim ${claim.id} created for ${units} Unit${units === 1 ? '' : 's'}.`,
          );
          const summary = await runBoundedClaim({
            config,
            api,
            claim,
            signal: controller.signal,
            logger,
            clientVersion: OFFICIAL_FLEET_CLIENT,
          });
          if (summary.terminalStatus === 'offline') {
            await api.cancelClaim(claim.id).catch(() => undefined);
          }
          output.log(`Claim ${summary.claimId} stopped with status ${summary.terminalStatus}.`);
          return 0;
        } catch (error) {
          if (createdByCli && claim) await api.cancelClaim(claim.id).catch(() => undefined);
          throw error;
        } finally {
          await Promise.all(
            preparedNodes.map((prepared) => api.disconnect(prepared.nodeId).catch(() => undefined)),
          );
          controller.dispose();
          await profileLock.release();
        }
      }

      case 'claim':
      case 'once': {
        const flags = parseFlags(
          commandArgs,
          ['json'],
          ['pool', 'units', 'claim', 'expires-at', 'idempotency-key'],
        );
        const json = flags.booleans.has('json');
        if (json) officialJsonAction = 'claims.run';
        const existingClaimId = optionOne(flags, 'claim');
        const poolId = optionOne(flags, 'pool');
        if ((existingClaimId ? 1 : 0) + (poolId ? 1 : 0) !== 1) {
          throw new Error('Select exactly one of --pool or --claim.');
        }
        if (existingClaimId) requireUuid(existingClaimId, 'claim');
        if (poolId) requireUuid(poolId, 'pool');
        if (command === 'once' && existingClaimId) {
          throw new Error('once requires --pool; use claim --claim for an existing grant.');
        }
        if (command === 'once' && optionOne(flags, 'units')) {
          throw new Error('once always claims exactly one Unit; remove --units.');
        }
        if (existingClaimId && optionOne(flags, 'units')) {
          throw new Error('--units cannot override an existing Claim.');
        }
        if (existingClaimId && optionOne(flags, 'idempotency-key')) {
          throw new Error('--idempotency-key is only valid when creating a Claim with --pool.');
        }
        const units = command === 'once' ? 1 : parseUnits(optionOne(flags, 'units'), !!poolId);
        const expiresAt = parseOptionalDate(optionOne(flags, 'expires-at'));
        if (existingClaimId && expiresAt) {
          throw new Error('--expires-at is only valid when creating a Claim with --pool.');
        }
        const token = await requireToken(tokenStore);
        const api = apiFactory(server, token);
        const fleet = await api.getOfficialFleet();
        requireStandby(fleet);
        const config = await loadFleetConfig(configPath);
        const logger = json ? silentLogger() : createLogger(output);
        const controller = createInterruptController();
        let claim: OfficialClaim | undefined;
        let prepared: PreparedCellNode | undefined;
        let profileLock: RunnerProfileLock | undefined;
        let createdByCli = false;
        let claimOperation: IdempotencyOperation | undefined;
        let claimRequestId: string | undefined;
        let claimReplayed = false;
        try {
          if (poolId) {
            profileLock = await profileLocks.acquireMany(
              config.cells.map(officialCellProfileLockKey),
            );
            for (const cell of config.cells) {
              if (controller.signal.aborted)
                throw new Error('Official Fleet claim was interrupted.');
              let candidate: PreparedCellNode | undefined;
              try {
                candidate = await prepareCellNode({
                  api,
                  cell,
                  logger,
                  clientVersion: OFFICIAL_FLEET_CLIENT,
                });
                // Do not preflight with listJobs here. A response can be lost
                // after the platform reserved the Pool, at which point a list
                // would no longer contain it and make its Idempotency-Key
                // impossible to replay. The authoritative create endpoint
                // validates availability and exact Cell capability atomically.
                await api.heartbeat(candidate.nodeId, 0);
                const claimInput = {
                  nodeId: candidate.nodeId,
                  poolId,
                  maxUnits: units,
                  ...(expiresAt ? { expiresAt } : {}),
                } satisfies CreateRunnerClaimInput;
                const claimStore = getClaimIdempotencyStore();
                const operation = await claimStore.begin(
                  'official.runner.claims.create',
                  { method: 'POST', route: '/api/runner/claims', body: claimInput },
                  optionOne(flags, 'idempotency-key'),
                );
                try {
                  const created = await createClaimWithMetadata(api, claimInput, operation.key);
                  claim = created.claim;
                  claimOperation = operation;
                  claimRequestId = created.requestId;
                  claimReplayed = created.idempotencyReplayed;
                  prepared = candidate;
                  candidate = undefined;
                  break;
                } catch (error) {
                  if (!isDefinitiveOfficialError(error)) throw error;
                  await claimStore.complete(operation).catch(() => undefined);
                }
              } catch (error) {
                if (isRetryableOfficialError(error)) throw error;
                if (!json)
                  output.log(
                    `Skipped unavailable or uncertified Cell ${terminalText(cell.id, 100)}.`,
                  );
              } finally {
                if (candidate) await api.disconnect(candidate.nodeId).catch(() => undefined);
              }
            }
            if (!prepared) {
              throw new Error('No configured exact Cell can claim the selected Pool.');
            }
            if (!claim) throw new Error('Platform did not create the bounded Claim.');
            if (controller.signal.aborted) throw new Error('Official Fleet claim was interrupted.');
            createdByCli = true;
            if (controller.signal.aborted) throw new Error('Official Fleet claim was interrupted.');
            if (!json) {
              output.log(
                `Bounded claim ${claim.id} created for ${units} Unit${units === 1 ? '' : 's'}.`,
              );
            }
          } else {
            claim = await api.getClaim(existingClaimId!);
            if (claim.status !== 'active' || claim.remainingUnits < 1) {
              throw new Error(`Claim ${claim.id} is ${claim.status} and cannot be resumed.`);
            }
            const cell = findCellForClaim(config, claim);
            profileLock = await profileLocks.acquire(officialCellProfileLockKey(cell));
          }
          if (controller.signal.aborted) throw new Error('Official Fleet claim was interrupted.');
          const summary = await runBoundedClaim({
            config,
            api,
            claim,
            signal: controller.signal,
            logger,
            clientVersion: OFFICIAL_FLEET_CLIENT,
          });
          if (summary.terminalStatus === 'offline' && createdByCli) {
            await api.cancelClaim(claim.id).catch(() => undefined);
          }
          if (json) {
            const finalClaim = await api.getClaim(claim.id).catch(() => claim!);
            emitOfficialJson(
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
          } else {
            output.log(`Claim ${summary.claimId} stopped with status ${summary.terminalStatus}.`);
          }
          if (claimOperation)
            await getClaimIdempotencyStore()
              .complete(claimOperation)
              .catch(() => undefined);
          return 0;
        } catch (error) {
          if (createdByCli && claim) await api.cancelClaim(claim.id).catch(() => undefined);
          if (claimOperation && createdByCli) {
            await getClaimIdempotencyStore()
              .complete(claimOperation)
              .catch(() => undefined);
          }
          throw error;
        } finally {
          if (prepared) await api.disconnect(prepared.nodeId).catch(() => undefined);
          controller.dispose();
          if (profileLock) await profileLock.release();
        }
      }

      case 'cancel': {
        const flags = parseFlags(commandArgs, ['json'], ['claim']);
        const json = flags.booleans.has('json');
        if (json) officialJsonAction = 'claims.cancel';
        const claimId = requireOne(flags, 'claim');
        requireUuid(claimId, 'claim');
        const token = await requireToken(tokenStore);
        const claim = await apiFactory(server, token).cancelClaim(claimId);
        if (json) {
          emitOfficialJson(output, 'claims.cancel', { claim });
          return 0;
        }
        output.log(`Claim ${claim.id} is ${claim.status}; remaining reservation released.`);
        return 0;
      }

      case 'benchmark': {
        const flags = parseFlags(commandArgs, [], ['cell', 'concurrency']);
        const cellId = requireOne(flags, 'cell');
        const concurrencyValue = optionOne(flags, 'concurrency');
        const concurrency = concurrencyValue
          ? parseInteger(concurrencyValue, 'concurrency', 1, 64)
          : undefined;
        const token = await requireToken(tokenStore);
        const api = apiFactory(server, token);
        requireStandby(await api.getOfficialFleet());
        const config = await loadFleetConfig(configPath);
        const cell = config.cells.find((candidate) => candidate.id === cellId);
        if (!cell) throw new Error('Configured Cell not found.');
        const profileLock = await profileLocks.acquire(officialCellProfileLockKey(cell));
        const controller = createInterruptController();
        try {
          const result = await benchmarkCell({
            config,
            api,
            cellId,
            ...(concurrency === undefined ? {} : { concurrency }),
            signal: controller.signal,
            logger: createLogger(output),
            clientVersion: OFFICIAL_FLEET_CLIENT,
          });
          output.log(result.certified ? 'CERTIFIED' : 'NOT CERTIFIED');
          output.log(`Certified concurrency: ${result.certifiedConcurrency}`);
          output.log(`P95: ${Math.round(result.p95Ms)} ms`);
          output.log(`Expiry: ${result.expiresAt}`);
          return result.certified ? 0 : 2;
        } finally {
          controller.dispose();
          await profileLock.release();
        }
      }

      case 'status': {
        const flags = parseFlags(commandArgs, ['json'], []);
        const json = flags.booleans.has('json');
        if (json) officialJsonAction = 'runner.status';
        const token = await tokenStore.read();
        if (!token) {
          if (json) {
            emitOfficialJson(output, 'runner.status', { signedIn: false });
            return 0;
          }
          output.log('Official Fleet: signed out');
          return 0;
        }
        const api = apiFactory(server, token);
        const [fleet, runner, claims] = await Promise.all([
          api.getOfficialFleet(),
          api.getStatus(),
          api.listClaims(),
        ]);
        if (json) {
          const config = await loadFleetConfig(configPath);
          emitOfficialJson(output, 'runner.status', {
            signedIn: true,
            fleet,
            runner,
            claims,
            cells: config.cells.map((cell) => ({
              id: cell.id,
              adapter: cell.adapter,
              model: cell.model,
              routes: cell.routes.length,
              concurrency: cell.routes.reduce((sum, route) => sum + route.concurrency, 0),
            })),
          });
          return 0;
        }
        output.log(`Official Fleet: ${fleet.fleet.mode}`);
        output.log(`Claims: ${claims.length}`);
        for (const claim of claims) {
          output.log(
            `  ${claim.id} pool ${claim.poolId} ${claim.requestedAgent}/${claim.requestedModel} remaining ${claim.remainingUnits}/${claim.maxUnits} until ${claim.expiresAt}`,
          );
        }
        output.log(`Active nodes: ${runner.activeNodes ?? runner.nodes?.length ?? 0}`);
        const config = await loadFleetConfig(configPath);
        for (const cell of config.cells) {
          const capacity = cell.routes.reduce((sum, route) => sum + route.concurrency, 0);
          output.log(
            `Configured Cell ${cell.id}: ${cell.adapter}/${cell.model}, ${cell.routes.length} Route(s), concurrency ${capacity}`,
          );
        }
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
        output.log('Official Fleet session revoked and local token removed.');
        return 0;
      }

      default:
        throw new Error('Unknown command. Run agentpool-official help for supported commands.');
    }
  } catch (error) {
    if (officialJsonAction) {
      emitOfficialJsonError(output, officialJsonAction, error);
      return 1;
    }
    output.error(safeOfficialErrorMessage(error));
    return 1;
  }
}

function emitOfficialJson(
  output: Output,
  action: string,
  data: unknown,
  meta?: Record<string, unknown>,
): void {
  output.log(
    JSON.stringify({
      protocol: OFFICIAL_RUNNER_PROTOCOL,
      ok: true,
      action,
      data,
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    }),
  );
}

function emitOfficialJsonError(output: Output, action: string, error: unknown): void {
  const apiError = error instanceof ApiError ? error : undefined;
  const transportError = error instanceof RunnerTransportError ? error : undefined;
  output.log(
    JSON.stringify({
      protocol: OFFICIAL_RUNNER_PROTOCOL,
      ok: false,
      action,
      error: {
        code: officialErrorCode(error),
        message: safeOfficialErrorMessage(error),
        retryable: isRetryableOfficialError(error),
      },
      ...(apiError || transportError
        ? {
            meta: {
              ...(apiError ? { httpStatus: apiError.status } : {}),
              ...(apiError?.metadata.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: apiError.metadata.retryAfterMs }),
              ...(apiError?.metadata.requestId
                ? { requestId: apiError.metadata.requestId }
                : transportError
                  ? { requestId: transportError.requestId }
                  : {}),
            },
          }
        : {}),
    }),
  );
}

function officialErrorCode(error: unknown): string {
  if (error instanceof ApiError) return error.metadata.code ?? `HTTP_${error.status}`;
  if (error instanceof OfficialAmbiguousResponseError) return error.code;
  if (error instanceof RunnerTransportError) return error.code;
  if (error instanceof Error && error.message.includes('login')) return 'AUTH_REQUIRED';
  if (error instanceof Error && error.message.includes('UUID')) return 'INVALID_ID';
  if (
    error instanceof Error &&
    (error.message.includes('required') || error.message.includes('requires a value'))
  ) {
    return 'MISSING_OPTION';
  }
  return 'OFFICIAL_RUNNER_COMMAND_FAILED';
}

function retryableOfficialStatus(status: number | undefined): boolean {
  return (
    status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)
  );
}

function isRetryableOfficialError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.metadata.retryable ?? retryableOfficialStatus(error.status);
  }
  if (error instanceof OfficialAmbiguousResponseError || error instanceof RunnerTransportError) {
    return true;
  }
  // Fetch/network failures have no response status and may safely be retried
  // only by the bounded device-login polling loop or a read-only jobs listing.
  return error instanceof Error && error.message === 'Could not reach the Agent Pool platform.';
}

function isDefinitiveOfficialError(error: unknown): boolean {
  return !isRetryableOfficialError(error) && error instanceof ApiError;
}

function detectOfficialJsonAction(argv: readonly string[]): string | undefined {
  if (!argv.some((value) => value === '--json' || value === '--json=true')) return undefined;
  const filtered: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--server' || value === '--config') {
      index += 1;
      continue;
    }
    if (value?.startsWith('--server=') || value?.startsWith('--config=')) continue;
    if (value !== undefined) filtered.push(value);
  }
  const command = filtered[0];
  if (command === 'jobs') return 'tasks.list';
  if (command === 'claim' || command === 'once') return 'claims.run';
  if (command === 'cancel') return 'claims.cancel';
  if (command === 'status') return 'runner.status';
  return 'official.runner';
}

function redactOfficialText(value: string): string {
  return value
    .replace(
      /\bap_(?:control(?:_device)?|runner|device)_[A-Za-z0-9._~+/=-]+/giu,
      '[REDACTED_TOKEN]',
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1[REDACTED]@')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, '');
}

function safeOfficialErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return `Platform request failed (HTTP ${error.status}).`;
  if (error instanceof RunnerTransportError) return error.message;
  if (error instanceof OfficialAmbiguousResponseError) return error.message;
  if (!(error instanceof Error)) return 'Official Fleet failed.';
  const message = redactOfficialText(error.message);
  // These are local CLI validation strings; none interpolates a task, token,
  // positional argv value, or server response. Everything else is deliberately
  // collapsed so Route/adapter subprocess failures cannot leak task text.
  if (
    /^(?:Unlimited online mode is disabled\.|Select exactly one of --pool or --claim\.|--[a-z-]+ (?:is required|cannot|must|does not)|pick requires an interactive TTY\.|Official Fleet Claim selection interrupted\.|Run agentpool-official login first\.|Unknown command\.|jobs is machine-readable only\.)/u.test(
      message,
    )
  ) {
    return message;
  }
  return 'Official Fleet command failed.';
}

function silentLogger(): FleetLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

async function createClaimWithMetadata(
  api: OfficialFleetApiClient,
  input: CreateRunnerClaimInput,
  idempotencyKey: string,
): Promise<{
  claim: OfficialClaim;
  requestId?: string;
  idempotencyReplayed: boolean;
}> {
  // The packaged client exposes metadata. This fallback preserves existing
  // embedders/test doubles while production keeps the crash-safe path.
  const candidate = api as OfficialFleetApiClient & {
    createClaimRequest?: OfficialFleetApiClient['createClaimRequest'];
  };
  if (typeof candidate.createClaimRequest === 'function') {
    return candidate.createClaimRequest(input, idempotencyKey);
  }
  return { claim: await api.createClaim(input), idempotencyReplayed: false };
}

function extractGlobals(argv: readonly string[]): {
  server?: string;
  config?: string;
  argv: string[];
} {
  let server: string | undefined;
  let config: string | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const matched = argument?.match(/^--(server|config)(?:=(.*))?$/u);
    if (!matched) {
      if (argument !== undefined) remaining.push(argument);
      continue;
    }
    const name = matched[1];
    const inline = matched[2];
    const value = inline || argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value.`);
    if (name === 'server') server = value;
    else config = value;
  }
  return { server, config, argv: remaining };
}

function parseFlags(
  argv: readonly string[],
  booleanNames: readonly string[],
  valueNames: readonly string[],
): ParsedFlags {
  const booleans = new Set<string>();
  const values = new Map<string, string[]>();
  const booleanSet = new Set(booleanNames);
  const valueSet = new Set(valueNames);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith('--')) throw new Error('Unexpected positional argument.');
    const separator = argument.indexOf('=');
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (booleanSet.has(name)) {
      if (separator !== -1) throw new Error(`--${name} does not accept a value.`);
      booleans.add(name);
      continue;
    }
    if (!valueSet.has(name)) throw new Error(`Unknown option: --${name}`);
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
  if (values.length > 1) throw new Error(`--${name} may only be specified once.`);
  return values[0];
}

function requireOne(flags: ParsedFlags, name: string): string {
  const value = optionOne(flags, name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
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

function parseInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function requireUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`--${name} must be a UUID.`);
  }
}

async function requireToken(tokenStore: TokenStore): Promise<string> {
  const token = await tokenStore.read();
  if (!token) throw new Error('Run agentpool-official login first.');
  return token;
}

function createLogger(output: Output): FleetLogger {
  return {
    info: (message) => output.log(message),
    warn: (message) => output.log(`Warning: ${message}`),
    error: (message) => output.error(message),
  };
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
      throw new Error('Official Fleet Claim selection interrupted.');
    }
    throw error;
  }
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

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
