import { createHash, randomUUID } from 'node:crypto';

import { CONTROL_SCOPES, controlScopeSchema, type ControlScope } from '@agent-pool/shared';
import { z } from 'zod';

import { controlAuth, ownerAuth, userAuth } from '../auth.js';
import { decryptJson, encryptJson } from '../crypto.js';
import { withTransaction } from '../db.js';
import { ApiError, invariant } from '../errors.js';
import { createUserCode, hashOpaqueToken, randomOpaqueToken } from '../security.js';
import { recordEvent } from '../services.js';
import type { App } from '../types.js';

const DEVICE_CODE_SECONDS = 10 * 60;
const DEFAULT_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_CREDENTIAL_TTL_SECONDS = 60 * 60;
const MAX_CREDENTIAL_TTL_SECONDS = 90 * 24 * 60 * 60;

const safeLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Device label contains control characters');

const requestedScopesSchema = z
  .array(controlScopeSchema)
  .min(1)
  .max(CONTROL_SCOPES.length)
  .transform((scopes) => [...new Set(scopes)].sort() as ControlScope[]);

const controlDeviceStartSchema = z.object({
  label: safeLabelSchema.optional(),
  scopes: requestedScopesSchema,
  ttlSeconds: z
    .number()
    .int()
    .min(MIN_CREDENTIAL_TTL_SECONDS)
    .max(MAX_CREDENTIAL_TTL_SECONDS)
    .default(DEFAULT_CREDENTIAL_TTL_SECONDS),
});

const deviceCodeSchema = z.object({ deviceCode: z.string().min(40).max(200) });
const userCodeSchema = z
  .string()
  .trim()
  .min(8)
  .max(9)
  .transform((value) => value.toUpperCase());
const previewSchema = z.object({ userCode: userCodeSchema });
const decisionSchema = previewSchema.extend({ approvalContext: z.string().min(40).max(2_000) });
const credentialParamsSchema = z.object({ id: z.string().uuid() });

interface ApprovalContextJwt {
  kind: 'control-device-approval';
  sub: string;
  aid: string;
  fingerprint: string;
  iat: number;
  exp: number;
}

interface ControlAuthorizationRow {
  id: string;
  label: string;
  scopes: ControlScope[];
  requested_ttl_seconds: number;
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  owner_id: string | null;
  control_credential_id: string | null;
  issued_token_ciphertext: string | null;
  expires_at: Date;
}

export async function registerControlAuthRoutes(app: App): Promise<void> {
  app.post(
    '/api/auth/control/device/start',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = controlDeviceStartSchema.parse(request.body);
      const id = randomUUID();
      const deviceCode = randomOpaqueToken('ap_control_device_');
      let userCode = createUserCode();
      for (let tries = 0; tries < 4; tries += 1) {
        try {
          await app.db.query(
            `INSERT INTO control_device_authorizations
               (id, device_code_hash, user_code_hash, label, scopes,
                requested_ttl_seconds, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 second'))`,
            [
              id,
              hashOpaqueToken(deviceCode),
              hashOpaqueToken(userCode),
              input.label ?? 'Agent Pool Control',
              input.scopes,
              input.ttlSeconds,
              DEVICE_CODE_SECONDS,
            ],
          );
          const verificationPath = '/connect?kind=control';
          return reply.code(201).send({
            deviceCode,
            userCode,
            verificationUri: `${app.config.appOrigin}${verificationPath}`,
            verificationUriComplete: `${app.config.appOrigin}${verificationPath}&code=${encodeURIComponent(userCode)}`,
            expiresIn: DEVICE_CODE_SECONDS,
            interval: 3,
            kind: 'control',
            access: 'owner',
            scopes: input.scopes,
            requestedTtlSeconds: input.ttlSeconds,
          });
        } catch (error) {
          if ((error as { code?: string }).code !== '23505') throw error;
          userCode = createUserCode();
        }
      }
      throw new ApiError(
        503,
        'CONTROL_DEVICE_CODE_UNAVAILABLE',
        'Could not allocate a device code',
      );
    },
  );

  app.post(
    '/api/auth/control/device/preview',
    { preHandler: userAuth(app), config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = previewSchema.parse(request.body);
      const row = await findPendingAuthorization(app, input.userCode);
      const remainingSeconds = Math.max(
        1,
        Math.min(5 * 60, Math.floor((row.expires_at.getTime() - Date.now()) / 1_000)),
      );
      const approvalContext = app.jwt.sign(
        {
          kind: 'control-device-approval',
          sub: request.authUser!.id,
          aid: row.id,
          fingerprint: authorizationFingerprint(row),
        },
        { expiresIn: remainingSeconds },
      );
      return reply.header('Cache-Control', 'no-store').send({
        approvalContext,
        label: row.label,
        kind: 'control',
        access: 'owner',
        scopes: row.scopes,
        requestedTtlSeconds: row.requested_ttl_seconds,
        expiresAt: row.expires_at.toISOString(),
      });
    },
  );

  app.post(
    '/api/auth/control/device/approve',
    { preHandler: userAuth(app), config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request) => {
      const input = decisionSchema.parse(request.body);
      const row = await decideAuthorization(app, request.authUser!.id, input, 'approved');
      return {
        approved: true,
        label: row.label,
        kind: 'control',
        access: 'owner',
        scopes: row.scopes,
        requestedTtlSeconds: row.requested_ttl_seconds,
      };
    },
  );

  app.post(
    '/api/auth/control/device/deny',
    { preHandler: userAuth(app), config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request) => {
      const input = decisionSchema.parse(request.body);
      const row = await decideAuthorization(app, request.authUser!.id, input, 'denied');
      return { denied: true, label: row.label, kind: 'control' };
    },
  );

  app.post(
    '/api/auth/control/device/token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = deviceCodeSchema.parse(request.body);
      reply.header('Cache-Control', 'no-store');
      const response = await withTransaction(app.db, async (client) => {
        const result = await client.query<ControlAuthorizationRow>(
          `SELECT id, label, scopes, requested_ttl_seconds, status, owner_id,
                  control_credential_id, issued_token_ciphertext, expires_at
           FROM control_device_authorizations WHERE device_code_hash = $1 FOR UPDATE`,
          [hashOpaqueToken(input.deviceCode)],
        );
        const row = result.rows[0];
        invariant(row, 404, 'CONTROL_DEVICE_CODE_NOT_FOUND', 'Control device code is invalid');
        if (row.expires_at.getTime() <= Date.now()) {
          await client.query(
            `UPDATE control_device_authorizations SET status = 'expired'
             WHERE id = $1 AND status NOT IN ('consumed', 'denied')`,
            [row.id],
          );
          return { state: 'expired' as const };
        }
        if (row.status === 'pending') return { state: 'pending' as const };
        if (row.status === 'denied') return { state: 'denied' as const };
        if (row.status === 'consumed') {
          invariant(
            row.control_credential_id && row.issued_token_ciphertext,
            409,
            'CONTROL_DEVICE_CODE_USED',
            'Control device code has already been used',
          );
          const issued = decryptJson<{ token: string }>(
            row.issued_token_ciphertext,
            app.config.encryptionKey,
          );
          const credential = await client.query<{ expires_at: Date }>(
            `SELECT expires_at FROM control_credentials WHERE id = $1`,
            [row.control_credential_id],
          );
          invariant(
            credential.rows[0],
            409,
            'CONTROL_DEVICE_CODE_USED',
            'Control device credential is no longer available',
          );
          return {
            state: 'approved' as const,
            token: issued.token,
            credentialId: row.control_credential_id,
            label: row.label,
            scopes: row.scopes,
            expiresAt: credential.rows[0].expires_at,
          };
        }
        invariant(
          row.status === 'approved' && row.owner_id,
          409,
          'CONTROL_DEVICE_CODE_USED',
          'Control device code has already been used',
        );

        const token = randomOpaqueToken('ap_control_');
        const credentialId = randomUUID();
        const credential = await client.query<{
          expires_at: Date;
        }>(
          `INSERT INTO control_credentials
             (id, owner_id, token_hash, label, scopes, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'))
           RETURNING expires_at`,
          [
            credentialId,
            row.owner_id,
            hashOpaqueToken(token),
            row.label,
            row.scopes,
            row.requested_ttl_seconds,
          ],
        );
        await client.query(
          `UPDATE control_device_authorizations
           SET status = 'consumed', control_credential_id = $2,
               issued_token_ciphertext = $3, consumed_at = now()
           WHERE id = $1`,
          [row.id, credentialId, encryptJson({ token }, app.config.encryptionKey)],
        );
        await recordEvent(client, row.owner_id, 'credential.updated', {
          credentialId,
          label: row.label,
          kind: 'control',
          status: 'issued',
          scopes: row.scopes,
        });
        return {
          state: 'approved' as const,
          token,
          credentialId,
          label: row.label,
          scopes: row.scopes,
          expiresAt: credential.rows[0]!.expires_at,
        };
      });
      if (response.state === 'pending') {
        return reply
          .code(202)
          .send({ status: 'pending', error: 'authorization_pending', interval: 3 });
      }
      if (response.state === 'expired') {
        throw new ApiError(410, 'CONTROL_DEVICE_CODE_EXPIRED', 'Control device code has expired');
      }
      if (response.state === 'denied') {
        throw new ApiError(403, 'CONTROL_DEVICE_DENIED', 'Control access was denied by the owner');
      }
      return {
        status: 'approved',
        kind: 'control',
        access: 'owner',
        accessToken: response.token,
        tokenType: 'Bearer',
        credential: {
          id: response.credentialId,
          label: response.label,
          scopes: response.scopes,
          expiresAt: response.expiresAt.toISOString(),
        },
      };
    },
  );

  app.get('/api/auth/control/me', { preHandler: controlAuth(app) }, async (request) => {
    const principal = request.controlPrincipal!;
    return {
      kind: 'control',
      access: 'owner',
      owner: {
        id: request.authUser!.id,
        ...(principal.scopes.includes('account:read')
          ? {
              email: request.authUser!.email,
              displayName: request.authUser!.displayName,
            }
          : {}),
      },
      credential: mapCredential({
        id: principal.credentialId,
        label: principal.label,
        scopes: principal.scopes,
        expires_at: principal.expiresAt,
        created_at: principal.createdAt,
        last_used_at: principal.lastUsedAt,
        revoked_at: null,
      }),
    };
  });

  app.delete('/api/auth/control/me', { preHandler: controlAuth(app) }, async (request) => {
    const credentialId = request.controlPrincipal!.credentialId;
    await withTransaction(app.db, async (client) => {
      await client.query(
        `UPDATE control_credentials SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
        [credentialId],
      );
      await recordEvent(client, request.authUser!.id, 'credential.updated', {
        credentialId,
        kind: 'control',
        status: 'revoked',
        selfRevoked: true,
      });
    });
    return { revoked: true, credentialId };
  });

  app.get(
    '/api/auth/control/credentials',
    { preHandler: ownerAuth(app, 'credentials:read') },
    async (request) => {
      const result = await app.db.query<CredentialRow>(
        `SELECT id, label, scopes, expires_at, created_at, last_used_at, revoked_at
         FROM control_credentials WHERE owner_id = $1 ORDER BY created_at DESC`,
        [request.authUser!.id],
      );
      return { credentials: result.rows.map(mapCredential) };
    },
  );

  app.delete(
    '/api/auth/control/credentials/:id',
    { preHandler: ownerAuth(app, 'credentials:write') },
    async (request) => {
      const { id } = credentialParamsSchema.parse(request.params);
      await withTransaction(app.db, async (client) => {
        const result = await client.query(
          `UPDATE control_credentials SET revoked_at = COALESCE(revoked_at, now())
           WHERE id = $1 AND owner_id = $2`,
          [id, request.authUser!.id],
        );
        invariant(
          result.rowCount === 1,
          404,
          'CONTROL_CREDENTIAL_NOT_FOUND',
          'Credential not found',
        );
        await recordEvent(client, request.authUser!.id, 'credential.updated', {
          credentialId: id,
          kind: 'control',
          status: 'revoked',
        });
      });
      return { revoked: true, credentialId: id };
    },
  );
}

async function findPendingAuthorization(app: App, userCode: string) {
  const result = await app.db.query<ControlAuthorizationRow>(
    `SELECT id, label, scopes, requested_ttl_seconds, status, owner_id,
            control_credential_id, issued_token_ciphertext, expires_at
     FROM control_device_authorizations
     WHERE user_code_hash = $1 AND status = 'pending' AND expires_at > now()`,
    [hashOpaqueToken(userCode)],
  );
  const row = result.rows[0];
  invariant(
    row,
    404,
    'CONTROL_DEVICE_CODE_NOT_FOUND',
    'Control device code is invalid, expired, or already used',
  );
  return row;
}

async function decideAuthorization(
  app: App,
  ownerId: string,
  input: z.infer<typeof decisionSchema>,
  decision: 'approved' | 'denied',
): Promise<ControlAuthorizationRow> {
  let context: ApprovalContextJwt;
  try {
    context = app.jwt.verify<ApprovalContextJwt>(input.approvalContext);
  } catch {
    throw new ApiError(
      409,
      'CONTROL_APPROVAL_CONTEXT_INVALID',
      'Preview this control request again before deciding',
    );
  }
  invariant(
    context.kind === 'control-device-approval' && context.sub === ownerId,
    409,
    'CONTROL_APPROVAL_CONTEXT_INVALID',
    'Approval context does not belong to this account',
  );
  return withTransaction(app.db, async (client) => {
    const result = await client.query<ControlAuthorizationRow>(
      `SELECT id, label, scopes, requested_ttl_seconds, status, owner_id,
              control_credential_id, issued_token_ciphertext, expires_at
       FROM control_device_authorizations
       WHERE user_code_hash = $1 AND status = 'pending' AND expires_at > now() FOR UPDATE`,
      [hashOpaqueToken(input.userCode)],
    );
    const row = result.rows[0];
    invariant(
      row,
      404,
      'CONTROL_DEVICE_CODE_NOT_FOUND',
      'Control device code is invalid, expired, or already used',
    );
    invariant(
      context.aid === row.id && context.fingerprint === authorizationFingerprint(row),
      409,
      'CONTROL_APPROVAL_CONTEXT_MISMATCH',
      'Control request changed; preview it again before deciding',
    );
    await client.query(
      `UPDATE control_device_authorizations
       SET status = $2, owner_id = $3,
           approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
           denied_at = CASE WHEN $2 = 'denied' THEN now() ELSE denied_at END
       WHERE id = $1`,
      [row.id, decision, ownerId],
    );
    await recordEvent(client, ownerId, 'credential.updated', {
      authorizationId: row.id,
      label: row.label,
      kind: 'control',
      status: decision,
      scopes: row.scopes,
    });
    return row;
  });
}

function authorizationFingerprint(row: ControlAuthorizationRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.label,
        [...row.scopes].sort(),
        row.requested_ttl_seconds,
        row.expires_at.toISOString(),
      ]),
    )
    .digest('hex');
}

interface CredentialRow {
  id: string;
  label: string;
  scopes: ControlScope[];
  expires_at: Date;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

function mapCredential(row: CredentialRow) {
  return {
    id: row.id,
    label: row.label,
    scopes: row.scopes,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}
