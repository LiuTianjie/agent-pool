import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ownerAuth } from '../auth.js';
import { safeInteger } from '../db.js';
import { ApiError } from '../errors.js';
import { withIdempotentTransaction } from '../idempotency.js';
import { getWallet, insertLedger, recordEvent } from '../services.js';
import type { App } from '../types.js';

const topupSchema = z.object({
  credits: z.number().int().min(1).max(10_000_000),
});
const withdrawalSchema = z.object({
  credits: z.number().int().min(1).max(10_000_000),
});

const ledgerQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function registerWalletRoutes(app: App): Promise<void> {
  app.get('/api/wallet', { preHandler: ownerAuth(app, 'wallet:read') }, async (request) => ({
    wallet: await getWallet(app.db, request.authUser!.id),
  }));

  app.get('/api/wallet/ledger', { preHandler: ownerAuth(app, 'wallet:read') }, async (request) => {
    const query = ledgerQuerySchema.parse(request.query);
    const result = await app.db.query<{
      id: string;
      bucket: string;
      delta: string;
      kind: string;
      reference_type: string | null;
      reference_id: string | null;
      created_at: Date;
    }>(
      `SELECT id, bucket, delta, kind, reference_type, reference_id, created_at
       FROM credit_ledger
       WHERE user_id = $1
         AND ($2::uuid IS NULL OR created_at < (SELECT created_at FROM credit_ledger WHERE id = $2))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [request.authUser!.id, query.before ?? null, query.limit],
    );
    return {
      entries: result.rows.map((row) => ({
        id: row.id,
        bucket: row.bucket,
        delta: safeInteger(row.delta),
        kind: row.kind,
        referenceType: row.reference_type,
        referenceId: row.reference_id,
        createdAt: row.created_at.toISOString(),
      })),
      nextCursor: result.rows.length === query.limit ? (result.rows.at(-1)?.id ?? null) : null,
    };
  });

  app.post(
    '/api/wallet/dev-topup',
    {
      preHandler: ownerAuth(app, 'wallet:write'),
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      if (!app.config.allowDevTopup) {
        throw new ApiError(404, 'NOT_FOUND', 'Route not found');
      }
      const input = topupSchema.parse(request.body);
      const response = await withIdempotentTransaction(
        app.db,
        request,
        app.config.encryptionKey,
        request.authUser!.id,
        'wallet.devTopup',
        async (client) => {
          await client.query(
            `UPDATE wallets
           SET purchased_available = purchased_available + $2, updated_at = now()
           WHERE user_id = $1`,
            [request.authUser!.id, input.credits],
          );
          await insertLedger(
            client,
            request.authUser!.id,
            'purchased_available',
            input.credits,
            'dev_topup',
            'user',
            request.authUser!.id,
          );
          await recordEvent(client, request.authUser!.id, 'wallet.updated', {
            topup: input.credits,
          });
          return {
            status: 200,
            body: { wallet: await getWallet(client, request.authUser!.id) },
          };
        },
      );
      if (response.replayed) reply.header('Idempotency-Replayed', 'true');
      return reply.code(response.status).send(response.body);
    },
  );

  app.post(
    '/api/wallet/dev-withdraw',
    {
      preHandler: ownerAuth(app, 'wallet:write'),
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      if (!app.config.allowDevTopup) {
        throw new ApiError(404, 'NOT_FOUND', 'Route not found');
      }
      const input = withdrawalSchema.parse(request.body);
      const response = await withIdempotentTransaction(
        app.db,
        request,
        app.config.encryptionKey,
        request.authUser!.id,
        'wallet.devWithdraw',
        async (client) => {
          const id = randomUUID();
          const changed = await client.query(
            `UPDATE wallets SET earned_available = earned_available - $2, updated_at = now()
           WHERE user_id = $1 AND earned_available >= $2`,
            [request.authUser!.id, input.credits],
          );
          if (changed.rowCount !== 1) {
            throw new ApiError(
              409,
              'INSUFFICIENT_EARNED_CREDITS',
              'Only earned available credits can be withdrawn',
            );
          }
          await client.query(
            `INSERT INTO withdrawal_requests (id, user_id, credits, status)
           VALUES ($1, $2, $3, 'simulated_paid')`,
            [id, request.authUser!.id, input.credits],
          );
          await insertLedger(
            client,
            request.authUser!.id,
            'earned_available',
            -input.credits,
            'dev_withdrawal',
            'withdrawal',
            id,
          );
          await recordEvent(client, request.authUser!.id, 'wallet.updated', {
            withdrawalId: id,
            withdrawn: input.credits,
            simulated: true,
          });
          const withdrawal = {
            id,
            credits: input.credits,
            status: 'simulated_paid',
            simulated: true,
            note: 'Development simulation only; no fiat payment was made.',
            createdAt: new Date().toISOString(),
          };
          return {
            status: 200,
            body: { withdrawal, wallet: await getWallet(client, request.authUser!.id) },
          };
        },
      );
      if (response.replayed) reply.header('Idempotency-Replayed', 'true');
      return reply.code(response.status).send(response.body);
    },
  );

  app.get(
    '/api/wallet/withdrawals',
    { preHandler: ownerAuth(app, 'wallet:read') },
    async (request) => {
      const result = await app.db.query<{
        id: string;
        credits: string;
        status: string;
        note: string;
        created_at: Date;
      }>(
        `SELECT id, credits, status, note, created_at FROM withdrawal_requests
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [request.authUser!.id],
      );
      return {
        withdrawals: result.rows.map((row) => ({
          id: row.id,
          credits: safeInteger(row.credits),
          status: row.status,
          simulated: true,
          note: row.note,
          createdAt: row.created_at.toISOString(),
        })),
      };
    },
  );
}
