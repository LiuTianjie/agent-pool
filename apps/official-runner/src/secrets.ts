import { lstat, readFile } from 'node:fs/promises';

import type { FleetRouteConfig, SecretReference } from './types.js';

const INHERITED_ENVIRONMENT = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_EXTRA_CA_CERTS',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
] as const;

export async function resolveRouteEnvironment(
  route: FleetRouteConfig,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENVIRONMENT) {
    const value = hostEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  Object.assign(environment, route.environment);
  for (const [target, reference] of Object.entries(route.secretEnvRefs)) {
    environment[target] = await readSecret(reference, hostEnvironment);
  }
  return environment;
}

async function readSecret(
  reference: SecretReference,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  let value: string | undefined;
  if ('env' in reference) {
    value = environment[reference.env];
  } else {
    const stat = await lstat(reference.file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error('A configured secret file is unavailable.');
    }
    value = await readFile(reference.file, 'utf8');
  }
  const normalized = value?.trim();
  if (!normalized || /[\r\n]/u.test(normalized)) {
    throw new Error('A configured Route secret is unavailable.');
  }
  return normalized;
}
