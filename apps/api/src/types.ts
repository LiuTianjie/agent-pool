import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';

import type { AppConfig } from './config.js';
import type { DbPool } from './db.js';
import type { ControlScope, RunnerOperatorType } from '@agent-pool/shared';

export interface UserPrincipal {
  id: string;
  email: string;
  displayName: string;
  authKind: 'session' | 'control';
  sessionId?: string;
  controlCredentialId?: string;
  controlScopes?: ControlScope[];
  viaCookie: boolean;
}

export interface ControlPrincipal {
  credentialId: string;
  ownerId: string;
  label: string;
  scopes: ControlScope[];
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface RunnerPrincipal {
  credentialId: string;
  ownerId: string;
  operatorType: RunnerOperatorType;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: DbPool;
    jwt: JWT;
  }

  interface FastifyRequest {
    authUser?: UserPrincipal;
    controlPrincipal?: ControlPrincipal;
    runnerPrincipal?: RunnerPrincipal;
  }
}

export type App = FastifyInstance;
