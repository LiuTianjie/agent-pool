import { access } from 'node:fs/promises';
import path from 'node:path';

import { parseEncryptionKey } from './crypto.js';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  encryptionKey: Buffer;
  appOrigin: string;
  allowDevTopup: boolean;
  defaultOfficialOwnerEmail: string;
  isProduction: boolean;
  webDistPath?: string;
}

export const DEFAULT_OFFICIAL_OWNER_EMAIL = 'liu28719976@gmail.com';

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseBoolean(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const isProduction = env.NODE_ENV === 'production';
  const jwtSecret = required('JWT_SECRET', env.JWT_SECRET);
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters');
  }

  let webDistPath: string | undefined;
  if (env.WEB_DIST_PATH?.trim()) {
    const candidate = path.resolve(env.WEB_DIST_PATH.trim());
    try {
      await access(path.join(candidate, 'index.html'));
      webDistPath = candidate;
    } catch {
      throw new Error(`WEB_DIST_PATH does not contain index.html: ${candidate}`);
    }
  }

  return {
    port,
    databaseUrl: required('DATABASE_URL', env.DATABASE_URL),
    jwtSecret,
    encryptionKey: parseEncryptionKey(required('TASK_ENCRYPTION_KEY', env.TASK_ENCRYPTION_KEY)),
    appOrigin: required('APP_ORIGIN', env.APP_ORIGIN).replace(/\/$/, ''),
    allowDevTopup: parseBoolean(env.ALLOW_DEV_TOPUP),
    defaultOfficialOwnerEmail: parseOfficialOwnerEmail(
      env.DEFAULT_OFFICIAL_OWNER_EMAIL ?? DEFAULT_OFFICIAL_OWNER_EMAIL,
    ),
    isProduction,
    webDistPath,
  };
}

function parseOfficialOwnerEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) {
    throw new Error('DEFAULT_OFFICIAL_OWNER_EMAIL must be a valid email address');
  }
  return email;
}
