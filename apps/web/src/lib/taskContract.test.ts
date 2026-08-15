import { describe, expect, it } from 'vitest';
import {
  acceptanceChecks,
  attachPublishDataset,
  callbackExample,
  compileAgentInstruction,
  expectedOutputCoverage,
  generateReceiptSecret,
  inlineUnitLimitMessage,
  isHttpsDatasetUrl,
  isHttpsWebhook,
  parseConstraints,
  parseJsonObject,
  receiptExample,
  resolvePublishUnitCount,
  unitReferenceIssues,
} from './taskContract';
import { INLINE_UNIT_MAX } from '@agent-pool/shared';

describe('task capsule contract helpers', () => {
  it('turns multiline constraints into stable chips', () => {
    expect(parseConstraints('Only JSON\nNo markdown，Only JSON')).toEqual([
      'Only JSON',
      'No markdown',
    ]);
  });

  it('reports JSON object parse state without calling it quality validation', () => {
    expect(parseJsonObject('{"type":"object"}').value).toEqual({ type: 'object' });
    expect(parseJsonObject('[]').error).toBe('必须是 JSON 对象');
    expect(parseJsonObject('{').error).toBeTruthy();
  });

  it('calculates hidden exact coverage and readiness', () => {
    const coverage = expectedOutputCoverage([{ input: 1, expectedOutput: 2 }, { input: 2 }]);
    expect(coverage).toEqual({ covered: 1, total: 2, percent: 50 });
    expect(acceptanceChecks('hidden_exact', coverage, false).at(-1)?.ready).toBe(false);
  });

  it('generates a 32-byte receipt secret and accepts HTTPS only', () => {
    expect(generateReceiptSecret()).toMatch(/^[a-f0-9]{64}$/);
    expect(isHttpsWebhook('https://hooks.example.com/a-long-random-path')).toBe(true);
    expect(isHttpsWebhook('http://hooks.example.com/path')).toBe(false);
  });

  it('finds missing and duplicate external reference IDs', () => {
    expect(
      unitReferenceIssues([{ label: 'same', input: 1 }, { label: 'same', input: 2 }, { input: 3 }]),
    ).toEqual(['1 条任务缺少外部引用 ID', '外部引用 ID 重复：same']);
  });

  it('renders protocol-accurate webhook examples with a redacted signature', () => {
    const delivery = JSON.parse(callbackExample()) as Record<string, unknown>;
    const receipt = JSON.parse(receiptExample()) as Record<string, unknown>;
    expect(delivery.protocol).toBe('agentpool-delivery/1');
    expect(delivery).toMatchObject({
      unit: { reference: 'question-0001', ordinal: 0, input: { expression: '2 + 2' } },
    });
    expect(receipt.protocol).toBe('agentpool-receipt/1');
    expect(receipt.signature).toBe('[REDACTED]');
  });

  it('keeps the inline unit cap out of publisher-facing copy', () => {
    expect(inlineUnitLimitMessage()).not.toMatch(/20[,.]?000|20000/);
    expect(INLINE_UNIT_MAX).toBe(20_000);
  });

  it('accepts HTTPS dataset URLs and rejects other schemes', () => {
    expect(isHttpsDatasetUrl('https://files.example.com/batch.jsonl')).toBe(true);
    expect(isHttpsDatasetUrl('http://files.example.com/batch.jsonl')).toBe(false);
  });

  it('omits inline units when publishing an HTTPS dataset', () => {
    const payload = attachPublishDataset(
      {
        title: 'Batch',
        category: 'data',
        publicSummary: 'Remote JSONL stays with the publisher',
        requestedAgent: 'codex',
        requestedModel: 'gpt-5.4',
        requiredConcurrency: 2,
        maxUnitSeconds: 60,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        rewardPerUnit: 4,
        validationMode: 'auto',
        taskCapsule: {
          version: 'ap-task/1',
          goal: 'Answer each row',
          inputDescription: 'One JSON object per line',
          outputDescription: 'Any non-empty result',
          constraints: [],
          examples: [{ input: { q: 1 }, output: 'ok' }],
          delivery: { format: 'text', maxBytes: 1024 },
          acceptance: { mode: 'non_empty', criteria: ['non-empty'] },
        },
        deliveryTarget: { mode: 'platform' },
        launchMode: 'pilot',
        pilotUnits: 2,
      },
      { mode: 'https', url: 'https://files.example.com/batch.jsonl' },
      [{ input: 'should-not-be-sent' }],
    );
    expect(payload.dataset).toEqual({
      mode: 'https',
      url: 'https://files.example.com/batch.jsonl',
    });
    expect(payload.units).toBeUndefined();
  });

  it('keeps inline units when the dataset stays on the platform', () => {
    const units = [{ input: 'a' }, { input: 'b' }];
    const payload = attachPublishDataset(
      {
        title: 'Pasted',
        category: 'text',
        publicSummary: 'Pasted rows are stored inline',
        requestedAgent: 'codex',
        requestedModel: 'gpt-5.4',
        requiredConcurrency: 1,
        maxUnitSeconds: 60,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        rewardPerUnit: 4,
        validationMode: 'auto',
        taskCapsule: {
          version: 'ap-task/1',
          goal: 'Answer each row',
          inputDescription: 'One line per task',
          outputDescription: 'Any non-empty result',
          constraints: [],
          examples: [{ input: 'a', output: 'ok' }],
          delivery: { format: 'text', maxBytes: 1024 },
          acceptance: { mode: 'non_empty', criteria: ['non-empty'] },
        },
        deliveryTarget: { mode: 'platform' },
        launchMode: 'pilot',
        pilotUnits: 2,
      },
      { mode: 'inline' },
      units,
    );
    expect(payload.dataset).toEqual({ mode: 'inline' });
    expect(payload.units).toEqual(units);
  });

  it('uses the remote count for HTTPS datasets and local rows for paste', () => {
    expect(
      resolvePublishUnitCount({ mode: 'https', url: 'https://files.example.com/a.jsonl' }, [], 128),
    ).toBe(128);
    expect(resolvePublishUnitCount({ mode: 'inline' }, [{ input: 1 }, { input: 2 }], 128)).toBe(2);
  });

  it('previews the same delimited task-capsule protocol used by the runner', () => {
    const prompt = compileAgentInstruction({
      goal: 'Return a result',
      inputDescription: 'One record',
      outputDescription: 'One JSON object',
      constraints: ['Preserve <id>'],
      examples: [{ input: '{"id":1}', output: '{"ok":true}', note: '' }],
      format: 'json',
      acceptanceMode: 'schema',
      schema: { type: 'object' },
      criteria: ['Check JSON structure only'],
    });
    expect(prompt).toContain('<agent-pool-task-capsule encoding="json">');
    expect(prompt).toContain('[ONE UNIT INPUT IS INSERTED HERE]');
    expect(prompt).toContain('Preserve \\u003cid\\u003e');
  });
});
