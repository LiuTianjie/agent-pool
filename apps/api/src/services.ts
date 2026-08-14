import { randomUUID } from 'node:crypto';

import type { PoolSummary, WalletSummary } from '@agent-pool/shared';

import type { DbClient, DbPool } from './db.js';
import { safeInteger, withTransaction } from './db.js';
import { ApiError, invariant } from './errors.js';
import { RUNNER_CAPACITY_SQL } from './official-fleet.js';
import { contractHashFromPoolRow } from './task-contract.js';

export type Queryable = Pick<DbClient, 'query'> | DbPool;

export interface CapacitySnapshot {
  adapter: string;
  model: string;
  deliveryMode: 'platform' | 'webhook';
  certifiedConcurrency: number;
  onlineConcurrency: number;
  availableConcurrency: number;
  p50Ms: number | null;
  p95Ms: number | null;
  certifiedNodes: number;
  onlineNodes: number;
  assurance: 'self-hosted-benchmark-not-model-attestation';
}

export interface CapacityQuote extends CapacitySnapshot {
  unitCount: number;
  requiredConcurrency: number;
  maxUnitSeconds: number;
  deadlineAt: string;
  estimatedSeconds: number | null;
  feasible: boolean;
  reasons: string[];
}

export async function recordEvent(
  db: Queryable,
  userId: string,
  type:
    | 'pool.updated'
    | 'unit.updated'
    | 'wallet.updated'
    | 'runner.updated'
    | 'credential.updated'
    | 'system.pulse',
  data: Record<string, unknown>,
): Promise<void> {
  await db.query('INSERT INTO user_events (user_id, type, data) VALUES ($1, $2, $3)', [
    userId,
    type,
    JSON.stringify(data),
  ]);
}

export async function getWallet(db: Queryable, userId: string): Promise<WalletSummary> {
  const result = await db.query<{
    purchased_available: string;
    purchased_locked: string;
    earned_pending: string;
    earned_available: string;
  }>(
    `SELECT purchased_available, purchased_locked, earned_pending, earned_available
     FROM wallets WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  invariant(row, 404, 'WALLET_NOT_FOUND', 'Wallet not found');
  return {
    purchasedAvailable: safeInteger(row.purchased_available),
    purchasedLocked: safeInteger(row.purchased_locked),
    earnedPending: safeInteger(row.earned_pending),
    earnedAvailable: safeInteger(row.earned_available),
  };
}

export async function insertLedger(
  client: DbClient,
  userId: string,
  bucket: keyof WalletSummary extends never ? never : string,
  delta: number,
  kind: string,
  referenceType?: string,
  referenceId?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO credit_ledger
       (id, user_id, bucket, delta, kind, reference_type, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), userId, bucket, delta, kind, referenceType ?? null, referenceId ?? null],
  );
}

export async function getCapacitySnapshot(
  db: Queryable,
  adapter: string,
  model: string,
  maximumP95Ms?: number,
  deliveryMode: 'platform' | 'webhook' = 'platform',
): Promise<CapacitySnapshot> {
  const result = await db.query<{
    certified_concurrency: string;
    online_concurrency: string;
    available_concurrency: string;
    p50_ms: string | null;
    p95_ms: string | null;
    certified_nodes: string;
    online_nodes: string;
  }>(
    `WITH lease_counts AS (
       SELECT leased_runner_id AS node_id, count(*)::int AS active
       FROM task_units
       WHERE status = 'leased' AND lease_expires_at > now()
       GROUP BY leased_runner_id
     ), certs AS (
       SELECT c.*, n.status AS node_status, n.last_seen_at, n.max_concurrency,
              COALESCE(l.active, 0) AS active
       FROM runner_certifications c
       JOIN runner_nodes n ON n.id = c.node_id
       JOIN runner_credentials credential ON credential.id = n.credential_id
       LEFT JOIN official_fleets official_fleet ON official_fleet.owner_id = credential.owner_id
       JOIN runner_capabilities cap
         ON cap.node_id = c.node_id AND cap.adapter = c.adapter
        AND c.model = ANY(cap.supported_models)
       LEFT JOIN lease_counts l ON l.node_id = c.node_id
       WHERE c.adapter = $1 AND c.model = $2 AND c.expires_at > now()
         AND credential.revoked_at IS NULL
         AND ${RUNNER_CAPACITY_SQL}
         AND ($3::int IS NULL OR c.p95_ms <= $3)
         AND ($4::text <> 'webhook' OR n.supports_direct_webhooks)
     )
     SELECT
       COALESCE(sum(certified_concurrency), 0)::bigint AS certified_concurrency,
       COALESCE(sum(LEAST(certified_concurrency, max_concurrency)) FILTER (
         WHERE node_status = 'online' AND last_seen_at > now() - interval '90 seconds'
       ), 0)::bigint AS online_concurrency,
       COALESCE(sum(GREATEST(LEAST(certified_concurrency, max_concurrency) - active, 0)) FILTER (
         WHERE node_status = 'online' AND last_seen_at > now() - interval '90 seconds'
       ), 0)::bigint AS available_concurrency,
       max(p50_ms) FILTER (
         WHERE node_status = 'online' AND last_seen_at > now() - interval '90 seconds'
       )::int AS p50_ms,
       max(p95_ms) FILTER (
         WHERE node_status = 'online' AND last_seen_at > now() - interval '90 seconds'
       )::int AS p95_ms,
       count(*)::int AS certified_nodes,
       count(*) FILTER (
         WHERE node_status = 'online' AND last_seen_at > now() - interval '90 seconds'
       )::int AS online_nodes
     FROM certs`,
    [adapter, model, maximumP95Ms ?? null, deliveryMode],
  );
  const row = result.rows[0];
  return {
    adapter,
    model,
    deliveryMode,
    certifiedConcurrency: safeInteger(row?.certified_concurrency ?? 0),
    onlineConcurrency: safeInteger(row?.online_concurrency ?? 0),
    availableConcurrency: safeInteger(row?.available_concurrency ?? 0),
    p50Ms: row?.p50_ms === null || row?.p50_ms === undefined ? null : safeInteger(row.p50_ms),
    p95Ms: row?.p95_ms === null || row?.p95_ms === undefined ? null : safeInteger(row.p95_ms),
    certifiedNodes: safeInteger(row?.certified_nodes ?? 0),
    onlineNodes: safeInteger(row?.online_nodes ?? 0),
    assurance: 'self-hosted-benchmark-not-model-attestation',
  };
}

export async function quoteCapacity(
  db: Queryable,
  input: {
    adapter: string;
    model: string;
    unitCount: number;
    requiredConcurrency: number;
    maxUnitSeconds: number;
    deadlineAt: Date;
    deliveryMode?: 'platform' | 'webhook';
  },
): Promise<CapacityQuote> {
  const snapshot = await getCapacitySnapshot(
    db,
    input.adapter,
    input.model,
    input.maxUnitSeconds * 1000,
    input.deliveryMode ?? 'platform',
  );
  const reasons: string[] = [];
  if (snapshot.certifiedConcurrency < input.requiredConcurrency) {
    reasons.push('CERTIFIED_CONCURRENCY_INSUFFICIENT');
  }
  if (snapshot.onlineConcurrency < input.requiredConcurrency) {
    reasons.push('ONLINE_CONCURRENCY_INSUFFICIENT');
  }
  if (snapshot.availableConcurrency < input.requiredConcurrency) {
    reasons.push('AVAILABLE_CONCURRENCY_INSUFFICIENT');
  }
  if (snapshot.p95Ms === null) {
    reasons.push('NO_VALID_PERFORMANCE_CERTIFICATION');
  } else if (snapshot.p95Ms > input.maxUnitSeconds * 1000) {
    reasons.push('P95_EXCEEDS_UNIT_LIMIT');
  }

  const effectiveParallelism = Math.min(snapshot.availableConcurrency, input.requiredConcurrency);
  const estimatedSeconds =
    effectiveParallelism > 0 && snapshot.p95Ms !== null
      ? Math.ceil(input.unitCount / effectiveParallelism) * (snapshot.p95Ms / 1000)
      : null;
  const secondsRemaining = (input.deadlineAt.getTime() - Date.now()) / 1000;
  if (secondsRemaining <= 0) {
    reasons.push('DEADLINE_ALREADY_PASSED');
  } else if (estimatedSeconds !== null && estimatedSeconds > secondsRemaining) {
    reasons.push('DEADLINE_NOT_FEASIBLE');
  }

  return {
    ...snapshot,
    unitCount: input.unitCount,
    requiredConcurrency: input.requiredConcurrency,
    maxUnitSeconds: input.maxUnitSeconds,
    deadlineAt: input.deadlineAt.toISOString(),
    estimatedSeconds,
    feasible: reasons.length === 0,
    reasons,
  };
}

export async function settleAcceptedUnit(client: DbClient, unitId: string): Promise<void> {
  const result = await client.query<{
    unit_id: string;
    pool_id: string;
    publisher_id: string;
    worker_id: string;
    reward: string;
  }>(
    `SELECT u.id AS unit_id, p.id AS pool_id, p.owner_id AS publisher_id,
            n.owner_id AS worker_id, p.reward_per_unit AS reward
     FROM task_units u
     JOIN pools p ON p.id = u.pool_id
     JOIN runner_nodes n ON n.id = u.leased_runner_id
     WHERE u.id = $1
     FOR UPDATE OF u, p`,
    [unitId],
  );
  const row = result.rows[0];
  invariant(row, 409, 'UNIT_NOT_SETTLEABLE', 'Unit is missing its runner or pool');
  const existing = await client.query('SELECT 1 FROM settlements WHERE unit_id = $1', [unitId]);
  if (existing.rowCount) return;
  const amount = safeInteger(row.reward);

  const publisherWallet = await client.query(
    `UPDATE wallets SET purchased_locked = purchased_locked - $2, updated_at = now()
     WHERE user_id = $1 AND purchased_locked >= $2`,
    [row.publisher_id, amount],
  );
  invariant(
    publisherWallet.rowCount === 1,
    409,
    'LOCKED_BALANCE_MISMATCH',
    'Publisher locked balance is inconsistent',
  );
  await insertLedger(
    client,
    row.publisher_id,
    'purchased_locked',
    -amount,
    'unit_settlement',
    'unit',
    unitId,
  );

  await client.query(
    `UPDATE wallets SET earned_pending = earned_pending + $2, updated_at = now() WHERE user_id = $1`,
    [row.worker_id, amount],
  );
  await insertLedger(
    client,
    row.worker_id,
    'earned_pending',
    amount,
    'unit_settlement',
    'unit',
    unitId,
  );

  const settlementId = randomUUID();
  await client.query(
    `INSERT INTO settlements
       (id, unit_id, pool_id, publisher_id, worker_id, amount, status, release_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())`,
    [settlementId, unitId, row.pool_id, row.publisher_id, row.worker_id, amount],
  );

  await client.query(
    `UPDATE wallets
     SET earned_pending = earned_pending - $2, earned_available = earned_available + $2, updated_at = now()
     WHERE user_id = $1 AND earned_pending >= $2`,
    [row.worker_id, amount],
  );
  await insertLedger(
    client,
    row.worker_id,
    'earned_pending',
    -amount,
    'earning_release',
    'settlement',
    settlementId,
  );
  await insertLedger(
    client,
    row.worker_id,
    'earned_available',
    amount,
    'earning_release',
    'settlement',
    settlementId,
  );
  await client.query(
    `UPDATE settlements SET status = 'released', released_at = now() WHERE id = $1`,
    [settlementId],
  );
  await recordEvent(client, row.publisher_id, 'wallet.updated', { poolId: row.pool_id, unitId });
  await recordEvent(client, row.worker_id, 'wallet.updated', { unitId, earned: amount });
  await completePoolIfFinished(client, row.pool_id, row.publisher_id);
}

export async function completePoolIfFinished(
  client: DbClient,
  poolId: string,
  ownerId: string,
): Promise<boolean> {
  const completed = await client.query(
    `UPDATE pools p SET status = 'completed', updated_at = now()
     WHERE p.id = $1 AND p.status IN ('piloting', 'queued', 'running')
       AND NOT EXISTS (
         SELECT 1 FROM task_units u WHERE u.pool_id = p.id
           AND u.status IN ('held', 'queued', 'leased', 'submitted')
       )`,
    [poolId],
  );
  if (completed.rowCount) {
    await terminateActiveClaimsForPool(client, poolId);
    await recordEvent(client, ownerId, 'pool.updated', { poolId, status: 'completed' });
  }
  return completed.rowCount === 1;
}

export async function terminateActiveClaimsForPool(
  client: DbClient,
  poolId: string,
): Promise<number> {
  const terminated = await client.query(
    `UPDATE runner_claim_grants SET revoked_at = now(), updated_at = now()
     WHERE pool_id = $1 AND revoked_at IS NULL
       AND expires_at > now() AND claimed_units < max_units`,
    [poolId],
  );
  return terminated.rowCount ?? 0;
}

export async function refundLockedUnits(
  client: DbClient,
  poolId: string,
  ownerId: string,
  unitCount: number,
  rewardPerUnit: number,
): Promise<number> {
  const amount = unitCount * rewardPerUnit;
  if (amount === 0) return 0;
  const changed = await client.query(
    `UPDATE wallets
     SET purchased_locked = purchased_locked - $2,
         purchased_available = purchased_available + $2,
         updated_at = now()
     WHERE user_id = $1 AND purchased_locked >= $2`,
    [ownerId, amount],
  );
  invariant(
    changed.rowCount === 1,
    409,
    'LOCKED_BALANCE_MISMATCH',
    'Publisher locked balance is inconsistent',
  );
  await insertLedger(client, ownerId, 'purchased_locked', -amount, 'pool_refund', 'pool', poolId);
  await insertLedger(client, ownerId, 'purchased_available', amount, 'pool_refund', 'pool', poolId);
  await recordEvent(client, ownerId, 'wallet.updated', { poolId, refunded: amount });
  return amount;
}

export async function runMaintenance(pool: DbPool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const lock = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('agent-pool-maintenance')) AS locked`,
    );
    if (!lock.rows[0]?.locked) return;

    const expiredPools = await client.query<{
      id: string;
      owner_id: string;
      reward_per_unit: string;
    }>(
      `UPDATE pools SET status = 'cancelled', terminal_reason = 'deadline',
          cancelled_at = now(), updated_at = now()
       WHERE status IN ('piloting', 'waiting_capacity', 'queued', 'running') AND deadline_at <= now()
       RETURNING id, owner_id, reward_per_unit`,
    );
    for (const expiredPool of expiredPools.rows) {
      await terminateActiveClaimsForPool(client, expiredPool.id);
      const cancelled = await client.query<{ id: string }>(
        `UPDATE task_units
         SET status = 'cancelled', lease_id = NULL,
             leased_runner_id = CASE WHEN status = 'submitted' THEN leased_runner_id ELSE NULL END,
             lease_expires_at = NULL, stage = NULL, updated_at = now()
         WHERE pool_id = $1 AND status IN ('held', 'queued', 'leased', 'submitted') RETURNING id`,
        [expiredPool.id],
      );
      await refundLockedUnits(
        client,
        expiredPool.id,
        expiredPool.owner_id,
        cancelled.rowCount ?? 0,
        safeInteger(expiredPool.reward_per_unit),
      );
      await recordEvent(client, expiredPool.owner_id, 'pool.updated', {
        poolId: expiredPool.id,
        status: 'cancelled',
        reason: 'deadline',
      });
    }

    const expiredLeases = await client.query<{
      id: string;
      pool_id: string;
      owner_id: string;
      reward_per_unit: string;
      should_fail: boolean;
    }>(
      `SELECT u.id, p.id AS pool_id, p.owner_id, p.reward_per_unit,
              u.attempt_count >= p.max_attempts AS should_fail
       FROM task_units u
       JOIN pools p ON p.id = u.pool_id
       WHERE u.status = 'leased' AND u.lease_expires_at <= now() AND p.deadline_at > now()
       FOR UPDATE OF u SKIP LOCKED`,
    );
    for (const unit of expiredLeases.rows) {
      if (unit.should_fail) {
        await client.query(
          `UPDATE task_units SET status = 'failed', failure_reason = 'lease_expired',
             lease_id = NULL, leased_runner_id = NULL, lease_expires_at = NULL,
             result_ciphertext = NULL, submitted_at = NULL,
             stage = 'failed', updated_at = now() WHERE id = $1`,
          [unit.id],
        );
        await refundLockedUnits(
          client,
          unit.pool_id,
          unit.owner_id,
          1,
          safeInteger(unit.reward_per_unit),
        );
      } else {
        await client.query(
          `UPDATE task_units SET status = 'queued', lease_id = NULL, leased_runner_id = NULL,
             lease_expires_at = NULL, stage = NULL, progress = 0,
             result_ciphertext = NULL, submitted_at = NULL, updated_at = now()
           WHERE id = $1`,
          [unit.id],
        );
      }
      await recordEvent(client, unit.owner_id, 'unit.updated', {
        poolId: unit.pool_id,
        unitId: unit.id,
        status: unit.should_fail ? 'failed' : 'queued',
      });
    }

    const completed = await client.query<{ id: string; owner_id: string }>(
      `UPDATE pools p SET status = 'completed', updated_at = now()
       WHERE p.status IN ('piloting', 'queued', 'running')
         AND NOT EXISTS (
           SELECT 1 FROM task_units u WHERE u.pool_id = p.id
             AND u.status IN ('held', 'queued', 'leased', 'submitted')
         )
       RETURNING p.id, p.owner_id`,
    );
    for (const row of completed.rows) {
      await terminateActiveClaimsForPool(client, row.id);
      await recordEvent(client, row.owner_id, 'pool.updated', {
        poolId: row.id,
        status: 'completed',
      });
    }

    await client.query(
      `DELETE FROM idempotency_records WHERE ctid IN (
         SELECT ctid FROM idempotency_records WHERE expires_at <= now() LIMIT 1000
       )`,
    );
    await client.query(
      `DELETE FROM runner_idempotency_records WHERE ctid IN (
         SELECT ctid FROM runner_idempotency_records WHERE expires_at <= now() LIMIT 1000
       )`,
    );
    await client.query(
      `UPDATE control_device_authorizations SET status = 'expired'
       WHERE status IN ('pending', 'approved') AND expires_at <= now()`,
    );
    await client.query(
      `UPDATE control_device_authorizations SET issued_token_ciphertext = NULL
       WHERE issued_token_ciphertext IS NOT NULL AND expires_at <= now()`,
    );
    await client.query(
      `UPDATE device_authorizations SET issued_token_ciphertext = NULL
       WHERE issued_token_ciphertext IS NOT NULL AND expires_at <= now()`,
    );
  });
}

export function mapPoolSummary(
  row: Record<string, unknown>,
): PoolSummary & Record<string, unknown> {
  return {
    id: String(row.id),
    title: String(row.title),
    category: row.category as PoolSummary['category'],
    requestedAgent: row.requested_agent as PoolSummary['requestedAgent'],
    requestedModel: String(row.requested_model),
    deliveryMode: row.delivery_mode === 'webhook' ? 'webhook' : 'platform',
    publicSummary: String(row.public_summary),
    status: row.status as PoolSummary['status'],
    rewardPerUnit: safeInteger(row.reward_per_unit as string),
    totalUnits: safeInteger(row.total_units as number),
    queuedUnits: safeInteger(row.queued_units as string),
    runningUnits: safeInteger(row.running_units as string),
    submittedUnits: safeInteger(row.submitted_units as string),
    acceptedUnits: safeInteger(row.accepted_units as string),
    failedUnits: safeInteger(row.failed_units as string),
    heldUnits: safeInteger((row.held_units as string) ?? 0),
    pilotUnits: safeInteger((row.pilot_units as number) ?? 0),
    pilotAcceptedUnits: safeInteger((row.pilot_accepted_units as string) ?? 0),
    pilotFailedUnits: safeInteger((row.pilot_failed_units as string) ?? 0),
    pilotSubmittedUnits: safeInteger((row.pilot_submitted_units as string) ?? 0),
    contractHash: contractHashFromPoolRow(row),
    createdAt: new Date(String(row.created_at)).toISOString(),
    requiredConcurrency: safeInteger(row.required_concurrency as number),
    maxUnitSeconds: safeInteger(row.max_unit_seconds as number),
    deadlineAt: new Date(String(row.deadline_at)).toISOString(),
    terminalReason:
      row.terminal_reason === 'deadline' || row.terminal_reason === 'cancelled_by_publisher'
        ? row.terminal_reason
        : null,
  };
}

export const POOL_SUMMARY_SELECT = `
  SELECT p.*,
    count(u.id) FILTER (WHERE u.status = 'queued')::int AS queued_units,
    count(u.id) FILTER (WHERE u.status = 'leased')::int AS running_units,
    count(u.id) FILTER (WHERE u.status = 'submitted')::int AS submitted_units,
    count(u.id) FILTER (WHERE u.status = 'accepted')::int AS accepted_units,
    count(u.id) FILTER (WHERE u.status IN ('failed', 'cancelled'))::int AS failed_units,
    count(u.id) FILTER (WHERE u.status = 'held')::int AS held_units,
    count(u.id) FILTER (WHERE u.is_pilot AND u.status = 'accepted')::int AS pilot_accepted_units,
    count(u.id) FILTER (WHERE u.is_pilot AND u.status IN ('failed', 'cancelled'))::int AS pilot_failed_units,
    count(u.id) FILTER (WHERE u.is_pilot AND u.status = 'submitted')::int AS pilot_submitted_units
  FROM pools p
  LEFT JOIN task_units u ON u.pool_id = p.id
`;

export function assertLeaseOwnership(
  row: { credential_id: string; status: string; lease_expires_at: Date | string },
  credentialId: string,
): void {
  if (row.credential_id !== credentialId)
    throw new ApiError(403, 'LEASE_NOT_OWNED', 'Lease belongs to another runner');
  if (row.status !== 'leased')
    throw new ApiError(409, 'LEASE_NOT_ACTIVE', 'Lease is no longer active');
  if (new Date(row.lease_expires_at).getTime() <= Date.now()) {
    throw new ApiError(409, 'LEASE_EXPIRED', 'Lease has expired');
  }
}
