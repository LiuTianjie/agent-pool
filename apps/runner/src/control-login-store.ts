import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ControlTokenStore } from './control-token-store.js';

export interface PendingControlLogin {
  version: 1;
  server: string;
  requestFingerprint: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  intervalSeconds: number;
  scopes: string[];
}

export class ControlLoginStore {
  readonly file: string;

  constructor(controlTokenStore: Pick<ControlTokenStore, 'directory'>) {
    this.file = join(controlTokenStore.directory, 'pending-login.json');
  }

  fingerprint(server: string, request: unknown): string {
    return createHash('sha256').update(JSON.stringify({ server, request })).digest('hex');
  }

  async read(): Promise<PendingControlLogin | null> {
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Control login state path is not a regular file.');
      }
      await chmod(this.file, 0o600);
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      if (!isPendingControlLogin(parsed)) throw new Error('Control login state is invalid.');
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

  async write(login: PendingControlLogin): Promise<void> {
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

function isPendingControlLogin(value: unknown): value is PendingControlLogin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.version === 1 &&
    typeof entry.server === 'string' &&
    typeof entry.requestFingerprint === 'string' &&
    typeof entry.deviceCode === 'string' &&
    entry.deviceCode.startsWith('ap_control_device_') &&
    typeof entry.userCode === 'string' &&
    typeof entry.verificationUri === 'string' &&
    typeof entry.verificationUriComplete === 'string' &&
    typeof entry.expiresAt === 'string' &&
    Number.isFinite(Date.parse(entry.expiresAt)) &&
    Number.isSafeInteger(entry.intervalSeconds) &&
    (entry.intervalSeconds as number) > 0 &&
    Array.isArray(entry.scopes) &&
    entry.scopes.every((scope) => typeof scope === 'string')
  );
}
