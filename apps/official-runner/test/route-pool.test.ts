import { describe, expect, it } from 'vitest';

import { AdapterExecutionError } from '../../runner/src/adapters/common.js';
import type { AgentAdapterDriver } from '../../runner/src/types.js';
import { classifyCommandFailure, createRouteCommandExecutor } from '../src/route-command.js';
import { CellRoutePool } from '../src/route-pool.js';
import type { FleetCellConfig } from '../src/types.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const lease = {
  leaseId: '00000000-0000-4000-8000-000000000001',
  unitId: '00000000-0000-4000-8000-000000000002',
  poolId: '00000000-0000-4000-8000-000000000003',
  category: 'text' as const,
  requestedAgent: 'codex' as const,
  requestedModel: 'gpt-exact',
  reward: 1,
  instruction: 'Return a value.',
  input: {},
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function cell(): FleetCellConfig {
  return {
    id: 'primary',
    adapter: 'codex',
    model: 'gpt-exact',
    allowWebhooks: false,
    routes: [
      { id: 'a', kind: 'cli', concurrency: 1, environment: {}, secretEnvRefs: {} },
      { id: 'b', kind: 'cli', concurrency: 1, environment: {}, secretEnvRefs: {} },
    ],
  };
}

function options() {
  return {
    lease,
    taskDirectory: '/tmp',
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

describe('Cell Route failover', () => {
  it('does not select a Route that failed its health detection while another is ready', async () => {
    const attempts: string[] = [];
    const pool = new CellRoutePool(cell(), {
      logger,
      adapterFactory: (profile, route): AgentAdapterDriver => ({
        name: profile.adapter,
        defaultModels: [profile.model],
        detect: async () => ({
          adapter: profile.adapter,
          available: true,
          authenticated: route.config.id === 'b',
        }),
        run: async () => {
          attempts.push(route.config.id);
          return 'delivered';
        },
      }),
    });
    await expect(pool.detect()).resolves.toMatchObject({ available: true, authenticated: true });
    await expect(pool.execute(options())).resolves.toBe('delivered');
    expect(attempts).toEqual(['b']);
  });

  it('tries each healthy Route at most once and stays inside one exact Cell', async () => {
    const attempts: string[] = [];
    const pool = new CellRoutePool(cell(), {
      logger,
      adapterFactory: (profile, route): AgentAdapterDriver => ({
        name: profile.adapter,
        defaultModels: [profile.model],
        detect: async () => ({ adapter: profile.adapter, available: true, authenticated: true }),
        run: async () => {
          attempts.push(route.config.id);
          if (route.config.id === 'a') throw new AdapterExecutionError('agent_error');
          return 'delivered';
        },
      }),
      failureClassifier: () => ({ failureKind: 'overloaded', producedFinalOutput: false }),
    });
    await expect(pool.execute(options())).resolves.toBe('delivered');
    expect(attempts).toEqual(['a', 'b']);
    expect(pool.snapshot().routes.map((route) => route.state)).toEqual(['cooling', 'ready']);
  });

  it('does not switch Routes after a final output has been produced', async () => {
    const attempts: string[] = [];
    const pool = new CellRoutePool(cell(), {
      logger,
      adapterFactory: (profile, route): AgentAdapterDriver => ({
        name: profile.adapter,
        defaultModels: [profile.model],
        detect: async () => ({ adapter: profile.adapter, available: true, authenticated: true }),
        run: async () => {
          attempts.push(route.config.id);
          throw new AdapterExecutionError('invalid_output');
        },
      }),
      failureClassifier: () => ({ failureKind: 'other', producedFinalOutput: true }),
    });
    await expect(pool.execute(options())).rejects.toThrow('invalid_output');
    expect(attempts).toEqual(['a']);
  });

  it('isolates authentication failures and never exposes failure contents in snapshots', async () => {
    const pool = new CellRoutePool(cell(), {
      logger,
      adapterFactory: (profile): AgentAdapterDriver => ({
        name: profile.adapter,
        defaultModels: [profile.model],
        detect: async () => ({ adapter: profile.adapter, available: true, authenticated: true }),
        run: async () => {
          throw new AdapterExecutionError('agent_error');
        },
      }),
      failureClassifier: (routeId) => ({
        failureKind: routeId === 'a' ? 'auth' : 'other',
        producedFinalOutput: routeId === 'b',
      }),
    });
    await expect(pool.execute(options())).rejects.toThrow();
    const snapshot = pool.snapshot();
    expect(snapshot.routes[0]).toMatchObject({ id: 'a', state: 'isolated', failureKind: 'auth' });
    expect(JSON.stringify(snapshot)).not.toContain('401');
    expect(JSON.stringify(snapshot)).not.toContain('api key');
  });

  it('rejects a lease for any other adapter/model before selecting a Route', async () => {
    const pool = new CellRoutePool(cell(), { logger });
    await expect(
      pool.execute({ ...options(), lease: { ...lease, requestedModel: 'other-model' } }),
    ).rejects.toThrow('model_mismatch');
  });
});

describe('sanitized command observations', () => {
  it('spawns Route A without exposing Route B or unrelated host secrets', async () => {
    const executor = createRouteCommandExecutor(
      {
        id: 'route-a',
        kind: 'cli',
        concurrency: 1,
        environment: {},
        secretEnvRefs: { ROUTE_SECRET: { env: 'ROUTE_A_SOURCE' } },
      },
      {
        PATH: process.env.PATH,
        ROUTE_A_SOURCE: 'secret-a',
        ROUTE_B_SOURCE: 'secret-b',
        PLATFORM_TOKEN: 'must-not-cross',
      },
    );
    const result = await executor.execute(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify({route:process.env.ROUTE_SECRET,other:process.env.ROUTE_B_SOURCE,platform:process.env.PLATFORM_TOKEN}))',
    ]);
    expect(JSON.parse(result.stdout)).toEqual({ route: 'secret-a' });
    executor.clearObservation();
  });

  it('classifies transport responses without retaining stdout or stderr', async () => {
    const executor = createRouteCommandExecutor(
      { id: 'route', kind: 'cli', concurrency: 1, environment: {}, secretEnvRefs: {} },
      { PATH: process.env.PATH },
    );
    const sensitive = 'TASK_OUTPUT_MUST_NOT_PERSIST';
    await executor.execute(
      process.execPath,
      [
        '-e',
        `console.log(JSON.stringify({type:'message.completed',text:'${sensitive}'}));console.error('429 rate limit');process.exit(1)`,
      ],
      { onStdoutLine: () => undefined },
    );
    const observation = executor.consumeObservation();
    expect(observation).toEqual({ failureKind: 'overloaded', producedFinalOutput: true });
    expect(JSON.stringify(observation)).not.toContain(sensitive);
    expect(executor.consumeObservation()).toBeUndefined();
  });

  it('classifies auth, timeout, and transient failures from metadata only', () => {
    expect(
      classifyCommandFailure({ exitCode: 1, stdout: '', stderr: 'HTTP 401', timedOut: false }),
    ).toBe('auth');
    expect(classifyCommandFailure({ exitCode: null, stdout: '', stderr: '', timedOut: true })).toBe(
      'timeout',
    );
    expect(
      classifyCommandFailure({
        exitCode: 1,
        stdout: '',
        stderr: 'bad gateway 502',
        timedOut: false,
      }),
    ).toBe('transient');
  });
});
