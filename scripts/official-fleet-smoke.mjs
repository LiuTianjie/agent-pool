import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OFFICIAL_OWNER_EMAIL = 'liu28719976@gmail.com';
const POSTGRES_IMAGE = 'postgres:16-alpine';
const officialRunner = resolve(ROOT, 'apps/official-runner/dist/agentpool-official');
const officialRunnerChecksum = `${officialRunner}.sha256`;
const apiEntry = resolve(ROOT, 'apps/api/dist/src/index.js');
const apiBindEntry = resolve(ROOT, 'apps/api/dist/src/bind-official-fleet.js');
const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const containerName = `agentpool-official-smoke-${process.pid}-${randomBytes(3).toString('hex')}`;
const workDirectory = await mkdtemp(join(tmpdir(), 'agentpool-official-smoke-'));
const stateDirectory = join(workDirectory, 'state');
const taskTempDirectory = join(workDirectory, 'tasks');
const configPath = join(workDirectory, 'official-fleet.config.json');
const postgresEnvPath = join(workDirectory, 'postgres.env');
const tokenPath = join(stateDirectory, 'token');

await Promise.all([
  mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
  mkdir(taskTempDirectory, { recursive: true, mode: 0o700 }),
]);
await Promise.all([chmod(stateDirectory, 0o700), chmod(taskTempDirectory, 0o700)]);

let apiProcess;
let postgresCleanupNeeded = false;
let summary;
const cleanup = {
  apiStopped: false,
  postgresContainerRemoved: false,
  temporaryDirectoryRemoved: false,
};

try {
  const artifactSha256 = await verifyBuiltOfficialRunner();
  await assertReadableFile(apiEntry, 'Build the API before running the Official Fleet smoke.');
  await assertReadableFile(apiBindEntry, 'Build the API before running the Official Fleet smoke.');
  await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 30_000,
  });

  let postgresPort = await reserveFreePort();
  let apiPort = await reserveFreePort();
  while (apiPort === postgresPort) apiPort = await reserveFreePort();

  const databasePassword = randomBytes(24).toString('base64url');
  const databaseUrl = `postgresql://agentpool:${databasePassword}@127.0.0.1:${postgresPort}/agentpool`;
  const server = `http://127.0.0.1:${apiPort}`;
  const jwtSecret = randomBytes(48).toString('base64url');
  const encryptionKey = randomBytes(32).toString('base64');
  const publisherPassword = `Publisher-${randomBytes(18).toString('base64url')}`;
  const ownerPassword = `Owner-${randomBytes(18).toString('base64url')}`;
  const privateInstruction = `private-instruction-${randomBytes(12).toString('hex')}`;
  const privateInputs = [
    `private-input-a-${randomBytes(12).toString('hex')}`,
    `private-input-b-${randomBytes(12).toString('hex')}`,
  ];
  const privateOutputs = [
    `private-output-a-${randomBytes(12).toString('hex')}`,
    `private-output-b-${randomBytes(12).toString('hex')}`,
  ];
  const publisherEmail = `official-smoke-publisher-${suffix}@agentpool.invalid`;
  const sensitiveValues = [
    databasePassword,
    databaseUrl,
    jwtSecret,
    encryptionKey,
    publisherPassword,
    ownerPassword,
    privateInstruction,
    ...privateInputs,
    ...privateOutputs,
  ];

  await writeFile(
    postgresEnvPath,
    [
      'POSTGRES_DB=agentpool',
      'POSTGRES_USER=agentpool',
      `POSTGRES_PASSWORD=${databasePassword}`,
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  await chmod(postgresEnvPath, 0o600);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 'agentpool-official-fleet/1',
        pollIntervalMs: 3_000,
        cells: [
          {
            id: 'local-smoke',
            adapter: 'mock',
            model: 'mock-v1',
            allowWebhooks: false,
            routes: [
              {
                id: 'local-mock',
                kind: 'mock',
                concurrency: 2,
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await chmod(configPath, 0o600);

  postgresCleanupNeeded = true;
  await runCommand(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--env-file',
      postgresEnvPath,
      '--publish',
      `127.0.0.1:${postgresPort}:5432`,
      POSTGRES_IMAGE,
    ],
    { timeoutMs: 180_000 },
  );
  await waitForPostgres(containerName);

  const apiEnvironment = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: 'development',
    PORT: String(apiPort),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    TASK_ENCRYPTION_KEY: encryptionKey,
    APP_ORIGIN: server,
    ALLOW_DEV_TOPUP: 'true',
    DEFAULT_OFFICIAL_OWNER_EMAIL: OFFICIAL_OWNER_EMAIL,
  };
  apiProcess = spawn(process.execPath, [apiEntry], {
    cwd: ROOT,
    env: apiEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const apiOutput = collectOutput(apiProcess, 512 * 1024);
  await waitForHealth(server, apiProcess);

  const publisherRegistration = await request(server, '/api/auth/register', {
    method: 'POST',
    body: {
      email: publisherEmail,
      displayName: 'Official Smoke Publisher',
      password: publisherPassword,
      tokenTransport: 'bearer',
    },
    expected: [201],
  });
  const publisher = requireRecord(publisherRegistration, 'user');
  const publisherId = requireString(publisher, 'id');
  const publisherToken = requireString(publisherRegistration, 'accessToken');
  sensitiveValues.push(publisherToken);

  const ownerRegistration = await request(server, '/api/auth/register', {
    method: 'POST',
    body: {
      email: OFFICIAL_OWNER_EMAIL,
      displayName: 'Agent Pool Official Owner',
      password: ownerPassword,
      tokenTransport: 'bearer',
    },
    expected: [201],
  });
  const owner = requireRecord(ownerRegistration, 'user');
  const ownerId = requireString(owner, 'id');
  const ownerToken = requireString(ownerRegistration, 'accessToken');
  sensitiveValues.push(ownerToken);
  assert(ownerId !== publisherId, 'Publisher and Official Fleet owner must be different users.');

  const bindResult = await runCommand(process.execPath, [apiBindEntry, '--owner-id', ownerId], {
    cwd: ROOT,
    env: apiEnvironment,
    timeoutMs: 60_000,
  });
  assertTerminalSafe(bindResult, sensitiveValues);
  assert(
    bindResult.stdout.includes(ownerId) && bindResult.stdout.includes(OFFICIAL_OWNER_EMAIL),
    'The built binding command did not confirm the exact configured owner.',
  );

  const fleetEnvelope = await request(server, '/api/official-fleet', { token: ownerToken });
  const fleet = requireRecord(fleetEnvelope, 'fleet');
  assert(requireString(fleet, 'ownerId') === ownerId, 'Official Fleet owner binding mismatched.');
  assert(
    requireString(fleet, 'ownerEmail') === OFFICIAL_OWNER_EMAIL,
    'Official Fleet was not bound to the configured email.',
  );
  assert(fleet.mode === 'standby', 'New Official Fleet must begin in standby mode.');

  const device = await request(server, '/api/auth/device/start', {
    method: 'POST',
    body: { client: 'agentpool-official-fleet' },
    expected: [201],
  });
  const userCode = requireString(device, 'userCode');
  sensitiveValues.push(userCode);
  const devicePreview = await request(server, '/api/auth/device/preview', {
    method: 'POST',
    token: ownerToken,
    body: { userCode },
  });
  assert(
    devicePreview.client === 'agentpool-official-fleet' &&
      devicePreview.operatorType === 'official',
    'Device preview did not identify the Official Fleet client and operator type.',
  );
  await request(server, '/api/auth/device/approve', {
    method: 'POST',
    token: ownerToken,
    body: {
      userCode,
      expectedClient: devicePreview.client,
      expectedOperatorType: devicePreview.operatorType,
    },
  });
  const paired = await request(server, '/api/auth/device/token', {
    method: 'POST',
    body: { deviceCode: requireString(device, 'deviceCode') },
  });
  assert(paired.operatorType === 'official', 'Device flow did not issue an Official credential.');
  const officialToken = requireString(paired, 'token');
  sensitiveValues.push(officialToken, requireString(device, 'deviceCode'));
  await writeFile(tokenPath, `${officialToken}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(tokenPath, 0o600);

  const officialEnvironment = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TMPDIR: taskTempDirectory,
    AGENTPOOL_OFFICIAL_STATE_DIR: stateDirectory,
  };
  const benchmark = await runOfficial(
    [
      '--server',
      server,
      '--config',
      configPath,
      'benchmark',
      '--cell',
      'local-smoke',
      '--concurrency',
      '2',
    ],
    officialEnvironment,
  );
  assertTerminalSafe(benchmark, sensitiveValues);
  assert(benchmark.stdout.includes('CERTIFIED'), 'Packaged Official mock Cell was not certified.');

  const preClaimEnvelope = await request(server, '/api/runner/claims', {
    token: officialToken,
  });
  assert(arrayAt(preClaimEnvelope, 'claims').length === 0, 'A Claim existed before owner action.');

  await request(server, '/api/wallet/dev-topup', {
    method: 'POST',
    token: publisherToken,
    body: { credits: 100 },
  });
  const created = await request(server, '/api/pools', {
    method: 'POST',
    token: publisherToken,
    body: {
      title: `Official bounded smoke ${suffix}`,
      category: 'data',
      publicSummary: 'Two synthetic Units validate explicit Official Fleet claim execution.',
      requestedAgent: 'mock',
      requestedModel: 'mock-v1',
      requiredConcurrency: 2,
      maxUnitSeconds: 30,
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      rewardPerUnit: 9,
      taskCapsule: {
        version: 'ap-task/1',
        goal: `Return the exact private output for this Unit. ${privateInstruction}`,
        inputDescription: 'Each Unit contains private input metadata and one private mock output.',
        outputDescription: 'Return only the private output string.',
        constraints: ['Do not log, explain, transform, or disclose the Unit payload.'],
        examples: [],
        delivery: {
          format: 'json',
          schema: { type: 'string', minLength: 1 },
          maxBytes: 1_024,
        },
        acceptance: {
          mode: 'schema_and_hidden_exact',
          criteria: ['The returned string matches the hidden expected output exactly.'],
        },
      },
      deliveryTarget: { mode: 'platform' },
      launchMode: 'immediate',
      units: privateOutputs.map((output, index) => ({
        label: `official-smoke-${index + 1}`,
        input: { confidential: privateInputs[index], __mockOutput: output },
        expectedOutput: output,
      })),
    },
    expected: [201],
  });
  const createdPool = requireRecord(created, 'pool');
  const poolId = requireString(createdPool, 'id');
  assertPoolState(createdPool, {
    status: 'queued',
    totalUnits: 2,
    queuedUnits: 2,
    runningUnits: 0,
    acceptedUnits: 0,
  });

  const registration = await request(server, '/api/runner/nodes', {
    method: 'POST',
    token: officialToken,
    body: {
      name: 'official-fleet:local-smoke',
      platform: 'local-smoke',
      runnerVersion: 'agentpool-official-fleet/0.1.0',
      maxConcurrency: 2,
      supportsDirectWebhooks: false,
      adapters: [
        {
          adapter: 'mock',
          supportedModels: ['mock-v1'],
          version: 'built-in',
        },
      ],
    },
    expected: [201],
  });
  const nodeId = requireString(registration, 'nodeId');
  const pollWithoutClaim = await request(
    server,
    `/api/runner/nodes/${encodeURIComponent(nodeId)}/leases/poll`,
    {
      method: 'POST',
      token: officialToken,
      body: { adapter: 'mock', models: ['mock-v1'] },
      expected: [400],
      includeStatus: true,
    },
  );
  assert(
    pollWithoutClaim.status === 400 &&
      requireRecord(pollWithoutClaim.data, 'error').code === 'RUNNER_CLAIM_REQUIRED',
    'Polling without a Claim was not rejected with RUNNER_CLAIM_REQUIRED.',
  );
  await wait(3_250);
  const untouchedPool = requireRecord(
    await request(server, `/api/pools/${encodeURIComponent(poolId)}`, {
      token: publisherToken,
    }),
    'pool',
  );
  assertPoolState(untouchedPool, {
    status: 'queued',
    totalUnits: 2,
    queuedUnits: 2,
    runningUnits: 0,
    acceptedUnits: 0,
  });
  const stillNoClaims = await request(server, '/api/runner/claims', {
    token: officialToken,
  });
  assert(
    arrayAt(stillNoClaims, 'claims').length === 0,
    'Registration or polling created a Claim automatically.',
  );

  const claimRun = await runOfficial(
    ['--server', server, '--config', configPath, 'claim', '--pool', poolId, '--units', '2'],
    officialEnvironment,
  );
  assertTerminalSafe(claimRun, sensitiveValues);
  assert(
    claimRun.stdout.includes('Bounded claim') && claimRun.stdout.includes('status exhausted'),
    'Packaged Official CLI did not report an exhausted bounded Claim.',
  );

  const completedPool = requireRecord(
    await request(server, `/api/pools/${encodeURIComponent(poolId)}`, {
      token: publisherToken,
    }),
    'pool',
  );
  assertPoolState(completedPool, {
    status: 'completed',
    totalUnits: 2,
    queuedUnits: 0,
    runningUnits: 0,
    submittedUnits: 0,
    acceptedUnits: 2,
    failedUnits: 0,
  });

  const resultEnvelope = await request(server, `/api/pools/${encodeURIComponent(poolId)}/results`, {
    token: publisherToken,
  });
  const results = arrayAt(resultEnvelope, 'results');
  assert(results.length === 2, 'Official Fleet did not deliver both Units.');
  for (const [index, result] of results.entries()) {
    assertRecord(result, `Result ${index + 1} is invalid.`);
    assert(result.ordinal === index, `Result ${index + 1} ordinal mismatched.`);
    assert(result.status === 'accepted', `Result ${index + 1} was not accepted.`);
    assert(result.result === privateOutputs[index], `Result ${index + 1} output mismatched.`);
  }

  const claimsEnvelope = await request(server, '/api/runner/claims', { token: officialToken });
  const claims = arrayAt(claimsEnvelope, 'claims');
  assert(claims.length === 1, 'Explicit CLI action did not create exactly one Claim.');
  const claim = claims[0];
  assertRecord(claim, 'Claim response was invalid.');
  assert(claim.poolId === poolId, 'Claim was not bound to the selected Pool.');
  assert(claim.nodeId === nodeId, 'Claim was not bound to the selected concrete Cell node.');
  assert(claim.maxUnits === 2, 'Claim did not preserve the explicit Unit bound.');
  assert(claim.claimedUnits === 2 && claim.remainingUnits === 0, 'Claim accounting mismatched.');
  assert(claim.status === 'exhausted', 'Completed bounded Claim was not exhausted.');

  const publisherWallet = requireRecord(
    await request(server, '/api/wallet', { token: publisherToken }),
    'wallet',
  );
  const ownerWallet = requireRecord(
    await request(server, '/api/wallet', { token: ownerToken }),
    'wallet',
  );
  assertWallet(publisherWallet, {
    purchasedAvailable: 82,
    purchasedLocked: 0,
    earnedPending: 0,
    earnedAvailable: 0,
  });
  assertWallet(ownerWallet, {
    purchasedAvailable: 0,
    purchasedLocked: 0,
    earnedPending: 0,
    earnedAvailable: 18,
  });

  const logout = await runOfficial(
    ['--server', server, '--config', configPath, 'logout'],
    officialEnvironment,
  );
  assertTerminalSafe(logout, sensitiveValues);
  assert(
    logout.stdout.includes('session revoked') && logout.stdout.includes('local token removed'),
    'Packaged Official CLI did not confirm credential revocation and local removal.',
  );
  const tokenRemains = await stat(tokenPath)
    .then(() => true)
    .catch((error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
  assert(!tokenRemains, 'Official CLI logout left the local token file behind.');
  const revoked = await rawRequest(server, '/api/runner/me', { token: officialToken });
  await revoked.body?.cancel();
  assert(
    revoked.status === 401,
    `Revoked Official credential remained usable (HTTP ${revoked.status}).`,
  );

  const migrations = await runCommand(
    'docker',
    [
      'exec',
      containerName,
      'psql',
      '--username',
      'agentpool',
      '--dbname',
      'agentpool',
      '--tuples-only',
      '--no-align',
      '--command',
      'SELECT count(*) FROM schema_migrations',
    ],
    { timeoutMs: 30_000 },
  );
  const migrationCount = Number(migrations.stdout.trim());
  assert(
    Number.isSafeInteger(migrationCount) && migrationCount >= 9,
    'Fresh database migrations were incomplete.',
  );

  assertTerminalSafe(apiOutput.snapshot(), sensitiveValues);
  summary = {
    ok: true,
    postgres: {
      image: POSTGRES_IMAGE,
      freshContainer: true,
      migrations: migrationCount,
    },
    api: 'local-built-api',
    artifact: {
      command: 'apps/official-runner/dist/agentpool-official',
      sha256: artifactSha256,
    },
    owner: {
      email: OFFICIAL_OWNER_EMAIL,
      boundByServerCommand: true,
      devicePreviewConfirmed: true,
      deviceCredential: 'official',
      distinctFromPublisher: true,
    },
    noClaim: {
      claimCount: 0,
      pollHttpStatus: pollWithoutClaim.status,
      errorCode: 'RUNNER_CLAIM_REQUIRED',
      queuedUnitsAfterWait: untouchedPool.queuedUnits,
      acceptedUnitsAfterWait: untouchedPool.acceptedUnits,
    },
    explicitClaim: {
      poolId,
      nodeId,
      maxUnits: claim.maxUnits,
      claimedUnits: claim.claimedUnits,
      status: claim.status,
      poolStatus: completedPool.status,
      acceptedUnits: completedPool.acceptedUnits,
    },
    settlement: {
      publisherPurchasedAvailable: publisherWallet.purchasedAvailable,
      ownerEarnedAvailable: ownerWallet.earnedAvailable,
    },
    privacy: {
      privateInstructionInTerminal: false,
      privateInputInTerminal: false,
      privateOutputInTerminal: false,
    },
    logout: {
      localTokenRemoved: true,
      credentialRevoked: true,
    },
  };
} finally {
  if (apiProcess) {
    await stopChild(apiProcess);
    cleanup.apiStopped = apiProcess.exitCode !== null;
  } else {
    cleanup.apiStopped = true;
  }
  if (postgresCleanupNeeded) {
    await runCommand('docker', ['rm', '--force', containerName], {
      expectedCodes: [0, 1],
      timeoutMs: 30_000,
    });
    const inspection = await runCommand(
      'docker',
      ['container', 'inspect', '--format', '{{.Id}}', containerName],
      { expectedCodes: [0, 1], timeoutMs: 30_000 },
    );
    assert(inspection.code === 1, 'Temporary PostgreSQL container still exists after cleanup.');
    cleanup.postgresContainerRemoved = true;
  } else {
    cleanup.postgresContainerRemoved = true;
  }
  await rm(workDirectory, { recursive: true, force: true });
  cleanup.temporaryDirectoryRemoved = true;
}

summary.cleanup = cleanup;
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

async function verifyBuiltOfficialRunner() {
  const binary = await readFile(officialRunner);
  const checksum = (await readFile(officialRunnerChecksum, 'utf8')).trim();
  const digest = createHash('sha256').update(binary).digest('hex');
  const match = checksum.match(/^([0-9a-f]{64})\s+agentpool-official$/u);
  assert(match?.[1] === digest, 'Built Official Runner checksum does not match its artifact.');
  const metadata = await stat(officialRunner);
  assert(
    metadata.isFile() && (metadata.mode & 0o111) !== 0,
    'Built Official Runner is not executable.',
  );
  return digest;
}

async function assertReadableFile(path, message) {
  const metadata = await stat(path).catch(() => undefined);
  assert(metadata?.isFile(), message);
}

async function reserveFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  assert(Number.isSafeInteger(port), 'Could not reserve a local smoke port.');
  return port;
}

async function waitForPostgres(name) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await runCommand(
      'docker',
      ['exec', name, 'pg_isready', '--username', 'agentpool', '--dbname', 'agentpool'],
      { expectedCodes: [0, 1, 2], timeoutMs: 10_000 },
    );
    if (result.code === 0) return;
    await wait(500);
  }
  throw new Error('Fresh PostgreSQL did not become ready in time.');
}

async function waitForHealth(server, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Local built API exited before becoming healthy.');
    try {
      const response = await fetch(`${server}/healthz`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // The API may still be applying migrations.
    }
    await wait(250);
  }
  throw new Error('Local built API did not become healthy in time.');
}

function rawRequest(server, path, options = {}) {
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

async function request(server, path, options = {}) {
  const response = await rawRequest(server, path, options);
  const expected = options.expected ?? [200];
  const body = await response.text();
  if (!expected.includes(response.status)) {
    let code = 'UNKNOWN';
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
    } catch {
      // Never echo arbitrary response bodies from a smoke failure.
    }
    throw new Error(
      `${options.method ?? 'GET'} ${path} failed with HTTP ${response.status} (${code}).`,
    );
  }
  let data = {};
  if (body) {
    assert(Buffer.byteLength(body, 'utf8') <= 4 * 1024 * 1024, 'Smoke API response was too large.');
    data = JSON.parse(body);
    assertRecord(data, `Invalid JSON object returned by ${path}.`);
  }
  return options.includeStatus ? { status: response.status, data } : data;
}

async function runOfficial(args, environment) {
  return runCommand(officialRunner, args, {
    cwd: ROOT,
    env: environment,
    timeoutMs: 120_000,
    maxOutputBytes: 1024 * 1024,
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = collectOutput(child, options.maxOutputBytes ?? 1024 * 1024);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 60_000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(new Error(`Could not start ${command}: ${error.code ?? 'SPAWN_FAILED'}.`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return rejectRun(new Error(`${command} timed out.`));
      const result = { code: code ?? -1, ...output.snapshot() };
      const expectedCodes = options.expectedCodes ?? [0];
      if (!expectedCodes.includes(result.code)) {
        return rejectRun(new Error(`${command} exited with code ${result.code}.`));
      }
      resolveRun(result);
    });
  });
}

function collectOutput(child, maximumBytes) {
  const stdout = [];
  const stderr = [];
  let totalBytes = 0;
  const append = (target, chunk) => {
    const copy = Buffer.from(chunk);
    totalBytes += copy.length;
    if (totalBytes <= maximumBytes) target.push(copy);
    if (totalBytes > maximumBytes && child.exitCode === null) child.kill('SIGKILL');
  };
  child.stdout?.on('data', (chunk) => append(stdout, chunk));
  child.stderr?.on('data', (chunk) => append(stderr, chunk));
  return {
    snapshot: () => ({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }),
  };
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('close', resolveExit));
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const graceful = await Promise.race([exited.then(() => true), wait(5_000).then(() => false)]);
  if (graceful || child.exitCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([exited, wait(2_000)]);
  assert(child.exitCode !== null, 'Local built API process did not stop during cleanup.');
}

function assertTerminalSafe(output, sensitiveValues) {
  const terminal = `${output.stdout ?? ''}\n${output.stderr ?? ''}`;
  for (const value of sensitiveValues) {
    if (value && terminal.includes(value)) {
      throw new Error('Smoke terminal output exposed a private task value or credential.');
    }
  }
}

function requireRecord(record, key) {
  assertRecord(record, 'Smoke response was not an object.');
  const value = record[key];
  assertRecord(value, `Missing ${key} in smoke response.`);
  return value;
}

function requireString(record, key) {
  assertRecord(record, 'Smoke response was not an object.');
  const value = record[key];
  assert(typeof value === 'string' && value, `Missing ${key} in smoke response.`);
  return value;
}

function arrayAt(record, key) {
  assertRecord(record, 'Smoke response was not an object.');
  const value = record[key];
  assert(Array.isArray(value), `Missing ${key} array in smoke response.`);
  return value;
}

function assertPoolState(pool, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert(pool[key] === value, `Pool ${key} was ${String(pool[key])}; expected ${String(value)}.`);
  }
}

function assertWallet(wallet, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert(
      wallet[key] === value,
      `Wallet ${key} was ${String(wallet[key])}; expected ${String(value)}.`,
    );
  }
}

function assertRecord(value, message) {
  assert(value && typeof value === 'object' && !Array.isArray(value), message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
