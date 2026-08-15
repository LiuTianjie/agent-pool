import { randomUUID } from 'node:crypto';

import { createPoolSchema, type CreatePoolInput, type TaskCapsule } from '@agent-pool/shared';
import { z } from 'zod';

import { ownerAuth } from '../auth.js';
import { decryptJson, encryptJson } from '../crypto.js';
import { indexHttpsDataset } from '../dataset-index.js';
import { safeInteger } from '../db.js';
import { ApiError, invariant } from '../errors.js';
import { withIdempotentTransaction } from '../idempotency.js';
import {
  getWallet,
  completePoolIfFinished,
  insertLedger,
  mapPoolSummary,
  POOL_SUMMARY_SELECT,
  quoteCapacity,
  recordEvent,
  refundLockedUnits,
  settleAcceptedUnit,
  terminateActiveClaimsForPool,
} from '../services.js';
import type { App } from '../types.js';
import { validateOutputSchemaDefinition } from '../validation.js';
import {
  contractHash,
  contractHashFromPoolRow,
  normalizeTaskCapsule,
  renderTaskInstruction,
  taskCapsuleFromPoolRow,
  validateTaskContractInput,
  type StoredDeliveryConfig,
} from '../task-contract.js';

const createPoolRequestSchema = createPoolSchema
  .and(z.object({ maxAttempts: z.number().int().min(1).max(10).default(3) }))
  .superRefine((value, context) => {
    const schema = value.taskCapsule?.delivery.schema ?? value.outputSchema;
    if (schema) {
      for (const message of validateOutputSchemaDefinition(schema)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['outputSchema'],
          message,
        });
      }
    }
    if (value.dataset.mode === 'inline') {
      if (value.requiredConcurrency > (value.units?.length ?? 0)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredConcurrency'],
          message: 'requiredConcurrency cannot exceed the number of units',
        });
      }
      value.units?.forEach((unit, index) => {
        if (!Object.prototype.hasOwnProperty.call(unit, 'input') || unit.input === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['units', index, 'input'],
            message: 'input is required and must be JSON-serializable',
          });
        }
      });
    }
    if (new Date(value.deadlineAt).getTime() <= Date.now() + 10_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deadlineAt'],
        message: 'deadlineAt must be at least 10 seconds in the future',
      });
    }
  });

const idParamsSchema = z.object({ id: z.string().uuid() });
const unitParamsSchema = z.object({ id: z.string().uuid(), unitId: z.string().uuid() });
const listQuerySchema = z.object({
  status: z
    .enum(['piloting', 'waiting_capacity', 'queued', 'running', 'paused', 'completed', 'cancelled'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const resultsQuerySchema = z.object({
  status: z.enum(['submitted', 'accepted', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(20_000).default(0),
});
const reviewSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  retry: z.boolean().default(false),
  reason: z.string().trim().max(500).optional(),
});

export async function registerPoolRoutes(app: App): Promise<void> {
  app.post(
    '/api/pools/validate',
    { preHandler: ownerAuth(app, 'pools:write'), bodyLimit: 25 * 1024 * 1024 },
    async (request) => {
      const input = createPoolRequestSchema.parse(request.body);
      const resolved = await resolvePublishUnits(app, input);
      const taskCapsule = normalizeTaskCapsule(input);
      validateTaskContractInput(input, taskCapsule, resolved.units);
      const totalCost = resolved.units.length * input.rewardPerUnit;
      invariant(
        Number.isSafeInteger(totalCost),
        400,
        'COST_TOO_LARGE',
        'Pool cost exceeds supported range',
      );
      const capacityQuote = await quoteCapacity(app.db, {
        adapter: input.requestedAgent,
        model: input.requestedModel,
        unitCount: resolved.units.length,
        requiredConcurrency: input.requiredConcurrency,
        maxUnitSeconds: input.maxUnitSeconds,
        deadlineAt: new Date(input.deadlineAt),
        deliveryMode: input.deliveryTarget.mode,
      });
      return {
        valid: true,
        taskCapsule,
        contractHash: contractHash(taskCapsule),
        totalUnits: resolved.units.length,
        totalCost,
        dataset: resolved.dataset,
        capacityQuote,
        defaults: {
          maxAttempts: input.maxAttempts,
          validationMode: input.validationMode,
          deliveryMode: input.deliveryTarget.mode,
          launchMode: input.launchMode,
          pilotUnits:
            input.launchMode === 'pilot' ? Math.min(input.pilotUnits, resolved.units.length) : 0,
        },
      };
    },
  );

  app.post(
    '/api/pools',
    { preHandler: ownerAuth(app, 'pools:write'), bodyLimit: 25 * 1024 * 1024 },
    async (request, reply) => {
      const ownerId = request.authUser!.id;
      const input = createPoolRequestSchema.parse(request.body);
      const resolved = await resolvePublishUnits(app, input);
      const units = resolved.units;
      const capsule = normalizeTaskCapsule(input);
      validateTaskContractInput(input, capsule, units);
      const response = await withIdempotentTransaction(
        app.db,
        request,
        app.config.encryptionKey,
        ownerId,
        'pools.create',
        async (client) => {
          const poolId = randomUUID();
          const taskContractHash = contractHash(capsule);
          const pilotUnits =
            input.launchMode === 'pilot' ? Math.min(input.pilotUnits, units.length) : 0;
          const pilotOrdinals = spreadPilotOrdinals(units.length, pilotUnits);
          const totalCost = units.length * input.rewardPerUnit;
          invariant(
            Number.isSafeInteger(totalCost),
            400,
            'COST_TOO_LARGE',
            'Pool cost exceeds supported range',
          );
          const deadline = new Date(input.deadlineAt);
          // Capacity is a quote, never a dispatch gate. Work only moves when a Runner
          // explicitly creates a scoped claim and polls it.
          const status = input.launchMode === 'pilot' ? 'piloting' : 'queued';
          const quote = await quoteCapacity(client, {
            adapter: input.requestedAgent,
            model: input.requestedModel,
            unitCount: units.length,
            requiredConcurrency: input.requiredConcurrency,
            maxUnitSeconds: input.maxUnitSeconds,
            deadlineAt: deadline,
            deliveryMode: input.deliveryTarget.mode,
          });
          const walletResult = await client.query<{ purchased_available: string }>(
            'SELECT purchased_available FROM wallets WHERE user_id = $1 FOR UPDATE',
            [ownerId],
          );
          const available = safeInteger(walletResult.rows[0]?.purchased_available ?? 0);
          invariant(
            available >= totalCost,
            402,
            'INSUFFICIENT_CREDITS',
            'Not enough purchased credits',
            {
              required: totalCost,
              available,
            },
          );
          await client.query(
            `UPDATE wallets
           SET purchased_available = purchased_available - $2,
               purchased_locked = purchased_locked + $2,
               updated_at = now()
           WHERE user_id = $1`,
            [ownerId, totalCost],
          );
          await insertLedger(
            client,
            ownerId,
            'purchased_available',
            -totalCost,
            'pool_lock',
            'pool',
            poolId,
          );
          await insertLedger(
            client,
            ownerId,
            'purchased_locked',
            totalCost,
            'pool_lock',
            'pool',
            poolId,
          );

          await client.query(
            `INSERT INTO pools (
             id, owner_id, title, category, requested_agent, requested_model,
             public_summary, secret_instruction_ciphertext, reward_per_unit,
             validation_mode, output_schema, max_attempts, required_concurrency,
             max_unit_seconds, deadline_at, total_units, status,
             task_capsule_ciphertext, contract_hash, delivery_mode,
             delivery_config_ciphertext, launch_mode, pilot_units, legacy_contract,
             dataset_mode, dataset_host, dataset_url_ciphertext
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
           )`,
            [
              poolId,
              ownerId,
              input.title,
              input.category,
              input.requestedAgent,
              input.requestedModel,
              input.publicSummary,
              encryptJson(renderTaskInstruction(capsule), app.config.encryptionKey),
              input.rewardPerUnit,
              capsule.acceptance.mode === 'manual' ? 'manual' : 'auto',
              !input.taskCapsule && capsule.delivery.schema
                ? JSON.stringify(capsule.delivery.schema)
                : null,
              input.maxAttempts,
              input.requiredConcurrency,
              input.maxUnitSeconds,
              deadline,
              units.length,
              status,
              encryptJson(capsule, app.config.encryptionKey),
              taskContractHash,
              input.deliveryTarget.mode,
              input.deliveryTarget.mode === 'webhook'
                ? encryptJson(
                    {
                      url: input.deliveryTarget.url,
                      receiptSecret: input.deliveryTarget.receiptSecret,
                    } satisfies StoredDeliveryConfig,
                    app.config.encryptionKey,
                  )
                : null,
              input.launchMode,
              pilotUnits,
              !input.taskCapsule,
              resolved.dataset.mode,
              resolved.dataset.mode === 'https' ? resolved.dataset.host : null,
              resolved.dataset.mode === 'https'
                ? encryptJson(resolved.dataset.url, app.config.encryptionKey)
                : null,
            ],
          );

          const chunkSize = 500;
          const storeInlineInput = resolved.dataset.mode === 'inline';
          for (let start = 0; start < units.length; start += chunkSize) {
            const chunk = units.slice(start, start + chunkSize);
            await client.query(
              `INSERT INTO task_units
               (id, pool_id, ordinal, label_ciphertext, input_ciphertext,
                expected_output_ciphertext, status, is_pilot,
                input_sha256, source_offset, source_length)
             SELECT * FROM unnest(
               $1::uuid[], $2::uuid[], $3::int[], $4::text[], $5::text[], $6::text[],
               $7::text[], $8::boolean[], $9::text[], $10::bigint[], $11::int[]
             )`,
              [
                chunk.map(() => randomUUID()),
                chunk.map(() => poolId),
                chunk.map((_, index) => start + index),
                chunk.map((unit) =>
                  unit.label === undefined
                    ? null
                    : encryptJson(unit.label, app.config.encryptionKey),
                ),
                chunk.map((unit) =>
                  storeInlineInput ? encryptJson(unit.input, app.config.encryptionKey) : null,
                ),
                chunk.map((unit) =>
                  unit.expectedOutput === undefined
                    ? null
                    : encryptJson(unit.expectedOutput, app.config.encryptionKey),
                ),
                chunk.map((_, index) =>
                  input.launchMode === 'pilot' && !pilotOrdinals.has(start + index)
                    ? 'held'
                    : 'queued',
                ),
                chunk.map((_, index) => pilotOrdinals.has(start + index)),
                chunk.map((unit) => unit.inputSha256 ?? null),
                chunk.map((unit) => unit.sourceOffset ?? null),
                chunk.map((unit) => unit.sourceLength ?? null),
              ],
            );
          }
          await recordEvent(client, ownerId, 'pool.updated', { poolId, status });
          await recordEvent(client, ownerId, 'wallet.updated', { poolId, locked: totalCost });
          return {
            status: 201,
            body: {
              pool: await getOwnedPoolSummary(app, poolId, ownerId, client),
              capacityQuote: quote,
              wallet: await getWallet(client, ownerId),
            },
          };
        },
      );
      if (response.replayed) reply.header('Idempotency-Replayed', 'true');
      return reply.code(response.status).send(response.body);
    },
  );

  app.get('/api/pools', { preHandler: ownerAuth(app, 'pools:read') }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const result = await app.db.query(
      `${POOL_SUMMARY_SELECT}
       WHERE p.owner_id = $1 AND ($2::text IS NULL OR p.status = $2)
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT $3 OFFSET $4`,
      [request.authUser!.id, query.status ?? null, query.limit, query.offset],
    );
    const count = await app.db.query<{ count: string }>(
      `SELECT count(*) FROM pools WHERE owner_id = $1 AND ($2::text IS NULL OR status = $2)`,
      [request.authUser!.id, query.status ?? null],
    );
    return {
      pools: result.rows.map((row) => mapOwnedPool(row as Record<string, unknown>, app)),
      total: safeInteger(count.rows[0]?.count ?? 0),
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.get('/api/pools/:id', { preHandler: ownerAuth(app, 'pools:read') }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const result = await app.db.query(
      `${POOL_SUMMARY_SELECT} WHERE p.id = $1 AND p.owner_id = $2 GROUP BY p.id`,
      [id, request.authUser!.id],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    invariant(row, 404, 'POOL_NOT_FOUND', 'Pool not found');
    return {
      pool: {
        ...mapOwnedPool(row, app),
        secretInstruction: decryptJson<string>(
          String(row.secret_instruction_ciphertext),
          app.config.encryptionKey,
        ),
        validationMode: row.validation_mode,
        outputSchema: row.output_schema,
        maxAttempts: row.max_attempts,
        updatedAt: new Date(String(row.updated_at)).toISOString(),
      },
    };
  });

  app.post(
    '/api/pools/:id/launch',
    { preHandler: ownerAuth(app, 'pools:write') },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const response = await withIdempotentTransaction(
        app.db,
        request,
        app.config.encryptionKey,
        request.authUser!.id,
        'pools.launch',
        async (client) => {
          const poolResult = await client.query<{
            owner_id: string;
            status: string;
            requested_agent: string;
            requested_model: string;
            required_concurrency: number;
            max_unit_seconds: number;
            deadline_at: Date;
            delivery_mode: 'platform' | 'webhook';
          }>(
            `SELECT owner_id, status, requested_agent, requested_model, required_concurrency,
                max_unit_seconds, deadline_at, delivery_mode
         FROM pools WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const pool = poolResult.rows[0];
          invariant(
            pool && pool.owner_id === request.authUser!.id,
            404,
            'POOL_NOT_FOUND',
            'Pool not found',
          );
          invariant(pool.status === 'piloting', 409, 'POOL_NOT_PILOTING', 'Pool is not piloting');
          invariant(
            pool.deadline_at.getTime() > Date.now(),
            409,
            'POOL_DEADLINE_PASSED',
            'Pool deadline has passed',
          );
          const pilot = await client.query<{
            total: string;
            accepted: string;
          }>(
            `SELECT count(*)::bigint AS total,
                count(*) FILTER (WHERE status = 'accepted')::bigint AS accepted
         FROM task_units WHERE pool_id = $1 AND is_pilot`,
            [id],
          );
          const pilotTotal = safeInteger(pilot.rows[0]?.total ?? 0);
          const pilotAccepted = safeInteger(pilot.rows[0]?.accepted ?? 0);
          invariant(
            pilotTotal > 0 && pilotAccepted === pilotTotal,
            409,
            'PILOT_NOT_ACCEPTED',
            'Every pilot unit must be accepted before launch',
            { pilotUnits: pilotTotal, acceptedPilotUnits: pilotAccepted },
          );
          const held = await client.query<{ count: string }>(
            `SELECT count(*) FROM task_units WHERE pool_id = $1 AND status = 'held'`,
            [id],
          );
          const heldUnits = safeInteger(held.rows[0]?.count ?? 0);
          let capacityQuote = null;
          let nextStatus: 'queued' | 'completed' = 'completed';
          if (heldUnits > 0) {
            capacityQuote = await quoteCapacity(client, {
              adapter: pool.requested_agent,
              model: pool.requested_model,
              unitCount: heldUnits,
              requiredConcurrency: Math.min(pool.required_concurrency, heldUnits),
              maxUnitSeconds: pool.max_unit_seconds,
              deadlineAt: pool.deadline_at,
              deliveryMode: pool.delivery_mode,
            });
            nextStatus = 'queued';
            await client.query(
              `UPDATE task_units SET status = 'queued', updated_at = now()
           WHERE pool_id = $1 AND status = 'held'`,
              [id],
            );
          }
          await client.query(`UPDATE pools SET status = $2, updated_at = now() WHERE id = $1`, [
            id,
            nextStatus,
          ]);
          await recordEvent(client, pool.owner_id, 'pool.updated', {
            poolId: id,
            status: nextStatus,
            releasedUnits: heldUnits,
          });
          return {
            status: 200,
            body: {
              capacityQuote,
              releasedUnits: heldUnits,
              pool: await getOwnedPoolSummary(app, id, request.authUser!.id, client),
              wallet: await getWallet(client, request.authUser!.id),
            },
          };
        },
      );
      if (response.replayed) reply.header('Idempotency-Replayed', 'true');
      return reply.code(response.status).send(response.body);
    },
  );

  app.post(
    '/api/pools/:id/cancel',
    { preHandler: ownerAuth(app, 'pools:write') },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const response = await withIdempotentTransaction(
        app.db,
        request,
        app.config.encryptionKey,
        request.authUser!.id,
        'pools.cancel',
        async (client) => {
          const poolResult = await client.query<{
            owner_id: string;
            status: string;
            reward_per_unit: string;
          }>('SELECT owner_id, status, reward_per_unit FROM pools WHERE id = $1 FOR UPDATE', [id]);
          const pool = poolResult.rows[0];
          invariant(
            pool && pool.owner_id === request.authUser!.id,
            404,
            'POOL_NOT_FOUND',
            'Pool not found',
          );
          invariant(
            ['piloting', 'waiting_capacity', 'queued', 'running', 'paused'].includes(pool.status),
            409,
            'POOL_NOT_CANCELLABLE',
            'Pool is already final',
          );
          await client.query(
            `UPDATE pools SET status = 'cancelled', terminal_reason = 'cancelled_by_publisher',
            cancelled_at = now(), updated_at = now() WHERE id = $1`,
            [id],
          );
          await terminateActiveClaimsForPool(client, id);
          const cancelled = await client.query(
            `UPDATE task_units
         SET status = 'cancelled', lease_id = NULL,
             leased_runner_id = CASE WHEN status = 'submitted' THEN leased_runner_id ELSE NULL END,
             lease_expires_at = NULL, stage = NULL, updated_at = now()
         WHERE pool_id = $1 AND status IN ('held', 'queued', 'leased', 'submitted')`,
            [id],
          );
          const refunded = await refundLockedUnits(
            client,
            id,
            pool.owner_id,
            cancelled.rowCount ?? 0,
            safeInteger(pool.reward_per_unit),
          );
          await recordEvent(client, pool.owner_id, 'pool.updated', {
            poolId: id,
            status: 'cancelled',
          });
          return {
            status: 200,
            body: {
              refunded,
              pool: await getOwnedPoolSummary(app, id, request.authUser!.id, client),
              wallet: await getWallet(client, request.authUser!.id),
            },
          };
        },
      );
      if (response.replayed) reply.header('Idempotency-Replayed', 'true');
      return reply.code(response.status).send(response.body);
    },
  );

  app.get(
    '/api/pools/:id/results',
    { preHandler: ownerAuth(app, 'pools:read') },
    async (request) => {
      const { id } = idParamsSchema.parse(request.params);
      const query = resultsQuerySchema.parse(request.query);
      const owner = await app.db.query<Record<string, unknown>>(
        'SELECT * FROM pools WHERE id = $1 AND owner_id = $2',
        [id, request.authUser!.id],
      );
      const ownerPool = owner.rows[0];
      invariant(ownerPool, 404, 'POOL_NOT_FOUND', 'Pool not found');
      const result = await app.db.query<{
        id: string;
        ordinal: number;
        label_ciphertext: string | null;
        input_ciphertext: string | null;
        result_ciphertext: string | null;
        status: string;
        attempt_count: number;
        validation: unknown;
        failure_reason: string | null;
        submitted_at: Date | null;
        accepted_at: Date | null;
        is_pilot: boolean;
        receipt_id: string | null;
        result_sha256: string | null;
        receipt_decision: 'accepted' | 'rejected' | null;
        receipt_retryable: boolean | null;
        receipt_reason_ciphertext: string | null;
        receipt_attempt: number | null;
        receipt_created_at: Date | null;
      }>(
        `SELECT u.id, u.ordinal, u.label_ciphertext, u.input_ciphertext, u.result_ciphertext,
              u.status, u.attempt_count, u.validation, u.failure_reason, u.submitted_at,
              u.accepted_at, u.is_pilot, receipt.receipt_id, receipt.result_sha256,
              receipt.decision AS receipt_decision, receipt.retryable AS receipt_retryable,
              receipt.reason_ciphertext AS receipt_reason_ciphertext,
              receipt.attempt AS receipt_attempt, receipt.created_at AS receipt_created_at
       FROM task_units u
       LEFT JOIN LATERAL (
         SELECT * FROM webhook_receipts candidate
         WHERE candidate.unit_id = u.id ORDER BY candidate.attempt DESC LIMIT 1
       ) receipt ON true
       WHERE u.pool_id = $1 AND (
         (u.status IN ('submitted', 'accepted', 'failed') AND u.result_ciphertext IS NOT NULL)
         OR receipt.id IS NOT NULL
       )
         AND ($2::text IS NULL OR u.status = $2)
       ORDER BY u.ordinal LIMIT $3 OFFSET $4`,
        [id, query.status ?? null, query.limit, query.offset],
      );
      const count = await app.db.query<{ count: string }>(
        `SELECT count(*) FROM task_units u
       WHERE u.pool_id = $1 AND (
         (u.status IN ('submitted', 'accepted', 'failed') AND u.result_ciphertext IS NOT NULL)
         OR EXISTS (
           SELECT 1 FROM webhook_receipts receipt WHERE receipt.unit_id = u.id
         )
       )
         AND ($2::text IS NULL OR u.status = $2)`,
        [id, query.status ?? null],
      );
      const taskCapsule = taskCapsuleFromPoolRow(ownerPool, app.config.encryptionKey);
      return {
        results: result.rows.map((row) => ({
          id: row.id,
          ordinal: row.ordinal,
          label: row.label_ciphertext
            ? decryptJson(row.label_ciphertext, app.config.encryptionKey)
            : undefined,
          input: row.input_ciphertext
            ? decryptJson(row.input_ciphertext, app.config.encryptionKey)
            : undefined,
          result: row.result_ciphertext
            ? decryptJson(row.result_ciphertext, app.config.encryptionKey)
            : undefined,
          status: row.status,
          attemptCount: row.attempt_count,
          validation: row.validation,
          failureReason: row.failure_reason,
          submittedAt: row.submitted_at?.toISOString() ?? null,
          acceptedAt: row.accepted_at?.toISOString() ?? null,
          isPilot: row.is_pilot,
          externalReceipt: row.receipt_id
            ? {
                receiptId: row.receipt_id,
                unitReference: row.label_ciphertext
                  ? decryptJson<string>(row.label_ciphertext, app.config.encryptionKey)
                  : undefined,
                resultSha256: row.result_sha256,
                decision: row.receipt_decision,
                retryable: row.receipt_retryable,
                reason: row.receipt_reason_ciphertext
                  ? decryptJson<string>(row.receipt_reason_ciphertext, app.config.encryptionKey)
                  : undefined,
                attempt: row.receipt_attempt,
                createdAt: row.receipt_created_at?.toISOString() ?? null,
              }
            : undefined,
        })),
        taskCapsule,
        contractHash: contractHashFromPoolRow(ownerPool),
        total: safeInteger(count.rows[0]?.count ?? 0),
        limit: query.limit,
        offset: query.offset,
      };
    },
  );

  app.post(
    '/api/pools/:id/units/:unitId/review',
    { preHandler: ownerAuth(app, 'pools:write') },
    async (request, reply) => {
      const { id, unitId } = unitParamsSchema.parse(request.params);
      const input = reviewSchema.parse(request.body);
      const response = await withIdempotentTransaction(
        app.db,
        request,
        app.config.encryptionKey,
        request.authUser!.id,
        'units.review',
        async (client) => {
          const result = await client.query<{
            owner_id: string;
            status: string;
            attempt_count: number;
            max_attempts: number;
            reward_per_unit: string;
            deadline_at: Date;
            pool_status: string;
            runner_owner_id: string;
          }>(
            `SELECT p.owner_id, u.status, u.attempt_count, p.max_attempts, p.reward_per_unit,
                  p.deadline_at, p.status AS pool_status, n.owner_id AS runner_owner_id
           FROM task_units u JOIN pools p ON p.id = u.pool_id
           JOIN runner_nodes n ON n.id = u.leased_runner_id
           WHERE u.id = $1 AND p.id = $2 FOR UPDATE OF u, p`,
            [unitId, id],
          );
          const row = result.rows[0];
          invariant(
            row && row.owner_id === request.authUser!.id,
            404,
            'UNIT_NOT_FOUND',
            'Unit not found',
          );
          invariant(
            row.status === 'submitted',
            409,
            'UNIT_NOT_REVIEWABLE',
            'Unit is not awaiting manual review',
          );

          let outcomeStatus: 'accepted' | 'queued' | 'failed';
          if (input.decision === 'accept') {
            await client.query(
              `UPDATE task_units SET status = 'accepted', stage = 'completed', progress = 100,
             accepted_at = now(), updated_at = now() WHERE id = $1`,
              [unitId],
            );
            await settleAcceptedUnit(client, unitId);
            outcomeStatus = 'accepted';
          } else if (
            input.retry &&
            row.attempt_count < row.max_attempts &&
            new Date(row.deadline_at).getTime() > Date.now() &&
            ['piloting', 'queued', 'running'].includes(row.pool_status)
          ) {
            await client.query(
              `UPDATE task_units SET status = 'queued', lease_id = NULL, leased_runner_id = NULL,
             lease_expires_at = NULL, stage = NULL, progress = 0, result_ciphertext = NULL,
             submitted_at = NULL, failure_reason = $2,
             updated_at = now() WHERE id = $1`,
              [unitId, input.reason ?? 'publisher_requested_retry'],
            );
            outcomeStatus = 'queued';
          } else {
            await client.query(
              `UPDATE task_units SET status = 'failed', stage = 'failed', failure_reason = $2,
             lease_id = NULL, leased_runner_id = NULL, lease_expires_at = NULL,
             updated_at = now() WHERE id = $1`,
              [unitId, input.reason ?? 'publisher_rejected'],
            );
            await refundLockedUnits(client, id, row.owner_id, 1, safeInteger(row.reward_per_unit));
            await completePoolIfFinished(client, id, row.owner_id);
            outcomeStatus = 'failed';
          }
          await recordEvent(client, row.owner_id, 'unit.updated', {
            poolId: id,
            unitId,
            status: outcomeStatus,
          });
          await recordEvent(client, row.runner_owner_id, 'unit.updated', {
            unitId,
            status: outcomeStatus === 'queued' ? 'retrying' : outcomeStatus,
          });
          return { status: 200, body: { reviewed: true, status: outcomeStatus } };
        },
      );
      if (response.replayed) reply.header('Idempotency-Replayed', 'true');
      return reply.code(response.status).send(response.body);
    },
  );
}

async function getOwnedPoolSummary(
  app: App,
  id: string,
  ownerId: string,
  db: import('../services.js').Queryable = app.db,
) {
  const result = await db.query(
    `${POOL_SUMMARY_SELECT} WHERE p.id = $1 AND p.owner_id = $2 GROUP BY p.id`,
    [id, ownerId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError(404, 'POOL_NOT_FOUND', 'Pool not found');
  return mapOwnedPool(row, app);
}

function mapOwnedPool(row: Record<string, unknown>, app: App) {
  const taskCapsule = taskCapsuleFromPoolRow(row, app.config.encryptionKey);
  let deliveryTarget: { mode: 'platform' } | { mode: 'webhook'; url: string } = {
    mode: 'platform',
  };
  if (row.delivery_mode === 'webhook' && typeof row.delivery_config_ciphertext === 'string') {
    const config = decryptJson<StoredDeliveryConfig>(
      row.delivery_config_ciphertext,
      app.config.encryptionKey,
    );
    deliveryTarget = { mode: 'webhook', url: config.url };
  }
  return {
    ...mapPoolSummary(row),
    taskCapsule,
    contractHash: contractHashFromPoolRow(row),
    deliveryTarget,
    launchMode: row.launch_mode === 'pilot' ? 'pilot' : 'immediate',
  };
}

type PublishUnit = {
  label?: string;
  input: unknown;
  expectedOutput?: unknown;
  inputSha256?: string;
  sourceOffset?: number;
  sourceLength?: number;
};

async function resolvePublishUnits(
  app: App,
  input: CreatePoolInput,
): Promise<{
  units: PublishUnit[];
  dataset: { mode: 'inline' } | { mode: 'https'; url: string; host: string };
}> {
  if (input.dataset.mode !== 'https') {
    return {
      units: (input.units ?? []).map((unit) => ({
        label: unit.label,
        input: unit.input,
        expectedOutput: unit.expectedOutput,
      })),
      dataset: { mode: 'inline' },
    };
  }
  const indexed = await indexHttpsDataset(input.dataset.url, app.datasetFetch);
  invariant(
    input.requiredConcurrency <= indexed.units.length,
    400,
    'VALIDATION_ERROR',
    'requiredConcurrency cannot exceed the number of units',
  );
  return {
    units: indexed.units,
    dataset: { mode: 'https', url: input.dataset.url, host: indexed.host },
  };
}

function spreadPilotOrdinals(unitCount: number, pilotCount: number): Set<number> {
  if (pilotCount <= 0) return new Set();
  if (pilotCount === 1) return new Set([0]);
  if (pilotCount === 2) return new Set([0, unitCount - 1]);
  return new Set([0, Math.floor((unitCount - 1) / 2), unitCount - 1]);
}
