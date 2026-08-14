import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { LeasePayload, WebhookReceipt } from './types.js';
import { assertResultMatchesContract, resultSha256 } from './task-contract.js';

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_WEBHOOK_ATTEMPTS = 4;
const BLOCKED_ADDRESSES = new BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(address, prefix, 'ipv4');
}

for (const [address, prefix] of [
  ['::', 96],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(address, prefix, 'ipv6');
}

export interface ResolvedWebhookTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

type ResolveAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

interface WebhookHttpResponse {
  status: number;
  body: string;
}

export interface WebhookDeliveryOptions {
  resolveAll?: ResolveAll;
  post?: (
    target: ResolvedWebhookTarget,
    body: string,
    timeoutMs: number,
  ) => Promise<WebhookHttpResponse>;
}

class WebhookPolicyError extends Error {}

class WebhookTransportError extends Error {
  constructor(readonly retryable: boolean) {
    super('Webhook delivery failed.');
  }
}

function withTransportTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        reject(new WebhookTransportError(true));
      },
      Math.max(1, timeoutMs),
    );
    timer.unref();
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
}

export function validateWebhookUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookPolicyError('Webhook URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new WebhookPolicyError('Webhook URL is not allowed.');
  }
  const hostname = normalizedHostname(url);
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new WebhookPolicyError('Webhook URL is not allowed.');
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new WebhookPolicyError('Webhook URL is not allowed.');
  }
  return url;
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '').split('%', 1)[0] ?? '';
  const family = isIP(normalized);
  if (family === 4) return !BLOCKED_ADDRESSES.check(normalized, 'ipv4');
  if (family === 6) {
    if (normalized.toLowerCase().startsWith('::ffff:')) return false;
    return !BLOCKED_ADDRESSES.check(normalized, 'ipv6');
  }
  return false;
}

export async function resolveWebhookTarget(
  rawUrl: string,
  resolveAll: ResolveAll = async (hostname) =>
    await dnsLookup(hostname, { all: true, verbatim: true }),
): Promise<ResolvedWebhookTarget> {
  const url = validateWebhookUrl(rawUrl);
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolveAll(hostname);
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) => (family !== 4 && family !== 6) || !isPublicAddress(address),
    )
  ) {
    throw new WebhookPolicyError('Webhook DNS target is not allowed.');
  }
  const selected = addresses[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export function createPinnedLookup(target: ResolvedWebhookTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

function postPinnedWebhook(
  target: ResolvedWebhookTarget,
  body: string,
  timeoutMs: number,
): Promise<WebhookHttpResponse> {
  return new Promise<WebhookHttpResponse>((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
    let settled = false;
    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = httpsRequest(
      target.url,
      {
        method: 'POST',
        agent: false,
        signal,
        headers: {
          Accept: 'application/json',
          Connection: 'close',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
        lookup: createPinnedLookup(target),
      },
      (response) => {
        let responseBody = '';
        let responseBytes = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          responseBytes += Buffer.byteLength(chunk, 'utf8');
          if (responseBytes > MAX_RECEIPT_BYTES) {
            response.destroy(new WebhookPolicyError('Webhook receipt is too large.'));
            return;
          }
          responseBody += chunk;
        });
        response.on('error', finishWithError);
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ status: response.statusCode ?? 0, body: responseBody });
        });
      },
    );
    request.on('error', finishWithError);
    request.end(body);
  });
}

export function validateWebhookReceipt(
  value: unknown,
  claims: {
    leaseId: string;
    unitId: string;
    contractHash: string;
    resultSha256: string;
  },
): WebhookReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WebhookPolicyError('Webhook receipt is invalid.');
  }
  const receipt = value as Record<string, unknown>;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (
    receipt.protocol !== 'agentpool-receipt/1' ||
    typeof receipt.leaseId !== 'string' ||
    !uuidPattern.test(receipt.leaseId) ||
    receipt.leaseId !== claims.leaseId ||
    typeof receipt.unitId !== 'string' ||
    !uuidPattern.test(receipt.unitId) ||
    receipt.unitId !== claims.unitId ||
    receipt.contractHash !== claims.contractHash ||
    receipt.resultSha256 !== claims.resultSha256 ||
    (receipt.decision !== 'accepted' && receipt.decision !== 'rejected') ||
    typeof receipt.retryable !== 'boolean' ||
    typeof receipt.receiptId !== 'string' ||
    !receipt.receiptId.trim() ||
    receipt.receiptId.length > 200 ||
    (receipt.reason !== undefined &&
      (typeof receipt.reason !== 'string' ||
        !receipt.reason.trim() ||
        receipt.reason.length > 4_000)) ||
    typeof receipt.signature !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(receipt.signature)
  ) {
    throw new WebhookPolicyError('Webhook receipt is invalid.');
  }
  return {
    protocol: 'agentpool-receipt/1',
    leaseId: receipt.leaseId as string,
    unitId: receipt.unitId as string,
    contractHash: receipt.contractHash as string,
    resultSha256: receipt.resultSha256 as string,
    decision: receipt.decision as 'accepted' | 'rejected',
    retryable: receipt.retryable as boolean,
    receiptId: (receipt.receiptId as string).trim(),
    ...(receipt.reason === undefined ? {} : { reason: (receipt.reason as string).trim() }),
    signature: receipt.signature as string,
  };
}

export async function deliverToWebhook(
  lease: LeasePayload,
  output: unknown,
  options: WebhookDeliveryOptions = {},
): Promise<WebhookReceipt> {
  if (lease.delivery?.mode !== 'webhook' || !lease.contractHash) {
    throw new WebhookPolicyError('Webhook delivery metadata is invalid.');
  }
  const serializedOutput = assertResultMatchesContract(lease, output);
  const result = JSON.parse(serializedOutput) as unknown;
  const digest = resultSha256(result);
  const requestBody = JSON.stringify({
    protocol: 'agentpool-delivery/1',
    leaseId: lease.leaseId,
    unitId: lease.unitId,
    contractHash: lease.contractHash,
    resultSha256: digest,
    unit: {
      id: lease.unitId,
      reference: lease.delivery.unitReference,
      ordinal: lease.delivery.ordinal,
      input: lease.input,
    },
    result,
  });
  const post = options.post ?? postPinnedWebhook;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_WEBHOOK_ATTEMPTS; attempt += 1) {
    const remainingMs = Date.parse(lease.expiresAt) - Date.now();
    if (remainingMs <= 0) break;
    try {
      const target = await withTransportTimeout(
        resolveWebhookTarget(lease.delivery.url, options.resolveAll),
        Math.min(5_000, remainingMs),
      );
      const requestRemainingMs = Date.parse(lease.expiresAt) - Date.now();
      if (requestRemainingMs <= 0) throw new WebhookTransportError(true);
      const response = await post(
        target,
        requestBody,
        Math.max(1, Math.min(10_000, requestRemainingMs)),
      );
      if (response.status < 200 || response.status >= 300) {
        throw new WebhookTransportError(response.status === 429 || response.status >= 500);
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(response.body) as unknown;
      } catch {
        throw new WebhookPolicyError('Webhook receipt is invalid.');
      }
      return validateWebhookReceipt(decoded, {
        leaseId: lease.leaseId,
        unitId: lease.unitId,
        contractHash: lease.contractHash,
        resultSha256: digest,
      });
    } catch (error) {
      lastError = error;
      if (error instanceof WebhookPolicyError) throw error;
      if (error instanceof WebhookTransportError && !error.retryable) throw error;
      const delayMs = Math.min(2_000, 250 * 2 ** attempt);
      if (
        attempt + 1 >= MAX_WEBHOOK_ATTEMPTS ||
        Date.parse(lease.expiresAt) - Date.now() <= delayMs
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Webhook delivery failed.');
}
