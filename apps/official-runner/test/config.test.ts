import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseFleetConfig } from '../src/config.js';
import { resolveRouteEnvironment } from '../src/secrets.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function config(route: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    version: 'agentpool-official-fleet/1',
    cells: [
      {
        id: 'primary',
        adapter: 'codex',
        model: 'gpt-exact',
        routes: [route],
        ...overrides,
      },
    ],
  };
}

describe('Official Fleet config', () => {
  it('accepts actual CLI Routes with exact profiles and secret references', () => {
    const parsed = parseFleetConfig(
      config({
        id: 'relay-a',
        kind: 'cli',
        concurrency: 4,
        environment: { OPENAI_BASE_URL: 'https://relay.example.com/v1' },
        secretEnvRefs: { OPENAI_API_KEY: { env: 'RELAY_A_KEY' } },
      }),
    );
    expect(parsed.cells[0]?.routes[0]).toMatchObject({ id: 'relay-a', concurrency: 4 });
  });

  it.each(['openai-compatible', 'anthropic-compatible', 'http'])(
    'rejects raw %s Routes that could impersonate a CLI adapter',
    (kind) => {
      expect(() => parseFleetConfig(config({ id: 'relay', kind, concurrency: 1 }))).toThrow(
        /actual CLI|unsupported/u,
      );
    },
  );

  it('rejects wildcard and duplicate execution profiles', () => {
    expect(() =>
      parseFleetConfig(config({ id: 'relay', kind: 'cli', concurrency: 1 }, { model: '*' })),
    ).toThrow(/exact model/u);
    const value = config({ id: 'relay-a', kind: 'cli', concurrency: 1 });
    (value.cells as unknown[]).push({
      id: 'secondary',
      adapter: 'codex',
      model: 'gpt-exact',
      routes: [{ id: 'relay-b', kind: 'cli', concurrency: 1 }],
    });
    expect(() => parseFleetConfig(value)).toThrow(/one cell/u);
  });

  it('rejects unsafe service URLs and inline secret-looking variables', () => {
    expect(() =>
      parseFleetConfig(
        config({
          id: 'relay',
          kind: 'cli',
          concurrency: 1,
          environment: { OPENAI_BASE_URL: 'https://user:pass@relay.example.com/v1' },
        }),
      ),
    ).toThrow(/without credentials/u);
    expect(() =>
      parseFleetConfig(
        config({
          id: 'relay',
          kind: 'cli',
          concurrency: 1,
          environment: { OPENAI_API_KEY: 'must-not-be-inline' },
        }),
      ),
    ).toThrow(/secretEnvRefs/u);
  });

  it('builds a minimal per-Route child environment without cross-Route secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'official-fleet-secret-'));
    temporaryDirectories.push(directory);
    const secretFile = join(directory, 'route-a');
    await writeFile(secretFile, 'file-secret-a\n', { mode: 0o600 });
    const route = {
      id: 'relay-a',
      kind: 'cli' as const,
      concurrency: 1,
      environment: { OPENAI_BASE_URL: 'https://relay.example.com/v1' },
      secretEnvRefs: {
        OPENAI_API_KEY: { file: secretFile },
        ROUTE_AUTH_TOKEN: { env: 'ROUTE_A_SOURCE' },
      },
    };
    const child = await resolveRouteEnvironment(route, {
      PATH: '/safe/bin',
      HOME: '/safe/home',
      ROUTE_A_SOURCE: 'env-secret-a',
      ROUTE_B_SOURCE: 'secret-b-must-not-cross',
      UNRELATED_API_KEY: 'unrelated-must-not-cross',
    });
    expect(child).toMatchObject({
      PATH: '/safe/bin',
      HOME: '/safe/home',
      OPENAI_BASE_URL: 'https://relay.example.com/v1',
      OPENAI_API_KEY: 'file-secret-a',
      ROUTE_AUTH_TOKEN: 'env-secret-a',
    });
    expect(child.ROUTE_B_SOURCE).toBeUndefined();
    expect(child.UNRELATED_API_KEY).toBeUndefined();
    expect(Object.values(child)).not.toContain('secret-b-must-not-cross');
  });
});
