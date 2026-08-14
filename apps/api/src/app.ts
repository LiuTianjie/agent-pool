import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';

import type { AppConfig } from './config.js';
import { createDatabase, type DbPool } from './db.js';
import { ApiError } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCapacityRoutes } from './routes/capacity.js';
import { registerControlAuthRoutes } from './routes/control-auth.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerEventRoutes } from './routes/events.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerOfficialFleetRoutes } from './routes/official-fleet.js';
import { registerPoolRoutes } from './routes/pools.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerRunnerRoutes } from './routes/runner.js';
import { registerWalletRoutes } from './routes/wallet.js';
import type { App } from './types.js';

export interface BuildAppOptions {
  config: AppConfig;
  db?: DbPool;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(options: BuildAppOptions): Promise<App> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: trustSinglePrivateProxy,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: 'x-request-id',
  }) as App;
  const ownsDatabase = !options.db;
  app.decorate('config', options.config);
  app.decorate('db', options.db ?? createDatabase(options.config.databaseUrl));

  await app.register(cookie);
  await app.register(cors, {
    origin: options.config.appOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(jwt, { secret: options.config.jwtSecret });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    hook: 'onRequest',
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (options.config.isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  app.get('/healthz', async (_request, reply) => {
    try {
      await app.db.query('SELECT 1');
      return { status: 'ok', database: 'ok', at: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ status: 'error', database: 'unavailable' });
    }
  });
  app.get('/api/health', async (_request, reply) => {
    try {
      await app.db.query('SELECT 1');
      return { status: 'ok', database: 'ok', at: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ status: 'error', database: 'unavailable' });
    }
  });

  await registerAuthRoutes(app);
  await registerControlAuthRoutes(app);
  await registerMetaRoutes(app);
  await registerWalletRoutes(app);
  await registerCapacityRoutes(app);
  await registerPoolRoutes(app);
  await registerRunnerRoutes(app);
  await registerOfficialFleetRoutes(app);
  await registerDashboardRoutes(app);
  await registerEventRoutes(app);
  await registerPublicRoutes(app);

  if (options.config.webDistPath) {
    await app.register(fastifyStatic, {
      root: options.config.webDistPath,
      wildcard: false,
    });
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/') || request.url === '/healthz') {
        throw new ApiError(404, 'NOT_FOUND', 'Route not found');
      }
      return reply.sendFile('index.html');
    });
  }

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found', retryable: false },
      requestId: request.id,
    }),
  );

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.issues,
          retryable: false,
        },
        requestId: request.id,
      });
    }
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          retryable: isRetryableStatus(error.statusCode),
        },
        requestId: request.id,
      });
    }
    const fastifyError = error as Error & { statusCode?: number; code?: string };
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      return reply.code(fastifyError.statusCode).send({
        error: {
          code: fastifyError.code ?? 'BAD_REQUEST',
          message: fastifyError.message,
          retryable: isRetryableStatus(fastifyError.statusCode),
        },
        requestId: request.id,
      });
    }
    request.log.error({ error }, 'Unhandled API error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', retryable: true },
      requestId: request.id,
    });
  });

  if (ownsDatabase) {
    app.addHook('onClose', async () => {
      await app.db.end();
    });
  }
  return app;
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function trustSinglePrivateProxy(address: string, hop: number): boolean {
  if (hop !== 0) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (normalized === '::1' || normalized === '127.0.0.1') return true;
  if (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  ) {
    return true;
  }
  const parts = normalized.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254)
  );
}
