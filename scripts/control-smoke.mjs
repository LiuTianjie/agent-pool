import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POSTGRES_IMAGE = 'postgres:16-alpine';
const runner = resolve(ROOT, 'apps/runner/dist/agentpool');
const runnerChecksum = `${runner}.sha256`;
const apiEntry = resolve(ROOT, 'apps/api/dist/src/index.js');
const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const containerName = `agentpool-control-smoke-${process.pid}-${randomBytes(3).toString('hex')}`;
const workDirectory = await mkdtemp(join(tmpdir(), 'agentpool-control-smoke-'));
const controlStateDirectory = join(workDirectory, 'control-state');
const runnerStateDirectory = join(workDirectory, 'runner-state');
const inputPath = join(workDirectory, 'task.json');
const postgresEnvPath = join(workDirectory, 'postgres.env');

let apiProcess;
let postgresStarted = false;
let summary;
const cleanup = {
  apiStopped: false,
  postgresContainerRemoved: false,
  temporaryDirectoryRemoved: false,
};

try {
  const artifactSha256 = await verifyRunnerArtifact();
  await assertReadableFile(apiEntry, 'Build the API before running smoke:control-local.');
  await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30_000 });
  await Promise.all([
    mkdir(controlStateDirectory, { recursive: true, mode: 0o700 }),
    mkdir(runnerStateDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([chmod(controlStateDirectory, 0o700), chmod(runnerStateDirectory, 0o700)]);

  const postgresPort = await reservePort();
  let apiPort = await reservePort();
  while (apiPort === postgresPort) apiPort = await reservePort();
  const server = `http://127.0.0.1:${apiPort}`;
  const databasePassword = randomBytes(24).toString('base64url');
  const databaseUrl = `postgresql://agentpool:${databasePassword}@127.0.0.1:${postgresPort}/agentpool`;
  const jwtSecret = randomBytes(48).toString('base64url');
  const encryptionKey = randomBytes(32).toString('base64');
  const ownerPassword = `Owner-${randomBytes(18).toString('base64url')}`;
  const sensitiveValues = [databasePassword, databaseUrl, jwtSecret, encryptionKey, ownerPassword];

  await writeFile(
    postgresEnvPath,
    `POSTGRES_DB=agentpool\nPOSTGRES_USER=agentpool\nPOSTGRES_PASSWORD=${databasePassword}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await chmod(postgresEnvPath, 0o600);
  postgresStarted = true;
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
  };
  apiProcess = spawn(process.execPath, [apiEntry], {
    cwd: ROOT,
    env: apiEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const apiOutput = collectOutput(apiProcess);
  await waitForHealth(server, apiProcess);

  const ownerRegistration = await request(server, '/api/auth/register', {
    method: 'POST',
    body: {
      email: `control-smoke-${suffix}@agentpool.invalid`,
      displayName: 'Control Smoke Owner',
      password: ownerPassword,
      tokenTransport: 'bearer',
    },
    expected: [201],
  });
  const ownerToken = requiredString(ownerRegistration, 'accessToken');
  sensitiveValues.push(ownerToken);

  const controlEnvironment = { ...process.env, AGENTPOOL_CONTROL_STATE_DIR: controlStateDirectory };
  const controlLogin = startCommand(
    runner,
    [
      '--server',
      server,
      'control',
      'login',
      '--no-browser',
      '--preset',
      'operator',
      '--label',
      'local-control-smoke',
      '--scope',
      'wallet:write',
      '--scope',
      'credentials:write',
    ],
    { env: controlEnvironment, timeoutMs: 50_000 },
  );
  const authorization = await controlLogin.waitForJson(
    (record) => record?.data?.status === 'authorization_required',
  );
  const userCode = requiredString(requiredRecord(authorization, 'data'), 'userCode');
  const preview = await request(server, '/api/auth/control/device/preview', {
    method: 'POST',
    token: ownerToken,
    body: { userCode },
  });
  const approvalContext = requiredString(preview, 'approvalContext');
  sensitiveValues.push(approvalContext);
  await request(server, '/api/auth/control/device/approve', {
    method: 'POST',
    token: ownerToken,
    body: { userCode, approvalContext },
  });
  const loginResult = await controlLogin.done;
  assert(loginResult.code === 0, 'Control CLI login did not exit successfully.');
  assertTerminalSafe(loginResult, sensitiveValues);
  const controlToken = (await readFile(join(controlStateDirectory, 'token'), 'utf8')).trim();
  assert(
    controlToken.startsWith('ap_control_'),
    'Control CLI did not persist an opaque Control credential.',
  );
  sensitiveValues.push(controlToken);

  const status = await runControl(server, controlEnvironment, ['status'], sensitiveValues);
  assert(status.data.authenticated === true, 'Control status was not authenticated.');
  const description = await runControl(server, controlEnvironment, ['describe'], sensitiveValues);
  assert(
    description.data.platform.protocolVersion === 'agentpool-control/1',
    'Control discovery protocol mismatched.',
  );

  const topupKey = `smoke-topup-${suffix}`;
  const topupOne = await runControl(
    server,
    controlEnvironment,
    ['wallet', 'topup', '--credits', '100', '--idempotency-key', topupKey],
    sensitiveValues,
  );
  const topupTwo = await runControl(
    server,
    controlEnvironment,
    ['wallet', 'topup', '--credits', '100', '--idempotency-key', topupKey],
    sensitiveValues,
  );
  assert(
    topupOne.meta.idempotencyReplayed === false && topupTwo.meta.idempotencyReplayed === true,
    'Wallet topup idempotency did not replay.',
  );

  const task = {
    title: `Control smoke ${suffix}`,
    category: 'data',
    publicSummary: 'Synthetic local task used only to verify the owner control protocol.',
    // Validation deliberately returns the normalized task contract. Keep this
    // fixture non-sensitive; credential secrecy is asserted separately below.
    secretInstruction: 'Return the supplied mock value without explanation.',
    requestedAgent: 'mock',
    requestedModel: 'mock-v1',
    requiredConcurrency: 2,
    maxUnitSeconds: 30,
    deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    rewardPerUnit: 3,
    validationMode: 'auto',
    deliveryTarget: { mode: 'platform' },
    launchMode: 'immediate',
    units: [
      { label: 'control-smoke-a', input: { value: 'synthetic-a', ordinal: 1 } },
      { label: 'control-smoke-b', input: { value: 'synthetic-b', ordinal: 2 } },
    ],
  };
  await writeFile(inputPath, `${JSON.stringify(task)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(inputPath, 0o600);
  const validated = await runControl(
    server,
    controlEnvironment,
    ['tasks', 'validate', '--input', inputPath],
    sensitiveValues,
  );
  assert(
    validated.data.valid === true && validated.data.totalUnits === 2,
    'Control task validation was not authoritative or did not preserve Units.',
  );
  const taskKey = `smoke-publish-${suffix}`;
  const publishOne = await runControl(
    server,
    controlEnvironment,
    ['tasks', 'publish', '--input', inputPath, '--idempotency-key', taskKey],
    sensitiveValues,
  );
  const poolId = requiredString(requiredRecord(publishOne.data, 'pool'), 'id');
  const publishTwo = await runControl(
    server,
    controlEnvironment,
    ['tasks', 'publish', '--input', inputPath, '--idempotency-key', taskKey],
    sensitiveValues,
  );
  assert(
    publishOne.meta.idempotencyReplayed === false && publishTwo.meta.idempotencyReplayed === true,
    'Task publish idempotency did not replay.',
  );
  assert(
    requiredString(requiredRecord(publishTwo.data, 'pool'), 'id') === poolId,
    'Publish replay produced a different task.',
  );
  const listed = await runControl(server, controlEnvironment, ['tasks', 'list'], sensitiveValues);
  assert(
    Array.isArray(listed.data.pools) && listed.data.pools.some((pool) => pool?.id === poolId),
    'Published task was not listed.',
  );
  const fetched = await runControl(
    server,
    controlEnvironment,
    ['tasks', 'get', '--task', poolId],
    sensitiveValues,
  );
  assert(fetched.data.pool?.id === poolId, 'Published task was not retrievable.');
  const cancelKey = `smoke-cancel-${suffix}`;
  const cancelOne = await runControl(
    server,
    controlEnvironment,
    ['tasks', 'cancel', '--task', poolId, '--idempotency-key', cancelKey],
    sensitiveValues,
  );
  const cancelTwo = await runControl(
    server,
    controlEnvironment,
    ['tasks', 'cancel', '--task', poolId, '--idempotency-key', cancelKey],
    sensitiveValues,
  );
  assert(
    cancelOne.meta.idempotencyReplayed === false && cancelTwo.meta.idempotencyReplayed === true,
    'Task cancel idempotency did not replay.',
  );
  const results = await runControl(
    server,
    controlEnvironment,
    ['tasks', 'results', '--task', poolId],
    sensitiveValues,
  );
  assert(Array.isArray(results.data.results), 'Task results did not return machine-readable JSON.');
  const events = await runControl(
    server,
    controlEnvironment,
    ['events', '--after', '0', '--limit', '100', '--wait-seconds', '0'],
    sensitiveValues,
  );
  assert(
    Array.isArray(events.data.events) && events.data.events.length > 0,
    'Control event history was empty after owner actions.',
  );

  const runnerEnvironment = { ...process.env, AGENTPOOL_STATE_DIR: runnerStateDirectory };
  const communityLogin = startCommand(runner, ['--server', server, 'login', '--no-browser'], {
    env: runnerEnvironment,
    timeoutMs: 50_000,
  });
  const communityUserCode = await communityLogin.waitForText(/Enter code:\s*([A-Z0-9-]+)/u);
  const runnerPreview = await runControl(
    server,
    controlEnvironment,
    ['devices', 'preview', '--code', communityUserCode],
    sensitiveValues,
  );
  const previewData = runnerPreview.data;
  const expectedClient = requiredString(previewData, 'client');
  const expectedOperatorType = requiredString(previewData, 'operatorType');
  await runControl(
    server,
    controlEnvironment,
    [
      'devices',
      'approve',
      '--code',
      communityUserCode,
      '--expected-client',
      expectedClient,
      '--expected-operator-type',
      expectedOperatorType,
    ],
    sensitiveValues,
  );
  const communityResult = await communityLogin.done;
  assert(communityResult.code === 0, 'Community Runner login did not exit successfully.');
  assertTerminalSafe(communityResult, sensitiveValues);
  const runnerToken = (await readFile(join(runnerStateDirectory, 'token'), 'utf8')).trim();
  assert(
    runnerToken.startsWith('ap_runner_'),
    'Community login did not persist a Runner credential.',
  );
  sensitiveValues.push(runnerToken);

  await assertStatus(
    server,
    '/api/runner/me',
    controlToken,
    401,
    'Control token accessed Runner API.',
  );
  await assertStatus(server, '/api/wallet', runnerToken, 401, 'Runner token accessed owner API.');
  await assertStatus(
    server,
    '/api/auth/control/me',
    runnerToken,
    401,
    'Runner token accessed Control API.',
  );
  await assertStatus(
    server,
    '/api/runner/me',
    runnerToken,
    200,
    'Runner token did not access Runner API.',
  );

  const logout = await runControl(server, controlEnvironment, ['logout'], sensitiveValues);
  assert(
    logout.data.localTokenRemoved === true && logout.data.revoked === true,
    'Control logout did not revoke and remove the local credential.',
  );
  await assertStatus(
    server,
    '/api/auth/control/me',
    controlToken,
    401,
    'Self-revoked Control token remained usable.',
  );
  await assertStatus(
    server,
    '/api/runner/me',
    runnerToken,
    200,
    'Control self-revoke unexpectedly revoked a Runner token.',
  );
  const controlTokenExists = await stat(join(controlStateDirectory, 'token'))
    .then(() => true)
    .catch((error) => (error?.code === 'ENOENT' ? false : Promise.reject(error)));
  assert(!controlTokenExists, 'Control logout left a local token file behind.');
  assertTerminalSafe(apiOutput.snapshot(), sensitiveValues);

  const migrations = Number(
    (
      await runCommand(
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
      )
    ).stdout.trim(),
  );
  assert(
    Number.isSafeInteger(migrations) && migrations >= 9,
    'Fresh database migrations were incomplete.',
  );
  summary = {
    ok: true,
    postgres: { image: POSTGRES_IMAGE, freshContainer: true, migrations },
    api: 'local-built-api',
    artifact: { command: 'apps/runner/dist/agentpool', sha256: artifactSha256 },
    control: {
      deviceApproval: true,
      status: true,
      discovery: true,
      events: true,
      selfRevoke: true,
    },
    idempotency: { walletTopupReplay: true, taskPublishReplay: true, taskCancelReplay: true },
    runner: { communityPairing: true, tokenBoundary: true },
    privacy: { credentialInTerminal: false },
  };
} finally {
  if (apiProcess) await stopChild(apiProcess);
  cleanup.apiStopped = !apiProcess || apiProcess.exitCode !== null;
  if (postgresStarted) {
    await runCommand('docker', ['rm', '--force', containerName], {
      expectedCodes: [0, 1],
      timeoutMs: 30_000,
    });
    const inspect = await runCommand(
      'docker',
      ['container', 'inspect', '--format', '{{.Id}}', containerName],
      { expectedCodes: [0, 1], timeoutMs: 30_000 },
    );
    assert(inspect.code === 1, 'Temporary PostgreSQL container still exists after cleanup.');
  }
  cleanup.postgresContainerRemoved = true;
  await rm(workDirectory, { recursive: true, force: true });
  cleanup.temporaryDirectoryRemoved = true;
}

summary.cleanup = cleanup;
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

async function verifyRunnerArtifact() {
  const binary = await readFile(runner);
  const checksum = (await readFile(runnerChecksum, 'utf8')).trim();
  const digest = createHash('sha256').update(binary).digest('hex');
  assert(checksum === `${digest}  agentpool`, 'Built Runner checksum does not match its artifact.');
  const metadata = await stat(runner);
  assert(metadata.isFile() && (metadata.mode & 0o111) !== 0, 'Built Runner is not executable.');
  return digest;
}

async function runControl(server, environment, args, sensitiveValues) {
  const result = await runCommand(runner, ['--server', server, 'control', ...args], {
    env: environment,
    timeoutMs: 50_000,
  });
  assertTerminalSafe(result, sensitiveValues);
  const records = parseJsonLines(result.stdout);
  assert(
    records.length === 1 && records[0]?.ok === true,
    'Control command did not emit exactly one successful JSON record.',
  );
  return records[0];
}

function startCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = collectOutput(child);
  const listeners = [];
  let settled = false;
  let timeout;
  const done = new Promise((resolveDone, rejectDone) => {
    timeout = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, options.timeoutMs ?? 60_000);
    timeout.unref();
    child.once('error', (error) => {
      settled = true;
      clearTimeout(timeout);
      rejectDone(new Error(`Could not start ${command}: ${error.code ?? 'SPAWN_FAILED'}.`));
    });
    child.once('close', (code) => {
      settled = true;
      clearTimeout(timeout);
      const result = { code: code ?? -1, ...output.snapshot() };
      if (result.code !== 0) rejectDone(new Error(`${command} exited with code ${result.code}.`));
      else resolveDone(result);
    });
  });
  const waitForLine = (predicate, timeoutMs = 15_000) =>
    new Promise((resolveLine, rejectLine) => {
      const timer = setTimeout(() => {
        remove();
        rejectLine(new Error('Timed out waiting for CLI authorization output.'));
      }, timeoutMs);
      timer.unref();
      const onLine = (line) => {
        try {
          const value = predicate(line);
          if (value !== undefined) {
            remove();
            resolveLine(value);
          }
        } catch (error) {
          remove();
          rejectLine(error);
        }
      };
      const remove = () => {
        clearTimeout(timer);
        const index = listeners.indexOf(onLine);
        if (index >= 0) listeners.splice(index, 1);
      };
      listeners.push(onLine);
    });
  let stdoutRemainder = '';
  child.stdout?.on('data', (chunk) => {
    stdoutRemainder += String(chunk);
    const lines = stdoutRemainder.split(/\r?\n/u);
    stdoutRemainder = lines.pop() ?? '';
    for (const line of lines) {
      if (line) for (const listener of [...listeners]) listener(line);
    }
  });
  return {
    done,
    waitForJson: (predicate) =>
      waitForLine((line) => {
        try {
          const record = JSON.parse(line);
          return predicate(record) ? record : undefined;
        } catch {
          return undefined;
        }
      }),
    waitForText: async (expression) => waitForLine((line) => expression.exec(line)?.[1]),
  };
}

async function request(server, path, options = {}) {
  const response = await rawRequest(server, path, options);
  const text = await response.text();
  if (!(options.expected ?? [200]).includes(response.status)) {
    let code = 'UNKNOWN';
    try {
      code = JSON.parse(text)?.error?.code ?? code;
    } catch {
      /* do not echo response bodies */
    }
    throw new Error(
      `${options.method ?? 'GET'} ${path} failed with HTTP ${response.status} (${code}).`,
    );
  }
  assert(Buffer.byteLength(text, 'utf8') <= 4 * 1024 * 1024, 'Smoke API response was too large.');
  const data = text ? JSON.parse(text) : {};
  assertRecord(data, `Invalid JSON object returned by ${path}.`);
  return data;
}

function rawRequest(server, path, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${server}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
}

async function assertStatus(server, path, token, expected, message) {
  const response = await rawRequest(server, path, { token });
  await response.body?.cancel();
  assert(response.status === expected, `${message} HTTP ${response.status}.`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address()?.port;
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
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
      const response = await fetch(`${server}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      /* migrations may still run */
    }
    await wait(250);
  }
  throw new Error('Local built API did not become healthy in time.');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = collectOutput(child);
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
      const result = { code: code ?? -1, ...output.snapshot() };
      if (timedOut || !(options.expectedCodes ?? [0]).includes(result.code))
        rejectRun(
          new Error(
            timedOut ? `${command} timed out.` : `${command} exited with code ${result.code}.`,
          ),
        );
      else resolveRun(result);
    });
  });
}

function collectOutput(child, maximumBytes = 1024 * 1024) {
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
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), wait(5_000).then(() => false)])) return;
  child.kill('SIGKILL');
  await Promise.race([exited, wait(2_000)]);
  assert(child.exitCode !== null, 'Local built API process did not stop during cleanup.');
}

function parseJsonLines(output) {
  return output
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function requiredRecord(record, key) {
  assertRecord(record, 'Smoke response was not an object.');
  assertRecord(record[key], `Missing ${key} object.`);
  return record[key];
}
function requiredString(record, key) {
  assertRecord(record, 'Smoke response was not an object.');
  assert(typeof record[key] === 'string' && record[key], `Missing ${key}.`);
  return record[key];
}
function assertReadableFile(path, message) {
  return stat(path).then((metadata) => assert(metadata.isFile(), message));
}
function assertRecord(value, message) {
  assert(value && typeof value === 'object' && !Array.isArray(value), message);
}
function assertTerminalSafe(output, sensitiveValues) {
  const terminal = `${output.stdout ?? ''}\n${output.stderr ?? ''}`;
  for (const value of sensitiveValues)
    if (value && terminal.includes(value))
      throw new Error('Smoke terminal output exposed a private task value or credential.');
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
