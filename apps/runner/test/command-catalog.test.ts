import { HIGH_RISK_CONTROL_SCOPES } from '@agent-pool/shared';
import { describe, expect, it } from 'vitest';

import {
  CONTROL_CLI_ACTIONS,
  CONTROL_SCOPE_PRESETS,
  RUNNER_CLI_ACTIONS,
} from '../src/command-catalog.js';
import { runCli } from '../src/cli.js';

describe('CLI command catalog', () => {
  it('covers every control dispatch action with machine-usable metadata', () => {
    const expected = [
      'help',
      'login',
      'status',
      'logout',
      'describe',
      'describe.schema',
      'dashboard',
      'network',
      'tasks.list',
      'tasks.get',
      'tasks.validate',
      'tasks.publish',
      'tasks.launch',
      'tasks.cancel',
      'tasks.results',
      'tasks.review',
      'wallet.show',
      'wallet.ledger',
      'wallet.withdrawals',
      'wallet.topup',
      'wallet.withdraw',
      'runners.list',
      'fleet.get',
      'fleet.update',
      'profile.get',
      'profile.update',
      'capacity.catalog',
      'capacity.quote',
      'devices.list',
      'devices.revoke',
      'devices.preview',
      'devices.approve',
      'events',
    ];
    expect(CONTROL_CLI_ACTIONS.map(({ action }) => action).sort()).toEqual(expected.sort());
    expect(new Set(CONTROL_CLI_ACTIONS.map(({ action }) => action)).size).toBe(
      CONTROL_CLI_ACTIONS.length,
    );
    for (const action of CONTROL_CLI_ACTIONS) {
      expect(action.command).toMatch(/^agentpool control /u);
      expect(action.outputMode).toMatch(/^jsonl?$/u);
      expect(Array.isArray(action.options)).toBe(true);
    }
  });

  it('documents every Community machine action as manual and bounded', () => {
    const expected = [
      'help',
      'agents.list',
      'tasks.list',
      'claims.run',
      'claims.run',
      'claims.cancel',
      'runner.status',
    ];
    expect(RUNNER_CLI_ACTIONS.map(({ action }) => action).sort()).toEqual(expected.sort());
    expect(
      RUNNER_CLI_ACTIONS.filter(({ action }) => action !== 'help').every(
        ({ claimMode }) => claimMode === 'manual_bounded_only',
      ),
    ).toBe(true);
  });

  it('keeps the default preset read-only and expands presets in the login catalog', () => {
    expect(
      CONTROL_SCOPE_PRESETS.readonly.some((scope) =>
        HIGH_RISK_CONTROL_SCOPES.includes(scope as (typeof HIGH_RISK_CONTROL_SCOPES)[number]),
      ),
    ).toBe(false);
    const preset = CONTROL_CLI_ACTIONS.find(({ action }) => action === 'login')?.options.find(
      ({ name }) => name === 'preset',
    );
    expect(preset?.expansions).toEqual(CONTROL_SCOPE_PRESETS);
  });

  it('returns the Runner action catalog from help --json', async () => {
    const logs: string[] = [];
    expect(
      await runCli(['help', '--json'], {
        output: { log: (message) => logs.push(message), error: () => undefined },
      }),
    ).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      protocol: 'agentpool-runner/1',
      ok: true,
      action: 'help',
      data: {
        claimMode: 'manual_bounded_only',
        actions: expect.arrayContaining([
          expect.objectContaining({ action: 'agents.list' }),
          expect.objectContaining({ action: 'tasks.list' }),
          expect.objectContaining({ action: 'claims.run' }),
          expect.objectContaining({ action: 'claims.cancel' }),
          expect.objectContaining({ action: 'runner.status' }),
        ]),
      },
    });
  });
});
