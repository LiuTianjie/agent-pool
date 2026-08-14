import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg, { type PoolClient, type QueryResultRow } from 'pg';

import {
  retryStartupOperation,
  safeRetryErrorCode,
  type StartupRetryOptions,
} from './startup-retry.js';

const { Pool } = pg;

export type DbPool = InstanceType<typeof Pool>;
export type DbClient = PoolClient;

export function createDatabase(databaseUrl: string): DbPool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'agent-pool-api',
    ssl: databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (error) => {
    console.error('Unexpected PostgreSQL pool error', {
      errorCode: safeRetryErrorCode(error),
    });
  });
  return pool;
}

export async function withTransaction<T>(
  pool: DbPool,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function runMigrations(pool: DbPool): Promise<void> {
  const sourceDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../migrations',
  );
  const cwdDirectory = path.resolve(process.cwd(), 'migrations');
  let directory = sourceDirectory;
  try {
    await readdir(directory);
  } catch {
    directory = cwdDirectory;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const file of files) {
    await withTransaction(pool, async (client) => {
      const acquired = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext('agent-pool-migrations')) AS locked`,
      );
      if (!acquired.rows[0]?.locked) {
        throw new Error('Another Agent Pool instance is applying database migrations');
      }
      const alreadyApplied = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [file],
      );
      if (alreadyApplied.rowCount) return;
      await client.query(await readFile(path.join(directory, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
  }
}

export function runMigrationsWithRetry(pool: DbPool, options?: StartupRetryOptions): Promise<void> {
  return retryStartupOperation(() => runMigrations(pool), options);
}

export function firstRow<T extends QueryResultRow>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('Expected one database row');
  return row;
}

export function safeInteger(value: string | number | bigint): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error('Database integer exceeds JavaScript safe range');
  return parsed;
}
