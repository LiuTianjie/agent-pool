import { describe, expect, it } from 'vitest';
import { isOfficialRunner, officialFleetTotals } from './officialFleet';
import type { RunnerNodePublic } from './types';

function node(input: Partial<RunnerNodePublic>): RunnerNodePublic {
  return {
    id: 'node-1',
    name: 'Runner',
    status: 'online',
    maxConcurrency: 4,
    activeLeases: 1,
    activeJobs: [],
    lastSeenAt: new Date(0).toISOString(),
    operatorType: 'community',
    supportsDirectWebhooks: false,
    completedToday: 0,
    earnedToday: 0,
    certifications: [],
    ...input,
  };
}

describe('official fleet view helpers', () => {
  it('marks Official only from the server-derived operatorType', () => {
    expect(isOfficialRunner(node({ operatorType: 'official' }))).toBe(true);
    expect(isOfficialRunner(node({ operatorType: 'community' }))).toBe(false);
    expect(isOfficialRunner(node({ name: 'Official Fleet', operatorType: undefined }))).toBe(false);
  });

  it('aggregates only reported node telemetry', () => {
    expect(
      officialFleetTotals([
        node({ id: 'one', maxConcurrency: 8, activeLeases: 3 }),
        node({ id: 'two', status: 'offline', maxConcurrency: 5, activeLeases: 0 }),
      ]),
    ).toEqual({ onlineNodes: 1, activeLeases: 3, maxConcurrency: 13 });
  });
});
