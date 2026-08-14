import { randomUUID } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RunnerOperatorType } from '@agent-pool/shared';

import { ownerAuth, userAuth } from '../auth.js';
import { decryptJson, encryptJson } from '../crypto.js';
import { withTransaction } from '../db.js';
import { ApiError, invariant } from '../errors.js';
import {
  createUserCode,
  hashOpaqueToken,
  hashPassword,
  randomOpaqueToken,
  verifyPassword,
} from '../security.js';
import { getWallet, recordEvent } from '../services.js';
import type { App } from '../types.js';

const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(256),
  tokenTransport: z.enum(['cookie', 'bearer']).default('cookie'),
});

const registerSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1).max(80),
});

const deviceStartSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Device label contains control characters')
    .optional(),
  client: z.enum(['agentpool-cli', 'agentpool-official-fleet']).default('agentpool-cli'),
});

const deviceCodeSchema = z.object({
  deviceCode: z.string().min(40).max(200),
});

const userCodeSchema = z
  .string()
  .trim()
  .min(8)
  .max(9)
  .transform((value) => value.toUpperCase());

const devicePreviewSchema = z.object({
  userCode: userCodeSchema,
});

const approvalSchema = devicePreviewSchema.extend({
  expectedClient: z.enum(['agentpool-cli', 'agentpool-official-fleet']),
  expectedOperatorType: z.enum(['community', 'official']),
});

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const DEVICE_CODE_SECONDS = 10 * 60;

function setSessionCookie(app: App, reply: FastifyReply, token: string): void {
  reply.setCookie('ap_session', token, {
    path: '/',
    httpOnly: true,
    secure: app.config.isProduction,
    sameSite: 'lax',
    maxAge: SESSION_SECONDS,
  });
}

function clearSessionCookie(app: App, reply: FastifyReply): void {
  reply.clearCookie('ap_session', {
    path: '/',
    httpOnly: true,
    secure: app.config.isProduction,
    sameSite: 'lax',
  });
}

async function issueSession(
  app: App,
  userId: string,
): Promise<{ token: string; sessionId: string }> {
  const sessionId = randomUUID();
  await app.db.query(
    `INSERT INTO auth_sessions (id, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
    [sessionId, userId, SESSION_SECONDS],
  );
  const token = app.jwt.sign(
    { sub: userId, sid: sessionId, kind: 'user' },
    { expiresIn: SESSION_SECONDS },
  );
  return { token, sessionId };
}

export async function registerAuthRoutes(app: App): Promise<void> {
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = registerSchema.parse(request.body);
      const passwordHash = await hashPassword(input.password);
      const userId = randomUUID();
      try {
        await withTransaction(app.db, async (client) => {
          await client.query(
            `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
            [userId, input.email, input.displayName, passwordHash],
          );
          await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [userId]);
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
        }
        throw error;
      }
      const session = await issueSession(app, userId);
      if (input.tokenTransport === 'cookie') setSessionCookie(app, reply, session.token);
      return reply.code(201).send({
        user: { id: userId, email: input.email, displayName: input.displayName },
        wallet: await getWallet(app.db, userId),
        ...(input.tokenTransport === 'bearer'
          ? { accessToken: session.token, tokenType: 'Bearer' }
          : {}),
      });
    },
  );

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = credentialsSchema.parse(request.body);
      const result = await app.db.query<{
        id: string;
        email: string;
        display_name: string;
        password_hash: string;
      }>('SELECT id, email, display_name, password_hash FROM users WHERE lower(email) = $1', [
        input.email,
      ]);
      const row = result.rows[0];
      const valid = row
        ? await verifyPassword(input.password, row.password_hash)
        : (await hashPassword(input.password), false);
      invariant(row && valid, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      const session = await issueSession(app, row.id);
      if (input.tokenTransport === 'cookie') setSessionCookie(app, reply, session.token);
      return {
        user: { id: row.id, email: row.email, displayName: row.display_name },
        wallet: await getWallet(app.db, row.id),
        ...(input.tokenTransport === 'bearer'
          ? { accessToken: session.token, tokenType: 'Bearer' }
          : {}),
      };
    },
  );

  app.post('/api/auth/logout', { preHandler: userAuth(app) }, async (request, reply) => {
    await app.db.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [
      request.authUser!.sessionId,
    ]);
    clearSessionCookie(app, reply);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: userAuth(app) }, async (request) => ({
    user: {
      id: request.authUser!.id,
      email: request.authUser!.email,
      displayName: request.authUser!.displayName,
    },
    wallet: await getWallet(app.db, request.authUser!.id),
  }));

  app.post(
    '/api/auth/device/start',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = deviceStartSchema.parse(request.body ?? {});
      const id = randomUUID();
      const deviceCode = randomOpaqueToken('ap_device_');
      let userCode = createUserCode();
      for (let tries = 0; tries < 4; tries += 1) {
        try {
          await app.db.query(
            `INSERT INTO device_authorizations
               (id, device_code_hash, user_code_hash, runner_label, client, expires_at)
             VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'))`,
            [
              id,
              hashOpaqueToken(deviceCode),
              hashOpaqueToken(userCode),
              input.label ??
                (input.client === 'agentpool-official-fleet'
                  ? 'Agent Pool Official Fleet'
                  : 'Agent Pool CLI'),
              input.client,
              DEVICE_CODE_SECONDS,
            ],
          );
          return reply.code(201).send({
            deviceCode,
            userCode,
            verificationUri: `${app.config.appOrigin}/device`,
            verificationUriComplete: `${app.config.appOrigin}/device?code=${encodeURIComponent(userCode)}`,
            expiresIn: DEVICE_CODE_SECONDS,
            interval: 3,
          });
        } catch (error) {
          if ((error as { code?: string }).code !== '23505') throw error;
          userCode = createUserCode();
        }
      }
      throw new ApiError(503, 'DEVICE_CODE_UNAVAILABLE', 'Could not allocate a device code');
    },
  );

  app.post(
    '/api/auth/device/preview',
    {
      preHandler: ownerAuth(app, 'runners:pair'),
      config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const input = devicePreviewSchema.parse(request.body);
      const result = await app.db.query<{
        runner_label: string;
        client: 'agentpool-cli' | 'agentpool-official-fleet';
        expires_at: Date;
      }>(
        `SELECT runner_label, client, expires_at
         FROM device_authorizations
         WHERE user_code_hash = $1 AND status = 'pending' AND expires_at > now()`,
        [hashOpaqueToken(input.userCode)],
      );
      const authorization = result.rows[0];
      invariant(
        authorization,
        404,
        'DEVICE_CODE_NOT_FOUND',
        'Device code is invalid, expired, or already used',
      );
      const operatorType = operatorTypeForDeviceClient(authorization.client);
      if (operatorType === 'official') {
        requireOfficialPairingScope(request.authUser!);
        const binding = await app.db.query(`SELECT 1 FROM official_fleets WHERE owner_id = $1`, [
          request.authUser!.id,
        ]);
        invariant(
          binding.rowCount === 1,
          403,
          'OFFICIAL_FLEET_OWNER_REQUIRED',
          'This account is not bound as the official fleet owner',
        );
      }
      return reply.header('Cache-Control', 'no-store').send({
        label: authorization.runner_label,
        client: authorization.client,
        operatorType,
        expiresAt: authorization.expires_at.toISOString(),
      });
    },
  );

  app.post(
    '/api/auth/device/approve',
    {
      preHandler: ownerAuth(app, 'runners:pair'),
      config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    },
    async (request) => {
      const input = approvalSchema.parse(request.body);
      const decision = await withTransaction(app.db, async (client) => {
        const result = await client.query<{
          id: string;
          runner_label: string;
          client: 'agentpool-cli' | 'agentpool-official-fleet';
          status: 'pending' | 'approved' | 'consumed';
          owner_id: string | null;
        }>(
          `SELECT id, runner_label, client, status, owner_id FROM device_authorizations
           WHERE user_code_hash = $1 AND status IN ('pending', 'approved', 'consumed')
             AND expires_at > now()
           FOR UPDATE`,
          [hashOpaqueToken(input.userCode)],
        );
        const authorization = result.rows[0];
        invariant(
          authorization,
          404,
          'DEVICE_CODE_NOT_FOUND',
          'Device code is invalid, expired, or already used',
        );
        const operatorType = operatorTypeForDeviceClient(authorization.client);
        invariant(
          authorization.client === input.expectedClient &&
            operatorType === input.expectedOperatorType,
          409,
          'DEVICE_APPROVAL_CONTEXT_MISMATCH',
          'Device identity changed; preview the device code again before approving',
        );
        if (authorization.status !== 'pending') {
          invariant(
            authorization.owner_id === request.authUser!.id,
            404,
            'DEVICE_CODE_NOT_FOUND',
            'Device code is invalid, expired, or already used',
          );
        }
        if (authorization.client === 'agentpool-official-fleet') {
          requireOfficialPairingScope(request.authUser!);
          const binding = await client.query(`SELECT 1 FROM official_fleets WHERE owner_id = $1`, [
            request.authUser!.id,
          ]);
          invariant(
            binding.rowCount === 1,
            403,
            'OFFICIAL_FLEET_OWNER_REQUIRED',
            'This account is not bound as the official fleet owner',
          );
        }
        if (authorization.status === 'pending') {
          await client.query(
            `UPDATE device_authorizations
             SET status = 'approved', owner_id = $2, approved_at = now() WHERE id = $1`,
            [authorization.id, request.authUser!.id],
          );
          await recordEvent(client, request.authUser!.id, 'runner.updated', {
            pairingId: authorization.id,
            label: authorization.runner_label,
            status: 'approved',
          });
        }
        return { authorization, newlyApproved: authorization.status === 'pending' };
      });
      return {
        approved: true,
        label: decision.authorization.runner_label,
        operatorType: operatorTypeForDeviceClient(decision.authorization.client),
      };
    },
  );

  app.post(
    '/api/auth/device/token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = deviceCodeSchema.parse(request.body);
      reply.header('Cache-Control', 'no-store');
      const response = await withTransaction(app.db, async (client) => {
        const result = await client.query<{
          id: string;
          status: string;
          owner_id: string | null;
          runner_label: string;
          client: 'agentpool-cli' | 'agentpool-official-fleet';
          runner_credential_id: string | null;
          issued_token_ciphertext: string | null;
          expires_at: Date;
        }>(
          `SELECT id, status, owner_id, runner_label, client, runner_credential_id,
                  issued_token_ciphertext, expires_at
           FROM device_authorizations WHERE device_code_hash = $1 FOR UPDATE`,
          [hashOpaqueToken(input.deviceCode)],
        );
        const row = result.rows[0];
        invariant(row, 404, 'DEVICE_CODE_NOT_FOUND', 'Device code is invalid');
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          await client.query(
            `UPDATE device_authorizations SET status = 'expired' WHERE id = $1 AND status <> 'consumed'`,
            [row.id],
          );
          throw new ApiError(410, 'DEVICE_CODE_EXPIRED', 'Device code has expired');
        }
        if (row.status === 'pending') return { pending: true as const };
        if (row.status === 'consumed' && row.issued_token_ciphertext) {
          const issued = decryptJson<{
            token: string;
            credentialId: string;
            operatorType: RunnerOperatorType;
          }>(row.issued_token_ciphertext, app.config.encryptionKey);
          invariant(
            issued.credentialId === row.runner_credential_id,
            409,
            'DEVICE_CODE_USED',
            'Device code has already been used',
          );
          return { pending: false as const, ...issued };
        }
        invariant(
          row.status === 'approved' && row.owner_id,
          409,
          'DEVICE_CODE_USED',
          'Device code has already been used',
        );

        const token = randomOpaqueToken('ap_runner_');
        const credentialId = randomUUID();
        const operatorType = operatorTypeForDeviceClient(row.client);
        if (operatorType === 'official') {
          const binding = await client.query(`SELECT 1 FROM official_fleets WHERE owner_id = $1`, [
            row.owner_id,
          ]);
          invariant(
            binding.rowCount === 1,
            403,
            'OFFICIAL_FLEET_OWNER_REQUIRED',
            'Official fleet owner binding is no longer active',
          );
        }
        await client.query(
          `INSERT INTO runner_credentials (id, owner_id, token_hash, label, operator_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [credentialId, row.owner_id, hashOpaqueToken(token), row.runner_label, operatorType],
        );
        await client.query(
          `UPDATE device_authorizations
           SET status = 'consumed', runner_credential_id = $2,
               issued_token_ciphertext = $3, consumed_at = now() WHERE id = $1`,
          [
            row.id,
            credentialId,
            encryptJson({ token, credentialId, operatorType }, app.config.encryptionKey),
          ],
        );
        await recordEvent(client, row.owner_id, 'runner.updated', {
          credentialId,
          label: row.runner_label,
          status: 'paired',
        });
        return { pending: false as const, token, credentialId, operatorType };
      });
      if (response.pending) {
        return reply
          .code(202)
          .send({ status: 'pending', error: 'authorization_pending', interval: 3 });
      }
      return {
        status: 'approved',
        token: response.token,
        accessToken: response.token,
        tokenType: 'Bearer',
        credentialId: response.credentialId,
        operatorType: response.operatorType,
      };
    },
  );
}

function operatorTypeForDeviceClient(
  client: 'agentpool-cli' | 'agentpool-official-fleet',
): RunnerOperatorType {
  return client === 'agentpool-official-fleet' ? 'official' : 'community';
}

function requireOfficialPairingScope(principal: NonNullable<FastifyRequest['authUser']>): void {
  if (principal.authKind !== 'control') return;
  invariant(
    principal.controlScopes?.includes('fleet:write'),
    403,
    'CONTROL_SCOPE_REQUIRED',
    'Official Runner pairing also requires the fleet:write scope',
    {
      requiredScopes: ['runners:pair', 'fleet:write'],
      missingScopes: ['fleet:write'],
      grantedScopes: principal.controlScopes ?? [],
    },
  );
}
