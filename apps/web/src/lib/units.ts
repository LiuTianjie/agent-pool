import type { TaskUnitDraft } from './unitTypes';

export type UnitParseMode = 'lines' | 'jsonl';

function labelFor(index: number): string {
  return `Unit ${String(index + 1).padStart(4, '0')}`;
}

export function parseUnits(raw: string, mode: UnitParseMode): TaskUnitDraft[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (mode === 'lines') {
    return lines.map((input, index) => ({ label: labelFor(index), input }));
  }

  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`第 ${index + 1} 行不是有效 JSON`);
    }

    if (value && typeof value === 'object' && !Array.isArray(value) && '$unit' in value) {
      const envelope = (value as { $unit?: unknown }).$unit;
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new Error(`第 ${index + 1} 行的 $unit 必须是对象`);
      }
      if (!('input' in envelope)) {
        throw new Error(`第 ${index + 1} 行的 $unit 缺少 input`);
      }
      const item = envelope as { label?: unknown; input: unknown; expectedOutput?: unknown };
      return {
        label: typeof item.label === 'string' ? item.label.slice(0, 120) : labelFor(index),
        input: item.input,
        expectedOutput: item.expectedOutput,
      };
    }

    return { label: labelFor(index), input: value };
  });
}

export function lockedBudget(unitCount: number, rewardPerUnit: number): number {
  if (!Number.isFinite(unitCount) || !Number.isFinite(rewardPerUnit)) return 0;
  return Math.max(0, Math.trunc(unitCount)) * Math.max(0, Math.trunc(rewardPerUnit));
}

export function printableValue(value: unknown, maxLength = 180): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '—';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
