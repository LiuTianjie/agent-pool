import { describe, expect, it } from 'vitest';
import { catalog, isCatalogLeaf } from './catalog';
import { lookupMessage } from './translate';

function walk(node: unknown, prefix = ''): string[] {
  if (isCatalogLeaf(node)) return prefix ? [prefix] : [];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    walk(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe('message catalog', () => {
  it('gives every leaf both Chinese and English copy', () => {
    const keys = walk(catalog);
    expect(keys.length).toBeGreaterThan(200);
    for (const key of keys) {
      const zh = lookupMessage(key, 'zh');
      const en = lookupMessage(key, 'en');
      expect(zh, key).not.toBe(key);
      expect(en, key).not.toBe(key);
      expect(zh.trim(), key).not.toBe('');
      expect(en.trim(), key).not.toBe('');
    }
  });

  it('keeps English landing copy in English', () => {
    expect(lookupMessage('landing.heroTitle2', 'en')).toMatch(/task runtime/i);
    expect(lookupMessage('landing.heroTitle2', 'zh')).toMatch(/任务/);
  });
});
