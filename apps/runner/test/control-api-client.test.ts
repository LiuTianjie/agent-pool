import { describe, expect, it, vi } from 'vitest';

import { CONTROL_PROTOCOL, ControlApiClient, ControlApiError } from '../src/control-api-client.js';

describe('ControlApiClient', () => {
  it('sends the control token only as Authorization and forwards idempotency metadata', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ task: { id: 'task-1' } }), {
          status: 201,
          headers: {
            'x-request-id': 'request-from-server',
            'idempotency-replayed': 'true',
          },
        }),
    );
    const api = new ControlApiClient('http://127.0.0.1:3000', 'ap_control_private', fetch);

    await expect(
      api.request({
        method: 'POST',
        route: '/api/pools',
        body: { title: 'Task' },
        idempotencyKey: 'apctl-request-123',
      }),
    ).resolves.toMatchObject({
      status: 201,
      data: { task: { id: 'task-1' } },
      requestId: 'request-from-server',
      idempotencyReplayed: true,
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:3000/api/pools');
    expect(url).not.toContain('ap_control_private');
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer ap_control_private',
        'Idempotency-Key': 'apctl-request-123',
        'X-AgentPool-Protocol': CONTROL_PROTOCOL,
      }),
    });
    expect(init?.body).not.toContain('ap_control_private');
  });

  it('preserves stable server error details, retryability, retry delay, and request id', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'CAPACITY_BUSY',
              message: 'Try later.',
              retryable: true,
              retryAfterMs: 2500,
              details: { adapter: 'codex' },
            },
          }),
          { status: 409, headers: { 'x-request-id': 'request-error' } },
        ),
    );
    const api = new ControlApiClient('http://127.0.0.1:3000', undefined, fetch);

    const error = await api
      .request({ route: '/api/test' })
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ControlApiError);
    expect(error).toMatchObject({
      code: 'CAPACITY_BUSY',
      message: 'Try later.',
      options: {
        status: 409,
        retryable: true,
        retryAfterMs: 2500,
        details: { adapter: 'codex' },
        requestId: 'request-error',
      },
    });
  });

  it('uses Retry-After when a rate-limit body has no retry delay', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Wait.' } }), {
          status: 429,
          headers: { 'retry-after': '2.5' },
        }),
    );
    const api = new ControlApiClient('http://127.0.0.1:3000', undefined, fetch);

    const error = await api.request({ route: '/api/test' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ControlApiError);
    expect(error).toMatchObject({
      options: { status: 429, retryable: true, retryAfterMs: 2500 },
    });
  });

  it('rejects credentials in server URLs before making a request', () => {
    expect(
      () => new ControlApiClient('https://user:password@example.com', 'ap_control_private'),
    ).toThrow('must not contain credentials');
  });

  it.each([
    ['truncated JSON', () => new Response('{"task":', { status: 201 })],
    [
      'interrupted body stream',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"task":'));
              controller.error(new Error('private stream failure'));
            },
          }),
          { status: 201 },
        ),
    ],
  ])('treats a 2xx %s as an ambiguous retryable response', async (_label, response) => {
    const api = new ControlApiClient(
      'http://127.0.0.1:3000',
      'ap_control_private',
      vi.fn(async () => {
        const value = response();
        value.headers.set('x-request-id', 'ambiguous-control');
        return value;
      }),
    );

    const error = await api
      .request({ method: 'POST', route: '/api/pools', body: { title: 'Task' } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ControlApiError);
    expect(error).toMatchObject({
      code: 'AMBIGUOUS_RESPONSE',
      options: { status: 201, retryable: true, requestId: 'ambiguous-control' },
    });
  });
});
