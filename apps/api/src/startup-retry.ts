import { performance } from 'node:perf_hooks';

export const STARTUP_RETRY_DEFAULTS = {
  maxElapsedMs: 600_000,
  initialDelayMs: 1_000,
  maxDelayMs: 15_000,
} as const;

const SAFE_NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOENT',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

export interface StartupRetryEvent {
  attempt: number;
  nextAttempt: number;
  elapsedMs: number;
  delayMs: number;
  errorCode: string;
}

export interface StartupRetryOptions {
  maxElapsedMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (event: StartupRetryEvent) => void;
}

export async function retryStartupOperation<T>(
  operation: () => Promise<T>,
  options: StartupRetryOptions = {},
): Promise<T> {
  const maxElapsedMs = positiveInteger(
    options.maxElapsedMs ?? STARTUP_RETRY_DEFAULTS.maxElapsedMs,
    'maxElapsedMs',
  );
  const initialDelayMs = positiveInteger(
    options.initialDelayMs ?? STARTUP_RETRY_DEFAULTS.initialDelayMs,
    'initialDelayMs',
  );
  const maxDelayMs = positiveInteger(
    options.maxDelayMs ?? STARTUP_RETRY_DEFAULTS.maxDelayMs,
    'maxDelayMs',
  );
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? wait;
  const startedAt = now();
  let attempt = 0;
  let baseDelayMs = Math.min(initialDelayMs, maxDelayMs);

  for (;;) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      const elapsedMs = Math.max(0, Math.floor(now() - startedAt));
      const remainingMs = maxElapsedMs - elapsedMs;
      if (remainingMs <= 0) throw error;

      const jitter = 0.8 + clampRandom(random()) * 0.2;
      const jitteredDelayMs = Math.max(1, Math.floor(baseDelayMs * jitter));
      const delayMs = Math.min(jitteredDelayMs, maxDelayMs, remainingMs);
      options.onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        elapsedMs,
        delayMs,
        errorCode: safeRetryErrorCode(error),
      });
      await sleep(delayMs);
      baseDelayMs = Math.min(baseDelayMs * 2, maxDelayMs);
    }
  }
}

export function safeRetryErrorCode(error: unknown): string {
  try {
    if (!error || typeof error !== 'object' || !('code' in error)) return 'UNKNOWN';
    const code = typeof error.code === 'string' ? error.code : '';
    if (SAFE_NETWORK_ERROR_CODES.has(code)) return code;
    if (/^[0-9A-Z]{5}$/.test(code)) return 'POSTGRES_ERROR';
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
