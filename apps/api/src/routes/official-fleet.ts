import { officialFleetModeSchema, type OfficialFleetMode } from '@agent-pool/shared';
import { z } from 'zod';

import { ownerAuth } from '../auth.js';
import { safeInteger } from '../db.js';
import { invariant } from '../errors.js';
import { withIdempotentTransaction } from '../idempotency.js';
import { getWallet, recordEvent, type Queryable } from '../services.js';
import type { App } from '../types.js';

const updateModeSchema = z.object({ mode: officialFleetModeSchema });

export async function registerOfficialFleetRoutes(app: App): Promise<void> {
  app.get('/api/official-fleet', { preHandler: ownerAuth(app, 'fleet:read') }, async (request) =>
    visibleFleetResponse(request.authUser!, await loadOfficialFleet(app, request.authUser!.id)),
  );

  app.patch(
    '/api/official-fleet',
    { preHandler: ownerAuth(app, 'fleet:write') },
    async (request, reply) => {
      const input = updateModeSchema.parse(request.body);
      const response = await withIdempotentTransaction(
        app.db,
        request,
        app.config.encryptionKey,
        request.authUser!.id,
        'fleet.update',
        async (client) => {
          const current = await client.query<{ mode: OfficialFleetMode }>(
            `SELECT mode FROM official_fleets WHERE owner_id = $1 FOR UPDATE`,
            [request.authUser!.id],
          );
          invariant(
            current.rows[0],
            404,
            'OFFICIAL_FLEET_NOT_FOUND',
            'Official fleet is not bound to this account',
          );
          await client.query(
            `UPDATE official_fleets SET mode = $2, updated_at = now() WHERE owner_id = $1`,
            [request.authUser!.id, input.mode],
          );
          if (input.mode === 'offline') {
            await client.query(
              `UPDATE runner_nodes node SET status = 'offline', updated_at = now()
             FROM runner_credentials credential
             WHERE node.credential_id = credential.id
               AND credential.owner_id = $1 AND credential.operator_type = 'official'`,
              [request.authUser!.id],
            );
          }
          await recordEvent(client, request.authUser!.id, 'runner.updated', {
            operatorType: 'official',
            fleetMode: input.mode,
          });
          return {
            status: 200,
            body: await loadOfficialFleet(app, request.authUser!.id, client),
          };
        },
      );
      if (response.replayed) reply.header('Idempotency-Replayed', 'true');
      return reply
        .code(response.status)
        .send(visibleFleetResponse(request.authUser!, response.body));
    },
  );
}

function visibleFleetResponse(
  principal: NonNullable<import('fastify').FastifyRequest['authUser']>,
  response: Awaited<ReturnType<typeof loadOfficialFleet>>,
) {
  if (principal.authKind === 'session') return response;
  return {
    fleet: {
      ownerId: response.fleet.ownerId,
      ...(principal.controlScopes?.includes('account:read')
        ? { ownerEmail: response.fleet.ownerEmail }
        : {}),
      mode: response.fleet.mode,
      updatedAt: response.fleet.updatedAt,
    },
    nodes: response.nodes,
    ...(principal.controlScopes?.includes('wallet:read') ? { wallet: response.wallet } : {}),
  };
}

async function loadOfficialFleet(app: App, ownerId: string, db: Queryable = app.db) {
  const result = await db.query<{
    owner_id: string;
    email: string;
    mode: OfficialFleetMode;
    updated_at: Date;
    total_nodes: string;
    online_nodes: string;
    active_leases: string;
  }>(
    `SELECT fleet.owner_id, owner.email, fleet.mode, fleet.updated_at,
            count(DISTINCT node.id)::text AS total_nodes,
            count(DISTINCT node.id) FILTER (
              WHERE node.status = 'online' AND node.last_seen_at > now() - interval '90 seconds'
            )::text AS online_nodes,
            count(DISTINCT unit.id) FILTER (
              WHERE unit.status = 'leased' AND unit.lease_expires_at > now()
            )::text AS active_leases
     FROM official_fleets fleet
     JOIN users owner ON owner.id = fleet.owner_id
     LEFT JOIN runner_credentials credential
       ON credential.owner_id = fleet.owner_id AND credential.operator_type = 'official'
     LEFT JOIN runner_nodes node ON node.credential_id = credential.id
     LEFT JOIN task_units unit ON unit.leased_runner_id = node.id
     WHERE fleet.owner_id = $1
     GROUP BY fleet.owner_id, owner.email, fleet.mode, fleet.updated_at`,
    [ownerId],
  );
  const fleet = result.rows[0];
  invariant(fleet, 404, 'OFFICIAL_FLEET_NOT_FOUND', 'Official fleet is not bound to this account');
  return {
    fleet: {
      ownerId: fleet.owner_id,
      ownerEmail: fleet.email,
      mode: fleet.mode,
      updatedAt: fleet.updated_at.toISOString(),
    },
    nodes: {
      total: safeInteger(fleet.total_nodes),
      online: fleet.mode === 'offline' ? 0 : safeInteger(fleet.online_nodes),
      activeLeases: safeInteger(fleet.active_leases),
    },
    wallet: await getWallet(db, ownerId),
  };
}
