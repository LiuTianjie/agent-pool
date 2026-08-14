import { describe, expect, it } from 'vitest';
import {
  acceptanceChecks,
  callbackExample,
  compileAgentInstruction,
  expectedOutputCoverage,
  generateReceiptSecret,
  isHttpsWebhook,
  parseConstraints,
  parseJsonObject,
  receiptExample,
  unitReferenceIssues,
} from './taskContract';

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
    ).toEqual(['1 个 Unit 缺少外部引用 ID', '外部引用 ID 重复：same']);
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
