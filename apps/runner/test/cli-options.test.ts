import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

describe('CLI polling options', () => {
  it('rejects a polling interval below the three-second floor before connecting', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    let connected = false;

    const exitCode = await runCli(
      ['claim', '--claim', '11111111-1111-4111-8111-111111111111', '--poll-interval', '2999'],
      {
        apiFactory: () => {
          connected = true;
          throw new Error('must not connect');
        },
        output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
      },
    );

    expect(exitCode).toBe(1);
    expect(connected).toBe(false);
    expect(logs).toEqual([]);
    expect(errors).toEqual(['--poll-interval must be an integer from 3000 to 60000.']);
  });

  it('has no unbounded online execution path', async () => {
    for (const command of ['online', 'serve']) {
      const errors: string[] = [];
      let connected = false;
      const exitCode = await runCli([command], {
        apiFactory: () => {
          connected = true;
          throw new Error('must not connect');
        },
        output: { log: () => undefined, error: (message) => errors.push(message) },
      });

      expect(exitCode).toBe(1);
      expect(connected).toBe(false);
      expect(errors.join('\n')).toContain('Unlimited online mode is disabled');
    }
  });

  it('documents direct webhook delivery as an explicit opt-in', async () => {
    const logs: string[] = [];
    const exitCode = await runCli(['help'], {
      output: { log: (message) => logs.push(message), error: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toContain('--allow-webhooks');
    expect(logs.join('\n')).toContain('cancel --claim');
  });
});
