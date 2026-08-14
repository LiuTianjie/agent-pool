import { z } from 'zod';

import { safeInteger } from '../db.js';
import { invariant } from '../errors.js';
import { mapPoolSummary, POOL_SUMMARY_SELECT } from '../services.js';
import { RUNNER_CAPACITY_SQL } from '../official-fleet.js';
import type { App } from '../types.js';

const listSchema = z.object({
  category: z.enum(['text', 'data', 'coding', 'research', 'math', 'vision', 'other']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export async function registerPublicRoutes(app: App): Promise<void> {
  app.get('/api/public/pools', async (request) => {
    const query = listSchema.parse(request.query);
    const result = await app.db.query(
      `${POOL_SUMMARY_SELECT}
       WHERE p.status IN ('piloting', 'waiting_capacity', 'queued', 'running', 'completed')
         AND ($1::text IS NULL OR p.category = $1)
       GROUP BY p.id ORDER BY
         CASE p.status WHEN 'running' THEN 0 WHEN 'piloting' THEN 1 WHEN 'queued' THEN 2
           WHEN 'waiting_capacity' THEN 3 ELSE 4 END,
         p.created_at DESC LIMIT $2 OFFSET $3`,
      [query.category ?? null, query.limit, query.offset],
    );
    return {
      pools: result.rows.map((row) => {
        const summary = mapPoolSummary(row as Record<string, unknown>);
        // Only deliberately public pool metadata and aggregate counters leave this route.
        return summary;
      }),
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.get('/api/public/pools/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await app.db.query(`${POOL_SUMMARY_SELECT} WHERE p.id = $1 GROUP BY p.id`, [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    invariant(row, 404, 'POOL_NOT_FOUND', 'Pool not found');
    return { pool: mapPoolSummary(row) };
  });

  app.get('/api/network/pulse', async () => {
    const result = await app.db.query<{
      online_nodes: string;
      certified_concurrency: string;
      active_leases: string;
      queued_units: string;
      accepted_today: string;
      credits_earned_today: string;
    }>(
      `SELECT
         (SELECT count(*) FROM runner_nodes node
          JOIN runner_credentials credential ON credential.id = node.credential_id
          LEFT JOIN official_fleets official_fleet ON official_fleet.owner_id = credential.owner_id
          WHERE node.status = 'online' AND node.last_seen_at > now() - interval '90 seconds'
            AND credential.revoked_at IS NULL AND ${RUNNER_CAPACITY_SQL}) AS online_nodes,
         (SELECT COALESCE(sum(LEAST(c.certified_concurrency, n.max_concurrency)), 0)
          FROM runner_certifications c
          JOIN runner_nodes n ON n.id = c.node_id
          JOIN runner_credentials credential ON credential.id = n.credential_id
          LEFT JOIN official_fleets official_fleet ON official_fleet.owner_id = credential.owner_id
          WHERE c.expires_at > now() AND n.status = 'online'
            AND n.last_seen_at > now() - interval '90 seconds'
            AND credential.revoked_at IS NULL AND ${RUNNER_CAPACITY_SQL}) AS certified_concurrency,
         (SELECT count(*) FROM task_units
          WHERE status = 'leased' AND lease_expires_at > now()) AS active_leases,
         (SELECT count(*) FROM task_units WHERE status = 'queued') AS queued_units,
         (SELECT count(*) FROM task_units
          WHERE status = 'accepted' AND accepted_at >= date_trunc('day', now())) AS accepted_today,
         (SELECT COALESCE(sum(amount), 0) FROM settlements
          WHERE created_at >= date_trunc('day', now())) AS credits_earned_today`,
    );
    const row = result.rows[0];
    return {
      onlineNodes: safeInteger(row?.online_nodes ?? 0),
      certifiedConcurrency: safeInteger(row?.certified_concurrency ?? 0),
      activeLeases: safeInteger(row?.active_leases ?? 0),
      queuedUnits: safeInteger(row?.queued_units ?? 0),
      acceptedToday: safeInteger(row?.accepted_today ?? 0),
      creditsEarnedToday: safeInteger(row?.credits_earned_today ?? 0),
      at: new Date().toISOString(),
    };
  });
}
