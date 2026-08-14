import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ControlScope, RunnerOperatorType } from '@agent-pool/shared';

import { ApiError, invariant } from './errors.js';
import type { App, ControlPrincipal, RunnerPrincipal, UserPrincipal } from './types.js';
import { hashOpaqueToken } from './security.js';

interface SessionJwt {
  sub: string;
  sid: string;
  kind: 'user';
  iat: number;
  exp: number;
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

function enforceCookieOrigin(app: App, request: FastifyRequest): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.origin;
  invariant(
    origin === app.config.appOrigin,
    403,
    'ORIGIN_REJECTED',
    'Request origin is not allowed',
  );
}

export function userAuth(app: App) {
  return async function authenticateUser(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    await authenticateUserSession(app, request);
  };
}

async function authenticateUserSession(app: App, request: FastifyRequest): Promise<void> {
  const headerToken = bearerToken(request);
  const cookieToken = request.cookies.ap_session;
  const token = headerToken ?? cookieToken;
  invariant(token, 401, 'AUTH_REQUIRED', 'Authentication required');

  let payload: SessionJwt;
  try {
    payload = app.jwt.verify<SessionJwt>(token);
  } catch {
    throw new ApiError(401, 'INVALID_SESSION', 'Session is invalid or expired');
  }
  invariant(
    payload.kind === 'user' && payload.sub && payload.sid,
    401,
    'INVALID_SESSION',
    'Session is invalid',
  );

  const result = await app.db.query<{
    id: string;
    email: string;
    display_name: string;
    session_id: string;
  }>(
    `SELECT u.id, u.email, u.display_name, s.id AS session_id
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [payload.sid, payload.sub],
  );
  const row = result.rows[0];
  invariant(row, 401, 'INVALID_SESSION', 'Session is invalid or expired');
  if (!headerToken) enforceCookieOrigin(app, request);
  request.authUser = {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    authKind: 'session',
    sessionId: row.session_id,
    viaCookie: !headerToken,
  } satisfies UserPrincipal;
  void app.db.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [
    row.session_id,
  ]);
}

export function controlAuth(app: App, requiredScopes?: ControlScope | ControlScope[]) {
  return async function authenticateControl(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const token = bearerToken(request);
    invariant(
      typeof token === 'string' && token.startsWith('ap_control_'),
      401,
      'CONTROL_AUTH_REQUIRED',
      'Control bearer token required',
    );
    const result = await app.db.query<{
      id: string;
      owner_id: string;
      label: string;
      scopes: ControlScope[];
      expires_at: Date;
      created_at: Date;
      last_used_at: Date | null;
      email: string;
      display_name: string;
    }>(
      `SELECT credential.id, credential.owner_id, credential.label, credential.scopes,
              credential.expires_at, credential.created_at, credential.last_used_at,
              owner.email, owner.display_name
       FROM control_credentials credential
       JOIN users owner ON owner.id = credential.owner_id
       WHERE credential.token_hash = $1 AND credential.revoked_at IS NULL
         AND credential.expires_at > now()`,
      [hashOpaqueToken(token)],
    );
    const row = result.rows[0];
    invariant(row, 401, 'INVALID_CONTROL_TOKEN', 'Control token is invalid or expired');
    const required = requiredScopes
      ? Array.isArray(requiredScopes)
        ? requiredScopes
        : [requiredScopes]
      : [];
    const missingScopes = required.filter((scope) => !row.scopes.includes(scope));
    invariant(
      missingScopes.length === 0,
      403,
      'CONTROL_SCOPE_REQUIRED',
      `Control credential is missing required scope${missingScopes.length === 1 ? '' : 's'}`,
      { requiredScopes: required, missingScopes, grantedScopes: row.scopes },
    );
    request.controlPrincipal = {
      credentialId: row.id,
      ownerId: row.owner_id,
      label: row.label,
      scopes: row.scopes,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    } satisfies ControlPrincipal;
    request.authUser = {
      id: row.owner_id,
      email: row.email,
      displayName: row.display_name,
      authKind: 'control',
      controlCredentialId: row.id,
      controlScopes: row.scopes,
      viaCookie: false,
    } satisfies UserPrincipal;
    void app.db.query('UPDATE control_credentials SET last_used_at = now() WHERE id = $1', [
      row.id,
    ]);
  };
}

export function ownerAuth(app: App, requiredScopes: ControlScope | ControlScope[]) {
  const authenticateControl = controlAuth(app, requiredScopes);
  return async function authenticateOwner(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = bearerToken(request);
    if (token?.startsWith('ap_control_')) {
      await authenticateControl(request, reply);
      return;
    }
    await authenticateUserSession(app, request);
  };
}

export function runnerAuth(app: App) {
  return async function authenticateRunner(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const token = bearerToken(request);
    invariant(
      typeof token === 'string' && token.startsWith('ap_runner_'),
      401,
      'RUNNER_AUTH_REQUIRED',
      'Runner bearer token required',
    );
    const result = await app.db.query<{
      id: string;
      owner_id: string;
      operator_type: RunnerOperatorType;
    }>(
      `SELECT id, owner_id, operator_type FROM runner_credentials
       WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [hashOpaqueToken(token)],
    );
    const row = result.rows[0];
    invariant(row, 401, 'INVALID_RUNNER_TOKEN', 'Runner token is invalid or expired');
    request.runnerPrincipal = {
      credentialId: row.id,
      ownerId: row.owner_id,
      operatorType: row.operator_type,
    } satisfies RunnerPrincipal;
    void app.db.query('UPDATE runner_credentials SET last_used_at = now() WHERE id = $1', [row.id]);
  };
}
