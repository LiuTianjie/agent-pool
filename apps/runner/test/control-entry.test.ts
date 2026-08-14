import { describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    target: {
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
    },
  };
}

describe('Control protocol at the shared binary entrypoint', () => {
  it.each([
    ['with an unnecessary --json flag', ['control', 'status', '--json', '--server']],
    ['without a --json flag', ['control', 'status', '--server']],
    ['with an empty inline value', ['control', 'status', '--server=']],
  ])('keeps a missing global server value on the control protocol %s', async (_label, args) => {
    const captured = output();
    expect(await runCli(args, { output: captured.target })).toBe(1);
    expect(captured.errors).toEqual([]);
    expect(captured.logs).toHaveLength(1);
    expect(JSON.parse(captured.logs[0]!)).toMatchObject({
      protocol: 'agentpool-control/1',
      ok: false,
      action: 'status',
      error: { code: 'MISSING_SERVER_VALUE', retryable: false },
    });
  });

  it('rejects a userinfo server without reflecting credentials or switching protocols', async () => {
    const captured = output();
    expect(
      await runCli(
        ['control', 'status', '--server', 'https://private-user:private-pass@example.test'],
        { output: captured.target },
      ),
    ).toBe(1);

    expect(captured.errors).toEqual([]);
    expect(captured.logs).toHaveLength(1);
    expect(captured.logs[0]).not.toContain('private-user');
    expect(captured.logs[0]).not.toContain('private-pass');
    expect(JSON.parse(captured.logs[0]!)).toMatchObject({
      protocol: 'agentpool-control/1',
      ok: false,
      action: 'status',
      error: { code: 'SERVER_CONTAINS_CREDENTIALS', retryable: false },
    });
  });

  it('never reflects a control token pasted as the malformed server value', async () => {
    const captured = output();
    expect(
      await runCli(['control', 'status', '--server', 'ap_control_private_mistake'], {
        output: captured.target,
      }),
    ).toBe(1);
    expect(captured.errors).toEqual([]);
    expect(captured.logs.join('\n')).not.toContain('private_mistake');
    expect(JSON.parse(captured.logs[0]!)).toMatchObject({
      protocol: 'agentpool-control/1',
      ok: false,
      action: 'status',
      error: { code: 'INVALID_SERVER', retryable: false },
    });
  });
});
