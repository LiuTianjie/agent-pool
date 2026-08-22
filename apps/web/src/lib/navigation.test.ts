import { describe, expect, it } from 'vitest';
import { safeAppPath } from './navigation';

describe('safeAppPath', () => {
  it('only keeps in-app destinations', () => {
    expect(safeAppPath('/app')).toBe('/app');
    expect(safeAppPath('/app/pools/new')).toBe('/app/pools/new');
    expect(safeAppPath('/app/run')).toBe('/app/run');
    expect(safeAppPath('/app/pools/7d60b586-1e7d-45dc-af1f-008c8454e49b')).toBe(
      '/app/pools/7d60b586-1e7d-45dc-af1f-008c8454e49b',
    );
    expect(safeAppPath('/login')).toBeNull();
    expect(safeAppPath('//evil.example')).toBeNull();
    expect(safeAppPath('https://example.com')).toBeNull();
    expect(safeAppPath('/application')).toBeNull();
    expect(safeAppPath('/app/../login')).toBeNull();
    expect(safeAppPath('/app/%2e%2e/login')).toBeNull();
  });
});
