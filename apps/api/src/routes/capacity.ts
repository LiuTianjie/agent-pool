import {
  DATASET_UNIT_MAX,
  REQUIRED_CONCURRENCY_MAX,
  agentAdapterSchema,
} from '@agent-pool/shared';
import { z } from 'zod';

import { getCapacitySnapshot, quoteCapacity } from '../services.js';
import { RUNNER_CAPACITY_SQL } from '../official-fleet.js';
import type { App } from '../types.js';

const quoteSchema = z
  .object({
    adapter: agentAdapterSchema,
    model: z.string().trim().min(1).max(120),
    deliveryMode: z.enum(['platform', 'webhook']).default('platform'),
    unitCount: z.number().int().min(1).max(DATASET_UNIT_MAX),
    requiredConcurrency: z.number().int().min(1).max(REQUIRED_CONCURRENCY_MAX),
    maxUnitSeconds: z.number().int().min(10).max(3_600),
    deadlineAt: z.string().datetime({ offset: true }),
  })
  .refine((value) => value.requiredConcurrency <= value.unitCount, {
    path: ['requiredConcurrency'],
    message: 'requiredConcurrency cannot exceed unitCount',
  });

export async function registerCapacityRoutes(app: App): Promise<void> {
  app.get('/api/capacity/catalog', async () => {
    const pairs = await app.db.query<{ adapter: string; model: string }>(
      `SELECT DISTINCT certification.adapter, certification.model
       FROM runner_certifications certification
       JOIN runner_nodes node ON node.id = certification.node_id
       JOIN runner_credentials credential ON credential.id = node.credential_id
       LEFT JOIN official_fleets official_fleet ON official_fleet.owner_id = credential.owner_id
       WHERE certification.expires_at > now() AND credential.revoked_at IS NULL
         AND ${RUNNER_CAPACITY_SQL}
       ORDER BY certification.adapter, certification.model`,
    );
    return {
      capacity: await Promise.all(
        pairs.rows.map(async ({ adapter, model }) => {
          const [platform, direct] = await Promise.all([
            getCapacitySnapshot(app.db, adapter, model),
            getCapacitySnapshot(app.db, adapter, model, undefined, 'webhook'),
          ]);
          return {
            ...platform,
            directWebhookOnlineConcurrency: direct.onlineConcurrency,
            directWebhookAvailableConcurrency: direct.availableConcurrency,
            directWebhookCertifiedNodes: direct.certifiedNodes,
          };
        }),
      ),
      generatedAt: new Date().toISOString(),
    };
  });

  app.post('/api/capacity/quote', async (request) => {
    const input = quoteSchema.parse(request.body);
    return {
      quote: await quoteCapacity(app.db, {
        ...input,
        deadlineAt: new Date(input.deadlineAt),
      }),
    };
  });
}
