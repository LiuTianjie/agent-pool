import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ControlTokenStore } from './control-token-store.js';

interface PendingEntry {
  key: string;
  createdAt: string;
}

interface PendingFile {
  version: 1;
  entries: Record<string, PendingEntry>;
}

const SAFE_RECOVERY_WINDOW_MS = 23 * 60 * 60 * 1_000;

export class AmbiguousOperationExpiredError extends Error {
  readonly code = 'AMBIGUOUS_OPERATION_EXPIRED';

  constructor() {
    super(
      'The safe automatic recovery window expired. Reconcile the operation by action, then retry with an explicit new Idempotency-Key only if needed.',
    );
    this.name = 'AmbiguousOperationExpiredError';
  }
}

export interface IdempotencyOperation {
  fingerprint: string;
  key: string;
  automatic: boolean;
  recovered: boolean;
}

export class ControlIdempotencyStore {
  readonly file: string;
  private readonly lockDirectory: string;

  constructor(controlTokenStore: Pick<ControlTokenStore, 'directory'>) {
    this.file = join(controlTokenStore.directory, 'pending-idempotency.json');
    this.lockDirectory = join(controlTokenStore.directory, '.idempotency-lock');
  }

  async begin(
    action: string,
    request: { method: string; route: string; body?: unknown },
    explicitKey?: string,
  ): Promise<IdempotencyOperation> {
    const fingerprint = operationFingerprint(action, request);
    if (explicitKey !== undefined) {
      validateIdempotencyKey(explicitKey);
      return { fingerprint, key: explicitKey, automatic: false, recovered: true };
    }

    return this.withLock(async () => {
      const state = await this.readState();
      const current = state.entries[fingerprint];
      if (current) {
        const age = Date.now() - Date.parse(current.createdAt);
        if (!Number.isFinite(age) || age >= SAFE_RECOVERY_WINDOW_MS) {
          throw new AmbiguousOperationExpiredError();
        }
        return { fingerprint, key: current.key, automatic: true, recovered: true };
      }
      const key = `apctl-${randomUUID()}`;
      state.entries[fingerprint] = { key, createdAt: new Date().toISOString() };
      pruneEntries(state.entries);
      await this.writeState(state);
      return { fingerprint, key, automatic: true, recovered: false };
    });
  }

  async complete(operation: IdempotencyOperation): Promise<void> {
    if (!operation.automatic) return;
    await this.withLock(async () => {
      const state = await this.readState();
      if (state.entries[operation.fingerprint]?.key !== operation.key) return;
      delete state.entries[operation.fingerprint];
      await this.writeState(state);
    });
  }

  private async readState(): Promise<PendingFile> {
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Control idempotency path is not a regular file.');
      }
      await chmod(this.file, 0o600);
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      if (!isPendingFile(parsed)) throw new Error('Control idempotency state is invalid.');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, entries: {} };
      }
      throw error;
    }
  }

  private async writeState(state: PendingFile): Promise<void> {
    const directory = this.file.slice(0, Math.max(0, this.file.lastIndexOf('/')));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const parent = this.lockDirectory.slice(0, Math.max(0, this.lockDirectory.lastIndexOf('/')));
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    const deadline = Date.now() + 3_000;
    while (true) {
      try {
        await mkdir(this.lockDirectory, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await lstat(this.lockDirectory).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > 30_000) {
          await rmdir(this.lockDirectory).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error('Control idempotency state is busy.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await rmdir(this.lockDirectory).catch(() => undefined);
    }
  }
}

export function operationFingerprint(
  action: string,
  request: { method: string; route: string; body?: unknown },
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        action,
        method: request.method,
        route: request.route,
        body: request.body ?? null,
      }),
    )
    .digest('hex');
}

export function validateIdempotencyKey(key: string): void {
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(key)) {
    throw new Error(
      'Idempotency key must be 8-128 characters using letters, numbers, dot, underscore, colon, or dash.',
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function isPendingFile(value: unknown): value is PendingFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== 'object') {
    return false;
  }
  return Object.values(candidate.entries as Record<string, unknown>).every(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).key === 'string' &&
      typeof (entry as Record<string, unknown>).createdAt === 'string',
  );
}

function pruneEntries(entries: Record<string, PendingEntry>): void {
  const definitelyStaleBefore = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  for (const [fingerprint, entry] of Object.entries(entries)) {
    if (Date.parse(entry.createdAt) < definitelyStaleBefore) delete entries[fingerprint];
  }
  const sorted = Object.entries(entries).sort(([, left], [, right]) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  for (const [fingerprint] of sorted.slice(0, Math.max(0, sorted.length - 256))) {
    delete entries[fingerprint];
  }
}
