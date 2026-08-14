import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlTokenStore } from '../src/control-token-store.js';
import { TokenStore } from '../src/token-store.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('ControlTokenStore', () => {
  it('uses a separate strict state directory and accepts only control credentials', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentpool-control-token-'));
    homes.push(home);
    const control = new ControlTokenStore({ homeDirectory: home });
    const runner = new TokenStore({ homeDirectory: home });

    await control.write('ap_control_secret');

    expect(control.directory).toBe(join(home, '.agentpool-control'));
    expect(runner.directory).toBe(join(home, '.agentpool'));
    expect(await control.read()).toBe('ap_control_secret');
    expect(await runner.read()).toBeNull();
    expect((await stat(control.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(control.tokenFile)).mode & 0o777).toBe(0o600);
    await expect(control.write('ap_runner_wrong_authority')).rejects.toThrow(
      'invalid control token',
    );
  });
});
