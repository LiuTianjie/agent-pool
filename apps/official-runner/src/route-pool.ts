import { ClaudeAdapter } from '../../runner/src/adapters/claude.js';
import { AdapterExecutionError } from '../../runner/src/adapters/common.js';
import { CodexAdapter } from '../../runner/src/adapters/codex.js';
import { MockAdapter } from '../../runner/src/adapters/mock.js';
import type { AgentAdapterDriver, RunnerAdapterStatus } from '../../runner/src/types.js';

import { createRouteCommandExecutor, type ObservedCommandExecutor } from './route-command.js';
import type {
  CellSnapshot,
  FleetCellConfig,
  FleetLogger,
  RouteExecutionOptions,
  RouteFailureKind,
  RouteRuntime,
} from './types.js';

interface InternalRoute extends RouteRuntime {
  observed?: ObservedCommandExecutor;
}

export interface RoutePoolOptions {
  now?: () => number;
  hostEnvironment?: NodeJS.ProcessEnv;
  logger: FleetLogger;
  adapterFactory?: (cell: FleetCellConfig, route: InternalRoute) => AgentAdapterDriver;
  failureClassifier?: (routeId: string) => {
    failureKind: RouteFailureKind;
    producedFinalOutput: boolean;
  };
}

export class CellRoutePool {
  private readonly routes: InternalRoute[];
  private readonly now: () => number;

  constructor(
    readonly cell: FleetCellConfig,
    private readonly options: RoutePoolOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.routes = cell.routes.map((config) => ({
      config,
      inFlight: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      isolated: false,
    }));
  }

  totalConcurrency(): number {
    return this.routes.reduce((total, route) => total + route.config.concurrency, 0);
  }

  availableConcurrency(now = this.now()): number {
    return this.routes.reduce((total, route) => {
      if (route.isolated || route.cooldownUntil > now) return total;
      return total + Math.max(0, route.config.concurrency - route.inFlight);
    }, 0);
  }

  nextAvailabilityDelay(now = this.now(), excluded: ReadonlySet<string> = new Set()): number {
    const hasAvailable = this.routes.some(
      (route) =>
        !excluded.has(route.config.id) &&
        !route.isolated &&
        route.cooldownUntil <= now &&
        route.inFlight < route.config.concurrency,
    );
    if (hasAvailable) return 0;
    const next = this.routes
      .filter(
        (route) => !excluded.has(route.config.id) && !route.isolated && route.cooldownUntil > now,
      )
      .map((route) => route.cooldownUntil - now)
      .sort((left, right) => left - right)[0];
    return next === undefined ? 3_000 : Math.max(50, Math.min(next, 60_000));
  }

  async detect(): Promise<RunnerAdapterStatus> {
    const statuses = await Promise.all(
      this.routes.map(async (route) => {
        try {
          const status = await this.adapterFor(route).detect();
          if (status.available && status.authenticated) {
            route.observed?.clearObservation();
            this.recordSuccess(route);
          } else {
            const failureKind = route.observed?.consumeObservation()?.failureKind ?? 'other';
            this.recordFailure(route, failureKind);
          }
          return status;
        } catch {
          const failureKind = route.observed?.consumeObservation()?.failureKind ?? 'other';
          this.recordFailure(route, failureKind);
          return null;
        }
      }),
    );
    const ready = statuses.filter(
      (status): status is RunnerAdapterStatus =>
        status !== null && status.available && status.authenticated,
    );
    return {
      adapter: this.cell.adapter,
      available: ready.length > 0,
      authenticated: ready.length > 0,
      supportedModels: ready.length > 0 ? [this.cell.model] : [],
      version: this.cell.adapter === 'mock' ? 'built-in' : 'official-cli',
      detail:
        ready.length > 0
          ? `${ready.length}/${this.routes.length} configured Routes ready.`
          : 'No configured Route has an available, authenticated CLI.',
    };
  }

  async execute(options: RouteExecutionOptions): Promise<unknown> {
    if (
      options.lease.requestedAgent !== this.cell.adapter ||
      options.lease.requestedModel !== this.cell.model
    ) {
      throw new AdapterExecutionError('model_mismatch');
    }
    const attempted = new Set<string>();
    let lastError: unknown;
    while (!options.signal.aborted) {
      const route = await this.acquire(options.signal, attempted);
      attempted.add(route.config.id);
      route.observed?.clearObservation();
      try {
        const output = await this.adapterFor(route).run(options);
        route.observed?.clearObservation();
        this.recordSuccess(route);
        return output;
      } catch (error) {
        lastError = error;
        const observation = this.options.failureClassifier?.(route.config.id) ??
          route.observed?.consumeObservation() ?? {
            failureKind: 'other' as const,
            producedFinalOutput: false,
          };
        this.recordFailure(route, observation.failureKind);
        if (
          options.signal.aborted ||
          observation.producedFinalOutput ||
          !this.hasUnattemptedRoute(attempted)
        ) {
          throw error;
        }
      } finally {
        route.inFlight = Math.max(0, route.inFlight - 1);
      }
    }
    throw lastError ?? new AdapterExecutionError('agent_error');
  }

  snapshot(now = this.now()): CellSnapshot {
    return {
      id: this.cell.id,
      adapter: this.cell.adapter,
      model: this.cell.model,
      availableConcurrency: this.availableConcurrency(now),
      totalConcurrency: this.totalConcurrency(),
      routes: this.routes.map((route) => ({
        id: route.config.id,
        concurrency: route.config.concurrency,
        inFlight: route.inFlight,
        state: route.isolated
          ? 'isolated'
          : route.cooldownUntil > now
            ? 'cooling'
            : route.inFlight >= route.config.concurrency
              ? 'busy'
              : 'ready',
        ...(route.cooldownUntil > now
          ? { cooldownUntil: new Date(route.cooldownUntil).toISOString() }
          : {}),
        ...(route.lastFailureKind ? { failureKind: route.lastFailureKind } : {}),
      })),
    };
  }

  private adapterFor(route: InternalRoute): AgentAdapterDriver {
    if (this.options.adapterFactory) return this.options.adapterFactory(this.cell, route);
    if (this.cell.adapter === 'mock') return new MockAdapter();
    route.observed ??= createRouteCommandExecutor(
      route.config,
      this.options.hostEnvironment ?? process.env,
    );
    return this.cell.adapter === 'codex'
      ? new CodexAdapter(route.observed.execute)
      : new ClaudeAdapter(route.observed.execute);
  }

  private async acquire(
    signal: AbortSignal,
    attempted: ReadonlySet<string>,
  ): Promise<InternalRoute> {
    while (!signal.aborted) {
      const now = this.now();
      const candidates = this.routes
        .filter(
          (route) =>
            !attempted.has(route.config.id) &&
            !route.isolated &&
            route.cooldownUntil <= now &&
            route.inFlight < route.config.concurrency,
        )
        .sort((left, right) => {
          const leftLoad = left.inFlight / left.config.concurrency;
          const rightLoad = right.inFlight / right.config.concurrency;
          return leftLoad - rightLoad || left.config.id.localeCompare(right.config.id);
        });
      const selected = candidates[0];
      if (selected) {
        selected.inFlight += 1;
        return selected;
      }
      if (!this.hasUnattemptedRoute(attempted)) break;
      await wait(this.nextAvailabilityDelay(now, attempted), signal);
    }
    throw new AdapterExecutionError('agent_error');
  }

  private hasUnattemptedRoute(attempted: ReadonlySet<string>): boolean {
    return this.routes.some((route) => !attempted.has(route.config.id) && !route.isolated);
  }

  private recordSuccess(route: InternalRoute): void {
    route.consecutiveFailures = 0;
    route.cooldownUntil = 0;
    route.lastFailureKind = undefined;
  }

  private recordFailure(route: InternalRoute, kind: RouteFailureKind): void {
    route.consecutiveFailures += 1;
    route.lastFailureKind = kind;
    if (kind === 'auth') {
      route.isolated = true;
      route.cooldownUntil = 0;
      this.options.logger.warn(
        `Route ${route.config.id} isolated after an authentication failure.`,
      );
      return;
    }
    const base =
      kind === 'overloaded' || kind === 'timeout' || kind === 'transient' ? 5_000 : 1_000;
    const delay = Math.min(5 * 60_000, base * 2 ** Math.min(6, route.consecutiveFailures - 1));
    route.cooldownUntil = this.now() + delay;
    this.options.logger.warn(`Route ${route.config.id} cooling after a ${kind} failure.`);
  }
}

export class CellAdapter implements AgentAdapterDriver {
  readonly name;
  readonly defaultModels;

  constructor(readonly pool: CellRoutePool) {
    this.name = pool.cell.adapter;
    this.defaultModels = [pool.cell.model] as const;
  }

  async detect(): Promise<RunnerAdapterStatus> {
    return this.pool.detect();
  }

  async run(options: Parameters<AgentAdapterDriver['run']>[0]): Promise<unknown> {
    return this.pool.execute(options);
  }
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, milliseconds));
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
