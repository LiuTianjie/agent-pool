import { describe, expect, it, vi } from 'vitest';
import { resultSha256, taskCapsuleHash } from '../src/task-contract.js';
import type { LeasePayload, TaskCapsule, WebhookReceipt } from '../src/types.js';
import {
  createPinnedLookup,
  deliverToWebhook,
  isPublicAddress,
  resolveWebhookTarget,
  validateWebhookReceipt,
  validateWebhookUrl,
} from '../src/webhook.js';

const LEASE_ID = '11111111-1111-4111-8111-111111111111';
const UNIT_ID = '22222222-2222-4222-8222-222222222222';
const CONTRACT_HASH = taskCapsuleHash(webhookCapsule());

function webhookCapsule(): TaskCapsule {
  return {
    version: 'ap-task/1',
    goal: 'Transform the record.',
    inputDescription: 'One record.',
    outputDescription: 'Return a JSON record.',
    constraints: [],
    examples: [],
    delivery: { format: 'json', maxBytes: 1_024 },
    acceptance: { mode: 'webhook', criteria: ['The receiver decides acceptance.'] },
  };
}

function webhookLease(): LeasePayload {
  return {
    leaseId: LEASE_ID,
    unitId: UNIT_ID,
    poolId: '33333333-3333-4333-8333-333333333333',
    category: 'data',
    requestedAgent: 'codex',
    requestedModel: 'exact-model',
    reward: 1,
    instruction: 'Legacy fallback.',
    input: { source: 'unit input' },
    taskCapsule: webhookCapsule(),
    contractHash: CONTRACT_HASH,
    delivery: {
      mode: 'webhook',
      url: 'https://receiver.example/v1/delivery',
      protocol: 'agentpool-webhook/1',
      unitReference: 'publisher-row-7',
      ordinal: 6,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function receipt(resultSha256: string): WebhookReceipt {
  return {
    protocol: 'agentpool-receipt/1',
    leaseId: LEASE_ID,
    unitId: UNIT_ID,
    contractHash: CONTRACT_HASH,
    resultSha256,
    decision: 'accepted',
    retryable: false,
    receiptId: 'receipt-7',
    signature: 'b'.repeat(64),
  };
}

describe('direct webhook policy', () => {
  it('rejects non-HTTPS, credentials, loopback, private, and link-local targets', async () => {
    expect(() => validateWebhookUrl('http://receiver.example/hook')).toThrow();
    expect(() => validateWebhookUrl('https://user:pass@receiver.example/hook')).toThrow();
    expect(() => validateWebhookUrl('https://127.0.0.1/hook')).toThrow();
    expect(() => validateWebhookUrl('https://[::1]/hook')).toThrow();
    expect(isPublicAddress('10.1.2.3')).toBe(false);
    expect(isPublicAddress('169.254.1.2')).toBe(false);
    expect(isPublicAddress('fc00::1')).toBe(false);
    expect(isPublicAddress('fe80::1')).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    await expect(
      resolveWebhookTarget('https://receiver.example/hook', async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.8', family: 4 },
      ]),
    ).rejects.toThrow('not allowed');
  });

  it('pins the validated DNS address and sends reconciliation context with the result', async () => {
    const post = vi.fn(async (target, body: string) => {
      const decoded = JSON.parse(body) as Record<string, unknown>;
      return {
        status: 200,
        body: JSON.stringify(receipt(decoded.resultSha256 as string)),
      };
    });
    const output = { answer: 42 };

    await expect(
      deliverToWebhook(webhookLease(), output, {
        resolveAll: async () => [{ address: '8.8.8.8', family: 4 }],
        post,
      }),
    ).resolves.toMatchObject({ decision: 'accepted', receiptId: 'receipt-7' });

    const [target, encodedBody] = post.mock.calls[0] ?? [];
    const body = JSON.parse(encodedBody as string) as Record<string, unknown>;
    expect(target).toMatchObject({ address: '8.8.8.8', family: 4 });
    expect(body).toMatchObject({
      protocol: 'agentpool-delivery/1',
      leaseId: LEASE_ID,
      unitId: UNIT_ID,
      contractHash: CONTRACT_HASH,
      unit: {
        id: UNIT_ID,
        reference: 'publisher-row-7',
        ordinal: 6,
        input: { source: 'unit input' },
      },
      result: output,
    });
    expect(body.resultSha256).toBe(resultSha256(output));

    const lookup = createPinnedLookup({
      url: new URL('https://receiver.example/hook'),
      address: '8.8.8.8',
      family: 4,
    });
    const one = vi.fn();
    const all = vi.fn();
    lookup('receiver.example', { all: false }, one);
    lookup('receiver.example', { all: true }, all);
    expect(one).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
  });

  it('rejects claim mismatches and never follows redirects', async () => {
    expect(() =>
      validateWebhookReceipt(
        { ...receipt('c'.repeat(64)), unitId: '44444444-4444-4444-8444-444444444444' },
        {
          leaseId: LEASE_ID,
          unitId: UNIT_ID,
          contractHash: CONTRACT_HASH,
          resultSha256: 'c'.repeat(64),
        },
      ),
    ).toThrow('invalid');

    expect(
      validateWebhookReceipt(
        {
          ...receipt('c'.repeat(64)),
          receiptId: '  receipt-7  ',
          extraUntrustedField: 'discarded',
        },
        {
          leaseId: LEASE_ID,
          unitId: UNIT_ID,
          contractHash: CONTRACT_HASH,
          resultSha256: 'c'.repeat(64),
        },
      ),
    ).toEqual(receipt('c'.repeat(64)));

    const post = vi.fn(async () => ({ status: 302, body: '' }));
    await expect(
      deliverToWebhook(
        webhookLease(),
        { answer: 42 },
        {
          resolveAll: async () => [{ address: '8.8.8.8', family: 4 }],
          post,
        },
      ),
    ).rejects.toThrow('delivery failed');
    expect(post).toHaveBeenCalledOnce();
  });

  it('re-resolves DNS and retries the identical callback payload after a transient response', async () => {
    vi.useFakeTimers();
    try {
      const resolveAll = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
      const bodies: string[] = [];
      const post = vi.fn(async (_target, body: string) => {
        bodies.push(body);
        if (bodies.length === 1) return { status: 500, body: '' };
        const decoded = JSON.parse(body) as { resultSha256: string };
        return { status: 200, body: JSON.stringify(receipt(decoded.resultSha256)) };
      });

      const delivery = deliverToWebhook(webhookLease(), { answer: 42 }, { resolveAll, post });
      await vi.runAllTimersAsync();
      await expect(delivery).resolves.toMatchObject({ decision: 'accepted' });

      expect(resolveAll).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenCalledTimes(2);
      expect(bodies[0]).toBe(bodies[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled DNS resolution by the lease expiry', async () => {
    vi.useFakeTimers();
    try {
      const work = { ...webhookLease(), expiresAt: new Date(Date.now() + 50).toISOString() };
      const delivery = deliverToWebhook(
        work,
        { answer: 42 },
        {
          resolveAll: async () =>
            await new Promise<Array<{ address: string; family: number }>>(() => undefined),
        },
      );
      const rejection = expect(delivery).rejects.toThrow('delivery failed');
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
