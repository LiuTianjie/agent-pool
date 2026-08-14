import { describe, expect, it } from 'vitest';
import { identitySignal, networkHandle, networkShortId } from './identity';

describe('network identity', () => {
  it('creates a compact unicode-safe handle', () => {
    expect(networkHandle('  Agent 主人  ')).toBe('agent-主人');
    expect(networkHandle('A!!! B')).toBe('a-b');
    expect(networkHandle('')).toBe('unclaimed');
  });

  it('keeps short IDs deterministic while names change', () => {
    expect(networkShortId('Nori')).toBe(networkShortId('Nori'));
    expect(networkShortId('Nori')).not.toBe(networkShortId('Mochi'));
    expect(networkShortId('')).toBe('------');
  });

  it('produces a stable boolean signal texture', () => {
    const signal = identitySignal('Nori');
    expect(signal).toHaveLength(24);
    expect(signal).toEqual(identitySignal('Nori'));
    expect(signal.some(Boolean)).toBe(true);
  });
});
