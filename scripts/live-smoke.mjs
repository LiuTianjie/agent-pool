import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const server = normalizeServer(process.env.AGENTPOOL_SERVER ?? 'https://agentpool.itool.tech');
const runner = resolve(
  process.env.AGENTPOOL_RUNNER_BIN ??
    new URL('../apps/runner/dist/agentpool', import.meta.url).pathname,
);
const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const password = `Smoke-${randomBytes(18).toString('base64url')}`;
const stateDirectory = await mkdtemp(join(tmpdir(), 'agentpool-live-smoke-'));
await chmod(stateDirectory, 0o700);

let runnerToken;
try {
  const publisher = await request('/api/auth/register', {
    method: 'POST',
    body: {
      email: `publisher-${suffix}@agentpool.invalid`,
      displayName: 'Live Smoke Publisher',
      password,
      tokenTransport: 'bearer',
    },
    expected: [201],
  });
  const publisherToken = requireString(publisher, 'accessToken');

  const worker = await request('/api/auth/register', {
    method: 'POST',
    body: {
      email: `worker-${suffix}@agentpool.invalid`,
      displayName: 'Live Smoke Worker',
      password,
      tokenTransport: 'bearer',
    },
    expected: [201],
  });
  const workerToken = requireString(worker, 'accessToken');

  await request('/api/wallet/dev-topup', {
    method: 'POST',
    token: publisherToken,
    body: { credits: 100 },
  });

  const device = await request('/api/auth/device/start', {
    method: 'POST',
    body: { client: 'agentpool-cli' },
    expected: [201],
  });
  const userCode = requireString(device, 'userCode');
  const devicePreview = await request('/api/auth/device/preview', {
    method: 'POST',
    token: workerToken,
    body: { userCode },
  });
  await request('/api/auth/device/approve', {
    method: 'POST',
    token: workerToken,
    body: {
      userCode,
      expectedClient: devicePreview.client,
      expectedOperatorType: devicePreview.operatorType,
    },
  });
  const paired = await request('/api/auth/device/token', {
    method: 'POST',
    body: { deviceCode: requireString(device, 'deviceCode') },
  });
  runnerToken = requireString(paired, 'token');
  await writeFile(join(stateDirectory, 'token'), `${runnerToken}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(join(stateDirectory, 'token'), 0o600);

  const runnerProfile = await request('/api/runner/me', { token: runnerToken });
  const runnerUser = requireRecord(runnerProfile, 'user');
  if (runnerUser.displayName !== 'Live Smoke Worker') {
    throw new Error('Runner credential was not bound to the separate worker account.');
  }

  await runRunner([
    '--server',
    server,
    'benchmark',
    '--agent',
    'mock',
    '--model',
    'mock-v1',
    '--concurrency',
    '2',
  ]);

  const expectedValues = Array.from(
    { length: 5 },
    (_, index) => `synthetic-${index + 1}-${suffix}`,
  );
  const created = await request('/api/pools', {
    method: 'POST',
    token: publisherToken,
    body: {
      title: `Production smoke ${suffix}`,
      category: 'data',
      publicSummary: 'Five synthetic units prove Task Capsule pilot and launch delivery.',
      requestedAgent: 'mock',
      requestedModel: 'mock-v1',
      // The five smoke units are intentionally consumed by two explicit bounded Claims.
      requiredConcurrency: 1,
      maxUnitSeconds: 30,
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      rewardPerUnit: 7,
      taskCapsule: {
        version: 'ap-task/1',
        goal: 'Return the exact synthetic string supplied by each unit.',
        inputDescription: 'Each unit contains one private synthetic string for the mock adapter.',
        outputDescription: 'Return only the synthetic string, without commentary.',
        constraints: ['Do not add, remove, or transform characters.'],
        examples: [
          {
            input: { __mockOutput: 'synthetic-example' },
            output: 'synthetic-example',
            note: 'The output is the exact unit value.',
          },
        ],
        delivery: {
          format: 'json',
          schema: { type: 'string', minLength: 1 },
          maxBytes: 1_024,
        },
        acceptance: {
          mode: 'schema_and_hidden_exact',
          criteria: ['Output satisfies the string schema and exactly matches the hidden answer.'],
        },
      },
      deliveryTarget: { mode: 'platform' },
      launchMode: 'pilot',
      pilotUnits: 3,
      units: expectedValues.map((value, index) => ({
        label: `smoke-${index + 1}`,
        input: { __mockOutput: value },
        expectedOutput: value,
      })),
    },
    expected: [201],
  });
  const pool = requireRecord(created, 'pool');
  const poolId = requireString(pool, 'id');
  assertPoolCounts(pool, {
    status: 'piloting',
    totalUnits: 5,
    queuedUnits: 3,
    acceptedUnits: 0,
    heldUnits: 2,
    pilotUnits: 3,
    pilotAcceptedUnits: 0,
  });
  if (typeof pool.contractHash !== 'string' || !/^[0-9a-f]{64}$/u.test(pool.contractHash)) {
    throw new Error('Task Capsule contract hash was missing or invalid.');
  }
  const createdCapsule = requireRecord(pool, 'taskCapsule');
  if (createdCapsule.version !== 'ap-task/1') {
    throw new Error('Created pool did not return the Task Capsule contract.');
  }

  const pilotClaimOutput = await runRunner([
    '--server',
    server,
    'claim',
    '--pool',
    poolId,
    '--units',
    '3',
    '--agent',
    'mock',
    '--model',
    'mock-v1',
    '--concurrency',
    '2',
  ]);
  assertRunnerOutputSafe(pilotClaimOutput, expectedValues);

  const pilotReady = requireRecord(
    await request(`/api/pools/${encodeURIComponent(poolId)}`, {
      token: publisherToken,
    }),
    'pool',
  );
  assertPoolCounts(pilotReady, {
    status: 'piloting',
    totalUnits: 5,
    queuedUnits: 0,
    acceptedUnits: 3,
    heldUnits: 2,
    pilotUnits: 3,
    pilotAcceptedUnits: 3,
    pilotFailedUnits: 0,
  });
  const pilotResults = await request(`/api/pools/${encodeURIComponent(poolId)}/results`, {
    token: publisherToken,
  });
  assertResults(pilotResults, expectedValues, [0, 2, 4], true);

  const launched = await request(`/api/pools/${encodeURIComponent(poolId)}/launch`, {
    method: 'POST',
    token: publisherToken,
  });
  if (launched.releasedUnits !== 2) {
    throw new Error(`Pilot launch released ${String(launched.releasedUnits)} units instead of 2.`);
  }
  const launchedPool = requireRecord(launched, 'pool');
  if (launchedPool.status !== 'queued') {
    throw new Error(`Pilot launch returned invalid status ${String(launchedPool.status)}.`);
  }
  assertPoolCounts(launchedPool, {
    totalUnits: 5,
    queuedUnits: 2,
    acceptedUnits: 3,
    heldUnits: 0,
    pilotAcceptedUnits: 3,
  });

  const releasedClaimOutput = await runRunner([
    '--server',
    server,
    'claim',
    '--pool',
    poolId,
    '--units',
    '2',
    '--agent',
    'mock',
    '--model',
    'mock-v1',
    '--concurrency',
    '2',
  ]);
  assertRunnerOutputSafe(releasedClaimOutput, expectedValues);

  const completed = await request(`/api/pools/${encodeURIComponent(poolId)}`, {
    token: publisherToken,
  });
  const completedPool = requireRecord(completed, 'pool');
  assertPoolCounts(completedPool, {
    status: 'completed',
    totalUnits: 5,
    queuedUnits: 0,
    runningUnits: 0,
    submittedUnits: 0,
    acceptedUnits: 5,
    failedUnits: 0,
    heldUnits: 0,
    pilotUnits: 3,
    pilotAcceptedUnits: 3,
  });
  const results = await request(`/api/pools/${encodeURIComponent(poolId)}/results`, {
    token: publisherToken,
  });
  const resultRows = Array.isArray(results.results) ? results.results : [];
  assertResults(results, expectedValues, [0, 1, 2, 3, 4]);

  const publisherWallet = requireRecord(
    await request('/api/wallet', { token: publisherToken }),
    'wallet',
  );
  const workerWalletBefore = requireRecord(
    await request('/api/wallet', { token: workerToken }),
    'wallet',
  );
  assertWallet(publisherWallet, {
    purchasedAvailable: 65,
    purchasedLocked: 0,
    earnedPending: 0,
    earnedAvailable: 0,
  });
  assertWallet(workerWalletBefore, {
    purchasedAvailable: 0,
    purchasedLocked: 0,
    earnedPending: 0,
    earnedAvailable: 35,
  });
  const withdrawalResponse = await request('/api/wallet/dev-withdraw', {
    method: 'POST',
    token: workerToken,
    body: { credits: 1 },
  });
  const withdrawal = requireRecord(withdrawalResponse, 'withdrawal');
  if (withdrawal.status !== 'simulated_paid' || withdrawal.simulated !== true) {
    throw new Error('Development withdrawal was not explicitly simulated.');
  }
  const workerWalletAfter = requireRecord(withdrawalResponse, 'wallet');
  if (workerWalletAfter.earnedAvailable !== 34) {
    throw new Error('Simulated withdrawal did not debit exactly one earned credit.');
  }

  await runRunner(['--server', server, 'logout']);
  const tokenFileExists = await stat(join(stateDirectory, 'token'))
    .then(() => true)
    .catch((error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
  if (tokenFileExists) throw new Error('Runner logout left the local token behind.');
  const revokedStatus = await rawRequest('/api/runner/me', { token: runnerToken });
  await revokedStatus.body?.cancel();
  if (revokedStatus.status !== 401) {
    throw new Error(`Revoked Runner credential remained usable (HTTP ${revokedStatus.status}).`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        server,
        poolId,
        poolStatus: completedPool.status,
        taskContractHash: pool.contractHash,
        pilotAccepted: pilotReady.pilotAcceptedUnits,
        releasedAfterPilot: launched.releasedUnits,
        acceptedResults: resultRows.length,
        publisherPurchasedLocked: publisherWallet.purchasedLocked,
        workerEarnedBeforeSimulatedWithdrawal: workerWalletBefore.earnedAvailable,
        withdrawal: 'simulated_paid',
        runnerCredentialRevoked: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  runnerToken = undefined;
  await rm(stateDirectory, { recursive: true, force: true });
}

async function request(path, options = {}) {
  const response = await rawRequest(path, options);
  const expected = options.expected ?? [200];
  const text = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? 'GET'} ${path} failed with HTTP ${response.status}.`);
  }
  if (!text) return {};
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Smoke response was too large.');
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid JSON response from ${path}.`);
  }
  return data;
}

function rawRequest(path, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  return fetch(`${server}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
}

async function runRunner(args) {
  await readFile(runner);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(runner, args, {
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        AGENTPOOL_STATE_DIR: stateDirectory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    const errors = [];
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', rejectRun);
    child.once('close', (code) => {
      const total = [...chunks, ...errors].reduce((sum, chunk) => sum + chunk.length, 0);
      if (total > 1024 * 1024) return rejectRun(new Error('Runner smoke output was too large.'));
      if (code !== 0) return rejectRun(new Error(`Runner command failed with exit code ${code}.`));
      resolveRun({
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errors).toString('utf8'),
      });
    });
  });
}

function assertRunnerOutputSafe(output, privateValues) {
  const terminal = `${output.stdout}\n${output.stderr}`;
  for (const value of privateValues) {
    if (terminal.includes(value)) {
      throw new Error('Runner terminal exposed a private Unit value.');
    }
  }
}

function requireRecord(record, key) {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Missing ${key} in smoke response.`);
  }
  return value;
}

function requireString(record, key) {
  const value = record[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${key} in smoke response.`);
  return value;
}

function assertPoolCounts(pool, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (pool[key] !== value) {
      throw new Error(`Pool ${key} was ${String(pool[key])}; expected ${String(value)}.`);
    }
  }
}

function assertResults(response, expectedValues, ordinals, requirePilots = false) {
  const rows = Array.isArray(response.results) ? response.results : [];
  if (rows.length !== ordinals.length) {
    throw new Error(`Smoke returned ${rows.length} results; expected ${ordinals.length}.`);
  }
  for (const [index, ordinal] of ordinals.entries()) {
    const row = rows[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Smoke result ${index} was invalid.`);
    }
    if (
      row.ordinal !== ordinal ||
      row.label !== `smoke-${ordinal + 1}` ||
      row.result !== expectedValues[ordinal] ||
      row.status !== 'accepted'
    ) {
      throw new Error(`Smoke result for ordinal ${ordinal} did not match its unit contract.`);
    }
    if (requirePilots && row.isPilot !== true) {
      throw new Error(`Spread pilot ordinal ${ordinal} was not marked as a pilot.`);
    }
  }
}

function assertWallet(wallet, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (wallet[key] !== value) {
      throw new Error(`Wallet ${key} was ${String(wallet[key])}; expected ${String(value)}.`);
    }
  }
}

function normalizeServer(value) {
  const url = new URL(value);
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname))) {
    throw new Error('Live smoke requires HTTPS, except for a loopback development server.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Smoke server URL must not include credentials, query, or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}
