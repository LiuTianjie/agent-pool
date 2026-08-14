import { createHash, createHmac, randomBytes } from 'node:crypto';

import { CONTROL_SCOPES, type ControlScope } from '@agent-pool/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { createDatabase, runMigrations, type DbPool } from './db.js';
import { bindOfficialFleetOwner } from './official-fleet.js';
import { runMaintenance } from './services.js';
import type { App } from './types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const officialOwnerEmail = `official-owner-${process.pid}-${Date.now()}@example.test`;

integration('API lifecycle against PostgreSQL', () => {
  let app: App;
  let db: DbPool;
  let publisherCookie: string;
  let workerCookie: string;
  let runnerToken: string;
  let runnerCredentialId: string;
  let nodeId: string;
  let officialOwnerCookie: string;

  const claimPool = async (
    token: string,
    claimNodeId: string,
    poolId: string,
    maxUnits: number,
    idempotencyKey?: string,
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: {
        authorization: `Bearer ${token}`,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      payload: { nodeId: claimNodeId, poolId, maxUnits },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().claim as {
      id: string;
      nodeId: string;
      poolId: string;
      maxUnits: number;
      claimedUnits: number;
      status: string;
    };
  };

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await runMigrations(db);
    app = await buildApp({
      config: {
        port: 3000,
        databaseUrl: databaseUrl!,
        jwtSecret: 'integration-test-jwt-secret-at-least-32-characters',
        encryptionKey: randomBytes(32),
        appOrigin: 'http://localhost:3000',
        allowDevTopup: true,
        defaultOfficialOwnerEmail: officialOwnerEmail,
        isProduction: false,
      },
      db,
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('runs auth, pairing, certification, encrypted leasing, validation, and settlement', async () => {
    const activeLeaseIndex = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = current_schema() AND indexname = 'task_units_runner_active_idx'
       ) AS exists`,
    );
    expect(activeLeaseIndex.rows[0]?.exists).toBe(true);

    const email = `publisher-${Date.now()}@example.test`;
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, displayName: 'Publisher', password: 'very-secure-test-password' },
    });
    expect(registered.statusCode).toBe(201);
    publisherCookie = registered.headers['set-cookie']!.split(';')[0]!;

    const topup = await app.inject({
      method: 'POST',
      url: '/api/wallet/dev-topup',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: { credits: 1_000 },
    });
    expect(topup.statusCode).toBe(200);
    expect(topup.json().wallet.purchasedAvailable).toBe(1_000);

    const worker = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `worker-${Date.now()}@example.test`,
        displayName: 'Worker',
        password: 'another-secure-test-password',
      },
    });
    expect(worker.statusCode).toBe(201);
    workerCookie = worker.headers['set-cookie']!.split(';')[0]!;

    const deceptiveDevice = await app.inject({
      method: 'POST',
      url: '/api/auth/device/start',
      payload: { client: 'agentpool-cli', label: 'Community\u202eOfficial' },
    });
    expect(deceptiveDevice.statusCode).toBe(400);
    const device = await app.inject({
      method: 'POST',
      url: '/api/auth/device/start',
      payload: { client: 'agentpool-cli' },
    });
    expect(device.statusCode).toBe(201);
    const codes = device.json();
    const blindApproval = await app.inject({
      method: 'POST',
      url: '/api/auth/device/approve',
      headers: { cookie: workerCookie, origin: 'http://localhost:3000' },
      payload: { userCode: codes.userCode },
    });
    expect(blindApproval.statusCode).toBe(400);
    const devicePreview = await app.inject({
      method: 'POST',
      url: '/api/auth/device/preview',
      headers: { cookie: workerCookie, origin: 'http://localhost:3000' },
      payload: { userCode: codes.userCode },
    });
    expect(devicePreview.statusCode, devicePreview.body).toBe(200);
    expect(devicePreview.headers['cache-control']).toContain('no-store');
    expect(devicePreview.json()).toMatchObject({
      label: 'Agent Pool CLI',
      client: 'agentpool-cli',
      operatorType: 'community',
    });
    const approval = await app.inject({
      method: 'POST',
      url: '/api/auth/device/approve',
      headers: { cookie: workerCookie, origin: 'http://localhost:3000' },
      payload: {
        userCode: codes.userCode,
        expectedClient: devicePreview.json().client,
        expectedOperatorType: devicePreview.json().operatorType,
      },
    });
    expect(approval.statusCode).toBe(200);
    const consumedPreview = await app.inject({
      method: 'POST',
      url: '/api/auth/device/preview',
      headers: { cookie: workerCookie, origin: 'http://localhost:3000' },
      payload: { userCode: codes.userCode },
    });
    expect(consumedPreview.statusCode).toBe(404);
    const expiringDevice = await app.inject({
      method: 'POST',
      url: '/api/auth/device/start',
      payload: { client: 'agentpool-cli', label: 'Expired test Runner' },
    });
    expect(expiringDevice.statusCode, expiringDevice.body).toBe(201);
    const expiringUserCode = expiringDevice.json().userCode as string;
    await db.query(
      `UPDATE device_authorizations SET expires_at = now() - interval '1 second'
       WHERE user_code_hash = $1`,
      [createHash('sha256').update(expiringUserCode, 'utf8').digest('hex')],
    );
    const expiredPreview = await app.inject({
      method: 'POST',
      url: '/api/auth/device/preview',
      headers: { cookie: workerCookie, origin: 'http://localhost:3000' },
      payload: { userCode: expiringUserCode },
    });
    expect(expiredPreview.statusCode).toBe(404);
    const deviceToken = await app.inject({
      method: 'POST',
      url: '/api/auth/device/token',
      payload: { deviceCode: codes.deviceCode },
    });
    expect(deviceToken.statusCode).toBe(200);
    expect(deviceToken.json().status).toBe('approved');
    runnerToken = deviceToken.json().token;
    runnerCredentialId = deviceToken.json().credentialId;

    const node = await app.inject({
      method: 'POST',
      url: '/api/runner/nodes',
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {
        adapter: 'mock',
        models: ['mock-v1'],
        concurrency: 2,
        clientVersion: '0.1.0-test',
        platform: 'darwin',
        arch: 'arm64',
      },
    });
    expect(node.statusCode).toBe(201);
    nodeId = node.json().nodeId;

    const benchmark = await app.inject({
      method: 'POST',
      url: '/api/runner/benchmarks',
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { nodeId, adapter: 'mock', model: 'mock-v1', requestedConcurrency: 2 },
    });
    expect(benchmark.statusCode, benchmark.body).toBe(201);
    const benchmarkBody = benchmark.json();
    const benchmarkResults = benchmarkBody.leases.map(
      (lease: { leaseId: string; input: { text: string } }) => ({
        leaseId: lease.leaseId,
        output: {
          reversed: [...lease.input.text].reverse().join(''),
          uppercase: lease.input.text.toUpperCase(),
          grouped: lease.input.text.match(/.{1,3}/g)?.join('-') ?? lease.input.text,
          length: lease.input.text.length,
        },
        durationMs: 25,
        success: true,
      }),
    );
    const certified = await app.inject({
      method: 'POST',
      url: `/api/runner/benchmarks/${benchmarkBody.benchmarkId}/results`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { results: benchmarkResults },
    });
    expect(certified.statusCode).toBe(200);
    expect(certified.json().certifiedConcurrency).toBe(2);

    const oversizedSchema = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Oversized schema batch',
        category: 'data',
        publicSummary: 'This batch proves publisher schemas are bounded before persistence.',
        secretInstruction: 'Return a value matching the oversized schema.',
        requestedAgent: 'mock',
        requestedModel: 'mock-v1',
        requiredConcurrency: 1,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        rewardPerUnit: 10,
        validationMode: 'auto',
        outputSchema: { type: 'string', description: 'x'.repeat(65_536) },
        units: [{ input: { row: 1 } }, { input: { row: 2 } }],
      },
    });
    expect(oversizedSchema.statusCode, oversizedSchema.body).toBe(400);
    expect(oversizedSchema.body).toContain('Output schema must not exceed 64 KiB');

    const created = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Secret extraction batch',
        category: 'data',
        publicSummary: 'Extract one public-safe field from each independent row.',
        secretInstruction: 'Return the exact expected JSON answer for this private row.',
        requestedAgent: 'mock',
        requestedModel: 'mock-v1',
        requiredConcurrency: 1,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        rewardPerUnit: 10,
        validationMode: 'auto',
        outputSchema: {
          type: 'object',
          required: ['answer'],
          properties: { answer: { type: 'string' } },
        },
        units: [
          {
            label: 'private-label-1',
            input: { hidden: 'private-input-1' },
            expectedOutput: { answer: '42' },
          },
          {
            label: 'private-label-2',
            input: { hidden: 'private-input-2' },
            expectedOutput: { answer: '42' },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const poolId = created.json().pool.id;
    expect(created.json().pool.status).toBe('queued');

    const encrypted = await db.query<{
      secret_instruction_ciphertext: string;
      input_ciphertext: string;
    }>(
      `SELECT p.secret_instruction_ciphertext, u.input_ciphertext
       FROM pools p JOIN task_units u ON u.pool_id = p.id WHERE p.id = $1`,
      [poolId],
    );
    expect(encrypted.rows[0]!.secret_instruction_ciphertext).not.toContain('private row');
    expect(encrypted.rows[0]!.input_ciphertext).not.toContain('private-input');

    const connectedWithoutClaim = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${nodeId}/heartbeat`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { status: 'online' },
    });
    expect(connectedWithoutClaim.statusCode, connectedWithoutClaim.body).toBe(200);
    const unclaimedPoll = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${nodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: ['mock-v1'] },
    });
    expect(unclaimedPoll.statusCode).toBe(400);
    expect(unclaimedPoll.json().error.code).toBe('RUNNER_CLAIM_REQUIRED');
    const untouchedWithoutClaim = await db.query<{ status: string }>(
      `SELECT status FROM task_units WHERE pool_id = $1 ORDER BY ordinal`,
      [poolId],
    );
    expect(untouchedWithoutClaim.rows.map(({ status }) => status)).toEqual(['queued', 'queued']);
    const jobs = await app.inject({
      method: 'GET',
      url: `/api/runner/jobs?nodeId=${nodeId}`,
      headers: { authorization: `Bearer ${runnerToken}` },
    });
    expect(jobs.statusCode, jobs.body).toBe(200);
    expect(jobs.json().jobs).toContainEqual(
      expect.objectContaining({
        id: poolId,
        requestedAgent: 'mock',
        requestedModel: 'mock-v1',
        deliveryMode: 'platform',
        maxUnitSeconds: 10,
        maxAttempts: 3,
        acceptanceMode: 'schema_and_hidden_exact',
        deliveryFormat: 'json',
        deliveryMaxBytes: 8 * 1024 * 1024,
        pilot: false,
        availableUnits: 2,
      }),
    );
    const extractionClaimKey = `claim-${randomBytes(12).toString('hex')}`;
    const claimResponses = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/runner/claims',
          headers: {
            authorization: `Bearer ${runnerToken}`,
            'idempotency-key': extractionClaimKey,
          },
          payload: { nodeId, poolId, maxUnits: 2 },
        }),
      ),
    );
    expect(claimResponses.map(({ statusCode }) => statusCode)).toEqual([201, 201]);
    expect(claimResponses[0]!.json()).toEqual(claimResponses[1]!.json());
    expect(
      claimResponses.filter(({ headers }) => headers['idempotency-replayed'] === 'true'),
    ).toHaveLength(1);
    const extractionClaim = claimResponses[0]!.json().claim;
    const grants = await db.query<{ count: string }>(
      `SELECT count(*) FROM runner_claim_grants
       WHERE credential_id = $1 AND node_id = $2 AND pool_id = $3`,
      [runnerCredentialId, nodeId, poolId],
    );
    expect(grants.rows[0]?.count).toBe('1');
    const encryptedClaimReplay = await db.query<{ response_ciphertext: string }>(
      `SELECT response_ciphertext FROM runner_idempotency_records
       WHERE credential_id = $1 AND route_scope = 'runner.claims.create'
         AND idempotency_key = $2`,
      [runnerCredentialId, extractionClaimKey],
    );
    expect(encryptedClaimReplay.rows[0]?.response_ciphertext).not.toContain(
      created.json().pool.title,
    );
    const extractionClaimConflict = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: {
        authorization: `Bearer ${runnerToken}`,
        'idempotency-key': extractionClaimKey,
      },
      payload: { nodeId, poolId, maxUnits: 1 },
    });
    expect(extractionClaimConflict.statusCode).toBe(409);
    expect(extractionClaimConflict.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    for (const expectedIndex of [1, 2]) {
      const leased = await app.inject({
        method: 'POST',
        url: `/api/runner/nodes/${nodeId}/leases/poll`,
        headers: { authorization: `Bearer ${runnerToken}` },
        payload: { adapter: 'mock', models: ['mock-v1'], claimId: extractionClaim.id },
      });
      expect(leased.statusCode).toBe(200);
      const lease = leased.json().lease;
      expect(lease.input).toEqual({ hidden: `private-input-${expectedIndex}` });
      expect(leased.headers['cache-control']).toContain('no-store');

      if (expectedIndex === 1) {
        const privateRunnerTelemetry = await app.inject({
          method: 'GET',
          url: '/api/runners',
          headers: { cookie: workerCookie },
        });
        expect(privateRunnerTelemetry.statusCode, privateRunnerTelemetry.body).toBe(200);
        expect(privateRunnerTelemetry.json().nodes[0].activeJobs[0]).toEqual({
          stage: 'leased',
          progress: 0,
          reward: 10,
        });
        expect(privateRunnerTelemetry.body).not.toContain('Secret extraction batch');
        expect(privateRunnerTelemetry.body).not.toContain('private-input');
        expect(privateRunnerTelemetry.body).not.toContain('exact expected JSON');
        expect(privateRunnerTelemetry.json().nodes[0].activeJobs[0]).not.toHaveProperty('id');
        expect(privateRunnerTelemetry.json().nodes[0].activeJobs[0]).not.toHaveProperty('poolId');
        expect(privateRunnerTelemetry.json().nodes[0].activeJobs[0]).not.toHaveProperty(
          'poolTitle',
        );
        expect(privateRunnerTelemetry.json().nodes[0].activeJobs[0]).not.toHaveProperty('category');
      }

      const submitted = await app.inject({
        method: 'POST',
        url: `/api/runner/leases/${lease.leaseId}/submit`,
        headers: { authorization: `Bearer ${runnerToken}` },
        payload: { output: { answer: '42' } },
      });
      expect(submitted.statusCode, submitted.body).toBe(200);
      expect(submitted.json().status).toBe('accepted');
    }

    const results = await app.inject({
      method: 'GET',
      url: `/api/pools/${poolId}/results`,
      headers: { cookie: publisherCookie },
    });
    expect(results.statusCode).toBe(200);
    expect(results.json().results).toHaveLength(2);
    expect(results.json().results[0].result).toEqual({ answer: '42' });

    const completedPool = await app.inject({
      method: 'GET',
      url: `/api/pools/${poolId}`,
      headers: { cookie: publisherCookie },
    });
    expect(completedPool.json().pool.status).toBe('completed');

    const publicPool = await app.inject({ method: 'GET', url: `/api/public/pools/${poolId}` });
    expect(publicPool.statusCode).toBe(200);
    expect(publicPool.body).not.toContain('private-input');
    expect(publicPool.body).not.toContain('private row');

    const publisherWallet = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: { cookie: publisherCookie },
    });
    expect(publisherWallet.json().wallet).toEqual({
      purchasedAvailable: 980,
      purchasedLocked: 0,
      earnedPending: 0,
      earnedAvailable: 0,
    });

    const workerWallet = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: { cookie: workerCookie },
    });
    expect(workerWallet.json().wallet).toEqual({
      purchasedAvailable: 0,
      purchasedLocked: 0,
      earnedPending: 0,
      earnedAvailable: 20,
    });

    const withdrawal = await app.inject({
      method: 'POST',
      url: '/api/wallet/dev-withdraw',
      headers: { cookie: workerCookie, origin: 'http://localhost:3000' },
      payload: { credits: 5 },
    });
    expect(withdrawal.statusCode).toBe(200);
    expect(withdrawal.json().withdrawal.status).toBe('simulated_paid');
    expect(withdrawal.json().wallet.earnedAvailable).toBe(15);

    const manualPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Manual review batch',
        category: 'text',
        publicSummary: 'Two independent writing units with publisher review.',
        secretInstruction: 'Return a short private draft for publisher review.',
        requestedAgent: 'mock',
        requestedModel: 'mock-v1',
        requiredConcurrency: 1,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        rewardPerUnit: 5,
        validationMode: 'manual',
        units: [{ input: { row: 1 } }, { input: { row: 2 } }],
      },
    });
    expect(manualPool.statusCode, manualPool.body).toBe(201);
    const manualPoolId = manualPool.json().pool.id;
    const manualClaim = await claimPool(runnerToken, nodeId, manualPoolId, 1);
    const manualLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${nodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: ['mock-v1'], claimId: manualClaim.id },
    });
    const manualLease = manualLeaseResponse.json().lease;
    const manualSubmit = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${manualLease.leaseId}/submit`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { output: { draft: 'review me' } },
    });
    expect(manualSubmit.json().status).toBe('submitted');
    const manualReview = await app.inject({
      method: 'POST',
      url: `/api/pools/${manualPoolId}/units/${manualLease.unitId}/review`,
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: { decision: 'accept' },
    });
    expect(manualReview.statusCode, manualReview.body).toBe(200);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/pools/${manualPoolId}/cancel`,
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().refunded).toBe(5);
    expect(cancelled.json().wallet).toEqual({
      purchasedAvailable: 975,
      purchasedLocked: 0,
      earnedPending: 0,
      earnedAvailable: 0,
    });

    const workerAfterManual = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: { cookie: workerCookie },
    });
    expect(workerAfterManual.json().wallet.earnedAvailable).toBe(20);

    const cancellableManualPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Cancel submitted manual batch',
        category: 'text',
        publicSummary: 'Submitted work must be cancelled and fully refunded with its batch.',
        secretInstruction: 'Return a private draft that remains pending manual review.',
        requestedAgent: 'mock',
        requestedModel: 'mock-v1',
        requiredConcurrency: 1,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        rewardPerUnit: 4,
        validationMode: 'manual',
        units: [{ input: { row: 1 } }, { input: { row: 2 } }],
      },
    });
    expect(cancellableManualPool.statusCode, cancellableManualPool.body).toBe(201);
    const cancellablePoolId = cancellableManualPool.json().pool.id;
    const cancellableClaim = await claimPool(runnerToken, nodeId, cancellablePoolId, 2);
    const cancellableLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${nodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: ['mock-v1'], claimId: cancellableClaim.id },
    });
    const cancellableLease = cancellableLeaseResponse.json().lease;
    const cancellableSubmit = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${cancellableLease.leaseId}/submit`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { output: { draft: 'cancel me' } },
    });
    expect(cancellableSubmit.json().status).toBe('submitted');
    const cancelSubmitted = await app.inject({
      method: 'POST',
      url: `/api/pools/${cancellablePoolId}/cancel`,
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
    });
    expect(cancelSubmitted.statusCode, cancelSubmitted.body).toBe(200);
    expect(cancelSubmitted.json().refunded).toBe(8);
    expect(cancelSubmitted.json().wallet.purchasedLocked).toBe(0);
    const terminatedCancelledClaim = await app.inject({
      method: 'GET',
      url: `/api/runner/claims/${cancellableClaim.id}`,
      headers: { authorization: `Bearer ${runnerToken}` },
    });
    expect(terminatedCancelledClaim.statusCode, terminatedCancelledClaim.body).toBe(200);
    expect(terminatedCancelledClaim.json().claim).toMatchObject({
      status: 'revoked',
      claimedUnits: 1,
      remainingUnits: 1,
    });
    const retryCancelled = await app.inject({
      method: 'POST',
      url: `/api/pools/${cancellablePoolId}/units/${cancellableLease.unitId}/review`,
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: { decision: 'reject', retry: true, reason: 'must stay cancelled' },
    });
    expect(retryCancelled.statusCode).toBe(409);
    const cancelledUnits = await db.query<{ status: string }>(
      'SELECT status FROM task_units WHERE pool_id = $1 ORDER BY ordinal',
      [cancellablePoolId],
    );
    expect(cancelledUnits.rows.map((unit) => unit.status)).toEqual(['cancelled', 'cancelled']);

    const deadlineAt = new Date(Date.now() + 60_000);
    const deadlineManualPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Deadline submitted manual batch',
        category: 'text',
        publicSummary: 'Deadline expiry must cancel submitted and queued work together.',
        secretInstruction: 'Return a private draft before this batch deadline.',
        requestedAgent: 'mock',
        requestedModel: 'mock-v1',
        requiredConcurrency: 1,
        maxUnitSeconds: 3_600,
        deadlineAt: deadlineAt.toISOString(),
        rewardPerUnit: 3,
        validationMode: 'manual',
        units: [{ input: { row: 1 } }, { input: { row: 2 } }],
      },
    });
    expect(deadlineManualPool.statusCode, deadlineManualPool.body).toBe(201);
    const deadlinePoolId = deadlineManualPool.json().pool.id;
    const deadlineClaim = await claimPool(runnerToken, nodeId, deadlinePoolId, 2);
    const deadlineLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${nodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: ['mock-v1'], claimId: deadlineClaim.id },
    });
    const deadlineLease = deadlineLeaseResponse.json().lease;
    expect(deadlineLease).not.toBeNull();
    expect(new Date(deadlineLease.expiresAt).getTime()).toBeLessThanOrEqual(deadlineAt.getTime());
    expect(new Date(deadlineLease.expiresAt).getTime()).toBeLessThan(Date.now() + 120_000);
    const deadlineSubmit = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${deadlineLease.leaseId}/submit`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { output: { draft: 'deadline me' } },
    });
    expect(deadlineSubmit.json().status).toBe('submitted');
    await db.query(`UPDATE pools SET deadline_at = now() - interval '1 second' WHERE id = $1`, [
      deadlinePoolId,
    ]);
    await runMaintenance(db);
    const terminatedDeadlineClaim = await app.inject({
      method: 'GET',
      url: `/api/runner/claims/${deadlineClaim.id}`,
      headers: { authorization: `Bearer ${runnerToken}` },
    });
    expect(terminatedDeadlineClaim.statusCode, terminatedDeadlineClaim.body).toBe(200);
    expect(terminatedDeadlineClaim.json().claim.status).toBe('revoked');
    const deadlinePoolAfter = await app.inject({
      method: 'GET',
      url: `/api/pools/${deadlinePoolId}`,
      headers: { cookie: publisherCookie },
    });
    expect(deadlinePoolAfter.json().pool.status).toBe('cancelled');
    expect(deadlinePoolAfter.json().pool.terminalReason).toBe('deadline');
    const deadlineUnits = await db.query<{ status: string }>(
      'SELECT status FROM task_units WHERE pool_id = $1 ORDER BY ordinal',
      [deadlinePoolId],
    );
    expect(deadlineUnits.rows.map((unit) => unit.status)).toEqual(['cancelled', 'cancelled']);
    const publisherAfterDeadline = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: { cookie: publisherCookie },
    });
    expect(publisherAfterDeadline.json().wallet.purchasedAvailable).toBe(975);
    expect(publisherAfterDeadline.json().wallet.purchasedLocked).toBe(0);

    const workerTopup = await app.inject({
      method: 'POST',
      url: '/api/wallet/dev-topup',
      headers: { cookie: workerCookie, origin: 'http://localhost:3000' },
      payload: { credits: 10 },
    });
    expect(workerTopup.statusCode).toBe(200);
    const selfOwnedPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: workerCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Self-owned conversion attempt',
        category: 'data',
        publicSummary: 'This split batch must never be leased to its own owner.',
        secretInstruction: 'Return any non-empty output for this security test.',
        requestedAgent: 'mock',
        requestedModel: 'mock-v1',
        requiredConcurrency: 1,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        rewardPerUnit: 5,
        validationMode: 'auto',
        units: [{ input: { row: 1 } }, { input: { row: 2 } }],
      },
    });
    expect(selfOwnedPool.statusCode, selfOwnedPool.body).toBe(201);
    expect(selfOwnedPool.json().pool.status).toBe('queued');
    const selfClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { nodeId, poolId: selfOwnedPool.json().pool.id, maxUnits: 1 },
    });
    expect(selfClaim.statusCode, selfClaim.body).toBe(409);
    expect(selfClaim.json().error.code).toBe('SELF_RENT_FORBIDDEN');
    const selfUnits = await db.query<{ status: string }>(
      'SELECT status FROM task_units WHERE pool_id = $1 ORDER BY ordinal',
      [selfOwnedPool.json().pool.id],
    );
    expect(selfUnits.rows.map((unit) => unit.status)).toEqual(['queued', 'queued']);
    const selfCancel = await app.inject({
      method: 'POST',
      url: `/api/pools/${selfOwnedPool.json().pool.id}/cancel`,
      headers: { cookie: workerCookie, origin: 'http://localhost:3000' },
    });
    expect(selfCancel.statusCode, selfCancel.body).toBe(200);
    expect(selfCancel.json().refunded).toBe(10);
    expect(selfCancel.json().wallet.earnedAvailable).toBe(20);
  }, 30_000);

  it('runs Task Capsule pilot and direct webhook receipt lifecycles', async () => {
    const publisherBeforeCapsules = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: { cookie: publisherCookie },
    });
    const workerBeforeCapsules = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: { cookie: workerCookie },
    });
    const publisherAvailableBeforeCapsules =
      publisherBeforeCapsules.json().wallet.purchasedAvailable;
    const workerEarnedBeforeCapsules = workerBeforeCapsules.json().wallet.earnedAvailable;
    const capsuleModel = `mock-capsule-${nodeId}`;
    const capsuleNode = await app.inject({
      method: 'POST',
      url: '/api/runner/nodes',
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {
        adapter: 'mock',
        models: ['mock-v1', capsuleModel],
        concurrency: 2,
        clientVersion: '0.1.0-test',
        platform: 'darwin',
        arch: 'arm64',
        supportsDirectWebhooks: false,
      },
    });
    expect(capsuleNode.statusCode, capsuleNode.body).toBe(201);
    const capsuleNodeId = capsuleNode.json().nodeId as string;
    expect(capsuleNodeId).not.toBe(nodeId);
    const capsuleBenchmark = await app.inject({
      method: 'POST',
      url: '/api/runner/benchmarks',
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {
        nodeId: capsuleNodeId,
        adapter: 'mock',
        model: capsuleModel,
        requestedConcurrency: 2,
      },
    });
    expect(capsuleBenchmark.statusCode, capsuleBenchmark.body).toBe(201);
    const capsuleBenchmarkBody = capsuleBenchmark.json();
    const capsuleBenchmarkResults = capsuleBenchmarkBody.leases.map(
      (lease: { leaseId: string; input: { text: string } }) => ({
        leaseId: lease.leaseId,
        output: {
          reversed: [...lease.input.text].reverse().join(''),
          uppercase: lease.input.text.toUpperCase(),
          grouped: lease.input.text.match(/.{1,3}/g)?.join('-') ?? lease.input.text,
          length: lease.input.text.length,
        },
        durationMs: 25,
        success: true,
      }),
    );
    const capsuleCertification = await app.inject({
      method: 'POST',
      url: `/api/runner/benchmarks/${capsuleBenchmarkBody.benchmarkId}/results`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { results: capsuleBenchmarkResults },
    });
    expect(capsuleCertification.statusCode, capsuleCertification.body).toBe(200);
    expect(capsuleCertification.json().certifiedConcurrency).toBe(2);
    const isolatedCellCertifications = await db.query<{ node_id: string; model: string }>(
      `SELECT certification.node_id, certification.model
       FROM runner_certifications certification
       JOIN runner_nodes node ON node.id = certification.node_id
       WHERE node.credential_id = $1 AND certification.model IN ('mock-v1', $2)
       ORDER BY certification.model`,
      [runnerCredentialId, capsuleModel],
    );
    expect(isolatedCellCertifications.rows).toEqual([
      { node_id: capsuleNodeId, model: capsuleModel },
      { node_id: nodeId, model: 'mock-v1' },
    ]);

    const pilotExpected = ['', 'one', 'two', 'three', 'four'];
    const pilotPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Task Capsule pilot batch',
        category: 'text',
        publicSummary: 'A spread pilot proves the task contract before the held batch launches.',
        requestedAgent: 'mock',
        requestedModel: capsuleModel,
        requiredConcurrency: 2,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        rewardPerUnit: 2,
        taskCapsule: {
          version: 'ap-task/1',
          goal: 'Return the exact private text value',
          inputDescription: 'Each unit contains one text value.',
          outputDescription: 'Return only that text value, including an empty string.',
          constraints: ['Do not add prose.'],
          examples: [{ input: { value: 'sample' }, output: 'sample' }],
          delivery: {
            format: 'json',
            schema: { type: 'string' },
            maxBytes: 1024,
          },
          acceptance: {
            mode: 'schema_and_hidden_exact',
            criteria: ['The returned string satisfies the schema and hidden expected output.'],
          },
        },
        deliveryTarget: { mode: 'platform' },
        launchMode: 'pilot',
        pilotUnits: 3,
        units: pilotExpected.map((value, index) => ({
          label: `pilot-${index}`,
          input: { value },
          expectedOutput: value,
        })),
      },
    });
    expect(pilotPool.statusCode, pilotPool.body).toBe(201);
    const pilotPoolBody = pilotPool.json();
    const pilotPoolId = pilotPoolBody.pool.id;
    expect(pilotPoolBody.pool.status).toBe('piloting');
    expect(pilotPoolBody.pool.pilotUnits).toBe(3);
    expect(pilotPoolBody.pool.heldUnits).toBe(2);
    expect(pilotPoolBody.pool.contractHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pilotPoolBody.pool.taskCapsule.version).toBe('ap-task/1');
    const encryptedCapsule = await db.query<{
      output_schema: Record<string, unknown> | null;
    }>('SELECT output_schema FROM pools WHERE id = $1', [pilotPoolId]);
    expect(encryptedCapsule.rows[0]?.output_schema).toBeNull();
    const pilotRows = await db.query<{
      ordinal: number;
      status: string;
      is_pilot: boolean;
    }>('SELECT ordinal, status, is_pilot FROM task_units WHERE pool_id = $1 ORDER BY ordinal', [
      pilotPoolId,
    ]);
    expect(pilotRows.rows.filter((row) => row.is_pilot).map((row) => row.ordinal)).toEqual([
      0, 2, 4,
    ]);
    expect(pilotRows.rows.filter((row) => row.status === 'held')).toHaveLength(2);

    const pilotClaim = await claimPool(runnerToken, capsuleNodeId, pilotPoolId, 3);
    const processedPilotOrdinals: number[] = [];
    for (let pilotIndex = 0; pilotIndex < 3; pilotIndex += 1) {
      const leaseResponse = await app.inject({
        method: 'POST',
        url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
        headers: { authorization: `Bearer ${runnerToken}` },
        payload: { adapter: 'mock', models: [capsuleModel], claimId: pilotClaim.id },
      });
      expect(leaseResponse.statusCode, leaseResponse.body).toBe(200);
      const lease = leaseResponse.json().lease;
      expect(lease).not.toBeNull();
      expect(lease.poolId).toBe(pilotPoolId);
      expect(lease.isPilot).toBe(true);
      expect(lease.delivery).toEqual({ mode: 'platform' });
      expect(lease.taskCapsule.acceptance.mode).toBe('schema_and_hidden_exact');
      expect(lease.outputSchema).toEqual({ type: 'string' });
      expect(lease.contractHash).toBe(pilotPoolBody.pool.contractHash);
      processedPilotOrdinals.push(
        Number(lease.input.value === '' ? 0 : pilotExpected.indexOf(lease.input.value)),
      );

      const submit = await app.inject({
        method: 'POST',
        url: `/api/runner/leases/${lease.leaseId}/submit`,
        headers: { authorization: `Bearer ${runnerToken}` },
        payload: { output: lease.input.value },
      });
      expect(submit.statusCode, submit.body).toBe(200);
      expect(submit.json().status).toBe('accepted');
      if (pilotIndex === 0) {
        const replay = await app.inject({
          method: 'POST',
          url: `/api/runner/leases/${lease.leaseId}/submit`,
          headers: { authorization: `Bearer ${runnerToken}` },
          payload: { output: lease.input.value },
        });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toEqual(submit.json());
        const conflictingReplay = await app.inject({
          method: 'POST',
          url: `/api/runner/leases/${lease.leaseId}/submit`,
          headers: { authorization: `Bearer ${runnerToken}` },
          payload: { output: 'different-content' },
        });
        expect(conflictingReplay.statusCode, conflictingReplay.body).toBe(409);

        const earlyLaunch = await app.inject({
          method: 'POST',
          url: `/api/pools/${pilotPoolId}/launch`,
          headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
        });
        expect(earlyLaunch.statusCode, earlyLaunch.body).toBe(409);
      }
    }
    expect(processedPilotOrdinals).toEqual([0, 2, 4]);
    const pilotReady = await app.inject({
      method: 'GET',
      url: `/api/pools/${pilotPoolId}`,
      headers: { cookie: publisherCookie },
    });
    expect(pilotReady.json().pool.pilotAcceptedUnits).toBe(3);
    expect(pilotReady.json().pool.pilotFailedUnits).toBe(0);
    expect(pilotReady.json().pool.heldUnits).toBe(2);

    const launch = await app.inject({
      method: 'POST',
      url: `/api/pools/${pilotPoolId}/launch`,
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
    });
    expect(launch.statusCode, launch.body).toBe(200);
    expect(launch.json().releasedUnits).toBe(2);
    expect(launch.json().pool.status).toBe('queued');
    expect(launch.json().pool.heldUnits).toBe(0);

    const launchedClaim = await claimPool(runnerToken, capsuleNodeId, pilotPoolId, 2);
    for (let remainingIndex = 0; remainingIndex < 2; remainingIndex += 1) {
      const leaseResponse = await app.inject({
        method: 'POST',
        url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
        headers: { authorization: `Bearer ${runnerToken}` },
        payload: { adapter: 'mock', models: [capsuleModel], claimId: launchedClaim.id },
      });
      const lease = leaseResponse.json().lease;
      expect(lease?.poolId).toBe(pilotPoolId);
      expect(lease?.isPilot).toBe(false);
      const submit = await app.inject({
        method: 'POST',
        url: `/api/runner/leases/${lease.leaseId}/submit`,
        headers: { authorization: `Bearer ${runnerToken}` },
        payload: { output: lease.input.value },
      });
      expect(submit.statusCode, submit.body).toBe(200);
      expect(submit.json().status).toBe('accepted');
    }
    const completedPilot = await app.inject({
      method: 'GET',
      url: `/api/pools/${pilotPoolId}`,
      headers: { cookie: publisherCookie },
    });
    expect(completedPilot.json().pool.status).toBe('completed');
    expect(completedPilot.json().pool.acceptedUnits).toBe(5);

    const allPilotPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'All units are pilot units',
        category: 'text',
        publicSummary: 'A two-unit all-pilot batch completes without a separate launch step.',
        requestedAgent: 'mock',
        requestedModel: capsuleModel,
        requiredConcurrency: 2,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        rewardPerUnit: 1,
        launchMode: 'pilot',
        pilotUnits: 2,
        taskCapsule: {
          version: 'ap-task/1',
          goal: 'Return the exact all-pilot value',
          inputDescription: 'Each pilot contains one text value.',
          outputDescription: 'Return only the text value.',
          constraints: [],
          examples: [],
          delivery: { format: 'text', maxBytes: 1024 },
          acceptance: {
            mode: 'hidden_exact',
            criteria: ['Output exactly equals the hidden pilot answer.'],
          },
        },
        units: [
          { input: { value: 'all-pilot-one' }, expectedOutput: 'all-pilot-one' },
          { input: { value: 'all-pilot-two' }, expectedOutput: 'all-pilot-two' },
        ],
      },
    });
    expect(allPilotPool.statusCode, allPilotPool.body).toBe(201);
    const allPilotPoolId = allPilotPool.json().pool.id;
    expect(allPilotPool.json().pool).toMatchObject({ status: 'piloting', heldUnits: 0 });
    const allPilotClaim = await claimPool(runnerToken, capsuleNodeId, allPilotPoolId, 2);
    for (let index = 0; index < 2; index += 1) {
      const leaseResponse = await app.inject({
        method: 'POST',
        url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
        headers: { authorization: `Bearer ${runnerToken}` },
        payload: { adapter: 'mock', models: [capsuleModel], claimId: allPilotClaim.id },
      });
      const lease = leaseResponse.json().lease;
      expect(lease.poolId).toBe(allPilotPoolId);
      const submit = await app.inject({
        method: 'POST',
        url: `/api/runner/leases/${lease.leaseId}/submit`,
        headers: { authorization: `Bearer ${runnerToken}` },
        payload: { output: lease.input.value },
      });
      expect(submit.statusCode, submit.body).toBe(200);
      expect(submit.json().status).toBe('accepted');
    }
    const completedAllPilot = await app.inject({
      method: 'GET',
      url: `/api/pools/${allPilotPoolId}`,
      headers: { cookie: publisherCookie },
    });
    expect(completedAllPilot.json().pool).toMatchObject({
      status: 'completed',
      acceptedUnits: 2,
      heldUnits: 0,
    });

    const staleAutomaticMarker = `stale-auto-output-${Date.now()}`;
    const automaticRetryPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Automatic retry output isolation',
        category: 'text',
        publicSummary: 'A rejected attempt must not remain visible as the current delivery.',
        requestedAgent: 'mock',
        requestedModel: capsuleModel,
        requiredConcurrency: 1,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        rewardPerUnit: 1,
        taskCapsule: {
          version: 'ap-task/1',
          goal: 'Return the exact expected string',
          inputDescription: 'Each unit contains a target string.',
          outputDescription: 'Return only the target string.',
          constraints: [],
          examples: [],
          delivery: { format: 'text', maxBytes: 1024 },
          acceptance: {
            mode: 'hidden_exact',
            criteria: ['Output exactly equals the hidden answer.'],
          },
        },
        units: [
          { input: { target: 'correct-one' }, expectedOutput: 'correct-one' },
          { input: { target: 'correct-two' }, expectedOutput: 'correct-two' },
        ],
      },
    });
    expect(automaticRetryPool.statusCode, automaticRetryPool.body).toBe(201);
    const automaticRetryPoolId = automaticRetryPool.json().pool.id;
    const automaticClaim = await claimPool(runnerToken, capsuleNodeId, automaticRetryPoolId, 2);
    const automaticLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: [capsuleModel], claimId: automaticClaim.id },
    });
    const automaticLease = automaticLeaseResponse.json().lease;
    const automaticRejected = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${automaticLease.leaseId}/submit`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { output: staleAutomaticMarker },
    });
    expect(automaticRejected.statusCode, automaticRejected.body).toBe(200);
    expect(automaticRejected.json().status).toBe('retrying');
    const automaticAfterRetry = await db.query<{
      status: string;
      result_ciphertext: string | null;
      submitted_at: Date | null;
    }>('SELECT status, result_ciphertext, submitted_at FROM task_units WHERE id = $1', [
      automaticLease.unitId,
    ]);
    expect(automaticAfterRetry.rows[0]).toMatchObject({
      status: 'queued',
      result_ciphertext: null,
      submitted_at: null,
    });
    const automaticRetryResults = await app.inject({
      method: 'GET',
      url: `/api/pools/${automaticRetryPoolId}/results`,
      headers: { cookie: publisherCookie },
    });
    expect(automaticRetryResults.body).not.toContain(staleAutomaticMarker);
    expect(automaticRetryResults.json().results).toEqual([]);

    const automaticRetryLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: [capsuleModel], claimId: automaticClaim.id },
    });
    const automaticRetryLease = automaticRetryLeaseResponse.json().lease;
    expect(automaticRetryLease.unitId).toBe(automaticLease.unitId);
    const explicitFailure = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${automaticRetryLease.leaseId}/fail`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { code: 'agent_error', retryable: false },
    });
    expect(explicitFailure.statusCode, explicitFailure.body).toBe(200);
    expect(explicitFailure.json().status).toBe('failed');
    const afterExplicitFailure = await app.inject({
      method: 'GET',
      url: `/api/pools/${automaticRetryPoolId}/results`,
      headers: { cookie: publisherCookie },
    });
    expect(afterExplicitFailure.body).not.toContain(staleAutomaticMarker);
    expect(afterExplicitFailure.json().results).toEqual([]);

    const automaticRemainderClaim = await claimPool(
      runnerToken,
      capsuleNodeId,
      automaticRetryPoolId,
      1,
    );
    const secondAutomaticLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {
        adapter: 'mock',
        models: [capsuleModel],
        claimId: automaticRemainderClaim.id,
      },
    });
    const secondAutomaticLease = secondAutomaticLeaseResponse.json().lease;
    const secondAutomaticAccepted = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${secondAutomaticLease.leaseId}/submit`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { output: secondAutomaticLease.input.target },
    });
    expect(secondAutomaticAccepted.statusCode, secondAutomaticAccepted.body).toBe(200);
    expect(secondAutomaticAccepted.json().status).toBe('accepted');

    const staleManualMarker = `stale-manual-output-${Date.now()}`;
    const manualRetryPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Manual retry output isolation',
        category: 'text',
        publicSummary: 'Publisher retry clears the prior draft before a new runner attempt.',
        requestedAgent: 'mock',
        requestedModel: capsuleModel,
        requiredConcurrency: 1,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        rewardPerUnit: 1,
        taskCapsule: {
          version: 'ap-task/1',
          goal: 'Draft text for publisher review',
          inputDescription: 'Each unit contains one draft request.',
          outputDescription: 'Return a plain text draft.',
          constraints: [],
          examples: [],
          delivery: { format: 'text', maxBytes: 1024 },
          acceptance: { mode: 'manual', criteria: ['Publisher approves the draft.'] },
        },
        units: [{ input: { row: 1 } }, { input: { row: 2 } }],
      },
    });
    expect(manualRetryPool.statusCode, manualRetryPool.body).toBe(201);
    const manualRetryPoolId = manualRetryPool.json().pool.id;
    const manualRetryClaim = await claimPool(runnerToken, capsuleNodeId, manualRetryPoolId, 2);
    const manualRetryLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: [capsuleModel], claimId: manualRetryClaim.id },
    });
    const manualRetryLease = manualRetryLeaseResponse.json().lease;
    const manualDraft = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${manualRetryLease.leaseId}/submit`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { output: staleManualMarker },
    });
    expect(manualDraft.json().status).toBe('submitted');
    const manualRetry = await app.inject({
      method: 'POST',
      url: `/api/pools/${manualRetryPoolId}/units/${manualRetryLease.unitId}/review`,
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: { decision: 'reject', retry: true, reason: 'Rewrite this draft' },
    });
    expect(manualRetry.statusCode, manualRetry.body).toBe(200);
    const manualAfterRetry = await db.query<{
      status: string;
      result_ciphertext: string | null;
      submitted_at: Date | null;
    }>('SELECT status, result_ciphertext, submitted_at FROM task_units WHERE id = $1', [
      manualRetryLease.unitId,
    ]);
    expect(manualAfterRetry.rows[0]).toMatchObject({
      status: 'queued',
      result_ciphertext: null,
      submitted_at: null,
    });
    const manualRetryResults = await app.inject({
      method: 'GET',
      url: `/api/pools/${manualRetryPoolId}/results`,
      headers: { cookie: publisherCookie },
    });
    expect(manualRetryResults.body).not.toContain(staleManualMarker);
    expect(manualRetryResults.json().results).toEqual([]);
    const manualRetryAgainResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: [capsuleModel], claimId: manualRetryClaim.id },
    });
    const manualRetryAgain = manualRetryAgainResponse.json().lease;
    expect(manualRetryAgain.unitId).toBe(manualRetryLease.unitId);
    const manualExplicitFailure = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${manualRetryAgain.leaseId}/fail`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { code: 'agent_error', retryable: false },
    });
    expect(manualExplicitFailure.statusCode, manualExplicitFailure.body).toBe(200);
    const manualAfterFailure = await app.inject({
      method: 'GET',
      url: `/api/pools/${manualRetryPoolId}/results`,
      headers: { cookie: publisherCookie },
    });
    expect(manualAfterFailure.body).not.toContain(staleManualMarker);
    const cancelManualRemainder = await app.inject({
      method: 'POST',
      url: `/api/pools/${manualRetryPoolId}/cancel`,
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
    });
    expect(cancelManualRemainder.statusCode, cancelManualRemainder.body).toBe(200);

    const receiptSecret = 'integration-webhook-secret-0123456789abcdef';
    const callbackUrl = 'https://example.test/agentpool/callback?tenant=integration';
    const webhookPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Direct webhook delivery batch',
        category: 'data',
        publicSummary:
          'Outputs go directly to an external callback and only receipts reach Agent Pool.',
        requestedAgent: 'mock',
        requestedModel: capsuleModel,
        requiredConcurrency: 2,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        rewardPerUnit: 3,
        maxAttempts: 3,
        taskCapsule: {
          version: 'ap-task/1',
          goal: 'Transform and deliver each record to the callback',
          inputDescription: 'Each unit contains one private source record.',
          outputDescription: 'POST one JSON result to the configured direct webhook.',
          constraints: ['Do not submit the result to Agent Pool.'],
          examples: [],
          delivery: { format: 'json', maxBytes: 2048 },
          acceptance: {
            mode: 'webhook',
            criteria: ['The callback returns an Agent Pool signed-receipt payload.'],
          },
        },
        deliveryTarget: { mode: 'webhook', url: callbackUrl, receiptSecret },
        launchMode: 'immediate',
        units: [
          { label: 'external-record-A', input: { secret: 'source-A' } },
          { label: 'external-record-B', input: { secret: 'source-B' } },
        ],
      },
    });
    expect(webhookPool.statusCode, webhookPool.body).toBe(201);
    const webhookPoolBody = webhookPool.json();
    const webhookPoolId = webhookPoolBody.pool.id;
    const receiptNamespace = webhookPoolId.slice(0, 8);
    expect(webhookPoolBody.pool.status).toBe('queued');
    expect(webhookPoolBody.capacityQuote.deliveryMode).toBe('webhook');
    expect(webhookPoolBody.capacityQuote.availableConcurrency).toBe(0);
    expect(webhookPool.body).not.toContain(receiptSecret);
    expect(webhookPoolBody.pool.deliveryTarget).toEqual({ mode: 'webhook', url: callbackUrl });

    const unsupportedClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { nodeId: capsuleNodeId, poolId: webhookPoolId, maxUnits: 1 },
    });
    expect(unsupportedClaim.statusCode, unsupportedClaim.body).toBe(409);
    expect(unsupportedClaim.json().error.code).toBe('NODE_NOT_ELIGIBLE');

    const webhookNode = await app.inject({
      method: 'POST',
      url: '/api/runner/nodes',
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {
        adapter: 'mock',
        models: [capsuleModel, 'mock-v1', capsuleModel],
        concurrency: 2,
        clientVersion: '0.1.0-test',
        platform: 'darwin',
        arch: 'arm64',
        supportsDirectWebhooks: true,
      },
    });
    expect(webhookNode.statusCode, webhookNode.body).toBe(201);
    expect(webhookNode.json().nodeId).toBe(capsuleNodeId);
    const webhookJobs = await app.inject({
      method: 'GET',
      url: `/api/runner/jobs?nodeId=${capsuleNodeId}`,
      headers: { authorization: `Bearer ${runnerToken}` },
    });
    expect(webhookJobs.statusCode, webhookJobs.body).toBe(200);
    expect(webhookJobs.json().jobs).toContainEqual(
      expect.objectContaining({
        id: webhookPoolId,
        deliveryMode: 'webhook',
        callbackHost: 'example.test',
        maxUnitSeconds: 10,
        maxAttempts: 3,
        acceptanceMode: 'webhook',
        deliveryFormat: 'json',
        deliveryMaxBytes: 2048,
        pilot: false,
      }),
    );
    expect(webhookJobs.body).not.toContain('/agentpool/callback');
    expect(webhookJobs.body).not.toContain('tenant=integration');
    expect(webhookJobs.body).not.toContain(receiptSecret);
    const promotedWebhookPool = await app.inject({
      method: 'GET',
      url: `/api/pools/${webhookPoolId}`,
      headers: { cookie: publisherCookie },
    });
    expect(promotedWebhookPool.json().pool.status).toBe('queued');

    const webhookClaim = await claimPool(runnerToken, capsuleNodeId, webhookPoolId, 2);

    type ReceiptInput = {
      protocol: 'agentpool-receipt/1';
      leaseId: string;
      unitId: string;
      contractHash: string;
      resultSha256: string;
      decision: 'accepted' | 'rejected';
      retryable: boolean;
      receiptId: string;
      reason?: string;
      signature: string;
    };
    const signReceipt = (
      lease: { leaseId: string; unitId: string; contractHash: string },
      receiptId: string,
      resultSha256: string,
      decision: 'accepted' | 'rejected',
      retryable: boolean,
      reason?: string,
    ): ReceiptInput => {
      const claims = {
        protocol: 'agentpool-receipt/1' as const,
        leaseId: lease.leaseId,
        unitId: lease.unitId,
        contractHash: lease.contractHash,
        resultSha256,
        decision,
        retryable,
        receiptId,
      };
      return {
        ...claims,
        ...(reason ? { reason } : {}),
        signature: createHmac('sha256', receiptSecret)
          .update(JSON.stringify({ ...claims, reason: reason ?? null }))
          .digest('hex'),
      };
    };

    const firstWebhookLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: [capsuleModel], claimId: webhookClaim.id },
    });
    const firstWebhookLease = firstWebhookLeaseResponse.json().lease;
    expect(firstWebhookLease.poolId).toBe(webhookPoolId);
    expect(firstWebhookLease.delivery).toEqual({
      mode: 'webhook',
      url: callbackUrl,
      protocol: 'agentpool-webhook/1',
      unitReference: 'external-record-A',
      ordinal: 0,
    });

    const externalOutputMarker = `webhook-output-never-persist-${Date.now()}`;
    const forbiddenPlatformSubmit = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${firstWebhookLease.leaseId}/submit`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { output: { marker: externalOutputMarker } },
    });
    expect(forbiddenPlatformSubmit.statusCode, forbiddenPlatformSubmit.body).toBe(409);

    const firstResultSha = createHash('sha256').update(externalOutputMarker).digest('hex');
    const firstReceipt = signReceipt(
      firstWebhookLease,
      `receipt-${receiptNamespace}-external-A`,
      firstResultSha,
      'accepted',
      false,
    );
    const invalidSignature = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${firstWebhookLease.leaseId}/receipt`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { ...firstReceipt, signature: '0'.repeat(64) },
    });
    expect(invalidSignature.statusCode, invalidSignature.body).toBe(401);
    const acceptedReceipt = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${firstWebhookLease.leaseId}/receipt`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: firstReceipt,
    });
    expect(acceptedReceipt.statusCode, acceptedReceipt.body).toBe(200);
    expect(acceptedReceipt.json().status).toBe('accepted');
    const acceptedReplay = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${firstWebhookLease.leaseId}/receipt`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: firstReceipt,
    });
    expect(acceptedReplay.statusCode, acceptedReplay.body).toBe(200);
    expect(acceptedReplay.json()).toEqual(acceptedReceipt.json());
    const changedFirstReceipt = signReceipt(
      firstWebhookLease,
      `receipt-${receiptNamespace}-external-A`,
      'b'.repeat(64),
      'accepted',
      false,
    );
    const receiptConflict = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${firstWebhookLease.leaseId}/receipt`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: changedFirstReceipt,
    });
    expect(receiptConflict.statusCode, receiptConflict.body).toBe(409);

    const secondWebhookLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: [capsuleModel], claimId: webhookClaim.id },
    });
    const secondWebhookLease = secondWebhookLeaseResponse.json().lease;
    expect(secondWebhookLease.delivery.unitReference).toBe('external-record-B');
    const rejectionReason = 'External row failed the publisher checksum';
    const rejectedReceipt = signReceipt(
      secondWebhookLease,
      `receipt-${receiptNamespace}-external-B-rejected`,
      'c'.repeat(64),
      'rejected',
      true,
      rejectionReason,
    );
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${secondWebhookLease.leaseId}/receipt`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: rejectedReceipt,
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().status).toBe('retrying');
    const rejectedResults = await app.inject({
      method: 'GET',
      url: `/api/pools/${webhookPoolId}/results`,
      headers: { cookie: publisherCookie },
    });
    const rejectedOwnerResult = rejectedResults
      .json()
      .results.find((result: { id: string }) => result.id === secondWebhookLease.unitId);
    expect(rejectedOwnerResult.externalReceipt.reason).toBe(rejectionReason);

    const webhookRetryClaim = await claimPool(runnerToken, capsuleNodeId, webhookPoolId, 1);
    const retryWebhookLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: [capsuleModel], claimId: webhookRetryClaim.id },
    });
    const retryWebhookLease = retryWebhookLeaseResponse.json().lease;
    expect(retryWebhookLease.unitId).toBe(secondWebhookLease.unitId);
    expect(retryWebhookLease.attemptFeedback.reason).toBe(rejectionReason);
    expect(retryWebhookLease.attemptFeedback.attempt).toBe(1);

    const reusedReceiptId = signReceipt(
      retryWebhookLease,
      firstReceipt.receiptId,
      'd'.repeat(64),
      'accepted',
      false,
    );
    const crossLeaseReplay = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${retryWebhookLease.leaseId}/receipt`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: reusedReceiptId,
    });
    expect(crossLeaseReplay.statusCode, crossLeaseReplay.body).toBe(409);

    const finalReceipt = signReceipt(
      retryWebhookLease,
      `receipt-${receiptNamespace}-external-B-accepted`,
      'e'.repeat(64),
      'accepted',
      false,
    );
    const finalAccepted = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${retryWebhookLease.leaseId}/receipt`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: finalReceipt,
    });
    expect(finalAccepted.statusCode, finalAccepted.body).toBe(200);
    expect(finalAccepted.json().status).toBe('accepted');

    const webhookPersistence = await db.query<{
      result_ciphertext: string | null;
      reason_ciphertext: string | null;
    }>(
      `SELECT u.result_ciphertext, receipt.reason_ciphertext
       FROM task_units u LEFT JOIN webhook_receipts receipt ON receipt.unit_id = u.id
       WHERE u.pool_id = $1 ORDER BY receipt.created_at`,
      [webhookPoolId],
    );
    expect(webhookPersistence.rows.every((row) => row.result_ciphertext === null)).toBe(true);
    const encryptedReason = webhookPersistence.rows.find(
      (row) => row.reason_ciphertext,
    )?.reason_ciphertext;
    expect(encryptedReason).toBeTruthy();
    expect(encryptedReason).not.toContain(rejectionReason);
    const receiptOutputColumn = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'webhook_receipts'
           AND column_name IN ('output', 'result', 'result_ciphertext')
       ) AS exists`,
    );
    expect(receiptOutputColumn.rows[0]?.exists).toBe(false);

    const completedWebhook = await app.inject({
      method: 'GET',
      url: `/api/pools/${webhookPoolId}`,
      headers: { cookie: publisherCookie },
    });
    expect(completedWebhook.json().pool.status).toBe('completed');
    const webhookResults = await app.inject({
      method: 'GET',
      url: `/api/pools/${webhookPoolId}/results`,
      headers: { cookie: publisherCookie },
    });
    expect(webhookResults.body).not.toContain(externalOutputMarker);
    expect(webhookResults.json().results).toHaveLength(2);
    expect(webhookResults.json().results[0].result).toBeUndefined();
    expect(webhookResults.json().results[0].externalReceipt.unitReference).toBe(
      'external-record-A',
    );

    const secondWebhookPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Pool-scoped receipt IDs',
        category: 'data',
        publicSummary: 'A different pool may safely reuse an external receipt sequence value.',
        requestedAgent: 'mock',
        requestedModel: capsuleModel,
        requiredConcurrency: 1,
        maxUnitSeconds: 10,
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        rewardPerUnit: 3,
        taskCapsule: {
          version: 'ap-task/1',
          goal: 'Deliver another pool through the direct callback',
          inputDescription: 'Each unit belongs to a separate external batch.',
          outputDescription: 'POST one JSON result to the configured direct webhook.',
          constraints: ['Do not submit the result body to Agent Pool.'],
          examples: [],
          delivery: { format: 'json', maxBytes: 2048 },
          acceptance: {
            mode: 'webhook',
            criteria: ['The callback returns a signed receipt.'],
          },
        },
        deliveryTarget: { mode: 'webhook', url: callbackUrl, receiptSecret },
        units: [
          { label: 'second-pool-A', input: { secret: 'second-source-A' } },
          { label: 'second-pool-B', input: { secret: 'second-source-B' } },
        ],
      },
    });
    expect(secondWebhookPool.statusCode, secondWebhookPool.body).toBe(201);
    expect(secondWebhookPool.body).not.toContain(receiptSecret);
    const secondWebhookPoolId = secondWebhookPool.json().pool.id;
    const secondWebhookClaim = await claimPool(runnerToken, capsuleNodeId, secondWebhookPoolId, 1);
    const secondPoolLeaseResponse = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${capsuleNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { adapter: 'mock', models: [capsuleModel], claimId: secondWebhookClaim.id },
    });
    const secondPoolLease = secondPoolLeaseResponse.json().lease;
    expect(secondPoolLease.poolId).toBe(secondWebhookPoolId);
    const sameIdDifferentPoolReceipt = signReceipt(
      secondPoolLease,
      firstReceipt.receiptId,
      'f'.repeat(64),
      'accepted',
      false,
    );
    const sameIdDifferentPoolAccepted = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${secondPoolLease.leaseId}/receipt`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: sameIdDifferentPoolReceipt,
    });
    expect(sameIdDifferentPoolAccepted.statusCode, sameIdDifferentPoolAccepted.body).toBe(200);
    expect(sameIdDifferentPoolAccepted.json().status).toBe('accepted');
    const scopedReceiptRows = await db.query<{ pools: string }>(
      `SELECT count(DISTINCT pool_id)::text AS pools
       FROM webhook_receipts WHERE receipt_id = $1`,
      [firstReceipt.receiptId],
    );
    expect(Number(scopedReceiptRows.rows[0]?.pools)).toBe(2);
    const cancelSecondWebhookPool = await app.inject({
      method: 'POST',
      url: `/api/pools/${secondWebhookPoolId}/cancel`,
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
    });
    expect(cancelSecondWebhookPool.statusCode, cancelSecondWebhookPool.body).toBe(200);
    expect(cancelSecondWebhookPool.json().refunded).toBe(3);

    const publisherAfterCapsules = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: { cookie: publisherCookie },
    });
    const workerAfterCapsules = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: { cookie: workerCookie },
    });
    expect(publisherAfterCapsules.json().wallet).toMatchObject({
      purchasedAvailable: publisherAvailableBeforeCapsules - 22,
      purchasedLocked: 0,
    });
    expect(workerAfterCapsules.json().wallet.earnedAvailable).toBe(workerEarnedBeforeCapsules + 22);
  }, 30_000);

  it('keeps runner telemetry, capacity, rate limits, and revocation working', async () => {
    const runners = await app.inject({
      method: 'GET',
      url: '/api/runners',
      headers: { cookie: workerCookie },
    });
    expect(runners.statusCode, runners.body).toBe(200);
    expect(
      runners
        .json()
        .nodes.some((runnerNode: { certifications: Array<{ model: string }> }) =>
          runnerNode.certifications.some(
            (certification: { model: string }) => certification.model === 'mock-v1',
          ),
        ),
    ).toBe(true);
    expect(
      runners
        .json()
        .nodes.every((runnerNode: { activeJobs: unknown[] }) => runnerNode.activeJobs.length === 0),
    ).toBe(true);

    const dashboard = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { cookie: publisherCookie },
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    expect(dashboard.json().pools.total).toBeGreaterThanOrEqual(2);
    expect(dashboard.body).not.toContain('private-input');

    const pulse = await app.inject({ method: 'GET', url: '/api/network/pulse' });
    expect(pulse.statusCode, pulse.body).toBe(200);
    expect(pulse.json().acceptedToday).toBeGreaterThanOrEqual(3);

    const profile = await app.inject({
      method: 'PATCH',
      url: '/api/settings/profile',
      headers: { cookie: publisherCookie, origin: 'http://localhost:3000' },
      payload: { displayName: 'Publisher Updated' },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().user.displayName).toBe('Publisher Updated');

    const highConcurrencyNode = await app.inject({
      method: 'POST',
      url: '/api/runner/nodes',
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {
        adapter: 'mock',
        models: ['mock-v1'],
        concurrency: 64,
        clientVersion: '0.1.0-test',
        platform: 'darwin',
        arch: 'arm64',
      },
    });
    expect(highConcurrencyNode.statusCode).toBe(201);
    expect(highConcurrencyNode.json().nodeId).toBe(nodeId);
    const highBenchmark = await app.inject({
      method: 'POST',
      url: '/api/runner/benchmarks',
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { nodeId, adapter: 'mock', model: 'mock-v1', requestedConcurrency: 64 },
    });
    expect(highBenchmark.statusCode, highBenchmark.body).toBe(201);
    expect(highBenchmark.json().leases).toHaveLength(128);
    const highResults = highBenchmark
      .json()
      .leases.map((lease: { leaseId: string; input: { text: string } }) => ({
        leaseId: lease.leaseId,
        output: {
          reversed: [...lease.input.text].reverse().join(''),
          uppercase: lease.input.text.toUpperCase(),
          grouped: lease.input.text.match(/.{1,3}/g)?.join('-') ?? lease.input.text,
          length: lease.input.text.length,
        },
        durationMs: 1,
        success: true,
      }));
    const highCertification = await app.inject({
      method: 'POST',
      url: `/api/runner/benchmarks/${highBenchmark.json().benchmarkId}/results`,
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { results: highResults },
    });
    expect(highCertification.statusCode, highCertification.body).toBe(200);
    expect(highCertification.json().certifiedConcurrency).toBe(64);

    const runnerBurst = await Promise.all(
      Array.from({ length: 384 }, () =>
        app.inject({
          method: 'GET',
          url: `/api/runner/capacity?adapter=mock&model=mock-v1&nodeId=${nodeId}`,
          headers: { authorization: `Bearer ${runnerToken}` },
        }),
      ),
    );
    expect(new Set(runnerBurst.map((response) => response.statusCode))).toEqual(new Set([200]));

    const rotatedFakeTokens = await Promise.all(
      Array.from({ length: 305 }, (_, index) =>
        app.inject({
          method: 'GET',
          url: '/api/runner/me',
          headers: { authorization: `Bearer ap_runner_invalid_${index}` },
        }),
      ),
    );
    expect(rotatedFakeTokens.every((response) => [401, 429].includes(response.statusCode))).toBe(
      true,
    );
    expect(rotatedFakeTokens.some((response) => response.statusCode === 429)).toBe(true);
    expect(
      rotatedFakeTokens.filter((response) => response.statusCode === 401).length,
    ).toBeLessThanOrEqual(300);
    const validRunnerAfterFakeTokenFlood = await app.inject({
      method: 'GET',
      url: `/api/runner/capacity?adapter=mock&model=mock-v1&nodeId=${nodeId}`,
      headers: { authorization: `Bearer ${runnerToken}` },
    });
    expect(validRunnerAfterFakeTokenFlood.statusCode).toBe(200);

    const revoke = await app.inject({
      method: 'DELETE',
      url: '/api/runner/me',
      headers: { authorization: `Bearer ${runnerToken}` },
    });
    expect(revoke.statusCode).toBe(204);
    const revokedMe = await app.inject({
      method: 'GET',
      url: '/api/runner/me',
      headers: { authorization: `Bearer ${runnerToken}` },
    });
    expect(revokedMe.statusCode).toBe(401);
    const revokedNodes = await db.query<{ status: string }>(
      'SELECT status FROM runner_nodes WHERE credential_id = $1',
      [runnerCredentialId],
    );
    expect(revokedNodes.rows.every((node) => node.status === 'offline')).toBe(true);
    const hiddenRevokedNodes = await app.inject({
      method: 'GET',
      url: '/api/runners',
      headers: { cookie: workerCookie },
    });
    expect(hiddenRevokedNodes.statusCode, hiddenRevokedNodes.body).toBe(200);
    expect(hiddenRevokedNodes.json().nodes).toEqual([]);
  }, 30_000);

  it('keeps official fleet identity operator-bound and every claim manual and bounded', async () => {
    const password = 'official-fleet-test-password';
    const register = async (email: string, displayName: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, displayName, password },
      });
      expect(response.statusCode, response.body).toBe(201);
      return {
        id: response.json().user.id as string,
        cookie: response.headers['set-cookie']!.split(';')[0]!,
      };
    };
    const startDevice = async (client: 'agentpool-cli' | 'agentpool-official-fleet') => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/device/start',
        payload: { client },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json() as { deviceCode: string; userCode: string };
    };
    const approveAndIssue = async (
      codes: { deviceCode: string; userCode: string },
      cookie: string,
    ) => {
      const preview = await app.inject({
        method: 'POST',
        url: '/api/auth/device/preview',
        headers: { cookie, origin: 'http://localhost:3000' },
        payload: { userCode: codes.userCode },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const approval = await app.inject({
        method: 'POST',
        url: '/api/auth/device/approve',
        headers: { cookie, origin: 'http://localhost:3000' },
        payload: {
          userCode: codes.userCode,
          expectedClient: preview.json().client,
          expectedOperatorType: preview.json().operatorType,
        },
      });
      expect(approval.statusCode, approval.body).toBe(200);
      const issued = await app.inject({
        method: 'POST',
        url: '/api/auth/device/token',
        payload: { deviceCode: codes.deviceCode },
      });
      expect(issued.statusCode, issued.body).toBe(200);
      return issued.json() as {
        token: string;
        credentialId: string;
        operatorType: 'community' | 'official';
      };
    };
    const certifyRunner = async (
      token: string,
      certificationNodeId: string,
      model: string,
      requestedConcurrency = 1,
    ) => {
      const attempt = await app.inject({
        method: 'POST',
        url: '/api/runner/benchmarks',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          nodeId: certificationNodeId,
          adapter: 'mock',
          model,
          requestedConcurrency,
        },
      });
      expect(attempt.statusCode, attempt.body).toBe(201);
      const results = attempt
        .json()
        .leases.map((lease: { leaseId: string; input: { text: string } }) => ({
          leaseId: lease.leaseId,
          output: {
            reversed: [...lease.input.text].reverse().join(''),
            uppercase: lease.input.text.toUpperCase(),
            grouped: lease.input.text.match(/.{1,3}/g)?.join('-') ?? lease.input.text,
            length: lease.input.text.length,
          },
          durationMs: 10,
          success: true,
        }));
      const result = await app.inject({
        method: 'POST',
        url: `/api/runner/benchmarks/${attempt.json().benchmarkId}/results`,
        headers: { authorization: `Bearer ${token}` },
        payload: { results },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().certifiedConcurrency).toBe(requestedConcurrency);
    };

    const owner = await register(officialOwnerEmail, 'Official Fleet Owner');
    officialOwnerCookie = owner.cookie;
    const publisher = await register(
      `official-publisher-${Date.now()}@example.test`,
      'Official Fleet Publisher',
    );
    await expect(bindOfficialFleetOwner(db, publisher.id, officialOwnerEmail)).rejects.toThrow(
      'does not match',
    );

    const officialCodes = await startDevice('agentpool-official-fleet');
    const emailOnlyPreview = await app.inject({
      method: 'POST',
      url: '/api/auth/device/preview',
      headers: { cookie: owner.cookie, origin: 'http://localhost:3000' },
      payload: { userCode: officialCodes.userCode },
    });
    expect(emailOnlyPreview.statusCode).toBe(403);
    expect(emailOnlyPreview.json().error.code).toBe('OFFICIAL_FLEET_OWNER_REQUIRED');
    const emailOnlyApproval = await app.inject({
      method: 'POST',
      url: '/api/auth/device/approve',
      headers: { cookie: owner.cookie, origin: 'http://localhost:3000' },
      payload: {
        userCode: officialCodes.userCode,
        expectedClient: 'agentpool-official-fleet',
        expectedOperatorType: 'official',
      },
    });
    expect(emailOnlyApproval.statusCode).toBe(403);
    expect(emailOnlyApproval.json().error.code).toBe('OFFICIAL_FLEET_OWNER_REQUIRED');

    const binding = await bindOfficialFleetOwner(db, owner.id, officialOwnerEmail);
    expect(binding).toMatchObject({
      ownerId: owner.id,
      ownerEmail: officialOwnerEmail,
      mode: 'standby',
      created: true,
    });
    const repeatedBinding = await bindOfficialFleetOwner(db, owner.id, officialOwnerEmail);
    expect(repeatedBinding).toMatchObject({ ownerId: owner.id, created: false });
    const rivalOwnerEmail = `official-rival-${Date.now()}@example.test`;
    const rivalOwner = await register(rivalOwnerEmail, 'Official Fleet Rival');
    await expect(bindOfficialFleetOwner(db, rivalOwner.id, rivalOwnerEmail)).rejects.toThrow(
      'already bound to another owner',
    );
    await expect(
      db.query(`INSERT INTO official_fleets (owner_id) VALUES ($1)`, [rivalOwner.id]),
    ).rejects.toMatchObject({ code: '23505' });
    const singletonFleet = await db.query<{ owner_id: string; singleton_slot: number }>(
      `SELECT owner_id, singleton_slot FROM official_fleets`,
    );
    expect(singletonFleet.rows).toEqual([{ owner_id: owner.id, singleton_slot: 1 }]);
    const officialPreview = await app.inject({
      method: 'POST',
      url: '/api/auth/device/preview',
      headers: { cookie: owner.cookie, origin: 'http://localhost:3000' },
      payload: { userCode: officialCodes.userCode },
    });
    expect(officialPreview.statusCode, officialPreview.body).toBe(200);
    expect(officialPreview.json()).toMatchObject({
      label: 'Agent Pool Official Fleet',
      client: 'agentpool-official-fleet',
      operatorType: 'official',
    });
    const mismatchedApproval = await app.inject({
      method: 'POST',
      url: '/api/auth/device/approve',
      headers: { cookie: owner.cookie, origin: 'http://localhost:3000' },
      payload: {
        userCode: officialCodes.userCode,
        expectedClient: 'agentpool-cli',
        expectedOperatorType: 'community',
      },
    });
    expect(mismatchedApproval.statusCode).toBe(409);
    expect(mismatchedApproval.json().error.code).toBe('DEVICE_APPROVAL_CONTEXT_MISMATCH');
    const officialCredential = await approveAndIssue(officialCodes, owner.cookie);
    expect(officialCredential.operatorType).toBe('official');

    const communityCodes = await startDevice('agentpool-cli');
    const communityCredential = await approveAndIssue(communityCodes, owner.cookie);
    expect(communityCredential.operatorType).toBe('community');

    const ownerFleet = await app.inject({
      method: 'GET',
      url: '/api/official-fleet',
      headers: { cookie: owner.cookie },
    });
    expect(ownerFleet.statusCode, ownerFleet.body).toBe(200);
    expect(ownerFleet.json().fleet).toMatchObject({
      ownerId: owner.id,
      ownerEmail: officialOwnerEmail,
      mode: 'standby',
    });
    const nonOwnerFleet = await app.inject({
      method: 'GET',
      url: '/api/official-fleet',
      headers: { cookie: publisher.cookie },
    });
    expect(nonOwnerFleet.statusCode).toBe(404);

    const officialModel = `official-manual-${Date.now()}`;
    const spoofModel = `${officialModel}-spoof`;
    const communityNode = await app.inject({
      method: 'POST',
      url: '/api/runner/nodes',
      headers: {
        authorization: `Bearer ${communityCredential.token}`,
        'x-forwarded-for': '10.10.0.41',
      },
      payload: {
        adapter: 'mock',
        models: [spoofModel, officialModel],
        concurrency: 2,
        clientVersion: 'official-test',
        platform: 'linux',
        arch: 'x64',
        operatorType: 'official',
      },
    });
    expect(communityNode.statusCode, communityNode.body).toBe(201);
    expect(communityNode.json().operatorType).toBe('community');
    expect(communityNode.json().node.operatorType).toBe('community');

    const officialNode = await app.inject({
      method: 'POST',
      url: '/api/runner/nodes',
      headers: {
        authorization: `Bearer ${officialCredential.token}`,
        'x-forwarded-for': '10.10.0.42',
      },
      payload: {
        adapter: 'mock',
        models: [officialModel],
        concurrency: 2,
        clientVersion: 'official-test',
        platform: 'linux',
        arch: 'x64',
        operatorType: 'community',
      },
    });
    expect(officialNode.statusCode, officialNode.body).toBe(201);
    expect(officialNode.json().operatorType).toBe('official');
    expect(officialNode.json().node.operatorType).toBe('official');
    const officialNodeId = officialNode.json().nodeId as string;
    const officialNodeName = officialNode.json().node.name as string;

    const communityFleetStatus = await app.inject({
      method: 'GET',
      url: '/api/runner/official-fleet',
      headers: { authorization: `Bearer ${communityCredential.token}` },
    });
    expect(communityFleetStatus.statusCode).toBe(403);
    const runnerFleetStatus = await app.inject({
      method: 'GET',
      url: '/api/runner/official-fleet',
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(runnerFleetStatus.statusCode, runnerFleetStatus.body).toBe(200);
    expect(runnerFleetStatus.json()).toMatchObject({
      operatorType: 'official',
      fleet: { ownerId: owner.id, mode: 'standby' },
    });
    expect(runnerFleetStatus.json()).not.toHaveProperty('claims');

    const benchmark = await app.inject({
      method: 'POST',
      url: '/api/runner/benchmarks',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: {
        nodeId: officialNodeId,
        adapter: 'mock',
        model: officialModel,
        requestedConcurrency: 2,
      },
    });
    expect(benchmark.statusCode, benchmark.body).toBe(201);
    const benchmarkResults = benchmark
      .json()
      .leases.map((lease: { leaseId: string; input: { text: string } }) => ({
        leaseId: lease.leaseId,
        output: {
          reversed: [...lease.input.text].reverse().join(''),
          uppercase: lease.input.text.toUpperCase(),
          grouped: lease.input.text.match(/.{1,3}/g)?.join('-') ?? lease.input.text,
          length: lease.input.text.length,
        },
        durationMs: 10,
        success: true,
      }));
    const certified = await app.inject({
      method: 'POST',
      url: `/api/runner/benchmarks/${benchmark.json().benchmarkId}/results`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { results: benchmarkResults },
    });
    expect(certified.statusCode, certified.body).toBe(200);
    expect(certified.json().certifiedConcurrency).toBe(2);

    await certifyRunner(communityCredential.token, communityNode.json().nodeId, officialModel, 1);
    const secondaryOfficialNode = await app.inject({
      method: 'POST',
      url: '/api/runner/nodes',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: {
        name: 'official-secondary',
        platform: 'linux/x64',
        runnerVersion: 'official-test',
        maxConcurrency: 1,
        supportsDirectWebhooks: false,
        adapters: [{ adapter: 'mock', supportedModels: [officialModel] }],
      },
    });
    expect(secondaryOfficialNode.statusCode, secondaryOfficialNode.body).toBe(201);
    const secondaryOfficialNodeId = secondaryOfficialNode.json().nodeId as string;
    await certifyRunner(officialCredential.token, secondaryOfficialNodeId, officialModel, 1);

    const automaticCapacity = await app.inject({
      method: 'POST',
      url: '/api/capacity/quote',
      payload: {
        adapter: 'mock',
        model: officialModel,
        unitCount: 2,
        requiredConcurrency: 1,
        maxUnitSeconds: 60,
        deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });
    expect(automaticCapacity.statusCode, automaticCapacity.body).toBe(200);
    expect(automaticCapacity.json().quote.certifiedConcurrency).toBe(4);

    const topupPublisher = await app.inject({
      method: 'POST',
      url: '/api/wallet/dev-topup',
      headers: { cookie: publisher.cookie, origin: 'http://localhost:3000' },
      payload: { credits: 100 },
    });
    expect(topupPublisher.statusCode, topupPublisher.body).toBe(200);
    const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const pool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: publisher.cookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Manual official claim pool',
        category: 'data',
        publicSummary: 'Only an explicit bounded official claim may consume these units.',
        requestedAgent: 'mock',
        requestedModel: officialModel,
        requiredConcurrency: 2,
        maxUnitSeconds: 60,
        deadlineAt,
        rewardPerUnit: 11,
        validationMode: 'auto',
        launchMode: 'immediate',
        taskCapsule: {
          version: 'ap-task/1',
          goal: 'Return one non-empty result.',
          inputDescription: 'Each input is an opaque row.',
          outputDescription: 'Return one non-empty text value.',
          constraints: ['Do not return an empty string.'],
          examples: [],
          delivery: { format: 'text', maxBytes: 1024 },
          acceptance: { mode: 'non_empty', criteria: ['Output is non-empty.'] },
        },
        deliveryTarget: { mode: 'platform' },
        units: [{ input: { row: 1 } }, { input: { row: 2 } }],
      },
    });
    expect(pool.statusCode, pool.body).toBe(201);
    expect(pool.json().pool.status).toBe('queued');
    const poolId = pool.json().pool.id as string;

    await db.query(`UPDATE runner_nodes SET status = 'offline' WHERE id = $1`, [officialNodeId]);

    const claimable = await app.inject({
      method: 'GET',
      url: `/api/runner/jobs?nodeId=${officialNodeId}`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(claimable.statusCode, claimable.body).toBe(200);
    expect(claimable.json().jobs).toContainEqual(
      expect.objectContaining({
        id: poolId,
        requestedAgent: 'mock',
        requestedModel: officialModel,
        deliveryMode: 'platform',
        availableUnits: 2,
        rewardPerUnit: 11,
      }),
    );
    const reconnectOfficialNode = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${officialNodeId}/heartbeat`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { status: 'online' },
    });
    expect(reconnectOfficialNode.statusCode, reconnectOfficialNode.body).toBe(200);

    const unscopedPoll = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${officialNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { adapter: 'mock', models: [officialModel] },
    });
    expect(unscopedPoll.statusCode).toBe(400);
    expect(unscopedPoll.json().error.code).toBe('RUNNER_CLAIM_REQUIRED');
    const communityClaimPoll = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${communityNode.json().nodeId}/leases/poll`,
      headers: { authorization: `Bearer ${communityCredential.token}` },
      payload: {
        adapter: 'mock',
        models: [spoofModel],
        claimId: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(communityClaimPoll.statusCode).toBe(200);
    expect(communityClaimPoll.json().lease).toBeNull();

    const runnerClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { nodeId: officialNodeId, poolId, maxUnits: 1 },
    });
    expect(runnerClaim.statusCode, runnerClaim.body).toBe(201);
    expect(runnerClaim.json().claim).toMatchObject({
      nodeId: officialNodeId,
      poolId,
      requestedAgent: 'mock',
      requestedModel: officialModel,
      deliveryMode: 'platform',
      maxUnits: 1,
      claimedUnits: 0,
      remainingUnits: 1,
      status: 'active',
    });
    const claimId = runnerClaim.json().claim.id as string;
    const duplicateClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { nodeId: officialNodeId, poolId, maxUnits: 1 },
    });
    expect(duplicateClaim.statusCode).toBe(409);

    const jobsAfterReservation = await app.inject({
      method: 'GET',
      url: `/api/runner/jobs?nodeId=${secondaryOfficialNodeId}`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(jobsAfterReservation.statusCode, jobsAfterReservation.body).toBe(200);
    expect(
      jobsAfterReservation.json().jobs.find((job: { id: string }) => job.id === poolId)
        .availableUnits,
    ).toBe(1);
    const overReservedClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { nodeId: secondaryOfficialNodeId, poolId, maxUnits: 2 },
    });
    expect(overReservedClaim.statusCode).toBe(409);
    expect(overReservedClaim.json().error).toMatchObject({
      code: 'CLAIM_EXCEEDS_AVAILABLE_UNITS',
      details: { availableUnits: 1 },
    });

    const crossCredentialClaimRead = await app.inject({
      method: 'GET',
      url: `/api/runner/claims/${claimId}`,
      headers: { authorization: `Bearer ${communityCredential.token}` },
    });
    expect(crossCredentialClaimRead.statusCode).toBe(404);
    const crossCredentialPoll = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${communityNode.json().nodeId}/leases/poll`,
      headers: { authorization: `Bearer ${communityCredential.token}` },
      payload: { adapter: 'mock', models: [officialModel], claimId },
    });
    expect(crossCredentialPoll.statusCode, crossCredentialPoll.body).toBe(200);
    expect(crossCredentialPoll.json().lease).toBeNull();
    const crossNodePoll = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${secondaryOfficialNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { adapter: 'mock', models: [officialModel], claimId },
    });
    expect(crossNodePoll.statusCode, crossNodePoll.body).toBe(200);
    expect(crossNodePoll.json().lease).toBeNull();

    const unrelatedClaimPoll = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${officialNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: {
        adapter: 'mock',
        models: [officialModel],
        claimId: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(unrelatedClaimPoll.statusCode, unrelatedClaimPoll.body).toBe(200);
    expect(unrelatedClaimPoll.json().lease).toBeNull();

    const [blockedProfile, ...concurrentPolls] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/runner/nodes',
        headers: { authorization: `Bearer ${officialCredential.token}` },
        payload: {
          name: officialNodeName,
          platform: 'linux/x64',
          runnerVersion: 'official-test-conflicting-profile',
          maxConcurrency: 1,
          supportsDirectWebhooks: true,
          adapters: [{ adapter: 'claude', supportedModels: [`${officialModel}-changed`] }],
        },
      }),
      ...Array.from({ length: 2 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/runner/nodes/${officialNodeId}/leases/poll`,
          headers: { authorization: `Bearer ${officialCredential.token}` },
          payload: { adapter: 'mock', models: [officialModel], claimId },
        }),
      ),
    ]);
    expect(blockedProfile.statusCode, blockedProfile.body).toBe(409);
    expect(blockedProfile.json().error.code).toBe('NODE_PROFILE_BUSY');
    expect(concurrentPolls.every((response) => response.statusCode === 200)).toBe(true);
    expect(concurrentPolls.filter((response) => response.json().lease !== null)).toHaveLength(1);
    const leased = concurrentPolls.find((response) => response.json().lease !== null)!;
    expect(leased.json().lease.poolId).toBe(poolId);
    const preservedProfile = await db.query<{
      max_concurrency: number;
      supports_direct_webhooks: boolean;
      adapter: string;
      supported_models: string[];
    }>(
      `SELECT node.max_concurrency, node.supports_direct_webhooks,
              capability.adapter, capability.supported_models
       FROM runner_nodes node
       JOIN runner_capabilities capability ON capability.node_id = node.id
       WHERE node.id = $1`,
      [officialNodeId],
    );
    expect(preservedProfile.rows).toEqual([
      {
        max_concurrency: 2,
        supports_direct_webhooks: false,
        adapter: 'mock',
        supported_models: [officialModel],
      },
    ]);
    const idempotentActiveRegistration = await app.inject({
      method: 'POST',
      url: '/api/runner/nodes',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: {
        name: officialNodeName,
        platform: 'linux/x64',
        runnerVersion: 'official-test-idempotent-refresh',
        maxConcurrency: 2,
        supportsDirectWebhooks: false,
        adapters: [{ adapter: 'mock', supportedModels: [officialModel] }],
      },
    });
    expect(idempotentActiveRegistration.statusCode, idempotentActiveRegistration.body).toBe(201);
    expect(idempotentActiveRegistration.json().nodeId).toBe(officialNodeId);
    const cleanupDuringLease = await app.inject({
      method: 'DELETE',
      url: `/api/runner/nodes/${officialNodeId}`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(cleanupDuringLease.statusCode, cleanupDuringLease.body).toBe(204);
    const nodeDuringLease = await db.query<{ status: string }>(
      `SELECT status FROM runner_nodes WHERE id = $1`,
      [officialNodeId],
    );
    expect(nodeDuringLease.rows[0]?.status).toBe('online');
    const exhaustedPoll = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${officialNodeId}/leases/poll`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { adapter: 'mock', models: [officialModel], claimId },
    });
    expect(exhaustedPoll.statusCode, exhaustedPoll.body).toBe(200);
    expect(exhaustedPoll.json().lease).toBeNull();
    const cannotRewriteExhausted = await app.inject({
      method: 'DELETE',
      url: `/api/runner/claims/${claimId}`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(cannotRewriteExhausted.statusCode).toBe(404);
    const claimConsumption = await db.query<{
      claimed_units: number;
      lease_count: string;
    }>(
      `SELECT claim.claimed_units,
              (SELECT count(*) FROM runner_claim_leases used WHERE used.grant_id = claim.id) AS lease_count
       FROM runner_claim_grants claim WHERE claim.id = $1`,
      [claimId],
    );
    expect(claimConsumption.rows[0]).toMatchObject({ claimed_units: 1, lease_count: '1' });

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/runner/leases/${leased.json().lease.leaseId}/submit`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { output: 'official-result' },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().status).toBe('accepted');
    const ownerWallet = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: { cookie: owner.cookie },
    });
    expect(ownerWallet.json().wallet.earnedAvailable).toBe(11);

    const ownerTopup = await app.inject({
      method: 'POST',
      url: '/api/wallet/dev-topup',
      headers: { cookie: owner.cookie, origin: 'http://localhost:3000' },
      payload: { credits: 30 },
    });
    expect(ownerTopup.statusCode, ownerTopup.body).toBe(200);
    const ownPool = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { cookie: owner.cookie, origin: 'http://localhost:3000' },
      payload: {
        title: 'Official self rent guard',
        category: 'data',
        publicSummary: 'The official owner must never turn purchased credits into earnings.',
        requestedAgent: 'mock',
        requestedModel: officialModel,
        requiredConcurrency: 1,
        maxUnitSeconds: 60,
        deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        rewardPerUnit: 5,
        validationMode: 'auto',
        launchMode: 'immediate',
        secretInstruction: 'Return a non-empty value for this isolated test input.',
        units: [{ input: { row: 'self-1' } }, { input: { row: 'self-2' } }],
      },
    });
    expect(ownPool.statusCode, ownPool.body).toBe(201);
    const selfClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { nodeId: officialNodeId, poolId: ownPool.json().pool.id, maxUnits: 1 },
    });
    expect(selfClaim.statusCode).toBe(409);
    expect(selfClaim.json().error.code).toBe('SELF_RENT_FORBIDDEN');

    const offline = await app.inject({
      method: 'PATCH',
      url: '/api/official-fleet',
      headers: { cookie: owner.cookie, origin: 'http://localhost:3000' },
      payload: { mode: 'offline' },
    });
    expect(offline.statusCode, offline.body).toBe(200);
    expect(offline.json().fleet.mode).toBe('offline');
    expect(offline.json().nodes.online).toBe(0);
    const forcedOfflineHeartbeat = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${officialNodeId}/heartbeat`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { status: 'online' },
    });
    expect(forcedOfflineHeartbeat.statusCode, forcedOfflineHeartbeat.body).toBe(200);
    const offlineNode = await db.query<{ status: string }>(
      `SELECT status FROM runner_nodes WHERE id = $1`,
      [officialNodeId],
    );
    expect(offlineNode.rows[0]?.status).toBe('offline');
    const offlineClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { nodeId: officialNodeId, poolId, maxUnits: 1 },
    });
    expect(offlineClaim.statusCode).toBe(409);
    expect(offlineClaim.json().error.code).toBe('OFFICIAL_FLEET_OFFLINE');

    const standby = await app.inject({
      method: 'PATCH',
      url: '/api/official-fleet',
      headers: { cookie: owner.cookie, origin: 'http://localhost:3000' },
      payload: { mode: 'standby' },
    });
    expect(standby.statusCode, standby.body).toBe(200);
    expect(standby.json().fleet.mode).toBe('standby');
    expect(standby.json().nodes.online).toBe(0);
    const staleNodeClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { nodeId: officialNodeId, poolId, maxUnits: 1 },
    });
    expect(staleNodeClaim.statusCode).toBe(409);
    expect(staleNodeClaim.json().error.code).toBe('RUNNER_NODE_OFFLINE');
    const reconnectedHeartbeat = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${officialNodeId}/heartbeat`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { activeLeases: 0 },
    });
    expect(reconnectedHeartbeat.statusCode, reconnectedHeartbeat.body).toBe(200);
    const reconnectedFleet = await app.inject({
      method: 'GET',
      url: '/api/official-fleet',
      headers: { cookie: owner.cookie },
    });
    expect(reconnectedFleet.statusCode, reconnectedFleet.body).toBe(200);
    expect(reconnectedFleet.json().nodes.online).toBe(1);
    const cookieClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { nodeId: officialNodeId, poolId, maxUnits: 1 },
    });
    expect(cookieClaim.statusCode, cookieClaim.body).toBe(201);
    expect(cookieClaim.json().claim.status).toBe('active');
    const cleanupDuringClaim = await app.inject({
      method: 'DELETE',
      url: `/api/runner/nodes/${officialNodeId}`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(cleanupDuringClaim.statusCode, cleanupDuringClaim.body).toBe(204);
    const nodeDuringClaim = await db.query<{ status: string }>(
      `SELECT status FROM runner_nodes WHERE id = $1`,
      [officialNodeId],
    );
    expect(nodeDuringClaim.rows[0]?.status).toBe('online');
    const runnerRevokedClaim = await app.inject({
      method: 'DELETE',
      url: `/api/runner/claims/${cookieClaim.json().claim.id}`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(runnerRevokedClaim.statusCode, runnerRevokedClaim.body).toBe(200);
    expect(runnerRevokedClaim.json().claim.status).toBe('revoked');
    const cleanupAfterClaim = await app.inject({
      method: 'DELETE',
      url: `/api/runner/nodes/${officialNodeId}`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(cleanupAfterClaim.statusCode, cleanupAfterClaim.body).toBe(204);
    const nodeAfterClaim = await db.query<{ status: string }>(
      `SELECT status FROM runner_nodes WHERE id = $1`,
      [officialNodeId],
    );
    expect(nodeAfterClaim.rows[0]?.status).toBe('offline');
    const heartbeatAfterCleanup = await app.inject({
      method: 'POST',
      url: `/api/runner/nodes/${officialNodeId}/heartbeat`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { status: 'online' },
    });
    expect(heartbeatAfterCleanup.statusCode, heartbeatAfterCleanup.body).toBe(200);
    const expiringClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { nodeId: officialNodeId, poolId, maxUnits: 1 },
    });
    expect(expiringClaim.statusCode, expiringClaim.body).toBe(201);
    await db.query(
      `UPDATE runner_claim_grants SET expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [expiringClaim.json().claim.id],
    );
    const cannotRewriteExpired = await app.inject({
      method: 'DELETE',
      url: `/api/runner/claims/${expiringClaim.json().claim.id}`,
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(cannotRewriteExpired.statusCode).toBe(404);

    const credentialRevokeClaim = await app.inject({
      method: 'POST',
      url: '/api/runner/claims',
      headers: { authorization: `Bearer ${officialCredential.token}` },
      payload: { nodeId: officialNodeId, poolId, maxUnits: 1 },
    });
    expect(credentialRevokeClaim.statusCode, credentialRevokeClaim.body).toBe(201);
    const jobsBeforeCredentialRevoke = await app.inject({
      method: 'GET',
      url: `/api/runner/jobs?nodeId=${communityNode.json().nodeId}`,
      headers: { authorization: `Bearer ${communityCredential.token}` },
    });
    expect(jobsBeforeCredentialRevoke.statusCode, jobsBeforeCredentialRevoke.body).toBe(200);
    expect(
      jobsBeforeCredentialRevoke.json().jobs.some((job: { id: string }) => job.id === poolId),
    ).toBe(false);

    const revoke = await app.inject({
      method: 'DELETE',
      url: '/api/runner/me',
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(revoke.statusCode, revoke.body).toBe(204);
    const jobsAfterCredentialRevoke = await app.inject({
      method: 'GET',
      url: `/api/runner/jobs?nodeId=${communityNode.json().nodeId}`,
      headers: { authorization: `Bearer ${communityCredential.token}` },
    });
    expect(jobsAfterCredentialRevoke.statusCode, jobsAfterCredentialRevoke.body).toBe(200);
    expect(jobsAfterCredentialRevoke.json().jobs).toContainEqual(
      expect.objectContaining({ id: poolId, availableUnits: 1 }),
    );
    const revokedCredentialClaim = await db.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM runner_claim_grants WHERE id = $1`,
      [credentialRevokeClaim.json().claim.id],
    );
    expect(revokedCredentialClaim.rows[0]?.revoked).toBe(true);
    const revokedFleet = await app.inject({
      method: 'GET',
      url: '/api/runner/official-fleet',
      headers: { authorization: `Bearer ${officialCredential.token}` },
    });
    expect(revokedFleet.statusCode).toBe(401);
    const revokedOfficialNodes = await db.query<{ status: string }>(
      `SELECT status FROM runner_nodes WHERE credential_id = $1`,
      [officialCredential.credentialId],
    );
    expect(revokedOfficialNodes.rows.every(({ status }) => status === 'offline')).toBe(true);
  }, 30_000);

  it('supports scoped control credentials, loss-safe polling, and atomic idempotency', async () => {
    // Reset the in-memory rate limiter after the intentionally noisy lifecycle tests above.
    await app.close();
    app = await buildApp({
      config: {
        port: 3000,
        databaseUrl: databaseUrl!,
        jwtSecret: 'integration-test-jwt-secret-at-least-32-characters',
        encryptionKey: randomBytes(32),
        appOrigin: 'http://localhost:3000',
        allowDevTopup: true,
        defaultOfficialOwnerEmail: officialOwnerEmail,
        isProduction: false,
      },
      db,
      logger: false,
    });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `control-${Date.now()}@example.test`,
        displayName: 'Control Owner',
        password: 'control-owner-secure-password',
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const cookie = registered.headers['set-cookie']!.split(';')[0]!;

    const issueControl = async (scopes: ControlScope[], label: string, approvalCookie = cookie) => {
      const start = await app.inject({
        method: 'POST',
        url: '/api/auth/control/device/start',
        payload: { label, scopes, ttlSeconds: 3_600 },
      });
      expect(start.statusCode, start.body).toBe(201);
      const preview = await app.inject({
        method: 'POST',
        url: '/api/auth/control/device/preview',
        headers: { cookie: approvalCookie, origin: 'http://localhost:3000' },
        payload: { userCode: start.json().userCode },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.headers['cache-control']).toContain('no-store');
      const approval = await app.inject({
        method: 'POST',
        url: '/api/auth/control/device/approve',
        headers: { cookie: approvalCookie, origin: 'http://localhost:3000' },
        payload: {
          userCode: start.json().userCode,
          approvalContext: preview.json().approvalContext,
        },
      });
      expect(approval.statusCode, approval.body).toBe(200);
      const firstPoll = await app.inject({
        method: 'POST',
        url: '/api/auth/control/device/token',
        payload: { deviceCode: start.json().deviceCode },
      });
      expect(firstPoll.statusCode, firstPoll.body).toBe(200);
      expect(firstPoll.headers['cache-control']).toContain('no-store');
      const replayPoll = await app.inject({
        method: 'POST',
        url: '/api/auth/control/device/token',
        payload: { deviceCode: start.json().deviceCode },
      });
      expect(replayPoll.statusCode, replayPoll.body).toBe(200);
      expect(replayPoll.json().accessToken).toBe(firstPoll.json().accessToken);
      expect(replayPoll.json().credential.id).toBe(firstPoll.json().credential.id);
      return firstPoll.json() as {
        accessToken: string;
        credential: { id: string; scopes: ControlScope[] };
      };
    };

    const minimal = await issueControl(['pools:read'], 'Minimal Control');
    const minimalHeaders = { authorization: `Bearer ${minimal.accessToken}` };
    const minimalMe = await app.inject({
      method: 'GET',
      url: '/api/auth/control/me',
      headers: minimalHeaders,
    });
    expect(minimalMe.statusCode, minimalMe.body).toBe(200);
    expect(minimalMe.json().owner).toEqual({ id: expect.any(String) });
    const leakedSessionMe = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: minimalHeaders,
    });
    expect(leakedSessionMe.statusCode).toBe(401);
    const leakedWallet = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: minimalHeaders,
    });
    expect(leakedWallet.statusCode).toBe(403);
    expect(leakedWallet.json().error.details.missingScopes).toEqual(['wallet:read']);
    const runnerRouteWithControl = await app.inject({
      method: 'GET',
      url: '/api/runner/me',
      headers: minimalHeaders,
    });
    expect(runnerRouteWithControl.statusCode).toBe(401);
    const credentialListWithoutScope = await app.inject({
      method: 'GET',
      url: '/api/auth/control/credentials',
      headers: minimalHeaders,
    });
    expect(credentialListWithoutScope.statusCode).toBe(403);

    const control = await issueControl([...CONTROL_SCOPES], 'Publisher Control');
    const controlHeaders = { authorization: `Bearer ${control.accessToken}` };
    const fullMe = await app.inject({
      method: 'GET',
      url: '/api/auth/control/me',
      headers: controlHeaders,
    });
    expect(fullMe.statusCode, fullMe.body).toBe(200);
    expect(fullMe.json().owner).toMatchObject({
      id: expect.any(String),
      email: expect.stringContaining('control-'),
      displayName: 'Control Owner',
    });

    const profileOnly = await issueControl(['profile:write'], 'Profile Control');
    const profileUpdate = await app.inject({
      method: 'PATCH',
      url: '/api/settings/profile',
      headers: {
        authorization: `Bearer ${profileOnly.accessToken}`,
        'idempotency-key': `profile-${randomBytes(10).toString('hex')}`,
      },
      payload: { displayName: 'Control Owner Updated' },
    });
    expect(profileUpdate.statusCode, profileUpdate.body).toBe(200);
    expect(profileUpdate.json().user).toEqual({
      id: fullMe.json().owner.id,
      displayName: 'Control Owner Updated',
    });

    if (!officialOwnerCookie) {
      const officialOwner = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: officialOwnerEmail,
          displayName: 'Official Fleet Owner',
          password: 'official-control-owner-password',
        },
      });
      expect(officialOwner.statusCode, officialOwner.body).toBe(201);
      officialOwnerCookie = officialOwner.headers['set-cookie']!.split(';')[0]!;
      await bindOfficialFleetOwner(db, officialOwner.json().user.id, officialOwnerEmail);
    }
    const fleetOnly = await issueControl(['fleet:read'], 'Fleet Read Control', officialOwnerCookie);
    const fleetRead = await app.inject({
      method: 'GET',
      url: '/api/official-fleet',
      headers: { authorization: `Bearer ${fleetOnly.accessToken}` },
    });
    expect(fleetRead.statusCode, fleetRead.body).toBe(200);
    expect(fleetRead.json().fleet).not.toHaveProperty('ownerEmail');
    expect(fleetRead.json()).not.toHaveProperty('wallet');

    const unapprovable = await app.inject({
      method: 'POST',
      url: '/api/auth/control/device/start',
      payload: { label: 'No delegation', scopes: ['pools:read'] },
    });
    const selfPreview = await app.inject({
      method: 'POST',
      url: '/api/auth/control/device/preview',
      headers: controlHeaders,
      payload: { userCode: unapprovable.json().userCode },
    });
    expect(selfPreview.statusCode).toBe(401);

    const deniedStart = await app.inject({
      method: 'POST',
      url: '/api/auth/control/device/start',
      payload: { label: 'Denied Control', scopes: ['pools:read'] },
    });
    const deniedPreview = await app.inject({
      method: 'POST',
      url: '/api/auth/control/device/preview',
      headers: { cookie, origin: 'http://localhost:3000' },
      payload: { userCode: deniedStart.json().userCode },
    });
    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/control/device/deny',
      headers: { cookie, origin: 'http://localhost:3000' },
      payload: {
        userCode: deniedStart.json().userCode,
        approvalContext: deniedPreview.json().approvalContext,
      },
    });
    expect(denied.statusCode, denied.body).toBe(200);
    const deniedPoll = await app.inject({
      method: 'POST',
      url: '/api/auth/control/device/token',
      payload: { deviceCode: deniedStart.json().deviceCode },
    });
    expect(deniedPoll.statusCode).toBe(403);
    expect(deniedPoll.json().error.code).toBe('CONTROL_DEVICE_DENIED');

    const runnerStart = await app.inject({
      method: 'POST',
      url: '/api/auth/device/start',
      payload: { client: 'agentpool-cli', label: 'Delegated Community Runner' },
    });
    const runnerPreview = await app.inject({
      method: 'POST',
      url: '/api/auth/device/preview',
      headers: controlHeaders,
      payload: { userCode: runnerStart.json().userCode },
    });
    expect(runnerPreview.statusCode, runnerPreview.body).toBe(200);
    const runnerApproval = await app.inject({
      method: 'POST',
      url: '/api/auth/device/approve',
      headers: controlHeaders,
      payload: {
        userCode: runnerStart.json().userCode,
        expectedClient: runnerPreview.json().client,
        expectedOperatorType: runnerPreview.json().operatorType,
      },
    });
    expect(runnerApproval.statusCode, runnerApproval.body).toBe(200);
    const runnerFirstPoll = await app.inject({
      method: 'POST',
      url: '/api/auth/device/token',
      payload: { deviceCode: runnerStart.json().deviceCode },
    });
    const runnerReplayPoll = await app.inject({
      method: 'POST',
      url: '/api/auth/device/token',
      payload: { deviceCode: runnerStart.json().deviceCode },
    });
    expect(runnerReplayPoll.statusCode, runnerReplayPoll.body).toBe(200);
    expect(runnerReplayPoll.json().accessToken).toBe(runnerFirstPoll.json().accessToken);
    const runnerApprovalReplay = await app.inject({
      method: 'POST',
      url: '/api/auth/device/approve',
      headers: controlHeaders,
      payload: {
        userCode: runnerStart.json().userCode,
        expectedClient: runnerPreview.json().client,
        expectedOperatorType: runnerPreview.json().operatorType,
      },
    });
    expect(runnerApprovalReplay.statusCode, runnerApprovalReplay.body).toBe(200);
    expect(runnerApprovalReplay.json()).toEqual(runnerApproval.json());
    const ownerRouteWithRunner = await app.inject({
      method: 'GET',
      url: '/api/pools',
      headers: { authorization: `Bearer ${runnerFirstPoll.json().accessToken}` },
    });
    expect(ownerRouteWithRunner.statusCode).toBe(401);

    const topupKey = `topup-${randomBytes(12).toString('hex')}`;
    const topup = await app.inject({
      method: 'POST',
      url: '/api/wallet/dev-topup',
      headers: { ...controlHeaders, 'idempotency-key': topupKey },
      payload: { credits: 1_000 },
    });
    expect(topup.statusCode, topup.body).toBe(200);
    const topupReplay = await app.inject({
      method: 'POST',
      url: '/api/wallet/dev-topup',
      headers: { ...controlHeaders, 'idempotency-key': topupKey },
      payload: { credits: 1_000 },
    });
    expect(topupReplay.statusCode, topupReplay.body).toBe(200);
    expect(topupReplay.headers['idempotency-replayed']).toBe('true');
    expect(topupReplay.json().wallet.purchasedAvailable).toBe(1_000);
    const topupConflict = await app.inject({
      method: 'POST',
      url: '/api/wallet/dev-topup',
      headers: { ...controlHeaders, 'idempotency-key': topupKey },
      payload: { credits: 2_000 },
    });
    expect(topupConflict.statusCode).toBe(409);
    expect(topupConflict.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const concurrentTopupKey = `topup-concurrent-${randomBytes(8).toString('hex')}`;
    const concurrentTopups = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/wallet/dev-topup',
          headers: { ...controlHeaders, 'idempotency-key': concurrentTopupKey },
          payload: { credits: 50 },
        }),
      ),
    );
    expect(concurrentTopups.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(concurrentTopups[0]!.json()).toEqual(concurrentTopups[1]!.json());
    expect(
      concurrentTopups.filter((response) => response.headers['idempotency-replayed'] === 'true'),
    ).toHaveLength(1);
    expect(concurrentTopups[0]!.json().wallet.purchasedAvailable).toBe(1_050);
    const concurrentLedger = await db.query<{ count: string }>(
      `SELECT count(*) FROM credit_ledger
       WHERE user_id = $1 AND kind = 'dev_topup' AND delta = 50`,
      [fullMe.json().owner.id],
    );
    expect(concurrentLedger.rows[0]?.count).toBe('1');

    const createPayload = {
      title: 'Control idempotency capsule',
      category: 'data',
      publicSummary: 'A control credential safely creates this task exactly once.',
      secretInstruction: 'Return one non-empty JSON-safe answer for each private unit.',
      requestedAgent: 'mock',
      requestedModel: 'mock-v1',
      requiredConcurrency: 1,
      maxUnitSeconds: 60,
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      rewardPerUnit: 10,
      validationMode: 'auto',
      launchMode: 'immediate',
      units: [{ input: { row: 'control-1' } }, { input: { row: 'control-2' } }],
    };
    const beforeValidate = await db.query<{ count: string }>(
      `SELECT count(*) FROM pools WHERE owner_id = $1`,
      [fullMe.json().owner.id],
    );
    const capabilities = await app.inject({ method: 'GET', url: '/api/meta/capabilities' });
    expect(capabilities.statusCode, capabilities.body).toBe(200);
    expect(capabilities.json().schemas).toMatchObject({
      createPool: '/api/meta/schemas/create-pool',
      validation: 'structural-only',
      authoritativeEndpoint: '/api/pools/validate',
    });
    expect(capabilities.json().actions).toContainEqual(
      expect.objectContaining({
        id: 'pools.validate',
        requestSchema: '/api/meta/schemas/create-pool',
      }),
    );
    for (const action of capabilities.json().actions as Array<{
      id: string;
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      path: string;
      parameters: unknown;
      requestSchema: unknown;
    }>) {
      expect(action.parameters, `${action.id} parameters`).toMatchObject({
        path: expect.any(Object),
        query: expect.any(Object),
        headers: expect.any(Object),
      });
      expect(action, `${action.id} request schema`).toHaveProperty('requestSchema');
      expect(
        app.hasRoute({
          method: action.method,
          url: action.path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, ':$1'),
        }),
        `${action.id} -> ${action.method} ${action.path}`,
      ).toBe(true);
    }
    const createSchema = await app.inject({
      method: 'GET',
      url: '/api/meta/schemas/create-pool',
    });
    expect(createSchema.statusCode, createSchema.body).toBe(200);
    expect(createSchema.json()).toMatchObject({
      'x-agentpool-validation': 'structural-only',
      'x-agentpool-authoritative-endpoint': '/api/pools/validate',
    });
    const validated = await app.inject({
      method: 'POST',
      url: '/api/pools/validate',
      headers: controlHeaders,
      payload: createPayload,
    });
    expect(validated.statusCode, validated.body).toBe(200);
    expect(validated.json()).toMatchObject({ valid: true, totalUnits: 2, totalCost: 20 });
    const afterValidate = await db.query<{ count: string }>(
      `SELECT count(*) FROM pools WHERE owner_id = $1`,
      [fullMe.json().owner.id],
    );
    expect(afterValidate.rows[0]?.count).toBe(beforeValidate.rows[0]?.count);

    const createKey = `create-${randomBytes(12).toString('hex')}`;
    const [created, createReplay] = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/pools',
          headers: { ...controlHeaders, 'idempotency-key': createKey },
          payload: createPayload,
        }),
      ),
    );
    expect(created.statusCode, created.body).toBe(201);
    expect(createReplay.statusCode, createReplay.body).toBe(201);
    expect(
      [created, createReplay].filter(
        (response) => response.headers['idempotency-replayed'] === 'true',
      ),
    ).toHaveLength(1);
    expect(createReplay.json().pool.id).toBe(created.json().pool.id);
    expect(createReplay.json().wallet.purchasedLocked).toBe(20);
    expect(createReplay.json().wallet.purchasedAvailable).toBe(1_030);
    const realDateNow = Date.now;
    Date.now = () => Date.parse(createPayload.deadlineAt) - 5_000;
    let dynamicallyInvalid: Awaited<ReturnType<typeof app.inject>>;
    let lateReplay: Awaited<ReturnType<typeof app.inject>>;
    try {
      dynamicallyInvalid = await app.inject({
        method: 'POST',
        url: '/api/pools/validate',
        headers: controlHeaders,
        payload: createPayload,
      });
      lateReplay = await app.inject({
        method: 'POST',
        url: '/api/pools',
        headers: { ...controlHeaders, 'idempotency-key': createKey },
        payload: createPayload,
      });
    } finally {
      Date.now = realDateNow;
    }
    expect(dynamicallyInvalid.statusCode, dynamicallyInvalid.body).toBe(400);
    expect(dynamicallyInvalid.body).toContain('deadlineAt');
    expect(lateReplay.statusCode, lateReplay.body).toBe(201);
    expect(lateReplay.headers['idempotency-replayed']).toBe('true');
    expect(lateReplay.json().pool.id).toBe(created.json().pool.id);
    const poolCountAfterCreate = await db.query<{ count: string }>(
      `SELECT count(*) FROM pools WHERE owner_id = $1`,
      [fullMe.json().owner.id],
    );
    expect(Number(poolCountAfterCreate.rows[0]?.count)).toBe(
      Number(beforeValidate.rows[0]?.count) + 1,
    );
    const createConflict = await app.inject({
      method: 'POST',
      url: '/api/pools',
      headers: { ...controlHeaders, 'idempotency-key': createKey },
      payload: { ...createPayload, title: 'Different body with the same key' },
    });
    expect(createConflict.statusCode).toBe(409);
    const storedIdempotency = await db.query<{ response_ciphertext: string }>(
      `SELECT response_ciphertext FROM idempotency_records
       WHERE owner_id = $1 AND route_scope = 'pools.create' AND idempotency_key = $2`,
      [fullMe.json().owner.id, createKey],
    );
    expect(storedIdempotency.rows[0]?.response_ciphertext).not.toContain(createPayload.title);
    expect(storedIdempotency.rows[0]?.response_ciphertext).not.toContain(
      createPayload.secretInstruction,
    );

    const history = await app.inject({
      method: 'GET',
      url: '/api/events/history?after=0&limit=100&waitSeconds=0',
      headers: controlHeaders,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().events).toContainEqual(
      expect.objectContaining({ type: 'credential.updated' }),
    );
    expect(history.json().nextCursor).toEqual(expect.any(String));

    const credentials = await app.inject({
      method: 'GET',
      url: '/api/auth/control/credentials',
      headers: controlHeaders,
    });
    expect(credentials.statusCode, credentials.body).toBe(200);
    expect(JSON.stringify(credentials.json())).not.toContain('ap_control_');
    expect(credentials.json().credentials).toContainEqual(
      expect.objectContaining({ id: minimal.credential.id, scopes: ['pools:read'] }),
    );

    const selfRevoke = await app.inject({
      method: 'DELETE',
      url: '/api/auth/control/me',
      headers: minimalHeaders,
    });
    expect(selfRevoke.statusCode, selfRevoke.body).toBe(200);
    const revokedControl = await app.inject({
      method: 'GET',
      url: '/api/auth/control/me',
      headers: minimalHeaders,
    });
    expect(revokedControl.statusCode).toBe(401);
  }, 30_000);
});
