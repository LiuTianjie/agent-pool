import type { AgentAdapter, LeasePayload } from './types.js';
import { taskCapsuleHash, validateTaskCapsule } from './task-contract.js';
import { validateWebhookUrl } from './webhook.js';

const AGENTS = new Set(['codex', 'claude', 'mock']);
const CATEGORIES = new Set(['text', 'data', 'coding', 'research', 'math', 'vision', 'other']);

export function validateLease(value: unknown): LeasePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid lease payload.');
  }
  const lease = value as Record<string, unknown>;
  const requiredStrings = [
    'leaseId',
    'unitId',
    'poolId',
    'category',
    'requestedAgent',
    'requestedModel',
    'instruction',
    'expiresAt',
  ];
  if (requiredStrings.some((key) => typeof lease[key] !== 'string' || !lease[key])) {
    throw new Error('Invalid lease payload.');
  }
  if (!AGENTS.has(lease.requestedAgent as string)) throw new Error('Invalid lease payload.');
  if (!CATEGORIES.has(lease.category as string)) throw new Error('Invalid lease payload.');
  if (!Object.prototype.hasOwnProperty.call(lease, 'input')) {
    throw new Error('Invalid lease payload.');
  }
  if (typeof lease.reward !== 'number' || !Number.isSafeInteger(lease.reward) || lease.reward < 0) {
    throw new Error('Invalid lease payload.');
  }
  if (
    lease.outputSchema !== undefined &&
    (typeof lease.outputSchema !== 'object' ||
      lease.outputSchema === null ||
      Array.isArray(lease.outputSchema))
  ) {
    throw new Error('Invalid lease payload.');
  }
  if (!Number.isFinite(Date.parse(lease.expiresAt as string))) {
    throw new Error('Invalid lease payload.');
  }
  if (lease.taskCapsule !== undefined) {
    const taskCapsule = validateTaskCapsule(lease.taskCapsule);
    if (typeof lease.contractHash !== 'string' || !/^[0-9a-f]{64}$/u.test(lease.contractHash)) {
      throw new Error('Invalid lease payload.');
    }
    if (taskCapsuleHash(taskCapsule) !== lease.contractHash) {
      throw new Error('Invalid lease payload.');
    }
    lease.taskCapsule = taskCapsule;
  }
  if (lease.attemptFeedback !== undefined) {
    if (
      typeof lease.attemptFeedback !== 'object' ||
      lease.attemptFeedback === null ||
      Array.isArray(lease.attemptFeedback)
    ) {
      throw new Error('Invalid lease payload.');
    }
    const feedback = lease.attemptFeedback as Record<string, unknown>;
    if (
      !Number.isSafeInteger(feedback.attempt) ||
      (feedback.attempt as number) < 1 ||
      typeof feedback.reason !== 'string' ||
      !feedback.reason.trim() ||
      feedback.reason.length > 4_000 ||
      (feedback.validation !== undefined &&
        (typeof feedback.validation !== 'object' ||
          feedback.validation === null ||
          Array.isArray(feedback.validation)))
    ) {
      throw new Error('Invalid lease payload.');
    }
    lease.attemptFeedback = {
      attempt: feedback.attempt,
      reason: feedback.reason,
      ...(feedback.validation === undefined ? {} : { validation: feedback.validation }),
    };
  }
  if (lease.delivery !== undefined) {
    if (
      typeof lease.delivery !== 'object' ||
      lease.delivery === null ||
      Array.isArray(lease.delivery)
    ) {
      throw new Error('Invalid lease payload.');
    }
    const delivery = lease.delivery as Record<string, unknown>;
    if (delivery.mode === 'platform') {
      lease.delivery = { mode: 'platform' };
    } else if (delivery.mode === 'webhook') {
      if (
        delivery.protocol !== 'agentpool-webhook/1' ||
        typeof delivery.url !== 'string' ||
        !delivery.url ||
        delivery.url.length > 2_048 ||
        typeof delivery.unitReference !== 'string' ||
        !delivery.unitReference ||
        delivery.unitReference.length > 500 ||
        !Number.isSafeInteger(delivery.ordinal) ||
        (delivery.ordinal as number) < 0 ||
        typeof lease.contractHash !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(lease.contractHash)
      ) {
        throw new Error('Invalid lease payload.');
      }
      validateWebhookUrl(delivery.url);
      lease.delivery = {
        mode: 'webhook',
        url: delivery.url,
        protocol: 'agentpool-webhook/1',
        unitReference: delivery.unitReference,
        ordinal: delivery.ordinal,
      };
    } else {
      throw new Error('Invalid lease payload.');
    }
  }
  const webhookDelivery =
    typeof lease.delivery === 'object' &&
    lease.delivery !== null &&
    !Array.isArray(lease.delivery) &&
    (lease.delivery as Record<string, unknown>).mode === 'webhook';
  const webhookAcceptance =
    typeof lease.taskCapsule === 'object' &&
    lease.taskCapsule !== null &&
    (lease.taskCapsule as { acceptance?: { mode?: unknown } }).acceptance?.mode === 'webhook';
  if (webhookDelivery !== webhookAcceptance) {
    throw new Error('Invalid lease payload.');
  }
  return lease as unknown as LeasePayload;
}

export function leaseMatchesCapability(
  lease: LeasePayload,
  adapter: AgentAdapter,
  allowedModels: readonly string[],
): boolean {
  return lease.requestedAgent === adapter && allowedModels.includes(lease.requestedModel);
}

export function normalizeAllowedModels(models: readonly string[]): string[] {
  const normalized = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  if (normalized.some((model) => model === '*' || model.toLowerCase() === 'any')) {
    throw new Error(
      'Wildcard models are not allowed. Declare each exact model with --allow-model.',
    );
  }
  if (normalized.length === 0) {
    throw new Error('At least one exact model is required via --allow-model.');
  }
  if (normalized.some((model) => model.length > 120)) {
    throw new Error('Model identifiers must be 120 characters or fewer.');
  }
  return normalized;
}
