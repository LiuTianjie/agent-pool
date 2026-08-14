import { randomUUID } from 'node:crypto';

export const CONTROL_PROTOCOL = 'agentpool-control/1' as const;

export const CONTROL_API_ROUTES = {
  capabilities: '/api/meta/capabilities',
  createTaskSchema: '/api/meta/schemas/create-pool',
  deviceStart: '/api/auth/control/device/start',
  deviceToken: '/api/auth/control/device/token',
  runnerDevicePreview: '/api/auth/device/preview',
  runnerDeviceApprove: '/api/auth/device/approve',
  me: '/api/auth/control/me',
  credentials: '/api/auth/control/credentials',
  credential: (id: string) => `/api/auth/control/credentials/${encodeURIComponent(id)}`,
  dashboard: '/api/dashboard',
  network: '/api/network/pulse',
  tasks: '/api/pools',
  task: (id: string) => `/api/pools/${encodeURIComponent(id)}`,
  taskValidate: '/api/pools/validate',
  taskLaunch: (id: string) => `/api/pools/${encodeURIComponent(id)}/launch`,
  taskCancel: (id: string) => `/api/pools/${encodeURIComponent(id)}/cancel`,
  taskResults: (id: string) => `/api/pools/${encodeURIComponent(id)}/results`,
  taskReview: (id: string, resultId: string) =>
    `/api/pools/${encodeURIComponent(id)}/units/${encodeURIComponent(resultId)}/review`,
  wallet: '/api/wallet',
  walletLedger: '/api/wallet/ledger',
  walletWithdrawals: '/api/wallet/withdrawals',
  walletTopup: '/api/wallet/dev-topup',
  walletWithdraw: '/api/wallet/dev-withdraw',
  runners: '/api/runners',
  fleet: '/api/official-fleet',
  profile: '/api/settings/profile',
  capacityCatalog: '/api/capacity/catalog',
  capacityQuote: '/api/capacity/quote',
  events: '/api/events/history',
} as const;

export interface ControlApiResponse<T = unknown> {
  status: number;
  data: T;
  requestId: string;
  idempotencyReplayed: boolean;
}

export interface ControlRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  route: string;
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export class ControlApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: {
      status?: number;
      retryable: boolean;
      retryAfterMs?: number;
      details?: unknown;
      requestId?: string;
    },
  ) {
    super(message);
    this.name = 'ControlApiError';
  }
}

type Fetch = typeof globalThis.fetch;

export class ControlApiClient {
  readonly server: string;

  constructor(
    server: string,
    private readonly token?: string,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.server = normalizeControlServer(server);
  }

  withToken(token: string): ControlApiClient {
    return new ControlApiClient(this.server, token, this.fetchImpl);
  }

  async request<T = unknown>(input: ControlRequest): Promise<ControlApiResponse<T>> {
    const method = input.method ?? 'GET';
    const requestId = randomUUID();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-AgentPool-Protocol': CONTROL_PROTOCOL,
      'X-Request-Id': requestId,
    };
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.server}${input.route}`, {
        method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, input.timeoutMs ?? 20_000)),
      });
    } catch (error) {
      if (isAbortLike(error)) {
        throw new ControlApiError('REQUEST_TIMEOUT', 'Platform request timed out.', {
          retryable: true,
          requestId,
        });
      }
      throw new ControlApiError('NETWORK_UNAVAILABLE', 'Could not reach the Agent Pool platform.', {
        retryable: true,
        requestId,
      });
    }

    const responseRequestId = response.headers.get('x-request-id') || requestId;
    let body: unknown;
    try {
      body = await decodeResponse(response, responseRequestId);
    } catch {
      if (response.ok) {
        throw new ControlApiError(
          'AMBIGUOUS_RESPONSE',
          'Platform response was interrupted or invalid; the operation result is ambiguous.',
          { status: response.status, retryable: true, requestId: responseRequestId },
        );
      }
      throw new ControlApiError(`HTTP_${response.status}`, 'Platform request failed.', {
        status: response.status,
        retryable: retryableStatus(response.status),
        requestId: responseRequestId,
        ...(parseRetryAfter(response.headers.get('retry-after')) === undefined
          ? {}
          : { retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) }),
      });
    }
    if (!response.ok) {
      const parsed = parseErrorBody(body);
      const retryAfterMs =
        parsed.retryAfterMs ?? parseRetryAfter(response.headers.get('retry-after'));
      throw new ControlApiError(parsed.code ?? `HTTP_${response.status}`, parsed.message, {
        status: response.status,
        retryable: parsed.retryable ?? retryableStatus(response.status),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(parsed.details === undefined ? {} : { details: parsed.details }),
        requestId: responseRequestId,
      });
    }

    return {
      status: response.status,
      data: body as T,
      requestId: responseRequestId,
      idempotencyReplayed:
        response.headers.get('idempotency-replayed')?.trim().toLowerCase() === 'true',
    };
  }
}

export function normalizeControlServer(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new ControlApiError('INVALID_SERVER', 'Server URL is invalid.', {
      retryable: false,
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ControlApiError('INVALID_SERVER', 'Server URL must use HTTP or HTTPS.', {
      retryable: false,
    });
  }
  const localHttpHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol === 'http:' && !localHttpHosts.has(url.hostname)) {
    throw new ControlApiError(
      'INSECURE_SERVER',
      'HTTP is only allowed for a loopback development server. Use HTTPS.',
      { retryable: false },
    );
  }
  if (url.username || url.password) {
    throw new ControlApiError(
      'SERVER_CONTAINS_CREDENTIALS',
      'Server URL must not contain credentials.',
      {
        retryable: false,
      },
    );
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}

async function decodeResponse(response: Response, requestId: string): Promise<unknown> {
  if (response.status === 204 || response.body === null) return null;
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 32 * 1024 * 1024) {
    await response.body?.cancel().catch(() => undefined);
    throw new ControlApiError('RESPONSE_TOO_LARGE', 'Platform response exceeds 32 MiB.', {
      status: response.status,
      retryable: false,
      requestId,
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > 32 * 1024 * 1024) {
      await reader.cancel().catch(() => undefined);
      throw new ControlApiError('RESPONSE_TOO_LARGE', 'Platform response exceeds 32 MiB.', {
        status: response.status,
        retryable: false,
        requestId,
      });
    }
    chunks.push(next.value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ControlApiError('INVALID_RESPONSE', 'Platform returned malformed JSON.', {
      status: response.status,
      retryable: response.status >= 500,
      requestId,
    });
  }
}

function parseErrorBody(body: unknown): {
  code?: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
} {
  if (isRecord(body) && isRecord(body.error)) {
    return {
      ...(typeof body.error.code === 'string' ? { code: body.error.code } : {}),
      message:
        typeof body.error.message === 'string' && body.error.message
          ? body.error.message
          : 'Platform request failed.',
      ...('details' in body.error ? { details: body.error.details } : {}),
      ...(typeof body.error.retryable === 'boolean' ? { retryable: body.error.retryable } : {}),
      ...(typeof body.error.retryAfterMs === 'number' &&
      Number.isSafeInteger(body.error.retryAfterMs) &&
      body.error.retryAfterMs >= 0
        ? { retryAfterMs: body.error.retryAfterMs }
        : {}),
    };
  }
  return { message: 'Platform request failed.' };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(24 * 60 * 60 * 1_000, Math.ceil(seconds * 1_000));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(24 * 60 * 60 * 1_000, Math.max(0, date - now));
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      error.message.includes('timed out'))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
