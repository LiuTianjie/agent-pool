import { afterEach, describe, expect, it } from 'vitest';
import { detectLocale, listJoin, setActiveLocale } from './locale';
import { interpolate } from './translate';

describe('locale helpers', () => {
  afterEach(() => {
    setActiveLocale('zh');
  });

  it('prefers an explicit lang query', () => {
    expect(detectLocale('?lang=en')).toBe('en');
    expect(detectLocale('?lang=zh')).toBe('zh');
    expect(detectLocale('?lang=de')).toBe('zh');
  });

  it('defaults to Chinese when no query is present', () => {
    expect(detectLocale('')).toBe('zh');
  });

  it('interpolates named placeholders and leaves unknown ones intact', () => {
    expect(interpolate('Hello {name}', { name: 'Nori' })).toBe('Hello Nori');
    expect(interpolate('Hello {name}', {})).toBe('Hello {name}');
  });

  it('joins lists with locale punctuation', () => {
    expect(listJoin(['A', 'B'], 'zh')).toBe('A、B');
    expect(listJoin(['A', 'B'], 'en')).toBe('A, B');
  });
});
