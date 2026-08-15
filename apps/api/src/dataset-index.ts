import { createHash } from 'node:crypto';

import { DATASET_UNIT_MAX, canonicalJson, type TaskUnitDraft } from '@agent-pool/shared';

import { ApiError, invariant } from './errors.js';
import { datasetHostname, validateDatasetUrl } from './task-contract.js';

export const DATASET_MAX_BYTES = 64 * 1024 * 1024;
export const DATASET_MAX_LINE_BYTES = 1024 * 1024;

export interface IndexedDatasetUnit extends TaskUnitDraft {
  inputSha256: string;
  sourceOffset: number;
  sourceLength: number;
}

export interface IndexedDataset {
  host: string;
  byteLength: number;
  units: IndexedDatasetUnit[];
}

export type DatasetFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export function inputDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function parseJsonlUnit(line: string, index: number): TaskUnitDraft {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ApiError(400, 'DATASET_LINE_INVALID', `Dataset line ${index + 1} is not valid JSON`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && '$unit' in value) {
    const envelope = (value as { $unit?: unknown }).$unit;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new ApiError(400, 'DATASET_LINE_INVALID', `Dataset line ${index + 1} $unit must be an object`);
    }
    if (!('input' in envelope)) {
      throw new ApiError(400, 'DATASET_LINE_INVALID', `Dataset line ${index + 1} $unit is missing input`);
    }
    const item = envelope as { label?: unknown; input: unknown; expectedOutput?: unknown };
    return {
      label: typeof item.label === 'string' ? item.label.slice(0, 120) : labelFor(index),
      input: item.input,
      expectedOutput: item.expectedOutput,
    };
  }
  return { label: labelFor(index), input: value };
}

export function indexJsonlBytes(bytes: Buffer): IndexedDatasetUnit[] {
  const units: IndexedDatasetUnit[] = [];
  let offset = 0;
  let lineStart = 0;
  while (offset <= bytes.length) {
    const isEnd = offset === bytes.length;
    const atBreak = !isEnd && (bytes[offset] === 0x0a || bytes[offset] === 0x0d);
    if (!isEnd && !atBreak) {
      offset += 1;
      continue;
    }
    let lineEnd = offset;
    if (bytes[offset] === 0x0d && bytes[offset + 1] === 0x0a) {
      offset += 2;
    } else if (!isEnd) {
      offset += 1;
    } else {
      offset += 1;
    }
    const lineBytes = bytes.subarray(lineStart, lineEnd);
    lineStart = offset;
    if (lineBytes.length === 0) {
      if (isEnd) break;
      continue;
    }
    invariant(
      lineBytes.length <= DATASET_MAX_LINE_BYTES,
      400,
      'DATASET_LINE_TOO_LARGE',
      `Dataset line ${units.length + 1} exceeds ${DATASET_MAX_LINE_BYTES} bytes`,
    );
    const parsed = parseJsonlUnit(lineBytes.toString('utf8'), units.length);
    units.push({
      ...parsed,
      inputSha256: inputDigest(parsed.input),
      sourceOffset: lineEnd - lineBytes.length,
      sourceLength: lineBytes.length,
    });
    invariant(
      units.length <= DATASET_UNIT_MAX,
      400,
      'DATASET_TOO_MANY_UNITS',
      `Dataset exceeds ${DATASET_UNIT_MAX} units`,
    );
    if (isEnd) break;
  }
  invariant(units.length >= 2, 400, 'DATASET_TOO_SMALL', 'Dataset must contain at least 2 units');
  return units;
}

export async function indexHttpsDataset(
  url: string,
  fetchImpl: DatasetFetch = fetch,
): Promise<IndexedDataset> {
  validateDatasetUrl(url);
  const response = await fetchImpl(url);
  invariant(response.status === 200, 400, 'DATASET_FETCH_FAILED', 'Dataset URL did not return HTTP 200');
  const bytes = Buffer.from(await response.arrayBuffer());
  invariant(
    bytes.length <= DATASET_MAX_BYTES,
    400,
    'DATASET_TOO_LARGE',
    `Dataset exceeds ${DATASET_MAX_BYTES} bytes`,
  );
  invariant(bytes.length > 0, 400, 'DATASET_EMPTY', 'Dataset is empty');
  return {
    host: datasetHostname(url),
    byteLength: bytes.length,
    units: indexJsonlBytes(bytes),
  };
}

export async function fetchDatasetInput(
  url: string,
  unit: Pick<IndexedDatasetUnit, 'sourceOffset' | 'sourceLength' | 'inputSha256'>,
  fetchImpl: DatasetFetch = fetch,
): Promise<unknown> {
  validateDatasetUrl(url);
  const end = unit.sourceOffset + unit.sourceLength - 1;
  const response = await fetchImpl(url, {
    headers: { Range: `bytes=${unit.sourceOffset}-${end}` },
  });
  invariant(
    response.status === 206 || response.status === 200,
    502,
    'DATASET_FETCH_FAILED',
    'Dataset URL did not return the requested unit',
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  const slice =
    response.status === 206
      ? bytes
      : bytes.subarray(unit.sourceOffset, unit.sourceOffset + unit.sourceLength);
  invariant(
    slice.length === unit.sourceLength,
    502,
    'DATASET_LINE_MISMATCH',
    'Dataset unit length no longer matches the published index',
  );
  const parsed = parseJsonlUnit(slice.toString('utf8'), 0);
  invariant(
    inputDigest(parsed.input) === unit.inputSha256,
    409,
    'DATASET_HASH_MISMATCH',
    'Dataset unit changed after publish',
  );
  return parsed.input;
}

function labelFor(index: number): string {
  return `Unit ${String(index + 1).padStart(4, '0')}`;
}
