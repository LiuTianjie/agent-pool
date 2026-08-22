import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commandSearchPath, executeCommand, taskProcessEnvironment } from '../src/process.js';

const original = {
  AGENTPOOL_CONTROL_TOKEN: process.env.AGENTPOOL_CONTROL_TOKEN,
  AGENTPOOL_CONTROL_STATE_DIR: process.env.AGENTPOOL_CONTROL_STATE_DIR,
  AGENTPOOL_TEST_PROVIDER_AUTH: process.env.AGENTPOOL_TEST_PROVIDER_AUTH,
};

afterEach(() => {
  restore('AGENTPOOL_CONTROL_TOKEN', original.AGENTPOOL_CONTROL_TOKEN);
  restore('AGENTPOOL_CONTROL_STATE_DIR', original.AGENTPOOL_CONTROL_STATE_DIR);
  restore('AGENTPOOL_TEST_PROVIDER_AUTH', original.AGENTPOOL_TEST_PROVIDER_AUTH);
});

describe('task process environment', () => {
  it('scrubs control authority while preserving provider authentication environment', async () => {
    process.env.AGENTPOOL_CONTROL_TOKEN = 'ap_control_must_not_reach_task';
    process.env.AGENTPOOL_CONTROL_STATE_DIR = '/private/control/state';
    process.env.AGENTPOOL_TEST_PROVIDER_AUTH = 'provider-auth-remains';

    const result = await executeCommand(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify({token:process.env.AGENTPOOL_CONTROL_TOKEN,state:process.env.AGENTPOOL_CONTROL_STATE_DIR,provider:process.env.AGENTPOOL_TEST_PROVIDER_AUTH}))',
      ],
      { timeoutMs: 5_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ provider: 'provider-auth-remains' });
  });

  it('puts user-local and Homebrew bins ahead of a PATH that missed them', () => {
    const home = homedir();
    const path = commandSearchPath({ PATH: '/usr/bin:/bin' });
    const entries = path.split(delimiter);
    expect(entries.slice(0, 4)).toEqual([
      join(home, '.local', 'bin'),
      join(home, 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]);
    expect(entries.slice(-2)).toEqual(['/usr/bin', '/bin']);
    expect(taskProcessEnvironment({ PATH: '/usr/bin' }).PATH).toContain(
      join(home, '.local', 'bin'),
    );
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
