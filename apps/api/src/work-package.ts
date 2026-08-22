import { resolveHostedAssetUrl, workPackageSchema, type WorkPackage } from '@agent-pool/shared';

import type { DatasetFetch } from './dataset-index.js';
import { ApiError, invariant } from './errors.js';
import { datasetHostname, validateDatasetUrl, validateWebhookUrl } from './task-contract.js';

export const WORK_PACKAGE_MAX_BYTES = 256 * 1024;

export interface LoadedWorkPackage {
  package: WorkPackage;
  url: string;
  host: string;
}

export async function loadWorkPackage(
  url: string,
  fetchImpl: DatasetFetch = fetch,
): Promise<LoadedWorkPackage> {
  validateDatasetUrl(url);
  const response = await fetchImpl(url);
  invariant(
    response.status === 200,
    400,
    'WORK_PACKAGE_FETCH_FAILED',
    'Work package URL did not return HTTP 200',
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  invariant(
    bytes.length <= WORK_PACKAGE_MAX_BYTES,
    400,
    'WORK_PACKAGE_TOO_LARGE',
    `Work package exceeds ${WORK_PACKAGE_MAX_BYTES} bytes`,
  );
  invariant(bytes.length > 0, 400, 'WORK_PACKAGE_EMPTY', 'Work package is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ApiError(400, 'WORK_PACKAGE_INVALID', 'Work package is not valid JSON');
  }
  const result = workPackageSchema.safeParse(parsed);
  if (!result.success) {
    throw new ApiError(400, 'WORK_PACKAGE_INVALID', 'Work package does not follow ap-work/1', {
      issues: result.error.issues,
    });
  }
  const resolved: WorkPackage = {
    ...result.data,
    units: { url: resolveHostedAssetUrl(url, result.data.units.url) },
    answers: result.data.answers
      ? { url: resolveHostedAssetUrl(url, result.data.answers.url) }
      : undefined,
  };
  validateDatasetUrl(resolved.units.url);
  if (resolved.answers) validateDatasetUrl(resolved.answers.url);
  if (resolved.delivery.mode === 'webhook') {
    validateWebhookUrl(resolved.delivery.url);
  }
  return {
    package: resolved,
    url,
    host: datasetHostname(url),
  };
}

export function workPackageCreateFields(loaded: LoadedWorkPackage): Record<string, unknown> {
  const { package: work } = loaded;
  return {
    title: work.title,
    category: work.category,
    publicSummary: work.publicSummary,
    requestedAgent: work.execution.adapter,
    requestedModel: work.execution.model,
    taskCapsule: work.task,
    deliveryTarget: work.delivery,
    validationMode:
      work.task.acceptance.mode === 'manual' || work.task.acceptance.mode === 'webhook'
        ? 'manual'
        : 'auto',
  };
}
