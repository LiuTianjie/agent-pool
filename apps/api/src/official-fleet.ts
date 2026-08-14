import type { OfficialFleetMode } from '@agent-pool/shared';

import type { DbPool } from './db.js';
import { withTransaction } from './db.js';

export interface OfficialFleetBinding {
  ownerId: string;
  ownerEmail: string;
  mode: OfficialFleetMode;
  created: boolean;
}

export async function bindOfficialFleetOwner(
  db: DbPool,
  ownerId: string,
  configuredEmail: string,
): Promise<OfficialFleetBinding> {
  return withTransaction(db, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('agent-pool-official-owner-bind'))`);
    const boundResult = await client.query<{
      owner_id: string;
      mode: OfficialFleetMode;
    }>(`SELECT owner_id, mode FROM official_fleets FOR UPDATE`);
    if (boundResult.rows.length > 1) {
      throw new Error(
        'Official Fleet binding invariant is broken: multiple owners exist and automatic owner migration is intentionally unsupported',
      );
    }

    const userResult = await client.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE id = $1 FOR UPDATE`,
      [ownerId],
    );
    const user = userResult.rows[0];
    if (!user) throw new Error('The selected platform owner does not exist');
    if (user.email.trim().toLowerCase() !== configuredEmail.trim().toLowerCase()) {
      throw new Error('The selected owner does not match DEFAULT_OFFICIAL_OWNER_EMAIL');
    }

    const bound = boundResult.rows[0];
    if (bound && bound.owner_id !== user.id) {
      throw new Error(
        'Official Fleet is already bound to another owner; automatic owner migration is intentionally unsupported',
      );
    }
    if (bound) {
      return {
        ownerId: user.id,
        ownerEmail: user.email,
        mode: bound.mode,
        created: false,
      };
    }

    const inserted = await client.query<{ mode: OfficialFleetMode }>(
      `INSERT INTO official_fleets (owner_id, mode)
       VALUES ($1, 'standby')
       ON CONFLICT DO NOTHING
       RETURNING mode`,
      [ownerId],
    );
    const created = inserted.rows[0];
    if (!created) {
      const conflicted = await client.query<{ owner_id: string; mode: OfficialFleetMode }>(
        `SELECT owner_id, mode FROM official_fleets FOR UPDATE`,
      );
      if (conflicted.rows.length !== 1 || conflicted.rows[0]?.owner_id !== user.id) {
        throw new Error(
          'Official Fleet is already bound to another owner; automatic owner migration is intentionally unsupported',
        );
      }
      return {
        ownerId: user.id,
        ownerEmail: user.email,
        mode: conflicted.rows[0].mode,
        created: false,
      };
    }
    return {
      ownerId: user.id,
      ownerEmail: user.email,
      mode: created.mode,
      created: true,
    };
  });
}

// Capacity is informational only. Both community and securely-bound official
// credentials are visible; online filters still exclude an offline official fleet.
export const RUNNER_CAPACITY_SQL = `TRUE`;
