import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlApiError, type ControlRequest } from '../src/control-api-client.js';
import { runControlCli } from '../src/control-cli.js';
import { ControlTokenStore } from '../src/control-token-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function storedControlToken(): Promise<ControlTokenStore> {
  const directory = await mkdtemp(join(tmpdir(), 'agentpool-control-cli-'));
  directories.push(directory);
  const store = new ControlTokenStore({ stateDirectory: directory });
  await store.write('ap_control_test_secret');
  return store;
}

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: {
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
    },
  };
}

describe('control CLI protocol', () => {
  it('returns machine-readable help and signed-out status without requiring a token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-control-cli-'));
    directories.push(directory);
    const tokenStore = new ControlTokenStore({ stateDirectory: directory });
    const help = capture();
    const status = capture();

    expect(
      await runControlCli(['help'], {
        server: 'http://127.0.0.1:3000',
        tokenStore,
        output: help.output,
      }),
    ).toBe(0);
    expect(
      await runControlCli(['status'], {
        server: 'http://127.0.0.1:3000',
        tokenStore,
        output: status.output,
      }),
    ).toBe(0);

    expect(JSON.parse(help.logs[0]!)).toMatchObject({
      protocol: 'agentpool-control/1',
      ok: true,
      action: 'help',
    });
    expect(JSON.parse(status.logs[0]!)).toMatchObject({
      protocol: 'agentpool-control/1',
      ok: true,
      action: 'status',
      data: { authenticated: false },
    });
    expect(help.errors).toEqual([]);
    expect(status.errors).toEqual([]);
  });

  it('publishes stdin/file-shaped JSON with a generated idempotency key and exact task route', async () => {
    const tokenStore = await storedControlToken();
    const captureOutput = capture();
    const requests: ControlRequest[] = [];
    const api = {
      server: 'http://127.0.0.1:3000',
      request: vi.fn(async (request: ControlRequest) => {
        requests.push(request);
        return {
          status: 201,
          data: { task: { id: 'task-1' } },
          requestId: 'publish-request',
          idempotencyReplayed: false,
        };
      }),
    };

    expect(
      await runControlCli(['tasks', 'publish', '--input', '-'], {
        server: api.server,
        tokenStore,
        output: captureOutput.output,
        inputReader: async () => ({ title: 'Task', units: [{ input: 1 }] }),
        apiFactory: () => api,
      }),
    ).toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      route: '/api/pools',
      body: { title: 'Task', units: [{ input: 1 }] },
      idempotencyKey: expect.stringMatching(/^apctl-/u),
    });
    expect(JSON.parse(captureOutput.logs[0]!)).toMatchObject({
      protocol: 'agentpool-control/1',
      ok: true,
      action: 'tasks.publish',
      data: { task: { id: 'task-1' } },
      meta: { requestId: 'publish-request', idempotencyReplayed: false },
    });
  });

  it('never accepts a token in argv and emits a stable JSON error on stdout', async () => {
    const captureOutput = capture();
    const exitCode = await runControlCli(['status', '--token', 'ap_control_leak'], {
      server: 'http://127.0.0.1:3000',
      output: captureOutput.output,
    });

    expect(exitCode).toBe(1);
    expect(captureOutput.errors).toEqual([]);
    expect(JSON.parse(captureOutput.logs[0]!)).toMatchObject({
      protocol: 'agentpool-control/1',
      ok: false,
      action: 'status',
      error: { code: 'TOKEN_ARGUMENT_FORBIDDEN', retryable: false },
    });
  });

  it('preserves server error codes and retry guidance in the protocol', async () => {
    const tokenStore = await storedControlToken();
    const captureOutput = capture();
    const apiError = new ControlApiError('RATE_LIMITED', 'Slow down.', {
      status: 429,
      retryable: true,
      retryAfterMs: 3000,
      requestId: 'rate-request',
    });

    expect(
      await runControlCli(['tasks', 'list'], {
        server: 'http://127.0.0.1:3000',
        tokenStore,
        output: captureOutput.output,
        apiFactory: () => ({
          server: 'http://127.0.0.1:3000',
          request: async () => Promise.reject(apiError),
        }),
      }),
    ).toBe(1);

    expect(JSON.parse(captureOutput.logs[0]!)).toMatchObject({
      ok: false,
      action: 'tasks.list',
      error: { code: 'RATE_LIMITED', retryable: true },
      meta: { httpStatus: 429, retryAfterMs: 3000, requestId: 'rate-request' },
    });
  });

  it('stores a successful device token without ever printing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-control-login-'));
    directories.push(directory);
    const tokenStore = new ControlTokenStore({ stateDirectory: directory });
    const captureOutput = capture();
    const responses = [
      {
        status: 201,
        data: {
          deviceCode: 'ap_control_device_private',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://example.test/connect?kind=control',
          verificationUriComplete: 'https://example.test/connect?kind=control&code=ABCD-EFGH',
          expiresIn: 600,
          interval: 3,
          scopes: ['account:read'],
        },
        requestId: 'start-request',
        idempotencyReplayed: false,
      },
      {
        status: 200,
        data: {
          status: 'approved',
          accessToken: 'ap_control_never_print_this',
          credential: { id: 'credential-1', scopes: ['account:read'] },
        },
        requestId: 'token-request',
        idempotencyReplayed: false,
      },
    ];

    expect(
      await runControlCli(['login', '--no-browser', '--scope', 'account:read'], {
        server: 'https://example.test',
        tokenStore,
        output: captureOutput.output,
        delay: async () => undefined,
        apiFactory: () => ({
          server: 'https://example.test',
          request: async () => responses.shift()!,
        }),
      }),
    ).toBe(0);

    expect(await tokenStore.read()).toBe('ap_control_never_print_this');
    expect(captureOutput.logs).toHaveLength(2);
    expect(captureOutput.logs.join('\n')).not.toContain('never_print_this');
    expect(JSON.parse(captureOutput.logs[0]!)).toMatchObject({
      data: { status: 'authorization_required', userCode: 'ABCD-EFGH' },
    });
    expect(JSON.parse(captureOutput.logs[1]!)).toMatchObject({
      data: { status: 'authenticated' },
    });
  });

  it('retries an ambiguous token response with the same device code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-control-login-'));
    directories.push(directory);
    const tokenStore = new ControlTokenStore({ stateDirectory: directory });
    const captureOutput = capture();
    const requests: ControlRequest[] = [];
    let poll = 0;
    const api = {
      server: 'https://example.test',
      request: async (request: ControlRequest) => {
        requests.push(request);
        if (request.route.endsWith('/start')) {
          return {
            status: 201,
            data: {
              deviceCode: 'ap_control_device_retry_private',
              userCode: 'RETRY-001',
              verificationUri: 'https://example.test/connect?kind=control',
              expiresIn: 600,
              interval: 1,
              scopes: ['account:read'],
            },
            requestId: 'start',
            idempotencyReplayed: false,
          };
        }
        poll += 1;
        if (poll === 1) {
          throw new ControlApiError('NETWORK_UNAVAILABLE', 'Could not reach platform.', {
            retryable: true,
            requestId: 'ambiguous',
          });
        }
        return {
          status: 200,
          data: {
            status: 'approved',
            accessToken: 'ap_control_retry_success',
            credential: { id: 'credential-retry' },
          },
          requestId: 'success',
          idempotencyReplayed: false,
        };
      },
    };

    expect(
      await runControlCli(['login', '--no-browser'], {
        server: api.server,
        tokenStore,
        output: captureOutput.output,
        delay: async () => undefined,
        apiFactory: () => api,
      }),
    ).toBe(0);

    const pollBodies = requests
      .filter((request) => request.route.endsWith('/token'))
      .map((request) => request.body);
    expect(pollBodies).toEqual([
      { deviceCode: 'ap_control_device_retry_private' },
      { deviceCode: 'ap_control_device_retry_private' },
    ]);
    expect(captureOutput.logs.join('\n')).not.toContain('retry_private');
  });

  it('resumes a persisted handshake after process restart without allocating a new code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-control-login-'));
    directories.push(directory);
    const tokenStore = new ControlTokenStore({ stateDirectory: directory });
    const firstOutput = capture();
    let starts = 0;
    const startApi = {
      server: 'https://example.test',
      request: async () => {
        starts += 1;
        return {
          status: 201,
          data: {
            deviceCode: 'ap_control_device_restart_private',
            userCode: 'START-001',
            verificationUri: 'https://example.test/connect?kind=control',
            expiresIn: 600,
            interval: 1,
            scopes: ['account:read'],
          },
          requestId: 'start',
          idempotencyReplayed: false,
        };
      },
    };
    expect(
      await runControlCli(['login', '--no-browser'], {
        server: startApi.server,
        tokenStore,
        output: firstOutput.output,
        delay: async () => Promise.reject(new Error('simulated process stop')),
        apiFactory: () => startApi,
      }),
    ).toBe(1);

    const resumedOutput = capture();
    const pollRequests: ControlRequest[] = [];
    expect(
      await runControlCli(['login', '--no-browser'], {
        server: startApi.server,
        tokenStore,
        output: resumedOutput.output,
        delay: async () => undefined,
        apiFactory: () => ({
          server: startApi.server,
          request: async (request) => {
            pollRequests.push(request);
            return {
              status: 200,
              data: {
                status: 'approved',
                accessToken: 'ap_control_restart_success',
                credential: { id: 'credential-restart' },
              },
              requestId: 'resumed',
              idempotencyReplayed: false,
            };
          },
        }),
      }),
    ).toBe(0);

    expect(starts).toBe(1);
    expect(pollRequests).toHaveLength(1);
    expect(pollRequests[0]?.route).toMatch(/\/token$/u);
    expect(JSON.parse(resumedOutput.logs[0]!)).toMatchObject({ data: { resumed: true } });
    expect(resumedOutput.logs.join('\n')).not.toContain('restart_private');
  });

  it('clears a locally cached credential when logout confirms it is already invalid', async () => {
    const tokenStore = await storedControlToken();
    const captureOutput = capture();
    expect(
      await runControlCli(['logout'], {
        server: 'https://example.test',
        tokenStore,
        output: captureOutput.output,
        apiFactory: () => ({
          server: 'https://example.test',
          request: async () =>
            Promise.reject(
              new ControlApiError('CONTROL_TOKEN_INVALID', 'Invalid.', {
                status: 401,
                retryable: false,
                requestId: 'logout-invalid',
              }),
            ),
        }),
      }),
    ).toBe(0);
    expect(await tokenStore.read()).toBeNull();
    expect(JSON.parse(captureOutput.logs[0]!)).toMatchObject({
      action: 'logout',
      data: { authenticated: false, revokedOrExpired: true, localTokenRemoved: true },
    });
  });

  it('never reflects server userinfo or a token pasted as a command', async () => {
    const serverOutput = capture();
    const tokenOutput = capture();
    await runControlCli(['status'], {
      server: 'https://private-user:private-password@example.test',
      output: serverOutput.output,
    });
    await runControlCli(['ap_control_super_private'], {
      server: 'https://example.test',
      output: tokenOutput.output,
    });

    expect(serverOutput.logs.join('\n')).not.toContain('private-user');
    expect(serverOutput.logs.join('\n')).not.toContain('private-password');
    expect(tokenOutput.logs.join('\n')).not.toContain('super_private');
    expect(JSON.parse(tokenOutput.logs[0]!)).toMatchObject({
      action: 'control',
      error: { code: 'UNKNOWN_COMMAND' },
    });
  });
});
