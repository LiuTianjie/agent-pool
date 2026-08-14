import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import type {
  FleetCellConfig,
  FleetRouteConfig,
  OfficialFleetConfig,
  SecretReference,
} from './types.js';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
const envNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/u)
  .max(120);
const secretReferenceSchema = z
  .union([
    z.object({ env: envNameSchema }).strict(),
    z.object({ file: z.string().trim().min(1).max(2_048) }).strict(),
  ])
  .superRefine((value, context) => {
    if ('file' in value && !isAbsolute(value.file)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Secret file paths must be absolute',
      });
    }
  });

const routeSchema = z
  .object({
    id: identifierSchema,
    kind: z.string().trim().min(1).max(80),
    concurrency: z.number().int().min(1).max(64),
    environment: z.record(envNameSchema, z.string().max(4_096)).default({}),
    secretEnvRefs: z.record(envNameSchema, secretReferenceSchema).default({}),
  })
  .strict();

const cellSchema = z
  .object({
    id: identifierSchema,
    adapter: z.enum(['codex', 'claude', 'mock']),
    model: z.string().trim().min(1).max(120),
    allowWebhooks: z.boolean().default(false),
    routes: z.array(routeSchema).min(1).max(64),
  })
  .strict();

const configSchema = z
  .object({
    version: z.literal('agentpool-official-fleet/1'),
    pollIntervalMs: z.number().int().min(3_000).max(60_000).default(3_000),
    cells: z.array(cellSchema).min(1).max(100),
  })
  .strict();

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/u;
const FORBIDDEN_ENV_NAMES = new Set([
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'SHELLOPTS',
]);

export async function loadFleetConfig(filePath: string): Promise<OfficialFleetConfig> {
  const absolutePath = resolve(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Official Fleet config is not valid JSON.');
    throw new Error('Official Fleet config could not be read.');
  }
  return parseFleetConfig(parsed);
}

export function parseFleetConfig(value: unknown): OfficialFleetConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) throw new Error('Official Fleet config is invalid.');
  const raw = result.data;
  const cellIds = new Set<string>();
  const executionProfiles = new Set<string>();

  const cells = raw.cells.map((cell): FleetCellConfig => {
    if (cellIds.has(cell.id)) throw new Error('Official Fleet cell IDs must be unique.');
    cellIds.add(cell.id);
    if (cell.model === '*' || cell.model.toLowerCase() === 'any') {
      throw new Error('Official Fleet cells require an exact model.');
    }
    if (cell.adapter === 'mock' && cell.model !== 'mock-v1') {
      throw new Error('Mock cells require the built-in exact model mock-v1.');
    }
    const profile = `${cell.adapter}\u0000${cell.model}`;
    if (executionProfiles.has(profile)) {
      throw new Error('Each exact adapter/model profile must use one cell.');
    }
    executionProfiles.add(profile);

    const routeIds = new Set<string>();
    let totalConcurrency = 0;
    const routes = cell.routes.map((route): FleetRouteConfig => {
      if (routeIds.has(route.id)) throw new Error('Route IDs must be unique inside a cell.');
      routeIds.add(route.id);
      totalConcurrency += route.concurrency;
      validateRouteKind(cell.adapter, route.kind);
      validateEnvironment(route.environment, route.secretEnvRefs);
      return {
        id: route.id,
        kind: route.kind as 'cli' | 'mock',
        concurrency: route.concurrency,
        environment: { ...route.environment },
        secretEnvRefs: route.secretEnvRefs as Record<string, SecretReference>,
      };
    });
    if (totalConcurrency > 64) {
      throw new Error('A cell cannot advertise more than 64 concurrent executions.');
    }
    return {
      id: cell.id,
      adapter: cell.adapter,
      model: cell.model,
      allowWebhooks: cell.allowWebhooks,
      routes,
    };
  });

  return {
    version: 'agentpool-official-fleet/1',
    pollIntervalMs: raw.pollIntervalMs,
    cells,
  };
}

function validateRouteKind(adapter: FleetCellConfig['adapter'], kind: string): void {
  if (adapter === 'mock') {
    if (kind !== 'mock') throw new Error('Mock cells only support mock routes.');
    return;
  }
  if (kind !== 'cli') {
    throw new Error(
      'Codex and Claude cells require their actual CLI; raw compatible HTTP routes are unsupported.',
    );
  }
}

function validateEnvironment(
  environment: Record<string, string>,
  secretEnvRefs: Record<string, SecretReference>,
): void {
  for (const [name, value] of Object.entries(environment)) {
    if (SECRET_NAME.test(name)) {
      throw new Error('Secret-looking environment variables must use secretEnvRefs.');
    }
    if (FORBIDDEN_ENV_NAMES.has(name) || name.startsWith('DYLD_')) {
      throw new Error('Official Fleet config contains a forbidden environment override.');
    }
    if (/URL|ENDPOINT|HOST/u.test(name) || value.includes('://')) validatePublicServiceUrl(value);
  }
  for (const name of Object.keys(secretEnvRefs)) {
    if (Object.prototype.hasOwnProperty.call(environment, name)) {
      throw new Error('An environment variable cannot be both literal and secret-backed.');
    }
    if (FORBIDDEN_ENV_NAMES.has(name) || name.startsWith('DYLD_')) {
      throw new Error('Official Fleet config contains a forbidden secret environment target.');
    }
  }
}

export function validatePublicServiceUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('A configured service URL is invalid.');
  }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Service URLs require HTTPS (or loopback HTTP) without credentials or query.');
  }
  return url;
}
