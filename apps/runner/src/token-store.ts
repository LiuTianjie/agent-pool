import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TokenStoreOptions {
  homeDirectory?: string;
  stateDirectory?: string;
}

export class TokenStore {
  readonly directory: string;
  readonly tokenFile: string;

  constructor(options: TokenStoreOptions = {}) {
    this.directory =
      options.stateDirectory ?? join(options.homeDirectory ?? homedir(), '.agentpool');
    this.tokenFile = join(this.directory, 'token');
  }

  async read(): Promise<string | null> {
    try {
      const stat = await lstat(this.tokenFile);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Agent Pool token path is not a regular file.');
      }
      await chmod(this.tokenFile, 0o600);
      const token = (await readFile(this.tokenFile, 'utf8')).trim();
      return token || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(token: string): Promise<void> {
    const normalized = token.trim();
    if (!normalized || /[\r\n]/u.test(normalized)) {
      throw new Error('The platform returned an invalid token.');
    }

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporaryFile = join(
      this.directory,
      `.token-${process.pid}-${randomBytes(8).toString('hex')}`,
    );

    try {
      await writeFile(temporaryFile, `${normalized}\n`, { flag: 'wx', mode: 0o600 });
      await chmod(temporaryFile, 0o600);
      await rename(temporaryFile, this.tokenFile);
      await chmod(this.tokenFile, 0o600);
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<boolean> {
    try {
      await unlink(this.tokenFile);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
