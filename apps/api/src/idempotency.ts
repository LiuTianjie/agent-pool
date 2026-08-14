import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { decryptJson, encryptJson } from './crypto.js';
import { withTransaction, type DbClient, type DbPool } from './db.js';
import { ApiError } from './errors.js';

export interface TransactionResponse<T> {
  status: number;
  body: T;
}

export interface IdempotentResult<T> extends TransactionResponse<T> {
  replayed: boolean;
}

export async function withIdempotentTransaction<T>(
  pool: DbPool,
  request: FastifyRequest,
  encryptionKey: Buffer,
  ownerId: string,
  routeScope: string,
  work: (client: DbClient) => Promise<TransactionResponse<T>>,
): Promise<IdempotentResult<T>> {
  const key = parseIdempotencyKey(request.headers['idempotency-key']);
  if (!key) {
    const response = await withTransaction(pool, work);
    return { ...response, replayed: false };
  }
  const requestHash = fingerprintRequest(request, routeScope);
  const lockKey = createHash('sha256')
    .update(canonicalJson([ownerId, routeScope, key]))
    .digest('hex');
  return withTransaction(pool, async (client) => {
    // A transaction-scoped advisory lock closes the race where two first requests
    // both observe that no idempotency row exists yet.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockKey]);
    const existing = await client.query<{
      request_hash: string;
      response_status: number;
      response_ciphertext: string;
      expires_at: Date;
    }>(
      `SELECT request_hash, response_status, response_ciphertext, expires_at
       FROM idempotency_records
       WHERE owner_id = $1 AND route_scope = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [ownerId, routeScope, key],
    );
    const row = existing.rows[0];
    if (row && row.expires_at.getTime() > Date.now()) {
      if (row.request_hash !== requestHash) {
        throw new ApiError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with a different request',
        );
      }
      return {
        status: row.response_status,
        body: decryptJson<T>(row.response_ciphertext, encryptionKey),
        replayed: true,
      };
    }
    if (row) {
      await client.query(
        `DELETE FROM idempotency_records
         WHERE owner_id = $1 AND route_scope = $2 AND idempotency_key = $3`,
        [ownerId, routeScope, key],
      );
    }

    const response = await work(client);
    if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
      throw new Error('Idempotent transaction can only persist successful HTTP responses');
    }
    await client.query(
      `INSERT INTO idempotency_records
         (owner_id, route_scope, idempotency_key, request_hash,
          response_status, response_ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ownerId,
        routeScope,
        key,
        requestHash,
        response.status,
        encryptJson(response.body, encryptionKey),
      ],
    );
    return { ...response, replayed: false };
  });
}

export async function withRunnerIdempotentTransaction<T>(
  pool: DbPool,
  request: FastifyRequest,
  encryptionKey: Buffer,
  credentialId: string,
  routeScope: string,
  work: (client: DbClient) => Promise<TransactionResponse<T>>,
): Promise<IdempotentResult<T>> {
  const key = parseIdempotencyKey(request.headers['idempotency-key']);
  if (!key) {
    const response = await withTransaction(pool, work);
    return { ...response, replayed: false };
  }
  const requestHash = fingerprintRequest(request, routeScope);
  const lockKey = createHash('sha256')
    .update(canonicalJson(['runner', credentialId, routeScope, key]))
    .digest('hex');
  return withTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockKey]);
    const existing = await client.query<{
      request_hash: string;
      response_status: number;
      response_ciphertext: string;
      expires_at: Date;
    }>(
      `SELECT request_hash, response_status, response_ciphertext, expires_at
       FROM runner_idempotency_records
       WHERE credential_id = $1 AND route_scope = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [credentialId, routeScope, key],
    );
    const row = existing.rows[0];
    if (row && row.expires_at.getTime() > Date.now()) {
      if (row.request_hash !== requestHash) {
        throw new ApiError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with a different request',
        );
      }
      return {
        status: row.response_status,
        body: decryptJson<T>(row.response_ciphertext, encryptionKey),
        replayed: true,
      };
    }
    if (row) {
      await client.query(
        `DELETE FROM runner_idempotency_records
         WHERE credential_id = $1 AND route_scope = $2 AND idempotency_key = $3`,
        [credentialId, routeScope, key],
      );
    }
    const response = await work(client);
    if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
      throw new Error('Idempotent transaction can only persist successful HTTP responses');
    }
    await client.query(
      `INSERT INTO runner_idempotency_records
         (credential_id, route_scope, idempotency_key, request_hash,
          response_status, response_ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        credentialId,
        routeScope,
        key,
        requestHash,
        response.status,
        encryptJson(response.body, encryptionKey),
      ],
    );
    return { ...response, replayed: false };
  });
}

function parseIdempotencyKey(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Provide exactly one Idempotency-Key');
  }
  if (!/^[\x21-\x7E]{8,128}$/.test(value)) {
    throw new ApiError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 8 to 128 printable ASCII characters without spaces',
    );
  }
  return value;
}

function fingerprintRequest(request: FastifyRequest, routeScope: string): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        method: request.method.toUpperCase(),
        routeScope,
        params: request.params,
        query: request.query,
        body: request.body,
      }),
    )
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new ApiError(400, 'INVALID_JSON', 'JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  throw new ApiError(400, 'INVALID_JSON', 'Request must be JSON-serializable');
}
