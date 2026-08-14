import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlIdempotencyStore } from '../src/control-idempotency-store.js';
import { ControlTokenStore } from '../src/control-token-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ControlIdempotencyStore', () => {
  it('reuses an automatic key after an ambiguous failure and removes it only after output completes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-control-idempotency-'));
    directories.push(directory);
    const tokenStore = new ControlTokenStore({ stateDirectory: directory });
    const store = new ControlIdempotencyStore(tokenStore);
    const request = {
      method: 'POST',
      route: '/api/pools',
      body: { privateInstruction: 'must never be persisted', units: [{ input: 1 }] },
    };

    const first = await store.begin('tasks.publish', request);
    const retried = await store.begin('tasks.publish', request);

    expect(retried).toEqual({ ...first, recovered: true });
    const persisted = await readFile(store.file, 'utf8');
    expect(persisted).toContain(first.key);
    expect(persisted).not.toContain('must never be persisted');

    await store.complete(first);
    const nextIntent = await store.begin('tasks.publish', request);
    expect(nextIntent.key).not.toBe(first.key);
  });

  it('accepts an explicit stable key without persisting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-control-idempotency-'));
    directories.push(directory);
    const store = new ControlIdempotencyStore(new ControlTokenStore({ stateDirectory: directory }));

    await expect(
      store.begin(
        'tasks.cancel',
        { method: 'POST', route: '/api/pools/task/cancel' },
        'caller-stable-key-1',
      ),
    ).resolves.toMatchObject({ key: 'caller-stable-key-1', automatic: false });
    await expect(readFile(store.file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to reuse or replace an ambiguous operation beyond the safe server window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-control-idempotency-'));
    directories.push(directory);
    const store = new ControlIdempotencyStore(new ControlTokenStore({ stateDirectory: directory }));
    const request = { method: 'POST', route: '/api/pools', body: { title: 'same intent' } };
    const pending = await store.begin('tasks.publish', request);
    const state = JSON.parse(await readFile(store.file, 'utf8')) as {
      entries: Record<string, { key: string; createdAt: string }>;
    };
    state.entries[pending.fingerprint]!.createdAt = new Date(
      Date.now() - 24 * 60 * 60 * 1_000,
    ).toISOString();
    await writeFile(store.file, JSON.stringify(state), { mode: 0o600 });

    await expect(store.begin('tasks.publish', request)).rejects.toMatchObject({
      code: 'AMBIGUOUS_OPERATION_EXPIRED',
    });
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toMatchObject({
      entries: { [pending.fingerprint]: { key: pending.key } },
    });
  });
});
