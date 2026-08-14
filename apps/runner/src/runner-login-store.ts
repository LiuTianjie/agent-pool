import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TokenStore } from './token-store.js';

export interface PendingRunnerLogin {
  version: 1;
  server: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  intervalSeconds: number;
}

/**
 * Community Runner device authorization state. This deliberately lives under
 * the Runner state directory and never shares a file with owner-control or
 * Official Runner credentials.
 */
export class RunnerLoginStore {
  readonly file: string;

  constructor(tokenStore: Pick<TokenStore, 'directory'>) {
    this.file = join(tokenStore.directory, 'pending-login.json');
  }

  async read(): Promise<PendingRunnerLogin | null> {
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Runner login state path is not a regular file.');
      }
      await chmod(this.file, 0o600);
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      if (!isPendingRunnerLogin(parsed)) throw new Error('Runner login state is invalid.');
      if (Date.parse(parsed.expiresAt) <= Date.now()) {
        await this.clear();
        return null;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(login: PendingRunnerLogin): Promise<void> {
    const directory = this.file.slice(0, Math.max(0, this.file.lastIndexOf('/')));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(login)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    await unlink(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function isPendingRunnerLogin(value: unknown): value is PendingRunnerLogin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.version === 1 &&
    typeof entry.server === 'string' &&
    typeof entry.deviceCode === 'string' &&
    entry.deviceCode.startsWith('ap_device_') &&
    typeof entry.userCode === 'string' &&
    typeof entry.verificationUri === 'string' &&
    typeof entry.verificationUriComplete === 'string' &&
    typeof entry.expiresAt === 'string' &&
    Number.isFinite(Date.parse(entry.expiresAt)) &&
    Number.isSafeInteger(entry.intervalSeconds) &&
    (entry.intervalSeconds as number) > 0
  );
}
