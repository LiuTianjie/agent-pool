import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenStore } from '../src/token-store.js';

const homes: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('TokenStore', () => {
  it('stores only the platform token with strict permissions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentpool-token-test-'));
    homes.push(home);
    const store = new TokenStore({ homeDirectory: home });

    await store.write('platform-token-value');

    expect(await store.read()).toBe('platform-token-value');
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(store.tokenFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(store.tokenFile, 'utf8')).toBe('platform-token-value\n');
    expect(await store.clear()).toBe(true);
    expect(await store.read()).toBeNull();
  });

  it('rejects line breaks in tokens', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentpool-token-test-'));
    homes.push(home);
    const store = new TokenStore({ homeDirectory: home });
    await expect(store.write('bad\ntoken')).rejects.toThrow('invalid token');
  });
});
