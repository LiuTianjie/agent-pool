const APP_PATH = /^\/app(?:\/[A-Za-z0-9._~-]+)*$/;

export function safeAppPath(value: string | null | undefined): string | null {
  if (!value) return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('..') || decoded.includes('//')) return null;
  if (decoded !== '/app' && !decoded.startsWith('/app/')) return null;
  if (!APP_PATH.test(decoded)) return null;
  return decoded;
}
