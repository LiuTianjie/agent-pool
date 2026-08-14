import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { TokenStore } from '../src/token-store.js';

const stateDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    stateDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('mock HTTP e2e', () => {
  it('benchmarks, certifies, takes one lease, and submits without exposing private data', async () => {
    const nodeId = '11111111-1111-4111-8111-111111111111';
    const poolId = '22222222-2222-4222-8222-222222222222';
    const claimId = '33333333-3333-4333-8333-333333333333';
    const stateDirectory = await mkdtemp(join(tmpdir(), 'agentpool-http-e2e-'));
    stateDirectories.push(stateDirectory);
    await new TokenStore({ stateDirectory }).write('ap_runner_test_token');

    const logs: string[] = [];
    const errors: string[] = [];
    let certification: Record<string, unknown> | null = null;
    let normalLeaseDelivered = false;
    let submittedOutput: unknown;

    const server = createServer(async (request, response) => {
      try {
        expect(request.headers.authorization).toBe('Bearer ap_runner_test_token');
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const body = await readJson(request);

        if (request.method === 'POST' && url.pathname === '/api/runner/nodes') {
          return json(response, 201, { nodeId, heartbeatInterval: 60 });
        }
        if (request.method === 'DELETE' && url.pathname === `/api/runner/nodes/${nodeId}`) {
          response.writeHead(204).end();
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/runner/benchmarks') {
          expect((body as { nodeId?: string }).nodeId).toBe(nodeId);
          return json(response, 201, {
            benchmarkId: 'benchmark-http-e2e',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            leases: [0, 1].map((index) => ({
              leaseId: `benchmark-lease-${index}`,
              unitId: `benchmark-unit-${index}`,
              poolId: 'benchmark-http-e2e',
              category: 'other',
              requestedAgent: 'mock',
              requestedModel: 'mock-v1',
              reward: 0,
              instruction: `PRIVATE BENCHMARK PROMPT ${index}`,
              input: { text: `abcdef${index}`, nonce: `PRIVATE-NONCE-${index}` },
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            })),
          });
        }
        if (
          request.method === 'POST' &&
          url.pathname === '/api/runner/benchmarks/benchmark-http-e2e/results'
        ) {
          const results = (body as { results: Array<{ output: unknown }> }).results;
          expect(results[0]?.output).toEqual({
            reversed: '0fedcba',
            uppercase: 'ABCDEF0',
            grouped: 'abc-def-0',
            length: 7,
          });
          certification = {
            adapter: 'mock',
            model: 'mock-v1',
            certified: true,
            certifiedConcurrency: 2,
            p50Ms: 3,
            p95Ms: 5,
            successRate: 1,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          };
          return json(response, 200, certification);
        }
        if (request.method === 'GET' && url.pathname === '/api/runner/capacity') {
          if (!certification) return json(response, 404, { error: 'missing' });
          return json(response, 200, certification);
        }
        if (request.method === 'GET' && url.pathname === '/api/runner/jobs') {
          expect(url.searchParams.get('nodeId')).toBe(nodeId);
          return json(response, 200, {
            generatedAt: new Date().toISOString(),
            jobs: [
              {
                id: poolId,
                title: 'Private mock Pool',
                status: 'queued',
                category: 'text',
                publicSummary: 'Safe public summary',
                requestedAgent: 'mock',
                requestedModel: 'mock-v1',
                deliveryMode: 'platform',
                maxUnitSeconds: 60,
                maxAttempts: 2,
                acceptanceMode: 'non_empty',
                deliveryFormat: 'text',
                deliveryMaxBytes: 65_536,
                pilot: false,
                availableUnits: 1,
                rewardPerUnit: 7,
                claimableUntil: new Date(Date.now() + 60_000).toISOString(),
              },
            ],
          });
        }
        if (request.method === 'POST' && url.pathname === '/api/runner/claims') {
          expect(body).toEqual({ nodeId, poolId, maxUnits: 1 });
          return json(response, 201, { claim: claim(normalLeaseDelivered) });
        }
        if (request.method === 'GET' && url.pathname === `/api/runner/claims/${claimId}`) {
          return json(response, 200, { claim: claim(normalLeaseDelivered) });
        }
        if (
          request.method === 'POST' &&
          url.pathname === `/api/runner/nodes/${nodeId}/leases/poll`
        ) {
          expect((body as { claimId?: string }).claimId).toBe(claimId);
          if (normalLeaseDelivered) return json(response, 200, { lease: null });
          normalLeaseDelivered = true;
          return json(response, 200, {
            lease: {
              leaseId: 'normal-private-lease',
              unitId: 'normal-private-unit',
              poolId,
              category: 'text',
              requestedAgent: 'mock',
              requestedModel: 'mock-v1',
              reward: 7,
              instruction: 'PRIVATE NORMAL PROMPT',
              input: { __mockOutput: 'PRIVATE NORMAL OUTPUT' },
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          });
        }
        if (request.method === 'POST' && url.pathname.endsWith('/progress')) {
          response.writeHead(204).end();
          return;
        }
        if (request.method === 'POST' && url.pathname.endsWith('/submit')) {
          submittedOutput = (body as { output: unknown }).output;
          response.writeHead(204).end();
          return;
        }
        if (request.method === 'POST' && url.pathname.endsWith('/heartbeat')) {
          response.writeHead(204).end();
          return;
        }
        json(response, 404, { error: 'unknown route' });
      } catch (error) {
        json(response, 500, { error: error instanceof Error ? error.message : 'test failure' });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not start');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const output = {
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
    };
    const environment = { ...process.env, AGENTPOOL_STATE_DIR: stateDirectory };

    try {
      expect(
        await runCli(
          [
            '--server',
            serverUrl,
            'benchmark',
            '--agent',
            'mock',
            '--model',
            'mock-v1',
            '--concurrency',
            '2',
          ],
          { output, environment },
        ),
      ).toBe(0);
      expect(
        await runCli(
          [
            '--server',
            serverUrl,
            'once',
            '--pool',
            poolId,
            '--agent',
            'mock',
            '--model',
            'mock-v1',
          ],
          { output, environment },
        ),
      ).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(errors).toEqual([]);
    expect(submittedOutput).toBe('PRIVATE NORMAL OUTPUT');
    const terminal = logs.join('\n');
    expect(terminal).not.toContain('PRIVATE BENCHMARK');
    expect(terminal).not.toContain('PRIVATE-NONCE');
    expect(terminal).not.toContain('PRIVATE NORMAL');
    expect(terminal).toContain('CERTIFIED');

    function claim(exhausted: boolean): Record<string, unknown> {
      return {
        id: claimId,
        nodeId,
        poolId,
        poolTitle: 'Private mock Pool',
        requestedAgent: 'mock',
        requestedModel: 'mock-v1',
        deliveryMode: 'platform',
        maxUnits: 1,
        claimedUnits: exhausted ? 1 : 0,
        remainingUnits: exhausted ? 0 : 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: exhausted ? 'exhausted' : 'active',
        createdAt: new Date().toISOString(),
      };
    }
  });

  it('revokes only a Claim created by the failing command', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'agentpool-claim-failure-'));
    stateDirectories.push(stateDirectory);
    await new TokenStore({ stateDirectory }).write('ap_runner_claim_failure_token');
    const nodeId = '44444444-4444-4444-8444-444444444444';
    const poolId = '55555555-5555-4555-8555-555555555555';
    const claimId = '66666666-6666-4666-8666-666666666666';
    let revocations = 0;

    const currentClaim = (status: 'active' | 'revoked' = 'active') => ({
      id: claimId,
      nodeId,
      poolId,
      poolTitle: 'Failure boundary Pool',
      requestedAgent: 'mock',
      requestedModel: 'mock-v1',
      deliveryMode: 'platform',
      maxUnits: 1,
      claimedUnits: 0,
      remainingUnits: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status,
      createdAt: new Date().toISOString(),
    });
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const body = await readJson(request);
      if (request.method === 'POST' && url.pathname === '/api/runner/nodes') {
        return json(response, 201, { nodeId, heartbeatInterval: 60 });
      }
      if (request.method === 'DELETE' && url.pathname === `/api/runner/nodes/${nodeId}`) {
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/runner/capacity') {
        return json(response, 200, {
          adapter: 'mock',
          model: 'mock-v1',
          certified: true,
          certifiedConcurrency: 1,
          p50Ms: 1,
          p95Ms: 2,
          successRate: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/runner/jobs') {
        return json(response, 200, {
          generatedAt: new Date().toISOString(),
          jobs: [
            {
              id: poolId,
              title: 'Failure boundary Pool',
              status: 'queued',
              category: 'text',
              publicSummary: 'Safe summary',
              requestedAgent: 'mock',
              requestedModel: 'mock-v1',
              deliveryMode: 'platform',
              maxUnitSeconds: 60,
              maxAttempts: 2,
              acceptanceMode: 'non_empty',
              deliveryFormat: 'text',
              deliveryMaxBytes: 65_536,
              pilot: false,
              availableUnits: 1,
              rewardPerUnit: 1,
              claimableUntil: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/runner/claims') {
        expect(body).toEqual({ nodeId, poolId, maxUnits: 1 });
        return json(response, 201, { claim: currentClaim() });
      }
      if (request.method === 'GET' && url.pathname === `/api/runner/claims/${claimId}`) {
        return json(response, 200, { claim: currentClaim() });
      }
      if (request.method === 'DELETE' && url.pathname === `/api/runner/claims/${claimId}`) {
        revocations += 1;
        return json(response, 200, { claim: currentClaim('revoked') });
      }
      if (request.method === 'POST' && url.pathname.endsWith('/leases/poll')) {
        return json(response, 503, { error: 'intentional failure' });
      }
      return json(response, 404, { error: 'unknown route' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not start');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const environment = { ...process.env, AGENTPOOL_STATE_DIR: stateDirectory };
    const output = { log: () => undefined, error: () => undefined };

    try {
      await expect(
        runCli(
          [
            '--server',
            serverUrl,
            'claim',
            '--pool',
            poolId,
            '--units',
            '1',
            '--agent',
            'mock',
            '--model',
            'mock-v1',
          ],
          { output, environment },
        ),
      ).resolves.toBe(1);
      expect(revocations).toBe(1);

      await expect(
        runCli(['--server', serverUrl, 'claim', '--claim', claimId], {
          output,
          environment,
        }),
      ).resolves.toBe(1);
      expect(revocations).toBe(1);

      await expect(
        runCli(['--server', serverUrl, 'cancel', '--claim', claimId], {
          output,
          environment,
        }),
      ).resolves.toBe(0);
      expect(revocations).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
