import { describe, expect, it } from 'vitest';

import { OfficialFleetApiClient, type OfficialClaim } from '../src/api-client.js';
import { findCellForClaim, runBoundedClaim } from '../src/fleet-service.js';
import type { OfficialFleetConfig } from '../src/types.js';

const claim: OfficialClaim = {
  id: '00000000-0000-4000-8000-000000000030',
  nodeId: '00000000-0000-4000-8000-000000000034',
  poolId: '00000000-0000-4000-8000-000000000031',
  poolTitle: 'Bounded smoke',
  requestedAgent: 'mock',
  requestedModel: 'mock-v1',
  deliveryMode: 'platform',
  maxUnits: 1,
  claimedUnits: 0,
  remainingUnits: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  status: 'active',
  createdAt: new Date().toISOString(),
};

const config: OfficialFleetConfig = {
  version: 'agentpool-official-fleet/1',
  pollIntervalMs: 3_000,
  cells: [
    {
      id: 'mock-cell',
      adapter: 'mock',
      model: 'mock-v1',
      allowWebhooks: false,
      routes: [
        { id: 'mock-relay', kind: 'mock', concurrency: 1, environment: {}, secretEnvRefs: {} },
      ],
    },
  ],
};

const lease = {
  leaseId: '00000000-0000-4000-8000-000000000032',
  unitId: '00000000-0000-4000-8000-000000000033',
  poolId: claim.poolId,
  category: 'text',
  requestedAgent: 'mock',
  requestedModel: 'mock-v1',
  reward: 5,
  instruction: 'Return the explicit mock output.',
  input: { __mockOutput: 'done' },
  delivery: { mode: 'platform' },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function response(value: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('bounded Official Fleet execution', () => {
  it('selects only the exact configured execution profile', () => {
    expect(findCellForClaim(config, claim).id).toBe('mock-cell');
    expect(() =>
      findCellForClaim(config, { ...claim, requestedModel: 'another-exact-model' }),
    ).toThrow(/exact adapter\/model/u);
  });

  it('uses the mock Relay end to end and retries delivery without rerunning the Agent', async () => {
    let pollCount = 0;
    let submitCount = 0;
    const progressBodies: Array<Record<string, unknown>> = [];
    const submitBodies: string[] = [];
    const pollBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (method === 'POST' && url.pathname === '/api/runner/nodes') {
        return response(
          {
            nodeId: '00000000-0000-4000-8000-000000000034',
            heartbeatInterval: 3_600,
          },
          201,
        );
      }
      if (method === 'GET' && url.pathname === '/api/runner/capacity') {
        return response({
          adapter: 'mock',
          model: 'mock-v1',
          certified: true,
          certifiedConcurrency: 1,
          p50Ms: 10,
          p95Ms: 20,
          successRate: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (method === 'POST' && url.pathname.endsWith('/leases/poll')) {
        pollBodies.push(body);
        pollCount += 1;
        return pollCount === 1 ? response({ lease }) : response(null, 204);
      }
      if (method === 'GET' && url.pathname === '/api/runner/official-fleet') {
        return response({
          operatorType: 'official',
          fleet: {
            ownerId: '00000000-0000-4000-8000-000000000035',
            mode: 'standby',
            updatedAt: new Date().toISOString(),
          },
        });
      }
      if (method === 'GET' && url.pathname === `/api/runner/claims/${claim.id}`) {
        return response({
          claim: {
            ...claim,
            claimedUnits: 1,
            remainingUnits: 0,
            status: 'exhausted',
          },
        });
      }
      if (method === 'POST' && url.pathname.endsWith('/progress')) {
        progressBodies.push(body);
        return response(null, 204);
      }
      if (method === 'POST' && url.pathname.endsWith('/submit')) {
        submitCount += 1;
        submitBodies.push(String(init?.body));
        return submitCount < 3
          ? response({ error: 'temporary' }, 503)
          : response({ status: 'accepted' });
      }
      if (method === 'DELETE' && url.pathname.startsWith('/api/runner/nodes/')) {
        return response(null, 204);
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    };
    const api = new OfficialFleetApiClient({
      server: 'http://127.0.0.1:3000',
      token: 'ap_runner_official-test',
      clientVersion: 'test',
      fetchImpl,
    });
    const summary = await runBoundedClaim({
      config,
      api,
      claim,
      signal: new AbortController().signal,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      clientVersion: 'agentpool-official-fleet/test',
    });

    expect(summary.claimId).toBe(claim.id);
    expect(summary.terminalStatus).toBe('exhausted');
    expect(pollBodies).toEqual([
      { adapter: 'mock', models: ['mock-v1'], claimId: claim.id },
      { adapter: 'mock', models: ['mock-v1'], claimId: claim.id },
    ]);
    expect(submitCount).toBe(3);
    expect(new Set(submitBodies).size).toBe(1);
    expect(progressBodies.filter((body) => body.stage === 'starting')).toHaveLength(1);
    expect(progressBodies.filter((body) => body.stage === 'completed')).toHaveLength(1);
  }, 15_000);
});
