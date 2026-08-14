import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import {
  canonicalJson,
  type CreatePoolInput,
  type TaskCapsule,
  type WebhookReceipt,
} from '@agent-pool/shared';

import { decryptJson } from './crypto.js';
import { invariant } from './errors.js';

export interface StoredDeliveryConfig {
  url: string;
  receiptSecret: string;
}

export function normalizeTaskCapsule(input: CreatePoolInput): TaskCapsule {
  if (input.taskCapsule) return input.taskCapsule;
  const hasExpected = input.units.some((unit) => unit.expectedOutput !== undefined);
  const requiresJsonDelivery =
    !!input.outputSchema ||
    input.units.some(
      (unit) => unit.expectedOutput !== undefined && typeof unit.expectedOutput !== 'string',
    );
  const acceptanceMode =
    input.validationMode === 'manual'
      ? 'manual'
      : input.outputSchema && hasExpected
        ? 'schema_and_hidden_exact'
        : input.outputSchema
          ? 'schema'
          : hasExpected
            ? 'hidden_exact'
            : 'non_empty';
  return {
    version: 'ap-task/1',
    goal: input.title,
    inputDescription: input.publicSummary,
    outputDescription: input.secretInstruction!,
    constraints: [],
    examples: [],
    delivery: {
      format: requiresJsonDelivery ? 'json' : 'text',
      ...(input.outputSchema ? { schema: input.outputSchema } : {}),
      maxBytes: 8 * 1024 * 1024,
    },
    acceptance: {
      mode: acceptanceMode,
      criteria: [input.secretInstruction!],
    },
  };
}

export function renderTaskInstruction(capsule: TaskCapsule): string {
  const constraints =
    capsule.constraints.length > 0
      ? `\nConstraints:\n${capsule.constraints.map((item) => `- ${item}`).join('\n')}`
      : '';
  return `${capsule.goal}\n\nInput: ${capsule.inputDescription}\nOutput: ${capsule.outputDescription}${constraints}`;
}

export function contractHash(capsule: TaskCapsule): string {
  return sha256(canonicalJson(capsule));
}

export function legacyContractHash(poolId: string): string {
  return sha256(`agentpool-legacy-contract:${poolId}`);
}

export function taskCapsuleFromPoolRow(
  row: Record<string, unknown>,
  encryptionKey: Buffer,
): TaskCapsule {
  if (typeof row.task_capsule_ciphertext === 'string' && row.task_capsule_ciphertext) {
    return decryptJson<TaskCapsule>(row.task_capsule_ciphertext, encryptionKey);
  }
  const instruction = decryptJson<string>(String(row.secret_instruction_ciphertext), encryptionKey);
  const schema = isRecord(row.output_schema) ? row.output_schema : undefined;
  return {
    version: 'ap-task/1',
    goal: String(row.title ?? 'Legacy Agent Pool task'),
    inputDescription: String(row.public_summary ?? 'See the unit input.'),
    outputDescription: instruction,
    constraints: [],
    examples: [],
    delivery: {
      format: schema ? 'json' : 'text',
      ...(schema ? { schema } : {}),
      maxBytes: 8 * 1024 * 1024,
    },
    acceptance: {
      mode: row.validation_mode === 'manual' ? 'manual' : schema ? 'schema' : 'non_empty',
      criteria: [instruction],
    },
  };
}

export function contractHashFromPoolRow(row: Record<string, unknown>): string {
  return typeof row.contract_hash === 'string' && /^[0-9a-f]{64}$/.test(row.contract_hash)
    ? row.contract_hash
    : legacyContractHash(String(row.id ?? row.pool_id));
}

export function validateTaskContractInput(input: CreatePoolInput, capsule: TaskCapsule): void {
  if (
    input.taskCapsule &&
    ['hidden_exact', 'schema_and_hidden_exact'].includes(capsule.acceptance.mode)
  ) {
    invariant(
      input.units.every((unit) => unit.expectedOutput !== undefined),
      400,
      'EXPECTED_OUTPUT_REQUIRED',
      'Every unit requires expectedOutput for hidden exact acceptance',
    );
    if (capsule.delivery.format === 'text') {
      invariant(
        input.units.every((unit) => typeof unit.expectedOutput === 'string'),
        400,
        'TEXT_EXPECTED_OUTPUT_INVALID',
        'Text delivery requires string expectedOutput values',
      );
    }
  }
  if (input.deliveryTarget.mode === 'webhook') {
    validateWebhookUrl(input.deliveryTarget.url);
    const labels = input.units.map((unit) => unit.label?.trim()).filter(Boolean) as string[];
    invariant(
      labels.length === input.units.length,
      400,
      'WEBHOOK_UNIT_REFERENCE_REQUIRED',
      'Webhook delivery requires a non-empty label on every unit',
    );
    invariant(
      new Set(labels).size === labels.length,
      400,
      'WEBHOOK_UNIT_REFERENCE_DUPLICATE',
      'Webhook unit labels must be unique within the pool',
    );
  }
}

export function validateWebhookUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invariant(false, 400, 'INVALID_WEBHOOK_URL', 'Webhook URL is invalid');
  }
  invariant(url.protocol === 'https:', 400, 'INVALID_WEBHOOK_URL', 'Webhook URL must use HTTPS');
  invariant(
    !url.username && !url.password,
    400,
    'INVALID_WEBHOOK_URL',
    'Webhook URL must not contain credentials',
  );
  invariant(!url.hash, 400, 'INVALID_WEBHOOK_URL', 'Webhook URL must not contain a fragment');
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  invariant(
    hostname !== 'localhost' &&
      !hostname.endsWith('.localhost') &&
      !hostname.endsWith('.local') &&
      !hostname.endsWith('.internal'),
    400,
    'INVALID_WEBHOOK_URL',
    'Webhook URL must not target localhost',
  );
  const ipVersion = isIP(hostname);
  invariant(
    ipVersion === 0 || !isPrivateLiteral(hostname, ipVersion),
    400,
    'INVALID_WEBHOOK_URL',
    'Webhook URL must not target a private IP literal',
  );
}

export function receiptSigningPayload(receipt: Omit<WebhookReceipt, 'signature'>): string {
  return JSON.stringify({
    protocol: receipt.protocol,
    leaseId: receipt.leaseId,
    unitId: receipt.unitId,
    contractHash: receipt.contractHash,
    resultSha256: receipt.resultSha256,
    decision: receipt.decision,
    retryable: receipt.retryable,
    receiptId: receipt.receiptId,
    reason: receipt.reason ?? null,
  });
}

export function verifyReceiptSignature(receipt: WebhookReceipt, secret: string): boolean {
  const { signature, ...claims } = receipt;
  const expected = createHmac('sha256', secret).update(receiptSigningPayload(claims)).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function receiptRequestDigest(receipt: WebhookReceipt): string {
  return sha256(canonicalJson(receipt));
}

export function resultDigest(result: unknown): string {
  return sha256(canonicalJson(result));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPrivateLiteral(hostname: string, version: number): boolean {
  if (version === 6) {
    const normalized = hostname.toLowerCase();
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  }
  const parts = hostname.split('.').map(Number);
  const [first = 0, second = 0] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}
