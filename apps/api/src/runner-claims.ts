import { randomUUID } from 'node:crypto';

import {
  runnerClaimRequestSchema,
  type OfficialFleetMode,
  type RunnerClaimStatus,
  type RunnerClaimSummary,
  type RunnerJobSummary,
} from '@agent-pool/shared';

import type { DbClient } from './db.js';
import { decryptJson } from './crypto.js';
import { safeInteger, withTransaction } from './db.js';
import { invariant } from './errors.js';
import { recordEvent, type Queryable } from './services.js';
import { type StoredDeliveryConfig, taskCapsuleFromPoolRow } from './task-contract.js';
import type { App, RunnerPrincipal } from './types.js';

interface ClaimRow {
  id: string;
  node_id: string;
  pool_id: string;
  pool_title: string;
  requested_agent: RunnerClaimSummary['requestedAgent'];
  requested_model: string;
  delivery_mode: RunnerClaimSummary['deliveryMode'];
  max_units: number;
  claimed_units: number;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export async function listRunnerJobs(
  app: App,
  principal: RunnerPrincipal,
  nodeId: string,
): Promise<{ jobs: RunnerJobSummary[]; generatedAt: string }> {
  await assertOfficialFleetCanClaim(app.db, principal);
  const node = await app.db.query<{ id: string }>(
    `SELECT id FROM runner_nodes WHERE id = $1 AND credential_id = $2`,
    [nodeId, principal.credentialId],
  );
  invariant(node.rowCount === 1, 404, 'RUNNER_NODE_NOT_FOUND', 'Runner node not found');

  const result = await app.db.query<{
    id: string;
    title: string;
    status: RunnerJobSummary['status'];
    category: RunnerJobSummary['category'];
    public_summary: string;
    requested_agent: RunnerJobSummary['requestedAgent'];
    requested_model: string;
    delivery_mode: RunnerJobSummary['deliveryMode'];
    delivery_config_ciphertext: string | null;
    task_capsule_ciphertext: string | null;
    secret_instruction_ciphertext: string;
    validation_mode: string;
    output_schema: Record<string, unknown> | null;
    contract_hash: string;
    max_unit_seconds: number;
    max_attempts: number;
    reward_per_unit: string;
    deadline_at: Date;
    available_units: string;
  }>(
    `SELECT pool.id, pool.title, pool.status, pool.category, pool.public_summary,
            pool.requested_agent, pool.requested_model, pool.delivery_mode,
            pool.delivery_config_ciphertext, pool.task_capsule_ciphertext,
            pool.secret_instruction_ciphertext, pool.validation_mode, pool.output_schema,
            pool.contract_hash, pool.max_unit_seconds, pool.max_attempts,
            pool.reward_per_unit, pool.deadline_at,
            GREATEST(
              count(unit.id) FILTER (WHERE unit.status = 'queued') - COALESCE((
                SELECT sum(active.max_units - active.claimed_units)
                FROM runner_claim_grants active
                WHERE active.pool_id = pool.id AND active.revoked_at IS NULL
                  AND active.expires_at > now() AND active.claimed_units < active.max_units
              ), 0),
              0
            )::text AS available_units
     FROM pools pool
     JOIN runner_capabilities capability
       ON capability.node_id = $1 AND capability.adapter = pool.requested_agent
      AND pool.requested_model = ANY(capability.supported_models)
     JOIN runner_certifications certification
       ON certification.node_id = $1
      AND certification.adapter = pool.requested_agent
      AND certification.model = pool.requested_model
      AND certification.certified_concurrency > 0
      AND certification.expires_at > now()
      AND certification.p95_ms <= pool.max_unit_seconds * 1000
     LEFT JOIN task_units unit ON unit.pool_id = pool.id
     JOIN runner_nodes node ON node.id = $1 AND node.credential_id = $2
     WHERE pool.owner_id <> $3
       AND pool.status IN ('piloting', 'waiting_capacity', 'queued', 'running')
       AND pool.deadline_at > now()
       AND (pool.delivery_mode <> 'webhook' OR node.supports_direct_webhooks)
     GROUP BY pool.id
     HAVING count(unit.id) FILTER (WHERE unit.status = 'queued') > COALESCE((
       SELECT sum(active.max_units - active.claimed_units)
       FROM runner_claim_grants active
       WHERE active.pool_id = pool.id AND active.revoked_at IS NULL
         AND active.expires_at > now() AND active.claimed_units < active.max_units
     ), 0)
     ORDER BY pool.reward_per_unit DESC, pool.deadline_at ASC
     LIMIT 100`,
    [nodeId, principal.credentialId, principal.ownerId],
  );
  return {
    jobs: result.rows.map((pool) => {
      const capsule = taskCapsuleFromPoolRow(
        pool as unknown as Record<string, unknown>,
        app.config.encryptionKey,
      );
      const callbackHost =
        pool.delivery_mode === 'webhook' && pool.delivery_config_ciphertext
          ? new URL(
              decryptJson<StoredDeliveryConfig>(
                pool.delivery_config_ciphertext,
                app.config.encryptionKey,
              ).url,
            ).host
          : undefined;
      return {
        id: pool.id,
        title: pool.title,
        status: pool.status,
        category: pool.category,
        publicSummary: pool.public_summary,
        requestedAgent: pool.requested_agent,
        requestedModel: pool.requested_model,
        deliveryMode: pool.delivery_mode,
        ...(callbackHost ? { callbackHost } : {}),
        maxUnitSeconds: safeInteger(pool.max_unit_seconds),
        maxAttempts: safeInteger(pool.max_attempts),
        acceptanceMode: capsule.acceptance.mode,
        deliveryFormat: capsule.delivery.format,
        deliveryMaxBytes: capsule.delivery.maxBytes,
        pilot: pool.status === 'piloting',
        availableUnits: safeInteger(pool.available_units),
        rewardPerUnit: safeInteger(pool.reward_per_unit),
        claimableUntil: pool.deadline_at.toISOString(),
      };
    }),
    generatedAt: new Date().toISOString(),
  };
}

export async function createRunnerClaim(
  app: App,
  principal: RunnerPrincipal,
  rawInput: unknown,
): Promise<RunnerClaimSummary> {
  return withTransaction(app.db, (client) =>
    createRunnerClaimInTransaction(app, principal, rawInput, client),
  );
}

export async function createRunnerClaimInTransaction(
  app: App,
  principal: RunnerPrincipal,
  rawInput: unknown,
  client: DbClient,
): Promise<RunnerClaimSummary> {
  const input = runnerClaimRequestSchema.parse(rawInput);
  const claimId = randomUUID();
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `runner-claim:${principal.credentialId}:${input.nodeId}:${input.poolId}`,
  ]);
  await assertOfficialFleetCanClaim(client, principal, true);

  const nodeResult = await client.query<{
    id: string;
    status: string;
    last_seen_at: Date;
    supports_direct_webhooks: boolean;
  }>(
    `SELECT id, status, last_seen_at, supports_direct_webhooks
       FROM runner_nodes WHERE id = $1 AND credential_id = $2 FOR UPDATE`,
    [input.nodeId, principal.credentialId],
  );
  const node = nodeResult.rows[0];
  invariant(node, 404, 'RUNNER_NODE_NOT_FOUND', 'Runner node not found');
  invariant(
    node.status === 'online' && node.last_seen_at.getTime() > Date.now() - 90_000,
    409,
    'RUNNER_NODE_OFFLINE',
    'Register or heartbeat this Runner node before claiming work',
  );

  const poolResult = await client.query<{
    id: string;
    owner_id: string;
    status: string;
    deadline_at: Date;
    requested_agent: string;
    requested_model: string;
    delivery_mode: 'platform' | 'webhook';
    max_unit_seconds: number;
  }>(
    `SELECT id, owner_id, status, deadline_at, requested_agent, requested_model,
              delivery_mode, max_unit_seconds
       FROM pools WHERE id = $1 FOR UPDATE`,
    [input.poolId],
  );
  const pool = poolResult.rows[0];
  invariant(pool, 404, 'POOL_NOT_FOUND', 'Pool not found');
  invariant(
    pool.owner_id !== principal.ownerId,
    409,
    'SELF_RENT_FORBIDDEN',
    "A Runner cannot claim its owner's Pool",
  );
  invariant(
    ['piloting', 'waiting_capacity', 'queued', 'running'].includes(pool.status) &&
      pool.deadline_at.getTime() > Date.now(),
    409,
    'POOL_NOT_CLAIMABLE',
    'Pool is not active or has passed its deadline',
  );
  invariant(
    pool.delivery_mode !== 'webhook' || node.supports_direct_webhooks,
    409,
    'NODE_NOT_ELIGIBLE',
    'Runner node does not support direct webhook delivery',
  );

  const eligible = await client.query(
    `SELECT 1
       FROM runner_capabilities capability
       JOIN runner_certifications certification
         ON certification.node_id = capability.node_id
        AND certification.adapter = capability.adapter
        AND certification.model = $3
        AND certification.certified_concurrency > 0
        AND certification.expires_at > now()
        AND certification.p95_ms <= $4
       WHERE capability.node_id = $1 AND capability.adapter = $2
         AND $3 = ANY(capability.supported_models)`,
    [input.nodeId, pool.requested_agent, pool.requested_model, pool.max_unit_seconds * 1000],
  );
  invariant(
    eligible.rowCount === 1,
    409,
    'NODE_NOT_ELIGIBLE',
    'Runner node lacks the exact active capability and performance certification',
  );

  const queued = await client.query<{ queued: string; reserved: string }>(
    `SELECT
         (SELECT count(*) FROM task_units
          WHERE pool_id = $1 AND status = 'queued')::text AS queued,
         COALESCE((SELECT sum(max_units - claimed_units) FROM runner_claim_grants
          WHERE pool_id = $1 AND revoked_at IS NULL AND expires_at > now()
            AND claimed_units < max_units), 0)::text AS reserved`,
    [pool.id],
  );
  const queuedUnits = safeInteger(queued.rows[0]?.queued ?? 0);
  const reservedUnits = safeInteger(queued.rows[0]?.reserved ?? 0);
  const availableUnits = Math.max(0, queuedUnits - reservedUnits);
  invariant(availableUnits > 0, 409, 'POOL_NOT_CLAIMABLE', 'Pool has no queued Units');
  invariant(
    input.maxUnits <= availableUnits,
    409,
    'CLAIM_EXCEEDS_AVAILABLE_UNITS',
    'maxUnits exceeds the currently queued Units',
    { availableUnits },
  );

  const duplicate = await client.query(
    `SELECT 1 FROM runner_claim_grants
       WHERE credential_id = $1 AND node_id = $2 AND pool_id = $3
         AND revoked_at IS NULL AND expires_at > now() AND claimed_units < max_units`,
    [principal.credentialId, input.nodeId, pool.id],
  );
  invariant(
    duplicate.rowCount === 0,
    409,
    'RUNNER_CLAIM_ALREADY_ACTIVE',
    'This Runner node already has an active claim for the Pool',
  );

  const now = Date.now();
  const defaultExpiry = Math.min(now + 10 * 60_000, pool.deadline_at.getTime());
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(defaultExpiry);
  invariant(
    expiresAt.getTime() >= now + 10_000 && expiresAt.getTime() <= now + 60 * 60_000,
    400,
    'CLAIM_EXPIRY_INVALID',
    'expiresAt must be between 10 seconds and 1 hour from now',
  );
  invariant(
    expiresAt.getTime() <= pool.deadline_at.getTime(),
    400,
    'CLAIM_EXPIRY_INVALID',
    'expiresAt cannot exceed the Pool deadline',
  );

  await client.query(
    `INSERT INTO runner_claim_grants
         (id, credential_id, node_id, pool_id, max_units, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [claimId, principal.credentialId, input.nodeId, pool.id, input.maxUnits, expiresAt],
  );
  await recordEvent(client, principal.ownerId, 'runner.updated', {
    operatorType: principal.operatorType,
    claimId,
    nodeId: input.nodeId,
    poolId: pool.id,
    maxUnits: input.maxUnits,
    expiresAt: expiresAt.toISOString(),
  });
  return loadRunnerClaim(client, principal.credentialId, claimId);
}

export async function listRunnerClaims(
  app: App,
  principal: RunnerPrincipal,
): Promise<{ claims: RunnerClaimSummary[] }> {
  const result = await app.db.query<{ id: string }>(
    `SELECT id FROM runner_claim_grants
     WHERE credential_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [principal.credentialId],
  );
  return {
    claims: await Promise.all(
      result.rows.map(({ id }) => loadRunnerClaim(app.db, principal.credentialId, id)),
    ),
  };
}

export async function getRunnerClaim(
  app: App,
  principal: RunnerPrincipal,
  claimId: string,
): Promise<RunnerClaimSummary> {
  return loadRunnerClaim(app.db, principal.credentialId, claimId);
}

export async function revokeRunnerClaim(
  app: App,
  principal: RunnerPrincipal,
  claimId: string,
): Promise<RunnerClaimSummary> {
  const changed = await app.db.query(
    `UPDATE runner_claim_grants SET revoked_at = now(), updated_at = now()
     WHERE id = $1 AND credential_id = $2 AND revoked_at IS NULL
       AND expires_at > now() AND claimed_units < max_units`,
    [claimId, principal.credentialId],
  );
  invariant(changed.rowCount === 1, 404, 'RUNNER_CLAIM_NOT_FOUND', 'Active claim not found');
  return loadRunnerClaim(app.db, principal.credentialId, claimId);
}

async function loadRunnerClaim(
  db: Queryable,
  credentialId: string,
  claimId: string,
): Promise<RunnerClaimSummary> {
  const result = await db.query<ClaimRow>(
    `SELECT claim.id, claim.node_id, claim.pool_id, pool.title AS pool_title,
            pool.requested_agent, pool.requested_model, pool.delivery_mode,
            claim.max_units, claim.claimed_units, claim.expires_at,
            claim.revoked_at, claim.created_at
     FROM runner_claim_grants claim
     JOIN pools pool ON pool.id = claim.pool_id
     WHERE claim.id = $1 AND claim.credential_id = $2`,
    [claimId, credentialId],
  );
  const claim = result.rows[0];
  invariant(claim, 404, 'RUNNER_CLAIM_NOT_FOUND', 'Claim not found');
  const status: RunnerClaimStatus = claim.revoked_at
    ? 'revoked'
    : claim.expires_at.getTime() <= Date.now()
      ? 'expired'
      : claim.claimed_units >= claim.max_units
        ? 'exhausted'
        : 'active';
  return {
    id: claim.id,
    nodeId: claim.node_id,
    poolId: claim.pool_id,
    poolTitle: claim.pool_title,
    requestedAgent: claim.requested_agent,
    requestedModel: claim.requested_model,
    deliveryMode: claim.delivery_mode,
    maxUnits: claim.max_units,
    claimedUnits: claim.claimed_units,
    remainingUnits: Math.max(0, claim.max_units - claim.claimed_units),
    expiresAt: claim.expires_at.toISOString(),
    status,
    createdAt: claim.created_at.toISOString(),
  };
}

async function assertOfficialFleetCanClaim(
  db: Queryable,
  principal: RunnerPrincipal,
  lock = false,
): Promise<void> {
  if (principal.operatorType === 'community') return;
  const result = await db.query<{ mode: OfficialFleetMode }>(
    `SELECT mode FROM official_fleets WHERE owner_id = $1${lock ? ' FOR SHARE' : ''}`,
    [principal.ownerId],
  );
  const fleet = result.rows[0];
  invariant(
    fleet,
    403,
    'OFFICIAL_FLEET_BINDING_REQUIRED',
    'Official runner credential is not attached to an active fleet owner',
  );
  invariant(
    fleet.mode === 'standby',
    409,
    'OFFICIAL_FLEET_OFFLINE',
    'Bring the official fleet to standby before claiming work',
  );
}
