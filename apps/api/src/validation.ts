import { isDeepStrictEqual } from 'node:util';

import type { TaskAcceptanceNormalization, TaskCapsule } from '@agent-pool/shared';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

export const OUTPUT_SCHEMA_LIMITS = {
  maxBytes: 64 * 1024,
  maxDepth: 12,
  maxNodes: 500,
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new Map<string, ValidateFunction>();
const MAX_CACHED_POOL_VALIDATORS = 256;

export interface ValidationResult {
  valid: boolean;
  mode?: TaskCapsule['acceptance']['mode'];
  checks: {
    nonEmpty: boolean;
    deliveryFormat?: boolean;
    maxBytes?: boolean;
    schema?: boolean;
    expectedOutput?: boolean;
    normalization?: TaskAcceptanceNormalization;
  };
  errors: Array<{ check: string; message: string; path?: string }>;
}

export function validateOutputSchemaDefinition(schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return ['Output schema must be JSON-serializable'];
  }
  if (Buffer.byteLength(serialized, 'utf8') > OUTPUT_SCHEMA_LIMITS.maxBytes) {
    errors.push('Output schema must not exceed 64 KiB');
  }

  let nodes = 0;
  let deepest = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    deepest = Math.max(deepest, current.depth);
    if (nodes > OUTPUT_SCHEMA_LIMITS.maxNodes || deepest > OUTPUT_SCHEMA_LIMITS.maxDepth) break;
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  if (deepest > OUTPUT_SCHEMA_LIMITS.maxDepth) {
    errors.push(`Output schema nesting must not exceed ${OUTPUT_SCHEMA_LIMITS.maxDepth} levels`);
  }
  if (nodes > OUTPUT_SCHEMA_LIMITS.maxNodes) {
    errors.push(`Output schema must not exceed ${OUTPUT_SCHEMA_LIMITS.maxNodes} nodes`);
  }

  if (errors.length === 0) {
    try {
      ajv.compile(schema);
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `Invalid output schema: ${error.message}`
          : 'Invalid output schema',
      );
    }
  }
  return errors;
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export function validateTaskResult(
  result: unknown,
  outputSchema?: Record<string, unknown> | null,
  expectedOutput?: unknown,
  schemaCacheKey?: string,
): ValidationResult {
  const checks: ValidationResult['checks'] = { nonEmpty: isNonEmpty(result) };
  const errors: ValidationResult['errors'] = [];

  if (!checks.nonEmpty) {
    errors.push({ check: 'nonEmpty', message: 'Result must not be empty' });
  }

  if (outputSchema) {
    try {
      const validate = getOutputValidator(outputSchema, schemaCacheKey);
      checks.schema = validate(result);
      if (!checks.schema) {
        for (const error of validate.errors ?? []) {
          errors.push(schemaError(error));
        }
      }
    } catch (error) {
      checks.schema = false;
      errors.push({
        check: 'schema',
        message:
          error instanceof Error
            ? `Invalid output schema: ${error.message}`
            : 'Invalid output schema',
      });
    }
  }

  if (expectedOutput !== undefined) {
    checks.expectedOutput = isDeepStrictEqual(result, expectedOutput);
    if (!checks.expectedOutput) {
      errors.push({
        check: 'expectedOutput',
        message: 'Result does not match the expected output',
      });
    }
  }

  return { valid: errors.length === 0, checks, errors };
}

export function validateTaskResultForCapsule(
  result: unknown,
  capsule: TaskCapsule,
  expectedOutput?: unknown,
  schemaCacheKey?: string,
): ValidationResult {
  const mode = capsule.acceptance.mode;
  const checks: ValidationResult['checks'] = { nonEmpty: isNonEmpty(result) };
  const errors: ValidationResult['errors'] = [];
  checks.deliveryFormat = capsule.delivery.format === 'json' || typeof result === 'string';
  if (!checks.deliveryFormat) {
    errors.push({ check: 'deliveryFormat', message: 'Text delivery requires a string result' });
  }
  let serialized: string | undefined;
  try {
    serialized =
      capsule.delivery.format === 'text' && typeof result === 'string'
        ? result
        : JSON.stringify(result);
  } catch {
    serialized = undefined;
  }
  checks.maxBytes =
    serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= capsule.delivery.maxBytes;
  if (!checks.maxBytes) {
    errors.push({
      check: 'maxBytes',
      message: `Result exceeds the ${capsule.delivery.maxBytes} byte delivery limit`,
    });
  }

  const validateSchema = (): void => {
    const schema = capsule.delivery.schema;
    if (!schema) {
      checks.schema = false;
      errors.push({ check: 'schema', message: 'The task contract is missing delivery.schema' });
      return;
    }
    try {
      const validate = getOutputValidator(schema, schemaCacheKey);
      checks.schema = validate(result);
      if (!checks.schema) {
        for (const error of validate.errors ?? []) errors.push(schemaError(error));
      }
    } catch (error) {
      checks.schema = false;
      errors.push({
        check: 'schema',
        message:
          error instanceof Error
            ? `Invalid output schema: ${error.message}`
            : 'Invalid output schema',
      });
    }
  };
  const validateExpected = (): void => {
    if (expectedOutput === undefined) {
      checks.expectedOutput = false;
      errors.push({
        check: 'expectedOutput',
        message: 'The unit is missing a hidden expected output',
      });
      return;
    }
    const normalization = capsule.acceptance.normalization ?? {
      trimStrings: false,
      collapseWhitespace: false,
      caseInsensitive: false,
      numericTolerance: 0,
    };
    checks.normalization = normalization;
    checks.expectedOutput = normalizedEqual(result, expectedOutput, normalization);
    if (!checks.expectedOutput) {
      errors.push({
        check: 'expectedOutput',
        message: 'Result does not match the expected output',
      });
    }
  };

  switch (mode) {
    case 'non_empty':
      if (!checks.nonEmpty) errors.push({ check: 'nonEmpty', message: 'Result must not be empty' });
      break;
    case 'schema':
      validateSchema();
      break;
    case 'hidden_exact':
      validateExpected();
      break;
    case 'schema_and_hidden_exact':
      validateSchema();
      validateExpected();
      break;
    case 'manual':
      if (capsule.delivery.schema) validateSchema();
      if (expectedOutput !== undefined) validateExpected();
      if (!checks.nonEmpty) errors.push({ check: 'nonEmpty', message: 'Result must not be empty' });
      break;
    case 'webhook':
      errors.push({ check: 'webhook', message: 'Webhook tasks require a signed receipt' });
      break;
  }
  return { valid: errors.length === 0, mode, checks, errors };
}

function getOutputValidator(
  outputSchema: Record<string, unknown>,
  schemaCacheKey?: string,
): ValidateFunction {
  if (!schemaCacheKey) return ajv.compile(outputSchema);
  const cached = validatorCache.get(schemaCacheKey);
  if (cached) {
    validatorCache.delete(schemaCacheKey);
    validatorCache.set(schemaCacheKey, cached);
    return cached;
  }
  const validate = ajv.compile(outputSchema);
  if (validatorCache.size >= MAX_CACHED_POOL_VALIDATORS) {
    const oldestKey = validatorCache.keys().next().value as string | undefined;
    if (oldestKey) validatorCache.delete(oldestKey);
  }
  validatorCache.set(schemaCacheKey, validate);
  return validate;
}

function schemaError(error: ErrorObject): { check: string; message: string; path?: string } {
  return {
    check: 'schema',
    message: error.message ?? 'Schema validation failed',
    ...(error.instancePath ? { path: error.instancePath } : {}),
  };
}

function normalizedEqual(
  actual: unknown,
  expected: unknown,
  normalization: TaskAcceptanceNormalization,
): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) <= normalization.numericTolerance;
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    return normalizeString(actual, normalization) === normalizeString(expected, normalization);
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) => normalizedEqual(value, expected[index], normalization))
    );
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const actualKeys = Object.keys(actualRecord).sort();
    const expectedKeys = Object.keys(expectedRecord).sort();
    return (
      isDeepStrictEqual(actualKeys, expectedKeys) &&
      actualKeys.every((key) =>
        normalizedEqual(actualRecord[key], expectedRecord[key], normalization),
      )
    );
  }
  return isDeepStrictEqual(actual, expected);
}

function normalizeString(value: string, normalization: TaskAcceptanceNormalization): string {
  let normalized = normalization.trimStrings ? value.trim() : value;
  if (normalization.collapseWhitespace) normalized = normalized.replace(/\s+/g, ' ');
  if (normalization.caseInsensitive) normalized = normalized.toLocaleLowerCase('en-US');
  return normalized;
}

export function runnerSupportsRequest(
  capabilities: Array<{ adapter: string; supportedModels: string[] }>,
  requestedAgent: string,
  requestedModel: string,
): boolean {
  return capabilities.some(
    ({ adapter, supportedModels }) =>
      adapter === requestedAgent && supportedModels.includes(requestedModel),
  );
}
