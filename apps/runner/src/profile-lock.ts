import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TokenStore } from './token-store.js';

const LOCK_VERSION = 1;
const BUSY_MESSAGE =
  'Runner profile is busy in another Agent Pool CLI process. Wait for it to finish or interrupt that command first.';

interface LockRecord {
  version: typeof LOCK_VERSION;
  pid: number;
  processStartedAtMs: number;
  ownerMarker: string;
}

export interface RunnerProfileLock {
  release(): Promise<void>;
}

export class RunnerProfileBusyError extends Error {
  constructor() {
    super(BUSY_MESSAGE);
    this.name = 'RunnerProfileBusyError';
  }
}

/**
 * Cross-process exclusion for the server's stable Runner node identity.
 *
 * The canonical file is published with an atomic hard link only after its
 * metadata is durable, so a crash cannot expose a half-written lock. The file
 * deliberately contains no platform token, task, prompt, or model output.
 */
export class RunnerProfileLockManager {
  readonly lockDirectory: string;
  private readonly owner: LockRecord;

  constructor(readonly stateDirectory: string) {
    this.lockDirectory = join(stateDirectory, 'profile-locks');
    this.owner = {
      version: LOCK_VERSION,
      pid: process.pid,
      processStartedAtMs: Math.max(0, Math.floor(Date.now() - process.uptime() * 1_000)),
      ownerMarker: randomBytes(16).toString('hex'),
    };
  }

  async acquire(profile: string): Promise<RunnerProfileLock> {
    await this.ensureDirectories();
    const lockPath = this.pathFor(profile);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidatePath = join(
        this.lockDirectory,
        `.candidate-${process.pid}-${randomBytes(12).toString('hex')}`,
      );
      await writeCandidate(candidatePath, this.owner);
      try {
        try {
          // link(2) publishes the fully-written candidate atomically and, like
          // O_EXCL, never replaces an existing profile lock.
          await link(candidatePath, lockPath);
          await chmod(lockPath, 0o600);
          return createLockHandle(lockPath, this.owner);
        } catch (error) {
          if (!isCode(error, 'EEXIST')) throw error;
        }
      } finally {
        await unlink(candidatePath).catch(() => undefined);
      }

      const observed = await readLock(lockPath);
      if (!observed || isProcessPresent(observed.record.pid)) {
        throw new RunnerProfileBusyError();
      }

      // A fixed hard-link derived from the stale owner's unguessable marker is
      // the compare-and-select step. Of any number of contenders that observed
      // this generation, exactly one can publish the reclaim link; losers never
      // unlink the canonical path and therefore cannot remove the winner's new
      // lock in a stale-read TOCTOU race.
      const reclaimPath = join(this.lockDirectory, `.reclaim-${observed.record.ownerMarker}`);
      try {
        try {
          await link(lockPath, reclaimPath);
        } catch (error) {
          if (isCode(error, 'EEXIST') || isCode(error, 'ENOENT')) {
            throw new RunnerProfileBusyError();
          }
          throw error;
        }

        // Never reclaim on a timestamp guess. Both hard links must still name
        // the exact dead generation, and signal 0 must still report ESRCH.
        const selected = await readLock(reclaimPath);
        const current = await readLock(lockPath);
        if (
          !selected ||
          !current ||
          selected.raw !== observed.raw ||
          current.raw !== observed.raw ||
          isProcessPresent(current.record.pid)
        ) {
          continue;
        }
        await unlink(lockPath).catch((error: unknown) => {
          if (!isCode(error, 'ENOENT')) throw error;
        });
      } finally {
        await unlink(reclaimPath).catch(() => undefined);
      }
    }

    throw new RunnerProfileBusyError();
  }

  async acquireMany(profiles: readonly string[]): Promise<RunnerProfileLock> {
    const locks: RunnerProfileLock[] = [];
    const uniqueProfiles = [...new Set(profiles)].sort();
    try {
      for (const profile of uniqueProfiles) locks.push(await this.acquire(profile));
    } catch (error) {
      await releaseAll(locks);
      throw error;
    }
    return {
      release: async () => releaseAll(locks),
    };
  }

  private pathFor(profile: string): string {
    const digest = createHash('sha256').update(profile).digest('hex');
    return join(this.lockDirectory, `${digest}.lock`);
  }

  private async ensureDirectories(): Promise<void> {
    await ensurePrivateDirectory(this.stateDirectory);
    await ensurePrivateDirectory(this.lockDirectory);
  }
}

export function communityProfileLockKey(adapter: string, model: string): string {
  return JSON.stringify(['community', process.platform, process.arch, adapter, [model]]);
}

export function officialCellProfileLockKey(cell: {
  id: string;
  adapter: string;
  model: string;
}): string {
  return JSON.stringify(['official', `official-fleet:${cell.id}`, cell.adapter, [cell.model]]);
}

const fallbackDirectories = new WeakMap<object, string>();
let fallbackSequence = 0;

/** Production TokenStore instances always expose their state directory. The
 * fallback keeps deliberately minimal embedded/test stores isolated. */
export function profileLockManagerForTokenStore(
  tokenStore: TokenStore,
  fallbackName: string,
): RunnerProfileLockManager {
  const suppliedDirectory = (tokenStore as TokenStore & { directory?: unknown }).directory;
  if (typeof suppliedDirectory === 'string' && suppliedDirectory) {
    return new RunnerProfileLockManager(suppliedDirectory);
  }
  const identity = tokenStore as unknown as object;
  let directory = fallbackDirectories.get(identity);
  if (!directory) {
    fallbackSequence += 1;
    directory = join(tmpdir(), `${fallbackName}-${process.pid}-${fallbackSequence}`);
    fallbackDirectories.set(identity, directory);
  }
  return new RunnerProfileLockManager(directory);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Runner profile lock directory must be a real directory.');
  }
  await chmod(directory, 0o700);
}

async function writeCandidate(path: string, record: LockRecord): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function readLock(path: string): Promise<{ raw: string; record: LockRecord } | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_024) return null;
    const raw = await readFile(path, 'utf8');
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (
      value.version !== LOCK_VERSION ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      !Number.isSafeInteger(value.processStartedAtMs) ||
      (value.processStartedAtMs ?? -1) < 0 ||
      typeof value.ownerMarker !== 'string' ||
      !/^[0-9a-f]{32}$/u.test(value.ownerMarker)
    ) {
      return null;
    }
    return { raw, record: value as LockRecord };
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isProcessPresent(pid: number): boolean {
  try {
    // Signal 0 checks existence/permission only; it never sends a terminating
    // signal and therefore cannot kill an unrelated or PID-reused process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, 'ESRCH');
  }
}

function createLockHandle(path: string, owner: LockRecord): RunnerProfileLock {
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      const observed = await readLock(path);
      if (!observed || !sameOwner(observed.record, owner)) return;
      await unlink(path).catch((error: unknown) => {
        if (!isCode(error, 'ENOENT')) throw error;
      });
    },
  };
}

function sameOwner(left: LockRecord, right: LockRecord): boolean {
  return (
    left.pid === right.pid &&
    left.processStartedAtMs === right.processStartedAtMs &&
    left.ownerMarker === right.ownerMarker
  );
}

async function releaseAll(locks: readonly RunnerProfileLock[]): Promise<void> {
  let failure: unknown;
  for (const lock of [...locks].reverse()) {
    try {
      await lock.release();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
