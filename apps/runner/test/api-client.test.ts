import { describe, expect, it, vi } from 'vitest';
import { AgentPoolApiClient, RunnerTransportError } from '../src/api-client.js';

describe('AgentPoolApiClient', () => {
  it('preserves the server lease-poll backoff without exposing envelope fields as a lease', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ lease: null, retryAfterMs: 7_500 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const api = new AgentPoolApiClient('http://127.0.0.1:3000', 'runner-token', fetch);

    await expect(
      api.pollLease('node-1', { adapter: 'mock', models: ['mock-v1'], claimId: 'claim-1' }),
    ).resolves.toEqual({ lease: null, retryAfterMs: 7_500 });
    expect(JSON.parse((fetch.mock.calls[0]?.[1]?.body as string) ?? '{}')).toEqual({
      adapter: 'mock',
      models: ['mock-v1'],
      claimId: 'claim-1',
    });
  });

  it('bounds an excessive lease-poll backoff and ignores an invalid one', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ lease: null, retryAfterMs: 999_999 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ lease: null, retryAfterMs: -1 }), { status: 200 }),
      );
    const api = new AgentPoolApiClient('http://127.0.0.1:3000', 'runner-token', fetch);

    await expect(
      api.pollLease('node-1', { adapter: 'mock', models: ['mock-v1'], claimId: 'claim-1' }),
    ).resolves.toEqual({ lease: null, retryAfterMs: 60_000 });
    await expect(
      api.pollLease('node-1', { adapter: 'mock', models: ['mock-v1'], claimId: 'claim-1' }),
    ).resolves.toEqual({ lease: null, retryAfterMs: undefined });
  });

  it('revokes the runner credential through the authenticated status endpoint', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const api = new AgentPoolApiClient('http://127.0.0.1:3000', 'runner-token', fetch);

    await api.revokeCredential();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:3000/api/runner/me');
    expect(init).toMatchObject({
      method: 'DELETE',
      headers: expect.objectContaining({ Authorization: 'Bearer runner-token' }),
    });
  });

  it('returns typed submit outcomes and forwards signed receipts to the receipt route', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'accepted', validation: { valid: true } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }));
    const api = new AgentPoolApiClient('http://127.0.0.1:3000', 'runner-token', fetch);
    const receipt = {
      protocol: 'agentpool-receipt/1' as const,
      leaseId: '11111111-1111-4111-8111-111111111111',
      unitId: '22222222-2222-4222-8222-222222222222',
      contractHash: 'a'.repeat(64),
      resultSha256: 'b'.repeat(64),
      decision: 'accepted' as const,
      retryable: false,
      receiptId: 'receipt-1',
      signature: 'c'.repeat(64),
    };

    await expect(api.submit(receipt.leaseId, { answer: 42 })).resolves.toEqual({
      status: 'accepted',
      validation: { valid: true },
    });
    await expect(api.receipt(receipt.leaseId, receipt)).resolves.toEqual({
      status: 'accepted',
    });

    expect(fetch.mock.calls[0]?.[0]).toBe(
      `http://127.0.0.1:3000/api/runner/leases/${receipt.leaseId}/submit`,
    );
    expect(JSON.parse((fetch.mock.calls[0]?.[1]?.body as string) ?? '{}')).toEqual({
      output: { answer: 42 },
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      `http://127.0.0.1:3000/api/runner/leases/${receipt.leaseId}/receipt`,
    );
    expect(JSON.parse((fetch.mock.calls[1]?.[1]?.body as string) ?? '{}')).toEqual(receipt);
  });

  it.each([
    ['truncated JSON', () => new Response('{"claim":', { status: 201 })],
    ['invalid claim envelope', () => new Response(JSON.stringify({ claim: {} }), { status: 201 })],
    [
      'interrupted body stream',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"claim":'));
              controller.error(new Error('private stream failure'));
            },
          }),
          { status: 201 },
        ),
    ],
  ])('marks a 2xx %s as an ambiguous retryable transport error', async (_label, response) => {
    const fetch = vi.fn(async () => {
      const value = response();
      value.headers.set('x-request-id', 'ambiguous-runner');
      return value;
    });
    const api = new AgentPoolApiClient('http://127.0.0.1:3000', 'ap_runner_private', fetch);

    const error = await api
      .createClaimRequest({ nodeId: 'node-1', poolId: 'pool-1', maxUnits: 1 }, 'stable-key')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RunnerTransportError);
    expect(error).toMatchObject({
      code: 'AMBIGUOUS_RESPONSE',
      requestId: 'ambiguous-runner',
    });
  });

  it('can safely retry an invalid 2xx Claim envelope with the identical key', async () => {
    const claim = {
      id: '11111111-1111-4111-8111-111111111111',
      nodeId: '22222222-2222-4222-8222-222222222222',
      poolId: '33333333-3333-4333-8333-333333333333',
      poolTitle: 'Task',
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
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ claim: {} }), {
          status: 201,
          headers: { 'x-request-id': 'ambiguous-create' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ claim }), {
          status: 201,
          headers: {
            'x-request-id': 'replayed-create',
            'idempotency-replayed': 'true',
          },
        }),
      );
    const api = new AgentPoolApiClient('http://127.0.0.1:3000', 'ap_runner_private', fetch);
    const input = { nodeId: claim.nodeId, poolId: claim.poolId, maxUnits: 1 };

    await expect(api.createClaimRequest(input, 'same-claim-key')).rejects.toMatchObject({
      code: 'AMBIGUOUS_RESPONSE',
      requestId: 'ambiguous-create',
    });
    await expect(api.createClaimRequest(input, 'same-claim-key')).resolves.toMatchObject({
      claim: { id: claim.id },
      requestId: 'replayed-create',
      idempotencyReplayed: true,
    });
    expect(fetch.mock.calls.map((call) => call[1]?.headers)).toEqual([
      expect.objectContaining({ 'Idempotency-Key': 'same-claim-key' }),
      expect.objectContaining({ 'Idempotency-Key': 'same-claim-key' }),
    ]);
  });
});
