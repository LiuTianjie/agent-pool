import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('control Agent web API', () => {
  it('binds approval to the opaque preview context without echoing scopes or TTL', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        approved: true,
        label: 'Desk Agent',
        kind: 'control',
        access: 'owner',
        scopes: ['pools:write'],
        requestedTtlSeconds: 86_400,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.approveControlDevice('ABCD-EFGH', 'signed-preview-context');

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/auth/control/device/approve');
    expect(JSON.parse(String(init?.body))).toEqual({
      userCode: 'ABCD-EFGH',
      approvalContext: 'signed-preview-context',
    });
    expect(init?.credentials).toBe('include');
  });

  it('uses the isolated control deny endpoint with the same preview context', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ denied: true, label: 'Desk Agent', kind: 'control' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.denyControlDevice('ABCD-EFGH', 'signed-preview-context');

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/auth/control/device/deny');
    expect(JSON.parse(String(init?.body))).toEqual({
      userCode: 'ABCD-EFGH',
      approvalContext: 'signed-preview-context',
    });
  });

  it('keeps legacy Runner approval on its existing route and server-derived type fields', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ approved: true, label: 'Local Mac', operatorType: 'community' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.approveRunnerDevice('ABCD-EFGH', {
      client: 'agentpool-cli',
      operatorType: 'community',
    });

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/auth/device/approve');
    expect(JSON.parse(String(init?.body))).toEqual({
      userCode: 'ABCD-EFGH',
      expectedClient: 'agentpool-cli',
      expectedOperatorType: 'community',
    });
    expect(result.kind).toBe('runner');
  });
});

describe('publish pool API', () => {
  it('checks an HTTPS dataset through /api/pools/validate', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        valid: true,
        totalUnits: 48,
        totalCost: 480,
        dataset: { mode: 'https', url: 'https://files.example.com/batch.jsonl', host: 'files.example.com' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.validatePool({
      title: 'Remote batch',
      category: 'data',
      publicSummary: 'Units stay at the publisher file',
      requestedAgent: 'codex',
      requestedModel: 'gpt-5.4',
      requiredConcurrency: 1,
      maxUnitSeconds: 60,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      rewardPerUnit: 10,
      validationMode: 'auto',
      taskCapsule: {
        version: 'ap-task/1',
        goal: 'Answer each row',
        inputDescription: 'One JSON object per line',
        outputDescription: 'Any non-empty result',
        constraints: [],
        examples: [{ input: { q: 1 }, output: 'ok' }],
        delivery: { format: 'text', maxBytes: 1024 },
        acceptance: { mode: 'non_empty', criteria: ['non-empty'] },
      },
      deliveryTarget: { mode: 'platform' },
      launchMode: 'pilot',
      pilotUnits: 2,
      dataset: { mode: 'https', url: 'https://files.example.com/batch.jsonl' },
    });

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/pools/validate');
    expect(JSON.parse(String(init?.body)).units).toBeUndefined();
    expect(JSON.parse(String(init?.body)).dataset).toEqual({
      mode: 'https',
      url: 'https://files.example.com/batch.jsonl',
    });
    expect(result.totalUnits).toBe(48);
  });
});
