import { homedir } from 'node:os';
import { join } from 'node:path';

import { TokenStore, type TokenStoreOptions } from './token-store.js';

export const CONTROL_TOKEN_PREFIX = 'ap_control_';

/**
 * The owner-control credential is deliberately isolated from the Runner
 * credential. Worker commands never open this directory or inject its location.
 * This is not a security boundary against a process running as the same OS user.
 */
export class ControlTokenStore extends TokenStore {
  constructor(options: TokenStoreOptions = {}) {
    super({
      ...options,
      stateDirectory:
        options.stateDirectory ?? join(options.homeDirectory ?? homedir(), '.agentpool-control'),
    });
  }

  override async write(token: string): Promise<void> {
    const normalized = token.trim();
    if (!normalized.startsWith(CONTROL_TOKEN_PREFIX)) {
      throw new Error('The platform returned an invalid control token.');
    }
    await super.write(normalized);
  }
}
