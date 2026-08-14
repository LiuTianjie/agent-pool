import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPoolApiClient } from '../src/api-client.js';
import { runCli } from '../src/cli.js';
import { TokenStore } from '../src/token-store.js';

const stateDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    stateDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStoredToken(): Promise<TokenStore> {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'agentpool-logout-test-'));
  stateDirectories.push(stateDirectory);
  const tokenStore = new TokenStore({ stateDirectory });
  await tokenStore.write('ap_runner_logout_test');
  return tokenStore;
}

describe('logout', () => {
  it('revokes remotely before removing the local token and reporting success', async () => {
    const tokenStore = await createStoredToken();
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(['logout', '--server', 'http://127.0.0.1:3000'], {
      tokenStore,
      apiFactory: (server, token) => new AgentPoolApiClient(server, token, fetch),
      output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    });

    expect(exitCode).toBe(0);
    expect(await tokenStore.read()).toBeNull();
    expect(errors).toEqual([]);
    expect(logs).toEqual(['Agent Pool session revoked and local token removed.']);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'DELETE',
      headers: expect.objectContaining({ Authorization: 'Bearer ap_runner_logout_test' }),
    });
  });

  it('keeps the local token and never claims success when remote revocation cannot be reached', async () => {
    const tokenStore = await createStoredToken();
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(['logout', '--server', 'http://127.0.0.1:3000'], {
      tokenStore,
      apiFactory: (server, token) => new AgentPoolApiClient(server, token, fetch),
      output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    });

    expect(exitCode).toBe(1);
    expect(await tokenStore.read()).toBe('ap_runner_logout_test');
    expect(logs).not.toContain('Agent Pool session revoked and local token removed.');
    expect(errors).toEqual(['Could not reach the Agent Pool platform.']);
  });
});
