import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunnerTransportError } from '../src/api-client.js';
import { runCli } from '../src/cli.js';
import { TokenStore } from '../src/token-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function state(): Promise<TokenStore> {
  const directory = await mkdtemp(join(tmpdir(), 'agentpool-runner-login-'));
  directories.push(directory);
  return new TokenStore({ stateDirectory: directory });
}

function device() {
  return {
    deviceCode: 'ap_device_private_runner_handshake',
    userCode: 'RUN-0001',
    verificationUri: 'https://example.test/device',
    verificationUriComplete: 'https://example.test/device?code=RUN-0001',
    expiresIn: 600,
    interval: 1,
  };
}

describe('Community Runner login recovery', () => {
  it('retries transient token polling with the same device code', async () => {
    const tokenStore = await state();
    const startDeviceLogin = vi.fn(async () => device());
    const seen: string[] = [];
    const pollDeviceLogin = vi.fn(async (deviceCode: string) => {
      seen.push(deviceCode);
      if (seen.length === 1) {
        throw new RunnerTransportError('NETWORK_UNAVAILABLE', 'poll-request');
      }
      return { status: 'approved' as const, token: 'ap_runner_login_success' };
    });
    const logs: string[] = [];

    expect(
      await runCli(['login', '--no-browser'], {
        tokenStore,
        delay: async () => undefined,
        apiFactory: () => ({ startDeviceLogin, pollDeviceLogin }) as never,
        output: { log: (message) => logs.push(message), error: () => undefined },
      }),
    ).toBe(0);

    expect(startDeviceLogin).toHaveBeenCalledOnce();
    expect(seen).toEqual([device().deviceCode, device().deviceCode]);
    expect(await tokenStore.read()).toBe('ap_runner_login_success');
    expect(logs.join('\n')).not.toContain(device().deviceCode);
  });

  it('resumes the pending handshake after restart instead of allocating another code', async () => {
    const tokenStore = await state();
    const startDeviceLogin = vi.fn(async () => device());
    const firstErrors: string[] = [];
    expect(
      await runCli(['login', '--no-browser'], {
        tokenStore,
        delay: async () => Promise.reject(new Error('simulated process stop')),
        apiFactory: () => ({ startDeviceLogin }) as never,
        output: { log: () => undefined, error: (message) => firstErrors.push(message) },
      }),
    ).toBe(1);

    const pollDeviceLogin = vi.fn(async () => ({
      status: 'approved' as const,
      token: 'ap_runner_restart_success',
    }));
    const resumedLogs: string[] = [];
    expect(
      await runCli(['login', '--no-browser'], {
        tokenStore,
        delay: async () => undefined,
        apiFactory: () => ({ startDeviceLogin, pollDeviceLogin }) as never,
        output: { log: (message) => resumedLogs.push(message), error: () => undefined },
      }),
    ).toBe(0);

    expect(firstErrors).toEqual(['simulated process stop']);
    expect(startDeviceLogin).toHaveBeenCalledOnce();
    expect(pollDeviceLogin).toHaveBeenCalledWith(device().deviceCode);
    expect(await tokenStore.read()).toBe('ap_runner_restart_success');
    expect(resumedLogs.join('\n')).not.toContain(device().deviceCode);
  });
});
