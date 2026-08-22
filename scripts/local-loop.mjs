const API = 'http://127.0.0.1:3001';
const ORIGIN = 'http://127.0.0.1:5174';
const WORK = `${ORIGIN}/examples/work.json`;

const stamp = Date.now();
const email = `loop-${stamp}@example.test`;
const password = 'very-secure-local-loop';
let cookie = '';

async function call(method, path, { body, token, extraHeaders } = {}) {
  const headers = {
    origin: ORIGIN,
    accept: 'application/json',
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(cookie ? { cookie } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  };
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const session = setCookie.find((value) => value.startsWith('ap_session='));
  if (session) cookie = session.split(';')[0];
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  }
  return json;
}

function expectedAnswer(input) {
  const match = /^(-?\d+)\s*([+*-])\s*(-?\d+)$/.exec(String(input?.expression ?? '').trim());
  if (!match) throw new Error(`unexpected input ${JSON.stringify(input)}`);
  const left = Number(match[1]);
  const right = Number(match[3]);
  const value = match[2] === '+' ? left + right : match[2] === '-' ? left - right : left * right;
  return { answer: String(value) };
}

const registered = await call('POST', '/api/auth/register', {
  body: { email, displayName: 'Loop', password },
});
console.log('register', registered.user.id);

const wallet = await call('POST', '/api/wallet/dev-topup', { body: { credits: 1000 } });
console.log('topup', wallet.wallet?.purchasedAvailable ?? wallet.purchasedAvailable);

const validated = await call('POST', '/api/pools/validate', {
  body: {
    dataset: { mode: 'work', url: WORK },
    requiredConcurrency: 2,
    maxUnitSeconds: 30,
    deadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    rewardPerUnit: 5,
    launchMode: 'immediate',
  },
});
console.log('validate', {
  title: validated.workPackage?.title,
  units: validated.totalUnits,
  host: validated.workPackage?.unitsHost,
});

const created = await call('POST', '/api/pools', {
  extraHeaders: { 'idempotency-key': `loop-${stamp}` },
  body: {
    dataset: { mode: 'work', url: WORK },
    requiredConcurrency: 2,
    maxUnitSeconds: 30,
    deadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    rewardPerUnit: 5,
    launchMode: 'immediate',
  },
});
const pool = created.pool;
console.log('publish', {
  id: pool.id,
  title: pool.title,
  units: pool.totalUnits,
  status: pool.status,
});

const device = await call('POST', '/api/auth/device/start', { body: { client: 'agentpool-cli' } });
const preview = await call('POST', '/api/auth/device/preview', {
  body: { userCode: device.userCode },
});
await call('POST', '/api/auth/device/approve', {
  body: {
    userCode: device.userCode,
    expectedClient: preview.client,
    expectedOperatorType: preview.operatorType,
  },
});
const issued = await call('POST', '/api/auth/device/token', {
  body: { deviceCode: device.deviceCode },
});
const runnerToken = issued.token;
const node = await call('POST', '/api/runner/nodes', {
  token: runnerToken,
  body: {
    adapter: 'mock',
    models: ['mock-v1'],
    concurrency: 2,
    clientVersion: '0.1.0-local',
    platform: 'darwin',
    arch: 'arm64',
  },
});
const nodeId = node.nodeId;
const benchmark = await call('POST', '/api/runner/benchmarks', {
  token: runnerToken,
  body: { nodeId, adapter: 'mock', model: 'mock-v1', requestedConcurrency: 2 },
});
const results = benchmark.leases.map((lease) => ({
  leaseId: lease.leaseId,
  output: {
    reversed: [...lease.input.text].reverse().join(''),
    uppercase: lease.input.text.toUpperCase(),
    grouped: lease.input.text.match(/.{1,3}/g)?.join('-') ?? lease.input.text,
    length: lease.input.text.length,
  },
  durationMs: 20,
  success: true,
}));
await call('POST', `/api/runner/benchmarks/${benchmark.benchmarkId}/results`, {
  token: runnerToken,
  body: { results },
});
await call('POST', `/api/runner/nodes/${nodeId}/heartbeat`, {
  token: runnerToken,
  body: { status: 'online' },
});
console.log('paired', nodeId);

const claimed = await call('POST', `/api/runners/${nodeId}/claims`, {
  extraHeaders: { 'idempotency-key': `claim-${stamp}` },
  body: { poolId: pool.id, maxUnits: pool.totalUnits },
});
console.log('claim', claimed.claim.id, claimed.executeCommand);

const accepted = [];
for (let index = 0; index < pool.totalUnits; index += 1) {
  const leased = await call('POST', `/api/runner/nodes/${nodeId}/leases/poll`, {
    token: runnerToken,
    body: { adapter: 'mock', models: ['mock-v1'], claimId: claimed.claim.id },
  });
  if (!leased.lease) throw new Error(`no lease at ${index}: ${JSON.stringify(leased)}`);
  const output = expectedAnswer(leased.lease.input);
  const submitted = await call('POST', `/api/runner/leases/${leased.lease.leaseId}/submit`, {
    token: runnerToken,
    body: { output },
  });
  accepted.push({ input: leased.lease.input, output, status: submitted.status });
  console.log('unit', submitted.status, leased.lease.input, output);
}

const detail = await call('GET', `/api/pools/${pool.id}`);
console.log('pool', {
  status: detail.pool?.status ?? detail.status,
  accepted: (detail.units ?? []).filter((unit) => unit.status === 'accepted').length,
  total: (detail.units ?? []).length,
});
console.log('DONE', { email, poolId: pool.id, claimId: claimed.claim.id, accepted });
