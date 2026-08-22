const SPA_PREFIXES = ['/login', '/register', '/device', '/connect', '/app', '/dashboard'];

export function requestPath(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path.length > 1 ? path.replace(/\/$/u, '') : path || '/';
}

export function isKnownSpaPath(path: string): boolean {
  if (path === '/' || path === '') return true;
  return SPA_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function isMissingStaticAsset(path: string): boolean {
  return /\.[A-Za-z0-9]+$/u.test(path) && !path.endsWith('.html');
}
