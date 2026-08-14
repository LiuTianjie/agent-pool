import { describe, expect, it, vi } from 'vitest';

import {
  retryStartupOperation,
  safeRetryErrorCode,
  STARTUP_RETRY_DEFAULTS,
} from './startup-retry.js';

describe('startup retry', () => {
  it('allows ten minutes for slow PostgreSQL recovery by default', () => {
    expect(STARTUP_RETRY_DEFAULTS).toMatchObject({
      maxElapsedMs: 600_000,
      initialDelayMs: 1_000,
      maxDelayMs: 15_000,
    });
  });

  it('returns immediately without sleeping when the operation succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    const operation = vi.fn(async () => 'ready');

    await expect(retryStartupOperation(operation, { sleep })).resolves.toBe('ready');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('uses capped exponential backoff and eventually succeeds', async () => {
    let clock = 0;
    let attempts = 0;
    const delays: number[] = [];
    const result = await retryStartupOperation(
      async () => {
        attempts += 1;
        if (attempts < 4) throw Object.assign(new Error('database unavailable'), { code: '57P03' });
        return 'migrated';
      },
      {
        maxElapsedMs: 1_000,
        initialDelayMs: 10,
        maxDelayMs: 25,
        now: () => clock,
        random: () => 1,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
          clock += milliseconds;
        },
      },
    );

    expect(result).toBe('migrated');
    expect(delays).toEqual([10, 20, 25]);
  });

  it('clips the final delay to the deadline and rethrows the final error', async () => {
    let clock = 0;
    let attempts = 0;
    const delays: number[] = [];
    const events: unknown[] = [];
    const secret = 'postgresql://user:password@example.invalid/database';

    await expect(
      retryStartupOperation(
        async () => {
          attempts += 1;
          throw new Error(`still unavailable: ${secret}`);
        },
        {
          maxElapsedMs: 70,
          initialDelayMs: 10,
          maxDelayMs: 25,
          now: () => clock,
          random: () => 1,
          sleep: async (milliseconds) => {
            delays.push(milliseconds);
            clock += milliseconds;
          },
          onRetry: (event) => events.push(event),
        },
      ),
    ).rejects.toThrow(secret);

    expect(delays).toEqual([10, 20, 25, 15]);
    expect(attempts).toBe(5);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events).toMatchObject([
      { attempt: 1, nextAttempt: 2, delayMs: 10, errorCode: 'UNKNOWN' },
      { attempt: 2, nextAttempt: 3, delayMs: 20, errorCode: 'UNKNOWN' },
      { attempt: 3, nextAttempt: 4, delayMs: 25, errorCode: 'UNKNOWN' },
      { attempt: 4, nextAttempt: 5, delayMs: 15, errorCode: 'UNKNOWN' },
    ]);
  });

  it('only exposes bounded machine-readable error codes to retry logs', () => {
    expect(safeRetryErrorCode({ code: 'ECONNREFUSED' })).toBe('ECONNREFUSED');
    expect(safeRetryErrorCode({ code: '57P03' })).toBe('POSTGRES_ERROR');
    expect(safeRetryErrorCode({ code: 'supersecretpassword' })).toBe('UNKNOWN');
    expect(safeRetryErrorCode({ code: 'secret=postgresql://user:password@host/db' })).toBe(
      'UNKNOWN',
    );
    expect(safeRetryErrorCode(new Error('DATABASE_URL is secret'))).toBe('UNKNOWN');
  });
});
