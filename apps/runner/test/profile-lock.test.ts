import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RunnerProfileLockManager } from '../src/profile-lock.js';

const temporaryDirectories: string[] = [];

async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentpool-profile-lock-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Runner profile lock', () => {
  it('excludes the same profile while allowing a different profile', async () => {
    const directory = await temporaryStateDirectory();
    const first = new RunnerProfileLockManager(directory);
    const second = new RunnerProfileLockManager(directory);
    const active = await first.acquire('mock/mock-v1');

    await expect(second.acquire('mock/mock-v1')).rejects.toThrow('Runner profile is busy');
    const parallel = await second.acquire('mock/mock-v2');

    await parallel.release();
    await active.release();
    await expect(second.acquire('mock/mock-v1')).resolves.toBeDefined();
  });

  it('publishes private files and recovers only a lock whose PID no longer exists', async () => {
    const directory = await temporaryStateDirectory();
    const first = new RunnerProfileLockManager(directory);
    const abandoned = await first.acquire('mock/mock-v1');
    const lockName = (await readdir(first.lockDirectory)).find((name) => name.endsWith('.lock'));
    expect(lockName).toBeDefined();
    const lockPath = join(first.lockDirectory, lockName!);
    const record = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      'ownerMarker',
      'pid',
      'processStartedAtMs',
      'version',
    ]);
    record.pid = 2_147_483_647;
    await writeFile(lockPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await chmod(lockPath, 0o600);

    const recovered = await new RunnerProfileLockManager(directory).acquire('mock/mock-v1');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(first.lockDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);

    await abandoned.release();
    await recovered.release();
  });

  it('elects one reclaimer and never lets a stale-read loser unlink the new owner', async () => {
    const directory = await temporaryStateDirectory();
    const seed = new RunnerProfileLockManager(directory);
    await seed.acquire('mock/mock-v1');
    const lockName = (await readdir(seed.lockDirectory)).find((name) => name.endsWith('.lock'))!;
    const lockPath = join(seed.lockDirectory, lockName);
    const stale = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
    stale.pid = 2_147_483_647;
    await writeFile(lockPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

    const first = new RunnerProfileLockManager(directory);
    const second = new RunnerProfileLockManager(directory);
    const results = await Promise.allSettled([
      first.acquire('mock/mock-v1'),
      second.acquire('mock/mock-v1'),
    ]);
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof first.acquire>>> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toContain('Runner profile is busy');
    await expect(new RunnerProfileLockManager(directory).acquire('mock/mock-v1')).rejects.toThrow(
      'Runner profile is busy',
    );

    await acquired[0]!.value.release();
    const afterRelease = await new RunnerProfileLockManager(directory).acquire('mock/mock-v1');
    await afterRelease.release();
  });

  it('releases every acquired profile when a multi-profile acquisition fails', async () => {
    const directory = await temporaryStateDirectory();
    const blocker = new RunnerProfileLockManager(directory);
    const blocked = await blocker.acquire('profile-b');
    const contender = new RunnerProfileLockManager(directory);

    await expect(contender.acquireMany(['profile-a', 'profile-b'])).rejects.toThrow(
      'Runner profile is busy',
    );
    const releasedProfile = await blocker.acquire('profile-a');

    await releasedProfile.release();
    await blocked.release();
  });
});
