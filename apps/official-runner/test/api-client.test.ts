import { describe, expect, it } from 'vitest';

import { RunnerTransportError } from '../../runner/src/api-client.js';
import { OfficialFleetApiClient } from '../src/api-client.js';
import type { FleetCellConfig } from '../src/types.js';

const claim = {
  id: '00000000-0000-4000-8000-000000000010',
  nodeId: '00000000-0000-4000-8000-000000000020',
  poolId: '00000000-0000-4000-8000-000000000011',
  poolTitle: 'Public pool title',
  requestedAgent: 'mock',
  requestedModel: 'mock-v1',
  deliveryMode: 'platform',
  maxUnits: 2,
  claimedUnits: 0,
  remainingUnits: 2,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  status: 'active',
  createdAt: new Date().toISOString(),
} as const;

const fleetState = {
  operatorType: 'official',
  fleet: {
    ownerId: '00000000-0000-4000-8000-000000000012',
    mode: 'standby',
    updatedAt: new Date().toISOString(),
  },
  claims: [claim],
};

const cell: FleetCellConfig = {
  id: 'mock-primary',
  adapter: 'mock',
  model: 'mock-v1',
  allowWebhooks: false,
  routes: [{ id: 'local', kind: 'mock', concurrency: 2, environment: {}, secretEnvRefs: {} }],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Official Fleet platform client', () => {
  it('starts device auth with the fixed official client identity', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = new OfficialFleetApiClient({
      server: 'http://127.0.0.1:3000',
      clientVersion: 'test',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return json(
          {
            deviceCode: 'd'.repeat(48),
            userCode: 'ABCD-EFGH',
            verificationUri: 'http://127.0.0.1:3000/device',
            expiresIn: 600,
            interval: 3,
          },
          201,
        );
      },
    });
    await api.startDeviceLogin();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      client: 'agentpool-official-fleet',
    });
    expect(calls[0]?.init?.headers).not.toHaveProperty('Authorization');
  });

  it('uses a stable nested node identity and always scopes official poll to claimId', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const api = new OfficialFleetApiClient({
      server: 'http://127.0.0.1:3000',
      token: 'ap_runner_official-test',
      clientVersion: 'agentpool-official-fleet/test',
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
        calls.push({ path, body });
        if (path === '/api/runner/nodes') {
          return json(
            {
              nodeId: '00000000-0000-4000-8000-000000000020',
              heartbeatInterval: 15,
            },
            201,
          );
        }
        if (path.endsWith('/leases/poll')) return json({ lease: null });
        if (path === '/api/runner/official-fleet') return json(fleetState);
        throw new Error(`Unexpected path ${path}`);
      },
    }).withScope(cell);
    const node = await api.registerNode({
      adapter: 'mock',
      models: ['mock-v1'],
      concurrency: 2,
      clientVersion: 'ignored-public-client',
      platform: 'linux',
      arch: 'x64',
      supportsDirectWebhooks: false,
    });
    await api.pollLease(node.nodeId, {
      adapter: 'mock',
      models: ['mock-v1'],
      claimId: claim.id,
    });

    expect(calls[0]?.body).toMatchObject({
      name: 'official-fleet:mock-primary',
      runnerVersion: 'agentpool-official-fleet/test',
      maxConcurrency: 2,
      adapters: [{ adapter: 'mock', supportedModels: ['mock-v1'] }],
    });
    expect(calls.find((call) => call.path.endsWith('/leases/poll'))?.body).toEqual({
      adapter: 'mock',
      models: ['mock-v1'],
      claimId: claim.id,
    });
  });

  it('creates and cancels only explicit bounded grants with a recoverable idempotency key', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; idempotencyKey?: string }> =
      [];
    const api = new OfficialFleetApiClient({
      server: 'http://127.0.0.1:3000',
      token: 'ap_runner_official-test',
      clientVersion: 'test',
      fetchImpl: async (url, init) => {
        const method = init?.method ?? 'GET';
        calls.push({
          method,
          path: new URL(String(url)).pathname,
          ...(typeof (init?.headers as Headers | undefined)?.get === 'function'
            ? { idempotencyKey: (init?.headers as Headers).get('Idempotency-Key') ?? undefined }
            : {
                idempotencyKey: (init?.headers as Record<string, string> | undefined)?.[
                  'Idempotency-Key'
                ],
              }),
          ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
        });
        if (method === 'POST') return json({ claim }, 201);
        return json({ claim: { ...claim, status: 'revoked' } });
      },
    });
    await expect(
      api.createClaimRequest(
        { nodeId: claim.nodeId, poolId: claim.poolId, maxUnits: 2 },
        'official-claim-0001',
      ),
    ).resolves.toMatchObject({ claim: { id: claim.id, nodeId: claim.nodeId, maxUnits: 2 } });
    await api.cancelClaim(claim.id);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/runner/claims',
        idempotencyKey: 'official-claim-0001',
        body: { nodeId: claim.nodeId, poolId: claim.poolId, maxUnits: 2 },
      },
      { method: 'DELETE', path: `/api/runner/claims/${claim.id}` },
    ]);
  });

  it('rejects non-official state and does not infer operator identity from names', async () => {
    const api = new OfficialFleetApiClient({
      server: 'http://127.0.0.1:3000',
      token: 'ap_runner_community-test',
      clientVersion: 'test',
      fetchImpl: async () =>
        json({ ...fleetState, operatorType: 'community', displayName: 'Official Fleet' }),
    });
    await expect(api.getOfficialFleet()).rejects.toThrow('Invalid platform response');
  });

  it('treats an unreadable 2xx Claim response as ambiguous so its key can be replayed', async () => {
    const api = new OfficialFleetApiClient({
      server: 'http://127.0.0.1:3000',
      token: 'ap_runner_official-test',
      clientVersion: 'test',
      fetchImpl: async () =>
        new Response('{this is not JSON', {
          status: 201,
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-ambiguous' },
        }),
    });
    await expect(
      api.createClaimRequest(
        { nodeId: claim.nodeId, poolId: claim.poolId, maxUnits: 1 },
        'official-claim-0002',
      ),
    ).rejects.toMatchObject({
      name: RunnerTransportError.name,
      code: 'AMBIGUOUS_RESPONSE',
      requestId: 'req-ambiguous',
    });
  });
});
