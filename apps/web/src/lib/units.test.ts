import { describe, expect, it } from 'vitest';
import { lockedBudget, parseUnits } from './units';

describe('parseUnits', () => {
  it('turns non-empty lines into independent units', () => {
    expect(parseUnits('first\n\nsecond', 'lines')).toEqual([
      { label: 'Unit 0001', input: 'first' },
      { label: 'Unit 0002', input: 'second' },
    ]);
  });

  it('accepts wrapped JSONL units', () => {
    expect(parseUnits('{"$unit":{"label":"A","input":{"id":1}}}', 'jsonl')).toEqual([
      { label: 'A', input: { id: 1 }, expectedOutput: undefined },
    ]);
  });

  it('keeps ordinary objects with an input field intact', () => {
    expect(parseUnits('{"input":"business value","context":"kept"}', 'jsonl')).toEqual([
      {
        label: 'Unit 0001',
        input: { input: 'business value', context: 'kept' },
      },
    ]);
  });

  it('points to the invalid JSONL line', () => {
    expect(() => parseUnits('{"ok":true}\nnot-json', 'jsonl')).toThrow('第 2 行');
  });
});

describe('lockedBudget', () => {
  it('uses whole credit values', () => {
    expect(lockedBudget(20_000, 12)).toBe(240_000);
    expect(lockedBudget(-1, 12)).toBe(0);
  });
});
