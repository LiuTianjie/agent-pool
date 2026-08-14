import { createHash } from 'node:crypto';
import type {
  DeliveryFormat,
  LeasePayload,
  TaskAcceptanceMode,
  TaskAcceptanceNormalization,
  TaskCapsule,
} from './types.js';

export const MAX_DELIVERY_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const ACCEPTANCE_MODES = new Set<TaskAcceptanceMode>([
  'non_empty',
  'schema',
  'hidden_exact',
  'schema_and_hidden_exact',
  'manual',
  'webhook',
]);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Value is not JSON-serializable.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  throw new Error('Value is not JSON-serializable.');
}

export function taskCapsuleHash(capsule: TaskCapsule): string {
  return createHash('sha256').update(canonicalJson(capsule), 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, maximum = 20_000): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error('Invalid task capsule.');
  }
  return value.trim();
}

function requireStrings(value: unknown, minimumItems: number, maximumItems: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimumItems ||
    value.length > maximumItems ||
    value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2_000)
  ) {
    throw new Error('Invalid task capsule.');
  }
  return (value as string[]).map((item) => item.trim());
}

function validateNormalization(value: unknown): TaskAcceptanceNormalization {
  if (!isRecord(value)) throw new Error('Invalid task capsule.');
  const numericTolerance = value.numericTolerance;
  if (
    typeof value.trimStrings !== 'boolean' ||
    typeof value.collapseWhitespace !== 'boolean' ||
    typeof value.caseInsensitive !== 'boolean' ||
    typeof numericTolerance !== 'number' ||
    !Number.isFinite(numericTolerance) ||
    numericTolerance < 0
  ) {
    throw new Error('Invalid task capsule.');
  }
  return {
    trimStrings: value.trimStrings,
    collapseWhitespace: value.collapseWhitespace,
    caseInsensitive: value.caseInsensitive,
    numericTolerance,
  };
}

export function validateTaskCapsule(value: unknown): TaskCapsule {
  if (!isRecord(value) || value.version !== 'ap-task/1') {
    throw new Error('Invalid task capsule.');
  }
  const delivery = value.delivery;
  const acceptance = value.acceptance;
  if (!isRecord(delivery) || !isRecord(acceptance)) {
    throw new Error('Invalid task capsule.');
  }
  if (delivery.format !== 'text' && delivery.format !== 'json') {
    throw new Error('Invalid task capsule.');
  }
  if (
    !Number.isSafeInteger(delivery.maxBytes) ||
    (delivery.maxBytes as number) < 1 ||
    (delivery.maxBytes as number) > MAX_DELIVERY_BYTES
  ) {
    throw new Error('Invalid task capsule.');
  }
  if (delivery.schema !== undefined && (!isRecord(delivery.schema) || delivery.format !== 'json')) {
    throw new Error('Invalid task capsule.');
  }
  if (!Array.isArray(value.examples) || value.examples.length > 20) {
    throw new Error('Invalid task capsule.');
  }
  const examples = value.examples.map((example) => {
    if (
      !isRecord(example) ||
      !Object.prototype.hasOwnProperty.call(example, 'input') ||
      !Object.prototype.hasOwnProperty.call(example, 'output') ||
      (example.note !== undefined &&
        (typeof example.note !== 'string' || !example.note.trim() || example.note.length > 2_000))
    ) {
      throw new Error('Invalid task capsule.');
    }
    return {
      input: example.input,
      output: example.output,
      ...(example.note === undefined ? {} : { note: (example.note as string).trim() }),
    };
  });
  const mode = acceptance.mode;
  if (typeof mode !== 'string' || !ACCEPTANCE_MODES.has(mode as TaskAcceptanceMode)) {
    throw new Error('Invalid task capsule.');
  }
  if ((mode === 'schema' || mode === 'schema_and_hidden_exact') && delivery.schema === undefined) {
    throw new Error('Invalid task capsule.');
  }
  if (
    acceptance.normalization !== undefined &&
    mode !== 'hidden_exact' &&
    mode !== 'schema_and_hidden_exact'
  ) {
    throw new Error('Invalid task capsule.');
  }
  const normalization =
    acceptance.normalization === undefined
      ? undefined
      : validateNormalization(acceptance.normalization);

  return {
    version: 'ap-task/1',
    goal: requireString(value, 'goal'),
    inputDescription: requireString(value, 'inputDescription'),
    outputDescription: requireString(value, 'outputDescription'),
    constraints: requireStrings(value.constraints, 0, 50),
    examples,
    delivery: {
      format: delivery.format,
      ...(delivery.schema === undefined
        ? {}
        : { schema: delivery.schema as Record<string, unknown> }),
      maxBytes: delivery.maxBytes as number,
    },
    acceptance: {
      mode: mode as TaskAcceptanceMode,
      criteria: requireStrings(acceptance.criteria, 1, 50),
      ...(normalization ? { normalization } : {}),
    },
  };
}

export function deliveryFormatForLease(lease: LeasePayload): DeliveryFormat {
  return lease.taskCapsule?.delivery.format ?? (lease.outputSchema ? 'json' : 'text');
}

export function outputSchemaForLease(lease: LeasePayload): Record<string, unknown> | undefined {
  if (lease.taskCapsule) {
    if (lease.taskCapsule.delivery.format !== 'json') return undefined;
    return lease.taskCapsule.delivery.schema;
  }
  return lease.outputSchema;
}

export function maxDeliveryBytesForLease(lease: LeasePayload): number {
  return lease.taskCapsule?.delivery.maxBytes ?? MAX_DELIVERY_BYTES;
}

export function processOutputLimitForLease(lease: LeasePayload): number {
  const deliveryBytes = maxDeliveryBytesForLease(lease);
  return Math.min(MAX_PROCESS_OUTPUT_BYTES, Math.max(64 * 1024, deliveryBytes * 2 + 64 * 1024));
}

export function parseTaskResult(text: string, lease: LeasePayload): unknown {
  if (deliveryFormatForLease(lease) === 'text') return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('invalid_output');
  }
}

export function serializeResult(output: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(output);
  } catch {
    throw new Error('invalid_output');
  }
  if (serialized === undefined) throw new Error('invalid_output');
  return serialized;
}

export function assertResultMatchesContract(lease: LeasePayload, output: unknown): string {
  const format = deliveryFormatForLease(lease);
  if (lease.taskCapsule && format === 'text' && typeof output !== 'string') {
    throw new Error('invalid_output');
  }
  const serialized = serializeResult(output);
  const deliveryBytes =
    lease.taskCapsule && format === 'text' && typeof output === 'string'
      ? Buffer.byteLength(output, 'utf8')
      : Buffer.byteLength(serialized, 'utf8');
  if (deliveryBytes > maxDeliveryBytesForLease(lease)) {
    throw new Error('invalid_output');
  }
  return serialized;
}

export function resultSha256(output: unknown): string {
  return createHash('sha256').update(canonicalJson(output), 'utf8').digest('hex');
}
