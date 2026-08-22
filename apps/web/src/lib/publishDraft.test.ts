import { describe, expect, it } from 'vitest';
import {
  PUBLISH_DRAFT_KEY,
  clearPublishDraft,
  parsePublishDraft,
  readPublishDraft,
  restorePublishDeadline,
  writePublishDraft,
  type PublishDraftV1,
} from './publishDraft';

function memoryStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

const draft: PublishDraftV1 = {
  v: 1,
  step: 2,
  source: 'work',
  workUrl: 'https://example.com/work.json',
  workPreview: null,
  title: 'Draft pool',
  category: 'text',
  goal: '',
  inputDescription: '',
  outputDescription: '',
  constraintsRaw: '',
  examples: [{ input: '', output: '', note: '' }],
  datasetUrl: '',
  datasetHost: null,
  remoteUnitCount: 0,
  datasetCheckedUrl: '',
  rawUnits: '',
  parseMode: 'jsonl',
  units: [],
  acceptanceMode: 'non_empty',
  deliveryFormat: 'text',
  schemaText: '',
  deliveryTarget: 'platform',
  webhookUrl: '',
  receiptSecret: 'secret',
  requestedAgent: 'mock',
  requestedModel: 'mock-v1',
  requiredConcurrency: 3,
  maxUnitSeconds: 120,
  deadlineAt: '2099-01-01T12:00',
  rewardPerUnit: 10,
  launchMode: 'pilot',
  pilotUnits: 3,
};

describe('publish draft', () => {
  it('round-trips a wizard snapshot through storage', () => {
    const storage = memoryStorage();
    writePublishDraft(draft, storage);
    expect(storage.data[PUBLISH_DRAFT_KEY]).toBeTruthy();
    expect(readPublishDraft(storage)?.requestedModel).toBe('mock-v1');
    expect(readPublishDraft(storage)?.step).toBe(2);
    clearPublishDraft(storage);
    expect(readPublishDraft(storage)).toBeNull();
  });

  it('rejects unknown versions and refreshes expired deadlines', () => {
    expect(parsePublishDraft({ v: 2, step: 1, source: 'work' })).toBeNull();
    expect(restorePublishDeadline('2000-01-01T00:00', Date.parse('2026-08-23T00:00:00Z'))).not.toBe(
      '2000-01-01T00:00',
    );
  });
});
