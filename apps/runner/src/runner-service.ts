import { arch, platform } from 'node:os';
import { combineAbortSignals } from './abort.js';
import { AdapterExecutionError } from './adapters/common.js';
import { leaseMatchesCapability, validateLease } from './lease.js';
import { assertResultMatchesContract } from './task-contract.js';
import { withTaskDirectory } from './task-directory.js';
import type {
  AgentAdapter,
  AgentAdapterDriver,
  CapacityCertification,
  DeliveryOutcome,
  LeaseFailure,
  Logger,
  RegisterNodeInput,
  RunnerClaim,
  RunnerProgressInput,
  WebhookReceipt,
} from './types.js';
import { deliverToWebhook } from './webhook.js';

export interface RunnerApi {
  getCapacity(
    adapter: AgentAdapter,
    model: string,
    nodeId?: string,
  ): Promise<CapacityCertification | null>;
  registerNode(input: RegisterNodeInput): Promise<{
    nodeId: string;
    heartbeatInterval?: number;
  }>;
  heartbeat(nodeId: string, activeLeases: number): Promise<void>;
  pollLease(
    nodeId: string,
    capability: { adapter: string; models: string[]; claimId: string },
  ): Promise<{ lease: unknown | null; retryAfterMs?: number }>;
  getClaim(claimId: string): Promise<RunnerClaim>;
  progress(leaseId: string, progress: RunnerProgressInput): Promise<void>;
  submit(leaseId: string, output: unknown, timeoutMs?: number): Promise<DeliveryOutcome>;
  receipt(leaseId: string, receipt: WebhookReceipt, timeoutMs?: number): Promise<DeliveryOutcome>;
  fail(leaseId: string, failure: LeaseFailure): Promise<void>;
  disconnect(nodeId: string): Promise<void>;
}

export interface RunnerServiceOptions {
  api: RunnerApi;
  adapter: AgentAdapterDriver;
  models: string[];
  requestedConcurrency: number;
  claimId: string;
  expectedNodeId: string;
  signal: AbortSignal;
  logger: Logger;
  clientVersion: string;
  pollIntervalMs?: number;
  shutdownGraceMs?: number;
  allowWebhooks?: boolean;
  webhookDeliverer?: (
    lease: ReturnType<typeof validateLease>,
    output: unknown,
  ) => Promise<WebhookReceipt>;
}

const MIN_POLL_INTERVAL_MS = 3_000;
const MAX_POLL_INTERVAL_MS = 60_000;

export function resolvePollDelay(
  configuredIntervalMs?: number,
  serverRetryAfterMs?: number,
): number {
  return Math.min(
    MAX_POLL_INTERVAL_MS,
    Math.max(
      MIN_POLL_INTERVAL_MS,
      configuredIntervalMs ?? MIN_POLL_INTERVAL_MS,
      serverRetryAfterMs ?? MIN_POLL_INTERVAL_MS,
    ),
  );
}

export async function resolveCertifiedConcurrency(options: {
  api: Pick<RunnerApi, 'getCapacity'>;
  adapter: AgentAdapter;
  models: readonly string[];
  requestedConcurrency: number;
  nodeId?: string;
  now?: number;
}): Promise<{ concurrency: number; certifications: CapacityCertification[] }> {
  const now = options.now ?? Date.now();
  const certifications: CapacityCertification[] = [];
  for (const model of options.models) {
    const certification = await options.api.getCapacity(options.adapter, model, options.nodeId);
    if (
      !certification ||
      !certification.certified ||
      certification.model !== model ||
      certification.adapter !== options.adapter ||
      certification.certifiedConcurrency < 1 ||
      Date.parse(certification.expiresAt) <= now
    ) {
      throw new Error(
        `No current capacity certification for ${options.adapter}/${model}. Run its matching Runner benchmark first.`,
      );
    }
    certifications.push(certification);
  }
  const certifiedLimit = Math.min(
    ...certifications.map((certification) => Math.floor(certification.certifiedConcurrency)),
  );
  return {
    concurrency: Math.min(options.requestedConcurrency, certifiedLimit),
    certifications,
  };
}

export class RunnerService {
  private readonly active = new Set<Promise<void>>();
  private readonly activeLeaseIds = new Set<string>();
  private readonly activeAbortController = new AbortController();
  private heartbeatRunning = false;

  constructor(private readonly options: RunnerServiceOptions) {}

  async run(): Promise<void> {
    const { api, adapter, models, requestedConcurrency, logger } = this.options;
    const detection = await adapter.detect();
    if (!detection.available || !detection.authenticated) {
      throw new Error(`${adapter.name} is not available and authenticated on this machine.`);
    }

    let registration: Awaited<ReturnType<RunnerApi['registerNode']>> | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let claimPollingFinished = false;
    try {
      registration = await api.registerNode({
        adapter: adapter.name,
        models,
        concurrency: requestedConcurrency,
        adapterVersion: detection.version,
        clientVersion: this.options.clientVersion,
        platform: platform(),
        arch: arch(),
        supportsDirectWebhooks: this.options.allowWebhooks === true,
      });
      if (registration.nodeId !== this.options.expectedNodeId) {
        throw new Error(
          'This claim is bound to a different Runner node. Revoke it and create a new claim on this node.',
        );
      }
      const certification = await resolveCertifiedConcurrency({
        api,
        adapter: adapter.name,
        models,
        requestedConcurrency,
        nodeId: registration.nodeId,
      });
      const concurrency = certification.concurrency;
      if (concurrency < requestedConcurrency) {
        logger.warn(`Concurrency limited to certified capacity ${concurrency}.`);
      }

      const heartbeatMs = Math.max(2_000, (registration.heartbeatInterval ?? 15) * 1_000);
      heartbeatTimer = setInterval(() => {
        if (this.heartbeatRunning) return;
        this.heartbeatRunning = true;
        void api
          .heartbeat(registration!.nodeId, this.active.size)
          .catch(() => logger.warn('Heartbeat delayed; retrying.'))
          .finally(() => {
            this.heartbeatRunning = false;
          });
      }, heartbeatMs);
      heartbeatTimer.unref();

      logger.info(`${adapter.name} running bounded claim with concurrency ${concurrency}.`);

      while (!this.options.signal.aborted) {
        if (this.active.size >= concurrency) {
          await Promise.race(this.active);
          continue;
        }

        const poll = await api.pollLease(registration.nodeId, {
          adapter: adapter.name,
          models,
          claimId: this.options.claimId,
        });
        if (poll.lease === null) {
          const claim = await api.getClaim(this.options.claimId);
          if (claim.nodeId !== registration.nodeId) {
            throw new Error('The platform returned a claim bound to a different Runner node.');
          }
          if (claim.status !== 'active') {
            logger.info(`Bounded claim stopped with status ${claim.status}.`);
            claimPollingFinished = true;
            break;
          }
          const retryAfterMs = resolvePollDelay(this.options.pollIntervalMs, poll.retryAfterMs);
          await wait(retryAfterMs, this.options.signal);
          continue;
        }
        const lease = validateLease(poll.lease);
        if (this.activeLeaseIds.has(lease.leaseId)) {
          await api
            .fail(lease.leaseId, { code: 'agent_error', retryable: true })
            .catch(() => undefined);
          continue;
        }
        if (!leaseMatchesCapability(lease, adapter.name, models)) {
          await api
            .fail(lease.leaseId, { code: 'model_mismatch', retryable: true })
            .catch(() => undefined);
          continue;
        }
        if (lease.delivery?.mode === 'webhook' && this.options.allowWebhooks !== true) {
          await api
            .fail(lease.leaseId, { code: 'model_mismatch', retryable: true })
            .catch(() => undefined);
          logger.warn('A direct-delivery unit was declined because webhooks are not enabled.');
          continue;
        }

        this.activeLeaseIds.add(lease.leaseId);
        const task = this.executeLease(lease)
          .catch(() => undefined)
          .finally(() => {
            this.active.delete(task);
            this.activeLeaseIds.delete(lease.leaseId);
          });
        this.active.add(task);
        logger.info(`Sealed work unit started. Active: ${this.active.size}/${concurrency}.`);
      }
    } finally {
      await this.finishActiveTasks(claimPollingFinished);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (registration) await api.disconnect(registration.nodeId).catch(() => undefined);
      logger.info('Runner offline.');
    }
  }

  private async executeLease(lease: ReturnType<typeof validateLease>): Promise<void> {
    const expiresIn = Date.parse(lease.expiresAt) - Date.now();
    if (expiresIn <= 0) {
      await this.options.api
        .fail(lease.leaseId, { code: 'lease_expired', retryable: true })
        .catch(() => undefined);
      return;
    }

    const leaseAbort = new AbortController();
    const expiryTimer = setTimeout(() => leaseAbort.abort(), Math.min(expiresIn, 2_147_000_000));
    expiryTimer.unref();
    const combinedSignal = combineAbortSignals([
      leaseAbort.signal,
      this.activeAbortController.signal,
    ]);
    let lastProgress = -1;
    const reportProgress = async (progress: RunnerProgressInput): Promise<void> => {
      if (progress.progress <= lastProgress) return;
      lastProgress = progress.progress;
      await this.options.api.progress(lease.leaseId, progress).catch(() => undefined);
    };

    try {
      const output = await withTaskDirectory(async (taskDirectory) =>
        this.options.adapter.run({
          lease,
          taskDirectory,
          signal: combinedSignal.signal,
          onProgress: reportProgress,
        }),
      );
      assertResultMatchesContract(lease, output);
      await reportProgress({ stage: 'submitting', progress: 96 });
      if (lease.delivery?.mode === 'webhook') {
        const receipt = await (this.options.webhookDeliverer ?? deliverToWebhook)(lease, output);
        await retryDelivery(
          (timeoutMs) => this.options.api.receipt(lease.leaseId, receipt, timeoutMs),
          lease.expiresAt,
          combinedSignal.signal,
        );
      } else {
        await retryDelivery(
          (timeoutMs) => this.options.api.submit(lease.leaseId, output, timeoutMs),
          lease.expiresAt,
          combinedSignal.signal,
        );
      }
      await reportProgress({ stage: 'completed', progress: 100 });
      this.options.logger.info('Sealed work unit delivery recorded.');
    } catch (error) {
      const code = mapFailureCode(
        error,
        leaseAbort.signal.aborted,
        this.activeAbortController.signal.aborted,
      );
      await this.options.api.fail(lease.leaseId, { code, retryable: true }).catch(() => undefined);
      this.options.logger.warn('A sealed work unit was released without exposing its contents.');
    } finally {
      clearTimeout(expiryTimer);
      combinedSignal.dispose();
    }
  }

  private async finishActiveTasks(drainNormally: boolean): Promise<void> {
    if (this.active.size === 0) return;
    const completed = Promise.allSettled([...this.active]);
    if (drainNormally && !this.options.signal.aborted) {
      let removeAbortListener = (): void => undefined;
      const interrupted = new Promise<boolean>((resolve) => {
        const onAbort = (): void => resolve(true);
        removeAbortListener = () => this.options.signal.removeEventListener('abort', onAbort);
        this.options.signal.addEventListener('abort', onAbort, { once: true });
        if (this.options.signal.aborted) onAbort();
      });
      const wasInterrupted = await Promise.race([completed.then(() => false), interrupted]);
      removeAbortListener();
      if (!wasInterrupted) return;
    }

    const graceMs = this.options.shutdownGraceMs ?? 30_000;
    let graceTimer: NodeJS.Timeout | undefined;
    const gracefullyFinished = await Promise.race([
      completed.then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    if (!gracefullyFinished) {
      this.activeAbortController.abort();
      await completed;
    }
  }
}

async function retryDelivery(
  operation: (timeoutMs: number) => Promise<DeliveryOutcome>,
  expiresAt: string,
  signal: AbortSignal,
): Promise<DeliveryOutcome> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (signal.aborted) throw new Error('Delivery interrupted.');
    const remainingMs = Date.parse(expiresAt) - Date.now();
    if (remainingMs <= 0) throw new Error('Delivery lease expired.');
    try {
      return await operation(Math.max(1, Math.min(20_000, remainingMs)));
    } catch (error) {
      lastError = error;
      if (!isRetryableDeliveryError(error)) throw error;
      const delayMs = Math.min(2_000, 250 * 2 ** attempt);
      if (attempt >= 3 || Date.parse(expiresAt) - Date.now() <= delayMs) break;
      await wait(delayMs, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Delivery failed.');
}

function isRetryableDeliveryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return true;
  const status = (error as { status?: unknown }).status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

function mapFailureCode(
  error: unknown,
  leaseExpired: boolean,
  shuttingDown: boolean,
): LeaseFailure['code'] {
  if (leaseExpired) return 'lease_expired';
  if (shuttingDown) return 'shutdown';
  if (error instanceof AdapterExecutionError) return error.code;
  if (error instanceof Error && error.message === 'invalid_output') return 'invalid_output';
  return 'agent_error';
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
