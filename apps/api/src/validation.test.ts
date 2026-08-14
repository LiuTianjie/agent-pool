import { describe, expect, it } from 'vitest';

import {
  runnerSupportsRequest,
  validateOutputSchemaDefinition,
  validateTaskResult,
  validateTaskResultForCapsule,
} from './validation.js';

import type { TaskCapsule } from '@agent-pool/shared';

describe('automatic result validation', () => {
  it('checks non-empty output, JSON Schema, and expected output together', () => {
    const schema = {
      type: 'object',
      required: ['answer'],
      additionalProperties: false,
      properties: { answer: { type: 'string', minLength: 1 } },
    };
    expect(validateTaskResult({ answer: '42' }, schema, { answer: '42' }).valid).toBe(true);
    const mismatch = validateTaskResult({ answer: '' }, schema, { answer: '42' });
    expect(mismatch.valid).toBe(false);
    expect(mismatch.checks.schema).toBe(false);
    expect(mismatch.checks.expectedOutput).toBe(false);
    expect(validateTaskResult('', undefined).checks.nonEmpty).toBe(false);
  });

  it('requires exact model capability and never implies wildcard support', () => {
    const capabilities = [{ adapter: 'codex', supportedModels: ['gpt-5.4'] }];
    expect(runnerSupportsRequest(capabilities, 'codex', 'gpt-5.4')).toBe(true);
    expect(runnerSupportsRequest(capabilities, 'codex', 'gpt-5.5')).toBe(false);
    expect(runnerSupportsRequest(capabilities, 'claude', 'gpt-5.4')).toBe(false);
  });

  it('bounds publisher-provided output schema size, depth, and node count', () => {
    expect(
      validateOutputSchemaDefinition({ type: 'string', description: 'x'.repeat(65_536) }),
    ).toContain('Output schema must not exceed 64 KiB');

    let deeplyNested: Record<string, unknown> = { type: 'string' };
    for (let index = 0; index < 13; index += 1) {
      deeplyNested = { properties: { child: deeplyNested } };
    }
    expect(validateOutputSchemaDefinition(deeplyNested)).toContain(
      'Output schema nesting must not exceed 12 levels',
    );

    expect(
      validateOutputSchemaDefinition({
        type: 'string',
        enum: Array.from({ length: 501 }, () => 1),
      }),
    ).toContain('Output schema must not exceed 500 nodes');
  });

  it('applies the capsule acceptance mode without implicit non-empty checks', () => {
    const capsule = (mode: TaskCapsule['acceptance']['mode']): TaskCapsule => ({
      version: 'ap-task/1',
      goal: 'Return exactly the requested value',
      inputDescription: 'A single value',
      outputDescription: 'A single value',
      constraints: [],
      examples: [],
      delivery: {
        format: 'json',
        schema: { type: 'string' },
        maxBytes: 1024,
      },
      acceptance: { mode, criteria: ['Follow the selected acceptance mode.'] },
    });

    expect(validateTaskResultForCapsule('', capsule('schema')).valid).toBe(true);
    expect(validateTaskResultForCapsule('', capsule('hidden_exact'), '').valid).toBe(true);
    expect(validateTaskResultForCapsule('', capsule('non_empty')).valid).toBe(false);
    expect(validateTaskResultForCapsule('', capsule('schema_and_hidden_exact'), '').valid).toBe(
      true,
    );
  });

  it('normalizes hidden exact values recursively only when requested', () => {
    const normalizedCapsule: TaskCapsule = {
      version: 'ap-task/1',
      goal: 'Normalize an answer',
      inputDescription: 'Nested values',
      outputDescription: 'Equivalent nested values',
      constraints: [],
      examples: [],
      delivery: { format: 'json', maxBytes: 1024 },
      acceptance: {
        mode: 'hidden_exact',
        criteria: ['Whitespace, case, and small numeric differences are accepted.'],
        normalization: {
          trimStrings: true,
          collapseWhitespace: true,
          caseInsensitive: true,
          numericTolerance: 0.01,
        },
      },
    };

    const result = validateTaskResultForCapsule(
      { answer: '  HELLO   world ', score: 1.005 },
      normalizedCapsule,
      { answer: 'hello world', score: 1 },
    );
    expect(result.valid).toBe(true);
    expect(result.checks.normalization).toEqual(normalizedCapsule.acceptance.normalization);

    const outsideTolerance = validateTaskResultForCapsule(
      { answer: 'hello world', score: 1.02 },
      normalizedCapsule,
      { answer: 'hello world', score: 1 },
    );
    expect(outsideTolerance.valid).toBe(false);
  });

  it('treats manual checks as review information rather than automatic acceptance', () => {
    const manualCapsule: TaskCapsule = {
      version: 'ap-task/1',
      goal: 'Draft text',
      inputDescription: 'A private prompt',
      outputDescription: 'A publisher-reviewed draft',
      constraints: [],
      examples: [],
      delivery: { format: 'text', maxBytes: 1024 },
      acceptance: { mode: 'manual', criteria: ['Publisher approves the draft.'] },
    };
    const referenceChecks = validateTaskResultForCapsule('', manualCapsule);
    expect(referenceChecks.valid).toBe(false);
    expect(referenceChecks.mode).toBe('manual');
    expect(referenceChecks.errors[0]?.check).toBe('nonEmpty');
  });
});
