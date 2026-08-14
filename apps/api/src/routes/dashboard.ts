import { z } from 'zod';

import { ownerAuth } from '../auth.js';
import { safeInteger } from '../db.js';
import { withIdempotentTransaction } from '../idempotency.js';
import { getWallet } from '../services.js';
import type { App } from '../types.js';

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
});

export async function registerDashboardRoutes(app: App): Promise<void> {
  app.get(
    '/api/dashboard',
    {
      preHandler: ownerAuth(app, [
        'account:read',
        'pools:read',
        'wallet:read',
        'runners:read',
        'events:read',
      ]),
    },
    async (request) => {
      const userId = request.authUser!.id;
      const [poolStats, runnerStats, recentEvents] = await Promise.all([
        app.db.query<{
          total: string;
          live: string;
          completed: string;
          total_units: string;
          accepted_units: string;
        }>(
          `SELECT count(*) AS total,
                count(*) FILTER (WHERE status IN ('waiting_capacity', 'queued', 'running')) AS live,
                count(*) FILTER (WHERE status = 'completed') AS completed,
                COALESCE(sum(total_units), 0) AS total_units,
                COALESCE((SELECT count(*) FROM task_units u JOIN pools owned ON owned.id = u.pool_id
                          WHERE owned.owner_id = $1 AND u.status = 'accepted'), 0) AS accepted_units
         FROM pools WHERE owner_id = $1`,
          [userId],
        ),
        app.db.query<{
          total: string;
          online: string;
          active_leases: string;
        }>(
          `SELECT count(*) AS total,
                count(*) FILTER (WHERE status = 'online' AND last_seen_at > now() - interval '90 seconds') AS online,
                (SELECT count(*) FROM task_units u JOIN runner_nodes owned ON owned.id = u.leased_runner_id
                 WHERE owned.owner_id = $1 AND u.status = 'leased' AND u.lease_expires_at > now()) AS active_leases
         FROM runner_nodes WHERE owner_id = $1`,
          [userId],
        ),
        app.db.query<{ id: string; type: string; data: Record<string, unknown>; created_at: Date }>(
          `SELECT id::text, type, data, created_at FROM user_events
         WHERE user_id = $1 ORDER BY id DESC LIMIT 30`,
          [userId],
        ),
      ]);
      const pools = poolStats.rows[0];
      const runners = runnerStats.rows[0];
      return {
        wallet: await getWallet(app.db, userId),
        pools: {
          total: safeInteger(pools?.total ?? 0),
          live: safeInteger(pools?.live ?? 0),
          completed: safeInteger(pools?.completed ?? 0),
          totalUnits: safeInteger(pools?.total_units ?? 0),
          acceptedUnits: safeInteger(pools?.accepted_units ?? 0),
        },
        runners: {
          total: safeInteger(runners?.total ?? 0),
          online: safeInteger(runners?.online ?? 0),
          activeLeases: safeInteger(runners?.active_leases ?? 0),
        },
        recentEvents: recentEvents.rows.reverse().map((event) => ({
          id: event.id,
          type: event.type,
          data: event.data,
          at: event.created_at.toISOString(),
        })),
      };
    },
  );

  app.patch(
    '/api/settings/profile',
    { preHandler: ownerAuth(app, 'profile:write') },
    async (request, reply) => {
      const input = profileSchema.parse(request.body);
      const response = await withIdempotentTransaction(
        app.db,
        request,
        app.config.encryptionKey,
        request.authUser!.id,
        'profile.update',
        async (client) => {
          const result = await client.query<{ id: string; email: string; display_name: string }>(
            `UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1
           RETURNING id, email, display_name`,
            [request.authUser!.id, input.displayName],
          );
          const user = result.rows[0]!;
          return {
            status: 200,
            body: { user: { id: user.id, email: user.email, displayName: user.display_name } },
          };
        },
      );
      if (response.replayed) reply.header('Idempotency-Replayed', 'true');
      return reply.code(response.status).send({
        user: {
          id: response.body.user.id,
          ...(request.authUser!.authKind === 'session' ||
          request.authUser!.controlScopes?.includes('account:read')
            ? { email: response.body.user.email }
            : {}),
          displayName: response.body.user.displayName,
        },
      });
    },
  );
}
