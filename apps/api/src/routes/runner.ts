import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  CLAIM_UNIT_MAX,
  agentAdapterSchema,
  type OfficialFleetMode,
  runnerProgressSchema,
  taskCategorySchema,
  webhookReceiptSchema,
  type AgentAdapter,
  type TaskCapsule,
} from '@agent-pool/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ownerAuth, runnerAuth } from '../auth.js';
import { decryptJson, encryptJson } from '../crypto.js';
import { fetchDatasetExpected, fetchDatasetInput, fetchDatasetUnitLine } from '../dataset-index.js';
import { safeInteger, withTransaction } from '../db.js';
import { ApiError, invariant } from '../errors.js';
import { withRunnerIdempotentTransaction } from '../idempotency.js';
import { hashOpaqueToken } from '../security.js';
import {
  createOwnerBoundClaim,
  createRunnerClaimInTransaction,
  getRunnerClaim,
  listRunnerClaims,
  listRunnerJobs,
  revokeRunnerClaim,
} from '../runner-claims.js';
import {
  assertLeaseOwnership,
  completePoolIfFinished,
  getWallet,
  recordEvent,
  refundLockedUnits,
  settleAcceptedUnit,
} from '../services.js';
import {
  contractHashFromPoolRow,
  receiptRequestDigest,
  resultDigest,
  taskCapsuleFromPoolRow,
  verifyReceiptSignature,
  type StoredDeliveryConfig,
} from '../task-contract.js';
import type { App } from '../types.js';
import { validateTaskResult, validateTaskResultForCapsule } from '../validation.js';

const capabilitySchema = z.object({
  adapter: agentAdapterSchema,
  supportedModels: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(120)
        .refine((model) => model !== '*', 'Wildcard models are not allowed'),
    )
    .min(1)
    .max(100),
  version: z.string().trim().max(80).optional(),
});

const nodeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  platform: z.string().trim().max(100).optional(),
  runnerVersion: z.string().trim().max(80).optional(),
  maxConcurrency: z.number().int().min(1).max(64).default(1),
  supportsDirectWebhooks: z.boolean().default(false),
  adapters: z.array(capabilitySchema).min(1).max(3),
});
const flatNodeSchema = z.object({
  adapter: agentAdapterSchema,
  models: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(120)
        .refine((model) => model !== '*', 'Wildcard models are not allowed'),
    )
    .min(1)
    .max(100),
  concurrency: z.number().int().min(1).max(64),
  adapterVersion: z.string().trim().max(80).optional(),
  clientVersion: z.string().trim().min(1).max(80),
  platform: z.string().trim().min(1).max(100),
  arch: z.string().trim().min(1).max(50),
  supportsDirectWebhooks: z.boolean().default(false),
});

const nodeParamsSchema = z.object({ id: z.string().uuid() });
const leaseParamsSchema = z.object({ leaseId: z.string().uuid() });
const claimParamsSchema = z.object({ claimId: z.string().uuid() });
const jobsQuerySchema = z.object({ nodeId: z.string().uuid() });
const heartbeatSchema = z.object({
  status: z.enum(['online', 'paused']).default('online'),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  runnerVersion: z.string().trim().max(80).optional(),
  activeLeases: z.number().int().min(0).max(64).optional(),
});
const pollSchema = z.object({
  claimId: z.string().uuid().optional(),
  categories: z.array(taskCategorySchema).min(1).max(7).optional(),
  adapter: agentAdapterSchema.optional(),
  models: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(120)
        .refine((model) => model !== '*', 'Wildcard models are not allowed'),
    )
    .min(1)
    .max(100)
    .optional(),
});
const submitSchema = z
  .object({ result: z.unknown().optional(), output: z.unknown().optional() })
  .refine(
    (value) =>
      Object.prototype.hasOwnProperty.call(value, 'result') ||
      Object.prototype.hasOwnProperty.call(value, 'output'),
    { path: ['output'], message: 'output is required' },
  )
  .transform((value) => ({
    result: Object.prototype.hasOwnProperty.call(value, 'output') ? value.output : value.result,
  }));
const failSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
    code: z.string().trim().min(1).max(500).optional(),
    retryable: z.boolean().default(true),
  })
  .refine((value) => value.reason || value.code, { message: 'code is required', path: ['code'] });
const benchmarkStartSchema = z.object({
  nodeId: z.string().uuid().optional(),
  adapter: agentAdapterSchema,
  model: z.string().trim().min(1).max(120),
  requestedConcurrency: z.number().int().min(1).max(64),
});
const benchmarkParamsSchema = z.object({ benchmarkId: z.string().uuid() });
const benchmarkResultsSchema = z.object({
  results: z
    .array(
      z.object({
        leaseId: z.string().uuid(),
        output: z.unknown().optional(),
        durationMs: z
          .number()
          .int()
          .min(0)
          .max(30 * 60 * 1000),
        success: z.boolean(),
      }),
    )
    .min(1)
    .max(128),
});
const capacityQuerySchema = z
  .object({
    adapter: agentAdapterSchema.optional(),
    model: z.string().trim().min(1).max(120).optional(),
    nodeId: z.string().uuid().optional(),
  })
  .superRefine((value, context) => {
    const exact = !!value.adapter && !!value.model && !!value.nodeId;
    const catalog = !value.adapter && !value.model && !value.nodeId;
    if (!exact && !catalog) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'adapter, model, and nodeId must be provided together, or all omitted',
      });
    }
  });

const STAGE_ORDER = new Map([
  ['leased', 0],
  ['starting', 1],
  ['thinking', 2],
  ['working', 3],
  ['checking', 4],
  ['submitting', 5],
  ['completed', 6],
  ['failed', 6],
]);

const RUNNER_CREDENTIAL_RATE_LIMIT = 10_000;
const RUNNER_UNTRUSTED_IP_RATE_LIMIT = 300;
const TRUSTED_RUNNER_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TRUSTED_RUNNER_TOKENS = 10_000;

interface StoredChallenge {
  leaseId: string;
  instruction: string;
  input: { text: string; nonce: string };
  expected: { reversed: string; uppercase: string; grouped: string; length: number };
}

export async function registerRunnerRoutes(app: App): Promise<void> {
  const requireRunner = runnerAuth(app);
  const trustedRunnerTokenHashes = new Map<string, number>();
  const untrustedIpRateLimit = app.createRateLimit({
    max: RUNNER_UNTRUSTED_IP_RATE_LIMIT,
    timeWindow: '1 minute',
    keyGenerator: (request) => `runner-untrusted-ip:${request.ip}`,
  });
  const credentialRateLimit = app.rateLimit({
    max: RUNNER_CREDENTIAL_RATE_LIMIT,
    timeWindow: '1 minute',
    keyGenerator: (request) => `runner-credential:${request.runnerPrincipal!.credentialId}`,
  });
  const limitUntrustedRunnerIp = async (request: FastifyRequest): Promise<void> => {
    const tokenHash = runnerBearerTokenHash(request);
    if (tokenHash && isTrustedRunnerToken(trustedRunnerTokenHashes, tokenHash)) return;
    const limit = await untrustedIpRateLimit(request);
    if (!limit.isAllowed && limit.isExceeded) {
      throw new ApiError(
        429,
        'RUNNER_AUTH_RATE_LIMITED',
        'Too many unauthenticated runner requests',
      );
    }
  };
  const authenticateAndTrustRunner = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const tokenHash = runnerBearerTokenHash(request);
    try {
      await requireRunner(request, reply);
    } catch (error) {
      if (tokenHash) trustedRunnerTokenHashes.delete(tokenHash);
      throw error;
    }
    if (tokenHash) rememberTrustedRunnerToken(trustedRunnerTokenHashes, tokenHash);
  };
  const runnerRouteOptions = {
    config: { rateLimit: false as const },
    preHandler: [limitUntrustedRunnerIp, authenticateAndTrustRunner, credentialRateLimit],
  };

  app.get('/api/runner/me', runnerRouteOptions, async (request) => {
    const principal = request.runnerPrincipal!;
    const nodes = await loadRunnerNodes(app, principal.credentialId);
    const owner = await app.db.query<{ display_name: string }>(
      'SELECT display_name FROM users WHERE id = $1',
      [principal.ownerId],
    );
    const active = await app.db.query<{ count: string }>(
      `SELECT count(*) FROM task_units u JOIN runner_nodes n ON n.id = u.leased_runner_id
       WHERE n.credential_id = $1 AND u.status = 'leased' AND u.lease_expires_at > now()`,
      [principal.credentialId],
    );
    const wallet = await getWallet(app.db, principal.ownerId);
    return {
      credentialId: principal.credentialId,
      operatorType: principal.operatorType,
      user: { displayName: owner.rows[0]?.display_name ?? 'Agent Pool worker' },
      wallet: {
        earnedAvailable: wallet.earnedAvailable,
        earnedPending: wallet.earnedPending,
      },
      activeNodes: nodes.filter((node) => node.status === 'online').length,
      activeLeases: safeInteger(active.rows[0]?.count ?? 0),
      nodes,
      privacyBoundary: {
        ownerDashboardReceivesTaskContents: false,
        runnerProcessReceivesTaskContents: true,
        resistantToMaliciousHostOwner: false,
        note: 'Local process isolation prevents accidental disclosure, but a host administrator can inspect or modify a self-hosted runner.',
      },
    };
  });

  app.get('/api/runner/official-fleet', runnerRouteOptions, async (request) => {
    const principal = request.runnerPrincipal!;
    invariant(
      principal.operatorType === 'official',
      403,
      'OFFICIAL_RUNNER_REQUIRED',
      'Official runner credential required',
    );
    const result = await app.db.query<{
      owner_id: string;
      mode: OfficialFleetMode;
      updated_at: Date;
    }>(`SELECT owner_id, mode, updated_at FROM official_fleets WHERE owner_id = $1`, [
      principal.ownerId,
    ]);
    const fleet = result.rows[0];
    invariant(
      fleet,
      403,
      'OFFICIAL_FLEET_BINDING_REQUIRED',
      'Official runner credential is not attached to an active fleet owner',
    );
    return {
      operatorType: 'official' as const,
      fleet: {
        ownerId: fleet.owner_id,
        mode: fleet.mode,
        updatedAt: fleet.updated_at.toISOString(),
      },
    };
  });

  app.get('/api/runner/jobs', runnerRouteOptions, async (request) => {
    const { nodeId } = jobsQuerySchema.parse(request.query);
    return listRunnerJobs(app, request.runnerPrincipal!, nodeId);
  });

  app.post('/api/runner/claims', runnerRouteOptions, async (request, reply) => {
    const principal = request.runnerPrincipal!;
    const response = await withRunnerIdempotentTransaction(
      app.db,
      request,
      app.config.encryptionKey,
      principal.credentialId,
      'runner.claims.create',
      async (client) => ({
        status: 201,
        body: {
          claim: await createRunnerClaimInTransaction(app, principal, request.body, client),
        },
      }),
    );
    if (response.replayed) reply.header('Idempotency-Replayed', 'true');
    return reply.code(response.status).send(response.body);
  });

  app.get('/api/runner/claims', runnerRouteOptions, async (request) => {
    return listRunnerClaims(app, request.runnerPrincipal!);
  });

  app.get('/api/runner/claims/:claimId', runnerRouteOptions, async (request) => {
    const { claimId } = claimParamsSchema.parse(request.params);
    return { claim: await getRunnerClaim(app, request.runnerPrincipal!, claimId) };
  });

  app.delete('/api/runner/claims/:claimId', runnerRouteOptions, async (request) => {
    const { claimId } = claimParamsSchema.parse(request.params);
    return { claim: await revokeRunnerClaim(app, request.runnerPrincipal!, claimId) };
  });

  app.delete('/api/runner/me', runnerRouteOptions, async (request, reply) => {
    const principal = request.runnerPrincipal!;
    await withTransaction(app.db, async (client) => {
      const revoked = await client.query(
        `UPDATE runner_credentials SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL`,
        [principal.credentialId],
      );
      invariant(revoked.rowCount, 401, 'INVALID_RUNNER_TOKEN', 'Runner token is already revoked');
      await client.query(
        `UPDATE runner_nodes SET status = 'offline', updated_at = now()
         WHERE credential_id = $1`,
        [principal.credentialId],
      );
      await client.query(
        `UPDATE runner_claim_grants SET revoked_at = now(), updated_at = now()
         WHERE credential_id = $1 AND revoked_at IS NULL
           AND expires_at > now() AND claimed_units < max_units`,
        [principal.credentialId],
      );
      await recordEvent(client, principal.ownerId, 'runner.updated', {
        credentialId: principal.credentialId,
        status: 'revoked',
      });
    });
    return reply.code(204).send();
  });

  app.post('/api/runner/nodes', runnerRouteOptions, async (request, reply) => {
    const input = normalizeNodeInput(request.body);
    const principal = request.runnerPrincipal!;
    const node = await withTransaction(app.db, async (client) => {
      const fleetMode = await loadFleetModeForCredential(client, principal);
      const effectiveStatus = fleetMode === 'offline' ? 'offline' : 'online';
      const existing = await client.query<{
        id: string;
        max_concurrency: number;
        supports_direct_webhooks: boolean;
      }>(
        `SELECT id, max_concurrency, supports_direct_webhooks
         FROM runner_nodes WHERE credential_id = $1 AND name = $2 FOR UPDATE`,
        [principal.credentialId, input.name],
      );
      const existingNode = existing.rows[0];
      const nodeId = existingNode?.id ?? randomUUID();
      const preserveActiveProfile = existingNode
        ? await hasActiveNodeWork(client, existingNode.id)
        : false;
      if (existingNode && preserveActiveProfile) {
        const currentCapabilities = await client.query<{
          adapter: string;
          supported_models: string[];
        }>(`SELECT adapter, supported_models FROM runner_capabilities WHERE node_id = $1`, [
          existingNode.id,
        ]);
        invariant(
          existingNode.max_concurrency === input.maxConcurrency &&
            existingNode.supports_direct_webhooks === input.supportsDirectWebhooks &&
            sameCapabilityProfile(
              currentCapabilities.rows.map((capability) => ({
                adapter: capability.adapter,
                supportedModels: capability.supported_models,
              })),
              input.adapters,
            ),
          409,
          'NODE_PROFILE_BUSY',
          'Runner node has an active Claim or Lease; drain it before changing adapters, models, concurrency, or webhook support',
        );
      }
      if (existingNode) {
        await client.query(
          `UPDATE runner_nodes SET platform = $2, runner_version = $3,
             max_concurrency = $4, supports_direct_webhooks = $5,
             status = $6, last_seen_at = now(), updated_at = now()
           WHERE id = $1`,
          [
            nodeId,
            input.platform ?? null,
            input.runnerVersion ?? null,
            input.maxConcurrency,
            input.supportsDirectWebhooks,
            effectiveStatus,
          ],
        );
        if (!preserveActiveProfile) {
          await client.query('DELETE FROM runner_capabilities WHERE node_id = $1', [nodeId]);
        }
      } else {
        await client.query(
          `INSERT INTO runner_nodes
             (id, owner_id, credential_id, name, platform, runner_version, max_concurrency,
              supports_direct_webhooks, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            nodeId,
            principal.ownerId,
            principal.credentialId,
            input.name,
            input.platform ?? null,
            input.runnerVersion ?? null,
            input.maxConcurrency,
            input.supportsDirectWebhooks,
            effectiveStatus,
          ],
        );
      }
      if (!preserveActiveProfile) {
        for (const capability of input.adapters) {
          const models = [...new Set(capability.supportedModels)].sort();
          await client.query(
            `INSERT INTO runner_capabilities (node_id, adapter, supported_models, version)
             VALUES ($1, $2, $3, $4)`,
            [nodeId, capability.adapter, models, capability.version ?? null],
          );
        }
      }
      await client.query(
        `DELETE FROM runner_certifications certification
         WHERE certification.node_id = $1 AND NOT EXISTS (
           SELECT 1 FROM runner_capabilities capability
           WHERE capability.node_id = certification.node_id
             AND capability.adapter = certification.adapter
             AND certification.model = ANY(capability.supported_models)
         )`,
        [nodeId],
      );
      await recordEvent(client, principal.ownerId, 'runner.updated', {
        nodeId,
        name: input.name,
        status: effectiveStatus,
        operatorType: principal.operatorType,
      });
      return { id: nodeId };
    });
    return reply.code(201).send({
      nodeId: node.id,
      operatorType: principal.operatorType,
      heartbeatInterval: 15,
      node: (await loadRunnerNodes(app, principal.credentialId, node.id))[0],
    });
  });

  app.post('/api/runner/nodes/:id/heartbeat', runnerRouteOptions, async (request) => {
    const { id } = nodeParamsSchema.parse(request.params);
    const input = heartbeatSchema.parse(request.body ?? {});
    const principal = request.runnerPrincipal!;
    await withTransaction(app.db, async (client) => {
      const fleetMode = await loadFleetModeForCredential(client, principal);
      const effectiveStatus = fleetMode === 'offline' ? 'offline' : input.status;
      const changed = await client.query(
        `UPDATE runner_nodes SET status = $3, last_seen_at = now(), updated_at = now(),
            max_concurrency = COALESCE($4, max_concurrency),
            runner_version = COALESCE($5, runner_version)
         WHERE id = $1 AND credential_id = $2`,
        [
          id,
          principal.credentialId,
          effectiveStatus,
          input.maxConcurrency ?? null,
          input.runnerVersion ?? null,
        ],
      );
      invariant(changed.rowCount, 404, 'RUNNER_NODE_NOT_FOUND', 'Runner node not found');
      await recordEvent(client, principal.ownerId, 'runner.updated', {
        nodeId: id,
        status: effectiveStatus,
        operatorType: principal.operatorType,
        ...(fleetMode ? { fleetMode } : {}),
      });
    });
    const active = await app.db.query<{ count: string }>(
      `SELECT count(*) FROM task_units
       WHERE leased_runner_id = $1 AND status = 'leased' AND lease_expires_at > now()`,
      [id],
    );
    return {
      ok: true,
      operatorType: principal.operatorType,
      activeLeases: safeInteger(active.rows[0]?.count ?? 0),
      serverTime: new Date().toISOString(),
    };
  });

  app.delete('/api/runner/nodes/:id', runnerRouteOptions, async (request, reply) => {
    const { id } = nodeParamsSchema.parse(request.params);
    const principal = request.runnerPrincipal!;
    await withTransaction(app.db, async (client) => {
      const node = await client.query<{ status: string }>(
        `SELECT status FROM runner_nodes
         WHERE id = $1 AND credential_id = $2 FOR UPDATE`,
        [id, principal.credentialId],
      );
      const current = node.rows[0];
      invariant(current, 404, 'RUNNER_NODE_NOT_FOUND', 'Runner node not found');
      const activeWork = await hasActiveNodeWork(client, id);
      if (!activeWork) {
        await client.query(
          `UPDATE runner_nodes SET status = 'offline', updated_at = now() WHERE id = $1`,
          [id],
        );
      }
      await recordEvent(client, principal.ownerId, 'runner.updated', {
        nodeId: id,
        status: activeWork ? current.status : 'offline',
        ...(activeWork ? { cleanupDeferred: true } : {}),
      });
    });
    return reply.code(204).send();
  });

  app.post('/api/runner/nodes/:id/leases/poll', runnerRouteOptions, async (request, reply) => {
    const { id: nodeId } = nodeParamsSchema.parse(request.params);
    const input = pollSchema.parse(request.body ?? {});
    const principal = request.runnerPrincipal!;
    invariant(
      input.claimId,
      400,
      'RUNNER_CLAIM_REQUIRED',
      'Runner polling must be scoped to one claimId created by this credential and node',
    );
    const polled = await withTransaction(app.db, async (client) => {
      const fleetMode = await loadFleetModeForCredential(client, principal);
      const nodeResult = await client.query<{
        id: string;
        owner_id: string;
        status: string;
        max_concurrency: number;
        supports_direct_webhooks: boolean;
      }>(
        `SELECT id, owner_id, status, max_concurrency, supports_direct_webhooks FROM runner_nodes
         WHERE id = $1 AND credential_id = $2 FOR UPDATE`,
        [nodeId, principal.credentialId],
      );
      const node = nodeResult.rows[0];
      invariant(node, 404, 'RUNNER_NODE_NOT_FOUND', 'Runner node not found');
      await client.query(
        `UPDATE runner_nodes SET last_seen_at = now(), updated_at = now(),
           status = CASE WHEN $2::boolean THEN 'offline' ELSE status END
         WHERE id = $1`,
        [nodeId, fleetMode === 'offline'],
      );
      if (fleetMode === 'offline') return null;
      invariant(node.status === 'online', 409, 'RUNNER_NODE_PAUSED', 'Runner node is not online');

      const candidate = await client.query<{
        unit_id: string;
        pool_id: string;
        category: string;
        requested_agent: AgentAdapter;
        requested_model: string;
        reward_per_unit: string;
        secret_instruction_ciphertext: string;
        input_ciphertext: string | null;
        input_sha256: string | null;
        source_offset: string | null;
        source_length: number | null;
        dataset_mode: 'inline' | 'https' | 'work';
        dataset_url_ciphertext: string | null;
        output_schema: Record<string, unknown> | null;
        max_unit_seconds: number;
        deadline_at: Date;
        owner_id: string;
        title: string;
        public_summary: string;
        task_capsule_ciphertext: string | null;
        contract_hash: string | null;
        delivery_mode: 'platform' | 'webhook';
        delivery_config_ciphertext: string | null;
        validation_mode: string;
        legacy_contract: boolean;
        ordinal: number;
        label_ciphertext: string | null;
        is_pilot: boolean;
        attempt_count: number;
        validation: Record<string, unknown> | null;
        failure_reason: string | null;
        feedback_reason_ciphertext: string | null;
        feedback_attempt: number | null;
        claim_id: string;
      }>(
        `SELECT u.id AS unit_id, p.id AS pool_id, p.category, p.requested_agent,
                p.requested_model, p.reward_per_unit, p.secret_instruction_ciphertext,
                u.input_ciphertext, u.input_sha256, u.source_offset, u.source_length,
                p.dataset_mode, p.dataset_url_ciphertext, p.output_schema, p.max_unit_seconds, p.deadline_at, p.owner_id,
                p.title, p.public_summary, p.task_capsule_ciphertext, p.contract_hash,
                p.delivery_mode, p.delivery_config_ciphertext, p.validation_mode,
                p.legacy_contract, u.ordinal, u.label_ciphertext, u.is_pilot, u.attempt_count,
                u.validation, u.failure_reason,
                feedback.reason_ciphertext AS feedback_reason_ciphertext,
                feedback.attempt AS feedback_attempt, claim_grant.id AS claim_id
         FROM task_units u
         JOIN pools p ON p.id = u.pool_id
         JOIN runner_certifications c
           ON c.node_id = $1 AND c.adapter = p.requested_agent AND c.model = p.requested_model
          AND c.expires_at > now() AND c.certified_concurrency > 0
          AND c.p95_ms <= p.max_unit_seconds * 1000
         JOIN runner_capabilities cap
           ON cap.node_id = $1 AND cap.adapter = p.requested_agent
          AND p.requested_model = ANY(cap.supported_models)
         JOIN runner_claim_grants claim_grant
           ON claim_grant.id = $7::uuid AND claim_grant.credential_id = $8
          AND claim_grant.node_id = $1 AND claim_grant.pool_id = p.id
          AND claim_grant.revoked_at IS NULL
          AND claim_grant.expires_at > now()
          AND claim_grant.claimed_units < claim_grant.max_units
         LEFT JOIN LATERAL (
           SELECT reason_ciphertext, attempt FROM webhook_receipts receipt
           WHERE receipt.unit_id = u.id AND receipt.decision = 'rejected'
           ORDER BY receipt.attempt DESC LIMIT 1
         ) feedback ON true
         WHERE u.status = 'queued'
           AND p.status IN ('piloting', 'waiting_capacity', 'queued', 'running')
           AND p.deadline_at > now()
           AND (p.delivery_mode <> 'webhook' OR $6::boolean)
           AND ($2::text[] IS NULL OR p.category = ANY($2::text[]))
           AND ($4::text IS NULL OR p.requested_agent = $4)
           AND ($5::text[] IS NULL OR p.requested_model = ANY($5::text[]))
           AND (SELECT count(*) FROM task_units current_node
                WHERE current_node.leased_runner_id = $1 AND current_node.status = 'leased'
                  AND current_node.lease_expires_at > now())
               < LEAST(c.certified_concurrency, $3)
           AND (SELECT count(*) FROM task_units current_pool
                WHERE current_pool.pool_id = p.id AND current_pool.status = 'leased'
                  AND current_pool.lease_expires_at > now()) < p.required_concurrency
         ORDER BY p.deadline_at ASC, p.reward_per_unit DESC, u.ordinal ASC
         FOR UPDATE OF u, p SKIP LOCKED LIMIT 1`,
        [
          nodeId,
          input.categories ?? null,
          node.max_concurrency,
          input.adapter ?? null,
          input.models ?? null,
          node.supports_direct_webhooks,
          input.claimId,
          principal.credentialId,
        ],
      );
      const unit = candidate.rows[0];
      if (!unit) return null;
      const leaseId = randomUUID();
      const consumed = await client.query(
        `UPDATE runner_claim_grants
         SET claimed_units = claimed_units + 1, updated_at = now()
         WHERE id = $1 AND credential_id = $2 AND node_id = $3 AND pool_id = $4
           AND revoked_at IS NULL AND expires_at > now() AND claimed_units < max_units`,
        [unit.claim_id, principal.credentialId, nodeId, unit.pool_id],
      );
      if (consumed.rowCount !== 1) return null;
      const updated = await client.query<{ expires_at: Date }>(
        `UPDATE task_units SET status = 'leased', lease_id = $2, leased_runner_id = $3,
            lease_expires_at = LEAST(now() + ($4 * interval '1 second'), $5::timestamptz),
            attempt_count = attempt_count + 1,
            stage = 'leased', progress = 0, updated_at = now()
         WHERE id = $1 AND status = 'queued' RETURNING lease_expires_at AS expires_at`,
        [unit.unit_id, leaseId, nodeId, unit.max_unit_seconds, unit.deadline_at],
      );
      invariant(updated.rowCount === 1, 409, 'LEASE_RACE', 'Unit was leased by another runner');
      await client.query(
        `INSERT INTO runner_claim_leases (grant_id, lease_id, unit_id) VALUES ($1, $2, $3)`,
        [unit.claim_id, leaseId, unit.unit_id],
      );
      await client.query(
        `UPDATE pools SET status = 'running', updated_at = now()
         WHERE id = $1 AND status IN ('waiting_capacity', 'queued')`,
        [unit.pool_id],
      );
      await recordEvent(client, unit.owner_id, 'unit.updated', {
        poolId: unit.pool_id,
        unitId: unit.unit_id,
        status: 'leased',
        progress: 0,
      });
      await recordEvent(client, principal.ownerId, 'unit.updated', {
        unitId: unit.unit_id,
        status: 'leased',
        reward: safeInteger(unit.reward_per_unit),
        claimId: unit.claim_id,
      });
      const capsule = taskCapsuleFromPoolRow(unit, app.config.encryptionKey);
      const taskContractHash = contractHashFromPoolRow(unit);
      const attemptFeedback = buildAttemptFeedback(unit, app.config.encryptionKey);
      const delivery =
        unit.delivery_mode === 'webhook'
          ? (() => {
              invariant(
                unit.delivery_config_ciphertext && unit.label_ciphertext,
                500,
                'WEBHOOK_CONTRACT_INVALID',
                'Webhook delivery configuration is missing',
              );
              const config = decryptJson<StoredDeliveryConfig>(
                unit.delivery_config_ciphertext,
                app.config.encryptionKey,
              );
              return {
                mode: 'webhook' as const,
                url: config.url,
                protocol: 'agentpool-webhook/1' as const,
                unitReference: decryptJson<string>(unit.label_ciphertext, app.config.encryptionKey),
                ordinal: unit.ordinal,
              };
            })()
          : ({ mode: 'platform' } as const);
      const pendingDataset =
        !unit.input_ciphertext &&
        unit.dataset_url_ciphertext &&
        unit.input_sha256 &&
        unit.source_offset !== null &&
        unit.source_length
          ? {
              url: decryptJson<string>(unit.dataset_url_ciphertext, app.config.encryptionKey),
              sourceOffset: safeInteger(unit.source_offset),
              sourceLength: unit.source_length,
              inputSha256: unit.input_sha256,
              unitId: unit.unit_id,
              leaseId,
              claimId: unit.claim_id,
            }
          : null;
      if (!unit.input_ciphertext) {
        invariant(
          pendingDataset,
          500,
          'DATASET_INDEX_INVALID',
          'Dataset unit is missing fetch coordinates',
        );
      }
      return {
        pendingDataset,
        lease: {
          leaseId,
          unitId: unit.unit_id,
          poolId: unit.pool_id,
          category: unit.category,
          requestedAgent: unit.requested_agent,
          requestedModel: unit.requested_model,
          reward: safeInteger(unit.reward_per_unit),
          instruction: decryptJson<string>(
            unit.secret_instruction_ciphertext,
            app.config.encryptionKey,
          ),
          input: unit.input_ciphertext
            ? decryptJson(unit.input_ciphertext, app.config.encryptionKey)
            : null,
          ...(capsule.delivery.schema ? { outputSchema: capsule.delivery.schema } : {}),
          taskCapsule: capsule,
          contractHash: taskContractHash,
          ...(attemptFeedback ? { attemptFeedback } : {}),
          delivery,
          isPilot: unit.is_pilot,
          expiresAt: updated.rows[0]!.expires_at.toISOString(),
        },
      };
    });
    const lease = polled?.lease ?? null;
    const fetchSpec = polled?.pendingDataset ?? null;

    if (lease && fetchSpec) {
      try {
        lease.input = await fetchDatasetInput(fetchSpec.url, fetchSpec, app.datasetFetch);
      } catch (error) {
        await withTransaction(app.db, async (client) => {
          await client.query(
            `UPDATE task_units
             SET status = 'queued', lease_id = NULL, leased_runner_id = NULL,
                 lease_expires_at = NULL, attempt_count = GREATEST(attempt_count - 1, 0),
                 stage = NULL, progress = 0, updated_at = now()
             WHERE id = $1 AND lease_id = $2`,
            [fetchSpec.unitId, fetchSpec.leaseId],
          );
          await client.query(`DELETE FROM runner_claim_leases WHERE lease_id = $1`, [
            fetchSpec.leaseId,
          ]);
          await client.query(
            `UPDATE runner_claim_grants
             SET claimed_units = GREATEST(claimed_units - 1, 0), updated_at = now()
             WHERE id = $1 AND claimed_units > 0`,
            [fetchSpec.claimId],
          );
        });
        throw error;
      }
    }

    reply.header('Cache-Control', 'no-store, private');
    reply.header('X-Agent-Pool-Content', 'runner-process-only');
    return {
      lease,
      retryAfterMs: lease ? 0 : 3_000,
      privacyBoundary: lease
        ? {
            intendedAudience: 'runner-process',
            ownerDashboardExposed: false,
            hostOwnerResistance: false,
          }
        : undefined,
    };
  });

  app.post('/api/runner/leases/:leaseId/progress', runnerRouteOptions, async (request) => {
    const { leaseId } = leaseParamsSchema.parse(request.params);
    const input = runnerProgressSchema.parse(request.body);
    const principal = request.runnerPrincipal!;
    await withTransaction(app.db, async (client) => {
      const result = await loadLeaseForUpdate(client, leaseId);
      const row = result.rows[0];
      invariant(row, 404, 'LEASE_NOT_FOUND', 'Lease not found');
      invariant(
        row.credential_id === principal.credentialId,
        403,
        'LEASE_NOT_OWNED',
        'Lease belongs to another runner',
      );
      if (
        (row.status === 'accepted' || row.status === 'submitted') &&
        input.stage === 'completed' &&
        input.progress === 100
      ) {
        await client.query(
          `UPDATE task_units SET stage = 'completed', progress = 100, updated_at = now() WHERE id = $1`,
          [row.unit_id],
        );
        return;
      }
      if (row.status === 'failed' && input.stage === 'failed') return;
      assertLeaseOwnership(row, principal.credentialId);
      const previousOrder = STAGE_ORDER.get(row.stage ?? 'leased') ?? 0;
      const nextOrder = STAGE_ORDER.get(input.stage) ?? 0;
      invariant(
        nextOrder >= previousOrder,
        409,
        'PROGRESS_REGRESSION',
        'Task stage cannot move backwards',
      );
      invariant(
        input.progress >= row.progress,
        409,
        'PROGRESS_REGRESSION',
        'Task progress cannot decrease',
      );
      await client.query(
        `UPDATE task_units SET stage = $2, progress = $3, updated_at = now() WHERE id = $1`,
        [row.unit_id, input.stage, input.progress],
      );
      await recordEvent(client, row.publisher_id, 'unit.updated', {
        poolId: row.pool_id,
        unitId: row.unit_id,
        status: 'leased',
        stage: input.stage,
        progress: input.progress,
      });
    });
    return { ok: true };
  });

  app.post(
    '/api/runner/leases/:leaseId/submit',
    { ...runnerRouteOptions, bodyLimit: 10 * 1024 * 1024 },
    async (request, reply) => {
      const { leaseId } = leaseParamsSchema.parse(request.params);
      const input = submitSchema.parse(request.body);
      const principal = request.runnerPrincipal!;
      const submissionDigest = resultDigest(input.result);
      const outcome = await withTransaction(app.db, async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `platform-submit:${leaseId}`,
        ]);
        const replay = await client.query<{
          credential_id: string;
          result_digest: string;
          outcome: { status: string; validation: Record<string, unknown> };
        }>(
          `SELECT credential_id, result_digest, outcome FROM lease_submissions
           WHERE lease_id = $1`,
          [leaseId],
        );
        const previous = replay.rows[0];
        if (previous) {
          invariant(
            previous.credential_id === principal.credentialId,
            403,
            'LEASE_NOT_OWNED',
            'Lease belongs to another runner',
          );
          invariant(
            previous.result_digest === submissionDigest,
            409,
            'SUBMISSION_IDEMPOTENCY_CONFLICT',
            'This lease was already submitted with different content',
          );
          return previous.outcome;
        }
        const result = await loadLeaseForUpdate(client, leaseId);
        const row = result.rows[0];
        invariant(row, 404, 'LEASE_NOT_FOUND', 'Lease not found');
        assertLeaseOwnership(row, principal.credentialId);
        invariant(
          row.delivery_mode === 'platform',
          409,
          'WEBHOOK_RECEIPT_REQUIRED',
          'Webhook leases must be completed with a signed receipt',
        );

        const expected = await resolveExpectedOutput(app, row);
        const capsule = taskCapsuleFromPoolRow(row, app.config.encryptionKey);
        const validation = row.legacy_contract
          ? validateTaskResult(input.result, row.output_schema, expected, row.pool_id)
          : validateTaskResultForCapsule(input.result, capsule, expected, row.pool_id);
        const encryptedResult = encryptJson(input.result, app.config.encryptionKey);
        if (capsule.acceptance.mode === 'manual') {
          await client.query(
            `UPDATE task_units SET status = 'submitted', result_ciphertext = $2,
               validation = $3, stage = 'submitting', progress = 100, submitted_at = now(),
               updated_at = now() WHERE id = $1`,
            [row.unit_id, encryptedResult, JSON.stringify(validation)],
          );
          await recordSubmissionEvents(client, row, principal.ownerId, 'submitted');
          return storePlatformSubmission(client, {
            leaseId,
            unitId: row.unit_id,
            credentialId: principal.credentialId,
            resultDigest: submissionDigest,
            outcome: { status: 'submitted', validation },
          });
        }

        if (validation.valid) {
          await client.query(
            `UPDATE task_units SET status = 'accepted', result_ciphertext = $2,
               validation = $3, stage = 'completed', progress = 100, submitted_at = now(),
               accepted_at = now(), updated_at = now() WHERE id = $1`,
            [row.unit_id, encryptedResult, JSON.stringify(validation)],
          );
          await settleAcceptedUnit(client, row.unit_id);
          await recordSubmissionEvents(client, row, principal.ownerId, 'accepted');
          return storePlatformSubmission(client, {
            leaseId,
            unitId: row.unit_id,
            credentialId: principal.credentialId,
            resultDigest: submissionDigest,
            outcome: { status: 'accepted', validation },
          });
        }

        const retry =
          row.attempt_count < row.max_attempts &&
          new Date(row.deadline_at).getTime() > Date.now() &&
          ['piloting', 'queued', 'running'].includes(row.pool_status);
        if (retry) {
          await client.query(
            `UPDATE task_units SET status = 'queued', result_ciphertext = NULL,
               validation = $2, lease_id = NULL, leased_runner_id = NULL,
               lease_expires_at = NULL, stage = NULL, progress = 0, submitted_at = NULL,
               failure_reason = 'automatic_validation_failed', updated_at = now() WHERE id = $1`,
            [row.unit_id, JSON.stringify(validation)],
          );
          await recordSubmissionEvents(client, row, principal.ownerId, 'queued');
          return storePlatformSubmission(client, {
            leaseId,
            unitId: row.unit_id,
            credentialId: principal.credentialId,
            resultDigest: submissionDigest,
            outcome: { status: 'retrying', validation },
          });
        }

        await client.query(
          `UPDATE task_units SET status = 'failed', result_ciphertext = $2,
             validation = $3, lease_id = NULL, leased_runner_id = NULL,
             lease_expires_at = NULL, stage = 'failed', progress = 100, submitted_at = now(),
             failure_reason = 'automatic_validation_failed', updated_at = now() WHERE id = $1`,
          [row.unit_id, encryptedResult, JSON.stringify(validation)],
        );
        await refundLockedUnits(
          client,
          row.pool_id,
          row.publisher_id,
          1,
          safeInteger(row.reward_per_unit),
        );
        await completePoolIfFinished(client, row.pool_id, row.publisher_id);
        await recordSubmissionEvents(client, row, principal.ownerId, 'failed');
        return storePlatformSubmission(client, {
          leaseId,
          unitId: row.unit_id,
          credentialId: principal.credentialId,
          resultDigest: submissionDigest,
          outcome: { status: 'failed', validation },
        });
      });
      reply.header('Cache-Control', 'no-store, private');
      return outcome;
    },
  );

  app.post('/api/runner/leases/:leaseId/receipt', runnerRouteOptions, async (request) => {
    const { leaseId } = leaseParamsSchema.parse(request.params);
    const receipt = webhookReceiptSchema.parse(request.body);
    invariant(
      receipt.leaseId === leaseId,
      409,
      'RECEIPT_CLAIM_MISMATCH',
      'Receipt leaseId does not match the route',
    );
    const principal = request.runnerPrincipal!;
    const requestDigest = receiptRequestDigest(receipt);
    return withTransaction(app.db, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `webhook-receipt-lease:${leaseId}`,
      ]);
      const leaseReplay = await client.query<{
        receipt_id: string;
        lease_id: string;
        credential_id: string;
        request_digest: string;
        outcome: Record<string, unknown>;
      }>(
        `SELECT receipt_id, lease_id, credential_id, request_digest, outcome
         FROM webhook_receipts WHERE lease_id = $1 FOR UPDATE`,
        [leaseId],
      );
      const previous = leaseReplay.rows[0];
      if (previous) {
        invariant(
          previous.credential_id === principal.credentialId,
          403,
          'LEASE_NOT_OWNED',
          'Receipt belongs to another runner credential',
        );
        invariant(
          previous.receipt_id === receipt.receiptId &&
            previous.lease_id === leaseId &&
            previous.request_digest === requestDigest,
          409,
          'RECEIPT_IDEMPOTENCY_CONFLICT',
          'Receipt ID or lease was already used with different claims',
        );
        return previous.outcome;
      }

      const result = await loadLeaseForUpdate(client, leaseId);
      const row = result.rows[0];
      invariant(row, 404, 'LEASE_NOT_FOUND', 'Lease not found');
      assertLeaseOwnership(row, principal.credentialId);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `webhook-receipt-pool:${row.pool_id}:${receipt.receiptId}`,
      ]);
      const receiptIdCollision = await client.query(
        `SELECT 1 FROM webhook_receipts
         WHERE pool_id = $1 AND receipt_id = $2 FOR UPDATE`,
        [row.pool_id, receipt.receiptId],
      );
      invariant(
        !receiptIdCollision.rowCount,
        409,
        'RECEIPT_IDEMPOTENCY_CONFLICT',
        'Receipt ID was already used by another lease in this pool',
      );
      invariant(
        row.delivery_mode === 'webhook',
        409,
        'PLATFORM_SUBMISSION_REQUIRED',
        'Platform leases must be completed through submit',
      );
      const taskContractHash = contractHashFromPoolRow(row);
      invariant(
        receipt.unitId === row.unit_id && receipt.contractHash === taskContractHash,
        409,
        'RECEIPT_CLAIM_MISMATCH',
        'Receipt unitId or contractHash does not match the lease',
      );
      invariant(
        row.delivery_config_ciphertext,
        500,
        'WEBHOOK_CONTRACT_INVALID',
        'Webhook delivery configuration is missing',
      );
      const deliveryConfig = decryptJson<StoredDeliveryConfig>(
        row.delivery_config_ciphertext,
        app.config.encryptionKey,
      );
      invariant(
        verifyReceiptSignature(receipt, deliveryConfig.receiptSecret),
        401,
        'INVALID_RECEIPT_SIGNATURE',
        'Receipt signature is invalid',
      );
      const validation = {
        valid: receipt.decision === 'accepted',
        mode: 'webhook',
        checks: { signedReceipt: true, externalDecision: receipt.decision },
        errors:
          receipt.decision === 'rejected'
            ? [{ check: 'externalDecision', message: 'External webhook rejected delivery' }]
            : [],
      };
      let outcomeStatus: 'accepted' | 'retrying' | 'failed';
      if (receipt.decision === 'accepted') {
        await client.query(
          `UPDATE task_units SET status = 'accepted', validation = $2, stage = 'completed',
             progress = 100, submitted_at = now(), accepted_at = now(), updated_at = now()
           WHERE id = $1`,
          [row.unit_id, JSON.stringify(validation)],
        );
        await settleAcceptedUnit(client, row.unit_id);
        outcomeStatus = 'accepted';
      } else {
        const retry =
          receipt.retryable &&
          row.attempt_count < row.max_attempts &&
          new Date(row.deadline_at).getTime() > Date.now() &&
          ['piloting', 'queued', 'running'].includes(row.pool_status);
        if (retry) {
          await client.query(
            `UPDATE task_units SET status = 'queued', validation = $2,
               lease_id = NULL, leased_runner_id = NULL, lease_expires_at = NULL,
               stage = NULL, progress = 0, failure_reason = 'webhook_rejected', updated_at = now()
             WHERE id = $1`,
            [row.unit_id, JSON.stringify(validation)],
          );
          outcomeStatus = 'retrying';
        } else {
          await client.query(
            `UPDATE task_units SET status = 'failed', validation = $2,
               lease_id = NULL, leased_runner_id = NULL, lease_expires_at = NULL,
               stage = 'failed', progress = 100, failure_reason = 'webhook_rejected',
               updated_at = now() WHERE id = $1`,
            [row.unit_id, JSON.stringify(validation)],
          );
          await refundLockedUnits(
            client,
            row.pool_id,
            row.publisher_id,
            1,
            safeInteger(row.reward_per_unit),
          );
          await completePoolIfFinished(client, row.pool_id, row.publisher_id);
          outcomeStatus = 'failed';
        }
      }
      const outcome = {
        status: outcomeStatus,
        validation,
        externalReceipt: {
          receiptId: receipt.receiptId,
          resultSha256: receipt.resultSha256,
          decision: receipt.decision,
          attempt: row.attempt_count,
        },
      };
      await client.query(
        `INSERT INTO webhook_receipts
           (id, pool_id, receipt_id, lease_id, unit_id, credential_id, contract_hash,
            result_sha256, decision, retryable, reason_ciphertext, attempt,
            request_digest, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          randomUUID(),
          row.pool_id,
          receipt.receiptId,
          leaseId,
          row.unit_id,
          principal.credentialId,
          taskContractHash,
          receipt.resultSha256,
          receipt.decision,
          receipt.retryable,
          receipt.reason ? encryptJson(receipt.reason, app.config.encryptionKey) : null,
          row.attempt_count,
          requestDigest,
          JSON.stringify(outcome),
        ],
      );
      await recordSubmissionEvents(
        client,
        row,
        principal.ownerId,
        outcomeStatus === 'retrying' ? 'queued' : outcomeStatus,
      );
      return outcome;
    });
  });

  app.post('/api/runner/leases/:leaseId/fail', runnerRouteOptions, async (request) => {
    const { leaseId } = leaseParamsSchema.parse(request.params);
    const input = failSchema.parse(request.body);
    const principal = request.runnerPrincipal!;
    return withTransaction(app.db, async (client) => {
      const result = await loadLeaseForUpdate(client, leaseId);
      const row = result.rows[0];
      invariant(row, 404, 'LEASE_NOT_FOUND', 'Lease not found');
      assertLeaseOwnership(row, principal.credentialId);
      const retry =
        input.retryable &&
        row.attempt_count < row.max_attempts &&
        new Date(row.deadline_at).getTime() > Date.now() &&
        ['piloting', 'queued', 'running'].includes(row.pool_status);
      if (retry) {
        await client.query(
          `UPDATE task_units SET status = 'queued', lease_id = NULL, leased_runner_id = NULL,
             lease_expires_at = NULL, stage = NULL, progress = 0, result_ciphertext = NULL,
             submitted_at = NULL, failure_reason = $2,
             updated_at = now() WHERE id = $1`,
          [row.unit_id, input.reason ?? input.code],
        );
      } else {
        await client.query(
          `UPDATE task_units SET status = 'failed', lease_id = NULL, leased_runner_id = NULL,
             lease_expires_at = NULL, stage = 'failed', result_ciphertext = NULL,
             submitted_at = NULL, failure_reason = $2,
             updated_at = now() WHERE id = $1`,
          [row.unit_id, input.reason ?? input.code],
        );
        await refundLockedUnits(
          client,
          row.pool_id,
          row.publisher_id,
          1,
          safeInteger(row.reward_per_unit),
        );
        await completePoolIfFinished(client, row.pool_id, row.publisher_id);
      }
      await recordSubmissionEvents(client, row, principal.ownerId, retry ? 'queued' : 'failed');
      return { status: retry ? 'retrying' : 'failed' };
    });
  });

  app.post('/api/runner/benchmarks', runnerRouteOptions, async (request, reply) => {
    const input = benchmarkStartSchema.parse(request.body);
    const principal = request.runnerPrincipal!;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const response = await withTransaction(app.db, async (client) => {
      let nodeResult = await client.query<{
        id: string;
        max_concurrency: number;
      }>(
        `SELECT n.id, n.max_concurrency
         FROM runner_nodes n
         JOIN runner_capabilities c ON c.node_id = n.id
         WHERE n.credential_id = $1 AND n.status = 'online'
           AND ($2::uuid IS NULL OR n.id = $2)
           AND c.adapter = $3 AND $4 = ANY(c.supported_models)
         ORDER BY n.id LIMIT 1 FOR UPDATE OF n`,
        [principal.credentialId, input.nodeId ?? null, input.adapter, input.model],
      );
      if (!nodeResult.rows[0] && !input.nodeId) {
        const nodeId = randomUUID();
        const name = `benchmark-${input.adapter}`;
        await client.query(
          `INSERT INTO runner_nodes
             (id, owner_id, credential_id, name, runner_version, max_concurrency)
           VALUES ($1, $2, $3, $4, 'benchmark-bootstrap', $5)
           ON CONFLICT (credential_id, name) DO UPDATE SET
             status = 'online', max_concurrency = EXCLUDED.max_concurrency,
             last_seen_at = now(), updated_at = now()`,
          [nodeId, principal.ownerId, principal.credentialId, name, input.requestedConcurrency],
        );
        const bootstrap = await client.query<{ id: string; max_concurrency: number }>(
          `SELECT id, max_concurrency FROM runner_nodes
           WHERE credential_id = $1 AND name = $2 FOR UPDATE`,
          [principal.credentialId, name],
        );
        const bootstrapNode = bootstrap.rows[0]!;
        await client.query(
          `INSERT INTO runner_capabilities (node_id, adapter, supported_models)
           VALUES ($1, $2, $3)
           ON CONFLICT (node_id, adapter) DO UPDATE SET supported_models = EXCLUDED.supported_models`,
          [bootstrapNode.id, input.adapter, [input.model]],
        );
        await client.query(
          `DELETE FROM runner_certifications
           WHERE node_id = $1 AND adapter = $2 AND model <> $3`,
          [bootstrapNode.id, input.adapter, input.model],
        );
        nodeResult = { ...nodeResult, rows: [bootstrapNode], rowCount: 1 };
      }
      const node = nodeResult.rows[0];
      invariant(
        node,
        404,
        'BENCHMARK_NODE_NOT_FOUND',
        'No online node advertises this exact adapter/model',
      );
      invariant(
        input.requestedConcurrency <= node.max_concurrency,
        400,
        'CONCURRENCY_EXCEEDS_NODE',
        'requestedConcurrency exceeds the node maximum',
      );
      const challengeCount = Math.max(3, input.requestedConcurrency * 2);
      const challenges = Array.from({ length: challengeCount }, () => makeChallenge());
      const benchmarkId = randomUUID();
      await client.query(
        `INSERT INTO benchmark_attempts
           (id, node_id, adapter, model, requested_concurrency, challenge_ciphertext, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          benchmarkId,
          node.id,
          input.adapter,
          input.model,
          input.requestedConcurrency,
          encryptJson(challenges, app.config.encryptionKey),
          expiresAt,
        ],
      );
      return { benchmarkId, nodeId: node.id, challenges };
    });
    reply.header('Cache-Control', 'no-store, private');
    reply.header('X-Agent-Pool-Content', 'runner-process-only');
    return reply.code(201).send({
      benchmarkId: response.benchmarkId,
      nodeId: response.nodeId,
      leases: response.challenges.map(({ leaseId, instruction, input: challengeInput }) => ({
        leaseId,
        unitId: leaseId,
        poolId: response.benchmarkId,
        category: 'other',
        requestedAgent: input.adapter,
        requestedModel: input.model,
        reward: 0,
        instruction,
        input: challengeInput,
        expiresAt: expiresAt.toISOString(),
      })),
      expiresAt: expiresAt.toISOString(),
      assurance:
        'The benchmark verifies claimed adapter/model correctness and observed performance on a self-hosted node; it does not cryptographically attest model identity.',
    });
  });

  app.post('/api/runner/benchmarks/:benchmarkId/results', runnerRouteOptions, async (request) => {
    const { benchmarkId } = benchmarkParamsSchema.parse(request.params);
    const input = benchmarkResultsSchema.parse(request.body);
    const principal = request.runnerPrincipal!;
    const certification = await withTransaction(app.db, async (client) => {
      const attemptResult = await client.query<{
        id: string;
        node_id: string;
        credential_id: string;
        adapter: AgentAdapter;
        model: string;
        requested_concurrency: number;
        challenge_ciphertext: string;
        status: string;
        started_at: Date;
        expires_at: Date;
      }>(
        `SELECT b.*, n.credential_id FROM benchmark_attempts b
           JOIN runner_nodes n ON n.id = b.node_id
           WHERE b.id = $1 FOR UPDATE OF b`,
        [benchmarkId],
      );
      const attempt = attemptResult.rows[0];
      invariant(
        attempt && attempt.credential_id === principal.credentialId,
        404,
        'BENCHMARK_NOT_FOUND',
        'Benchmark not found',
      );
      invariant(
        attempt.status === 'running',
        409,
        'BENCHMARK_ALREADY_SUBMITTED',
        'Benchmark is no longer active',
      );
      if (new Date(attempt.expires_at).getTime() <= Date.now()) {
        await client.query(`UPDATE benchmark_attempts SET status = 'expired' WHERE id = $1`, [
          benchmarkId,
        ]);
        throw new ApiError(410, 'BENCHMARK_EXPIRED', 'Benchmark has expired');
      }
      const challenges = decryptJson<StoredChallenge[]>(
        attempt.challenge_ciphertext,
        app.config.encryptionKey,
      );
      const submitted = new Map(input.results.map((result) => [result.leaseId, result]));
      const durations: number[] = [];
      let passed = 0;
      for (const challenge of challenges) {
        const result = submitted.get(challenge.leaseId);
        if (
          result?.success &&
          validateTaskResult(result.output, undefined, challenge.expected).valid
        ) {
          passed += 1;
          durations.push(result.durationMs);
        }
      }
      const wallMs = Math.max(1, Date.now() - new Date(attempt.started_at).getTime());
      const successRate = passed / challenges.length;
      const certifiedConcurrency = successRate >= 0.8 ? attempt.requested_concurrency : 0;
      const waves = Math.ceil(challenges.length / attempt.requested_concurrency);
      const observedWaveMs = Math.max(1, Math.ceil(wallMs / waves));
      const conservativeDurations = durations.length
        ? durations.map((duration) => Math.max(duration, observedWaveMs))
        : [observedWaveMs];
      const p50Ms = percentile(conservativeDurations, 0.5);
      const p95Ms = percentile(conservativeDurations, 0.95);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM runner_certifications
           WHERE node_id = $1 AND adapter = $2 AND model = $3 FOR UPDATE`,
        [attempt.node_id, attempt.adapter, attempt.model],
      );
      const certificationId = existing.rows[0]?.id ?? randomUUID();
      await client.query(
        `INSERT INTO runner_certifications
             (id, node_id, adapter, model, certified_concurrency, p50_ms, p95_ms,
              success_rate, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (node_id, adapter, model) DO UPDATE SET
             certified_concurrency = EXCLUDED.certified_concurrency,
             p50_ms = EXCLUDED.p50_ms, p95_ms = EXCLUDED.p95_ms,
             success_rate = EXCLUDED.success_rate, expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
        [
          certificationId,
          attempt.node_id,
          attempt.adapter,
          attempt.model,
          certifiedConcurrency,
          p50Ms,
          p95Ms,
          successRate,
          expiresAt,
        ],
      );
      await client.query(
        `UPDATE benchmark_attempts SET status = $2, submitted_at = now() WHERE id = $1`,
        [benchmarkId, certifiedConcurrency > 0 ? 'passed' : 'failed'],
      );
      await recordEvent(client, principal.ownerId, 'runner.updated', {
        nodeId: attempt.node_id,
        certificationId,
        adapter: attempt.adapter,
        model: attempt.model,
        certifiedConcurrency,
      });
      return {
        certified: certifiedConcurrency > 0,
        certificationId,
        nodeId: attempt.node_id,
        adapter: attempt.adapter,
        model: attempt.model,
        certifiedConcurrency,
        p50Ms,
        p95Ms,
        successRate,
        expiresAt: expiresAt.toISOString(),
        assurance: 'self-hosted-benchmark-not-model-attestation' as const,
      };
    });
    return certification;
  });

  app.get('/api/runner/capacity', runnerRouteOptions, async (request) => {
    const query = capacityQuerySchema.parse(request.query);
    const principal = request.runnerPrincipal!;
    const result = await app.db.query<{
      id: string;
      node_id: string;
      adapter: AgentAdapter;
      model: string;
      certified_concurrency: number;
      p50_ms: number;
      p95_ms: number;
      success_rate: number;
      expires_at: Date;
    }>(
      `SELECT c.id, c.node_id, c.adapter, c.model, c.certified_concurrency, c.p50_ms, c.p95_ms,
              c.success_rate, c.expires_at
       FROM runner_certifications c JOIN runner_nodes n ON n.id = c.node_id
       WHERE n.credential_id = $1
         AND ($2::text IS NULL OR c.adapter = $2)
         AND ($3::text IS NULL OR c.model = $3)
         AND ($4::uuid IS NULL OR c.node_id = $4)
       ORDER BY c.expires_at DESC`,
      [principal.credentialId, query.adapter ?? null, query.model ?? null, query.nodeId ?? null],
    );
    const summaries = result.rows.map((row) => ({
      id: row.id,
      certificationId: row.id,
      nodeId: row.node_id,
      adapter: row.adapter,
      model: row.model,
      certified: row.certified_concurrency > 0 && row.expires_at.getTime() > Date.now(),
      certifiedConcurrency: row.certified_concurrency,
      p50Ms: row.p50_ms,
      p95Ms: row.p95_ms,
      successRate: row.success_rate,
      expiresAt: row.expires_at.toISOString(),
      valid: row.expires_at.getTime() > Date.now(),
      assurance: 'self-hosted-benchmark-not-model-attestation' as const,
    }));
    if (!query.adapter || !query.model) return summaries;
    invariant(summaries[0], 404, 'CERTIFICATION_NOT_FOUND', 'No certification found');
    return summaries[0];
  });

  app.post(
    '/api/runners/:nodeId/claims',
    { preHandler: ownerAuth(app, 'pools:write') },
    async (request, reply) => {
      const { nodeId } = z.object({ nodeId: z.string().uuid() }).parse(request.params);
      const input = z
        .object({
          poolId: z.string().uuid(),
          maxUnits: z.number().int().min(1).max(CLAIM_UNIT_MAX),
        })
        .parse(request.body);
      const claim = await createOwnerBoundClaim(app, request.authUser!.id, {
        nodeId,
        poolId: input.poolId,
        maxUnits: input.maxUnits,
      });
      return reply.code(201).send({
        claim,
        executeCommand:
          claim.deliveryMode === 'webhook'
            ? `agentpool claim --claim ${claim.id} --allow-webhooks`
            : `agentpool claim --claim ${claim.id}`,
      });
    },
  );

  app.get('/api/runners', { preHandler: ownerAuth(app, 'runners:read') }, async (request) => {
    const nodes = await app.db.query<{
      id: string;
      name: string;
      platform: string | null;
      runner_version: string | null;
      status: string;
      max_concurrency: number;
      supports_direct_webhooks: boolean;
      operator_type: 'community' | 'official';
      last_seen_at: Date;
      active_leases: string;
      completed_today: string;
      earned_today: string;
      certifications: Array<{
        adapter: string;
        model: string;
        certifiedConcurrency: number;
        p50Ms: number;
        p95Ms: number;
        successRate: number;
        expiresAt: string;
      }>;
      active_jobs: Array<{
        stage: string;
        progress: number;
        reward: number;
      }>;
    }>(
      `SELECT n.id, n.name, n.platform, n.runner_version, n.status, n.max_concurrency,
              n.supports_direct_webhooks, credential.operator_type,
              n.last_seen_at,
              (SELECT count(*) FROM task_units active
               WHERE active.leased_runner_id = n.id AND active.status = 'leased'
                 AND active.lease_expires_at > now()) AS active_leases,
              (SELECT count(*) FROM task_units done
               WHERE done.leased_runner_id = n.id AND done.status = 'accepted'
                 AND done.accepted_at >= date_trunc('day', now())) AS completed_today,
              (SELECT COALESCE(sum(s.amount), 0) FROM settlements s
               JOIN task_units settled ON settled.id = s.unit_id
               WHERE settled.leased_runner_id = n.id
                 AND s.created_at >= date_trunc('day', now())) AS earned_today,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'adapter', c.adapter, 'model', c.model,
                'certifiedConcurrency', c.certified_concurrency,
                'p50Ms', c.p50_ms, 'p95Ms', c.p95_ms,
                'successRate', c.success_rate, 'expiresAt', c.expires_at
              ) ORDER BY c.expires_at DESC) FROM runner_certifications c
               WHERE c.node_id = n.id), '[]'::jsonb) AS certifications,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'stage', active.stage, 'progress', active.progress,
                'reward', p.reward_per_unit
              ) ORDER BY active.updated_at DESC) FROM task_units active
               JOIN pools p ON p.id = active.pool_id
               WHERE active.leased_runner_id = n.id AND active.status = 'leased'
                 AND active.lease_expires_at > now()), '[]'::jsonb) AS active_jobs
       FROM runner_nodes n
       JOIN runner_credentials credential ON credential.id = n.credential_id
       WHERE n.owner_id = $1 AND credential.revoked_at IS NULL
       ORDER BY n.created_at DESC`,
      [request.authUser!.id],
    );
    return {
      nodes: nodes.rows.map((node) => ({
        id: node.id,
        name: node.name,
        platform: node.platform,
        runnerVersion: node.runner_version,
        status: node.status,
        maxConcurrency: node.max_concurrency,
        supportsDirectWebhooks: node.supports_direct_webhooks,
        operatorType: node.operator_type,
        activeLeases: safeInteger(node.active_leases),
        completedToday: safeInteger(node.completed_today),
        earnedToday: safeInteger(node.earned_today),
        certifications: node.certifications,
        activeJobs: node.active_jobs,
        lastSeenAt: node.last_seen_at.toISOString(),
      })),
      privacyBoundary: {
        taskInstructionsVisible: false,
        taskInputsVisible: false,
        taskResultsVisible: false,
        visibleTelemetry: ['stage', 'progress', 'reward', 'status'],
      },
    };
  });
}

async function loadRunnerNodes(app: App, credentialId: string, nodeId?: string) {
  const result = await app.db.query<{
    id: string;
    name: string;
    platform: string | null;
    runner_version: string | null;
    status: string;
    max_concurrency: number;
    supports_direct_webhooks: boolean;
    operator_type: 'community' | 'official';
    last_seen_at: Date;
    adapters: Array<{ adapter: string; supportedModels: string[]; version?: string }>;
  }>(
    `SELECT n.id, n.name, n.platform, n.runner_version, n.status, n.max_concurrency,
            n.supports_direct_webhooks, credential.operator_type,
            n.last_seen_at,
            COALESCE(jsonb_agg(jsonb_build_object(
              'adapter', c.adapter, 'supportedModels', c.supported_models, 'version', c.version
            )) FILTER (WHERE c.adapter IS NOT NULL), '[]'::jsonb) AS adapters
     FROM runner_nodes n
     JOIN runner_credentials credential ON credential.id = n.credential_id
     LEFT JOIN runner_capabilities c ON c.node_id = n.id
     WHERE n.credential_id = $1 AND ($2::uuid IS NULL OR n.id = $2)
     GROUP BY n.id, credential.operator_type ORDER BY n.created_at DESC`,
    [credentialId, nodeId ?? null],
  );
  return result.rows.map((node) => ({
    id: node.id,
    name: node.name,
    platform: node.platform,
    runnerVersion: node.runner_version,
    status: node.status,
    maxConcurrency: node.max_concurrency,
    supportsDirectWebhooks: node.supports_direct_webhooks,
    operatorType: node.operator_type,
    lastSeenAt: node.last_seen_at.toISOString(),
    adapters: node.adapters,
  }));
}

async function loadFleetModeForCredential(
  db: Pick<import('../db.js').DbClient, 'query'>,
  principal: import('../types.js').RunnerPrincipal,
): Promise<OfficialFleetMode | null> {
  if (principal.operatorType === 'community') return null;
  const result = await db.query<{ mode: OfficialFleetMode }>(
    `SELECT mode FROM official_fleets WHERE owner_id = $1 FOR SHARE`,
    [principal.ownerId],
  );
  const fleet = result.rows[0];
  invariant(
    fleet,
    403,
    'OFFICIAL_FLEET_BINDING_REQUIRED',
    'Official runner credential is not attached to an active fleet owner',
  );
  return fleet.mode;
}

type LeaseRow = {
  unit_id: string;
  pool_id: string;
  publisher_id: string;
  credential_id: string;
  status: string;
  lease_expires_at: Date;
  stage: string | null;
  progress: number;
  expected_output_ciphertext: string | null;
  dataset_url_ciphertext: string | null;
  answers_url_ciphertext: string | null;
  input_sha256: string | null;
  source_offset: string | null;
  source_length: number | null;
  answer_sha256: string | null;
  answer_offset: string | null;
  answer_length: number | null;
  output_schema: Record<string, unknown> | null;
  validation_mode: string;
  attempt_count: number;
  max_attempts: number;
  deadline_at: Date;
  pool_status: string;
  reward_per_unit: string;
  title: string;
  public_summary: string;
  secret_instruction_ciphertext: string;
  task_capsule_ciphertext: string | null;
  contract_hash: string | null;
  delivery_mode: 'platform' | 'webhook';
  delivery_config_ciphertext: string | null;
  legacy_contract: boolean;
};

async function loadLeaseForUpdate(
  client: Parameters<typeof withTransaction>[1] extends (client: infer C) => unknown ? C : never,
  leaseId: string,
) {
  const typedClient = client as import('../db.js').DbClient;
  return typedClient.query<LeaseRow>(
    `SELECT u.id AS unit_id, u.pool_id, p.owner_id AS publisher_id, n.credential_id,
            u.status, u.lease_expires_at, u.stage, u.progress, u.expected_output_ciphertext,
            p.dataset_url_ciphertext, p.answers_url_ciphertext, u.input_sha256,
            u.source_offset, u.source_length, u.answer_sha256, u.answer_offset, u.answer_length,
            p.output_schema, p.validation_mode, u.attempt_count, p.max_attempts,
            p.deadline_at, p.status AS pool_status, p.reward_per_unit, p.title,
            p.public_summary, p.secret_instruction_ciphertext, p.task_capsule_ciphertext,
            p.contract_hash, p.delivery_mode, p.delivery_config_ciphertext, p.legacy_contract
     FROM task_units u JOIN pools p ON p.id = u.pool_id
     JOIN runner_nodes n ON n.id = u.leased_runner_id
     WHERE u.lease_id = $1 FOR UPDATE OF u, p`,
    [leaseId],
  );
}

async function resolveExpectedOutput(app: App, row: LeaseRow): Promise<unknown> {
  if (row.expected_output_ciphertext) {
    return decryptJson(row.expected_output_ciphertext, app.config.encryptionKey);
  }
  if (
    row.answers_url_ciphertext &&
    row.answer_sha256 &&
    row.answer_offset !== null &&
    row.answer_length
  ) {
    return fetchDatasetExpected(
      decryptJson<string>(row.answers_url_ciphertext, app.config.encryptionKey),
      {
        sourceOffset: safeInteger(row.answer_offset),
        sourceLength: row.answer_length,
        expectedSha256: row.answer_sha256,
      },
      app.datasetFetch,
    );
  }
  if (
    row.dataset_url_ciphertext &&
    row.input_sha256 &&
    row.source_offset !== null &&
    row.source_length
  ) {
    const line = await fetchDatasetUnitLine(
      decryptJson<string>(row.dataset_url_ciphertext, app.config.encryptionKey),
      {
        sourceOffset: safeInteger(row.source_offset),
        sourceLength: row.source_length,
        inputSha256: row.input_sha256,
      },
      app.datasetFetch,
    );
    return line.expectedOutput;
  }
  return undefined;
}

async function recordSubmissionEvents(
  client: import('../db.js').DbClient,
  row: LeaseRow,
  runnerOwnerId: string,
  status: string,
) {
  await recordEvent(client, row.publisher_id, 'unit.updated', {
    poolId: row.pool_id,
    unitId: row.unit_id,
    status,
  });
  await recordEvent(client, runnerOwnerId, 'unit.updated', {
    unitId: row.unit_id,
    status,
    reward: status === 'accepted' ? safeInteger(row.reward_per_unit) : 0,
  });
}

async function storePlatformSubmission<T extends Record<string, unknown>>(
  client: import('../db.js').DbClient,
  input: {
    leaseId: string;
    unitId: string;
    credentialId: string;
    resultDigest: string;
    outcome: T;
  },
): Promise<T> {
  await client.query(
    `INSERT INTO lease_submissions
       (lease_id, unit_id, credential_id, result_digest, outcome)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.leaseId,
      input.unitId,
      input.credentialId,
      input.resultDigest,
      JSON.stringify(input.outcome),
    ],
  );
  return input.outcome;
}

function buildAttemptFeedback(
  unit: {
    attempt_count: number;
    validation: Record<string, unknown> | null;
    failure_reason: string | null;
    feedback_reason_ciphertext: string | null;
    feedback_attempt: number | null;
  },
  encryptionKey: Buffer,
) {
  if (unit.attempt_count < 1) return undefined;
  const validationErrors = Array.isArray(unit.validation?.errors)
    ? unit.validation.errors
        .map((error) =>
          error && typeof error === 'object' && 'message' in error ? String(error.message) : '',
        )
        .filter(Boolean)
    : [];
  const reason = unit.feedback_reason_ciphertext
    ? decryptJson<string>(unit.feedback_reason_ciphertext, encryptionKey)
    : validationErrors.join('; ') || unit.failure_reason;
  if (!reason && !unit.validation) return undefined;
  return {
    attempt: unit.feedback_attempt ?? unit.attempt_count,
    reason: reason ?? 'Previous attempt did not satisfy the task contract',
    ...(unit.validation ? { validation: unit.validation } : {}),
  };
}

function makeChallenge(): StoredChallenge {
  const text = randomBytes(18).toString('base64url');
  const nonce = randomBytes(8).toString('hex');
  return {
    leaseId: randomUUID(),
    instruction:
      'Return only a JSON object with reversed (Unicode characters reversed), uppercase, grouped (split text into groups of 3 joined by hyphens), and length (JavaScript string length). The nonce is only a challenge identifier and must not appear in the output.',
    input: { text, nonce },
    expected: {
      reversed: [...text].reverse().join(''),
      uppercase: text.toUpperCase(),
      grouped: text.match(/.{1,3}/g)?.join('-') ?? text,
      length: text.length,
    },
  };
}

async function hasActiveNodeWork(
  db: Pick<import('../db.js').DbClient, 'query'>,
  nodeId: string,
): Promise<boolean> {
  const result = await db.query<{ active: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM task_units
         WHERE leased_runner_id = $1 AND status = 'leased' AND lease_expires_at > now()
       ) OR EXISTS (
         SELECT 1 FROM runner_claim_grants
         WHERE node_id = $1 AND revoked_at IS NULL AND expires_at > now()
           AND claimed_units < max_units
       )
     ) AS active`,
    [nodeId],
  );
  return result.rows[0]?.active ?? false;
}

function sameCapabilityProfile(
  current: ReadonlyArray<{ adapter: string; supportedModels: readonly string[] }>,
  incoming: ReadonlyArray<{ adapter: string; supportedModels: readonly string[] }>,
): boolean {
  return (
    JSON.stringify(canonicalCapabilityProfile(current)) ===
    JSON.stringify(canonicalCapabilityProfile(incoming))
  );
}

function canonicalCapabilityProfile(
  capabilities: ReadonlyArray<{ adapter: string; supportedModels: readonly string[] }>,
): Array<[string, string[]]> {
  return capabilities
    .map((capability): [string, string[]] => [
      capability.adapter,
      [...new Set(capability.supportedModels)].sort(),
    ])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function normalizeNodeInput(raw: unknown): z.infer<typeof nodeSchema> {
  const flat = flatNodeSchema.safeParse(raw);
  if (flat.success) {
    const value = flat.data;
    const models = [...new Set(value.models)].sort();
    const identityDigest = createHash('sha256')
      .update(JSON.stringify([value.platform, value.arch, value.adapter, models]))
      .digest('hex')
      .slice(0, 16);
    const readablePrefix = `${value.platform}-${value.arch}-${value.adapter}`
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .slice(0, 83);
    return {
      // Legacy flat registration has no explicit node name. Bind its stable
      // identity to the exact canonical model set so one Cell cannot overwrite
      // another Cell's capability/certification during claim setup.
      name: `${readablePrefix}-${identityDigest}`,
      platform: `${value.platform}/${value.arch}`,
      runnerVersion: value.clientVersion,
      maxConcurrency: value.concurrency,
      supportsDirectWebhooks: value.supportsDirectWebhooks,
      adapters: [
        {
          adapter: value.adapter,
          supportedModels: models,
          version: value.adapterVersion,
        },
      ],
    };
  }
  return nodeSchema.parse(raw);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function runnerBearerTokenHash(request: FastifyRequest): string | undefined {
  const match = /^Bearer\s+(ap_runner_[A-Za-z0-9_-]+)$/i.exec(request.headers.authorization ?? '');
  return match?.[1] ? hashOpaqueToken(match[1]) : undefined;
}

function isTrustedRunnerToken(trusted: Map<string, number>, tokenHash: string): boolean {
  const trustedUntil = trusted.get(tokenHash);
  if (!trustedUntil) return false;
  if (trustedUntil <= Date.now()) {
    trusted.delete(tokenHash);
    return false;
  }
  return true;
}

function rememberTrustedRunnerToken(trusted: Map<string, number>, tokenHash: string): void {
  trusted.delete(tokenHash);
  if (trusted.size >= MAX_TRUSTED_RUNNER_TOKENS) {
    const oldest = trusted.keys().next().value as string | undefined;
    if (oldest) trusted.delete(oldest);
  }
  trusted.set(tokenHash, Date.now() + TRUSTED_RUNNER_TOKEN_TTL_MS);
}
