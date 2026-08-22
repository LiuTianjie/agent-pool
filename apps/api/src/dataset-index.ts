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
  answerSha256?: string;
  answerOffset?: number;
  answerLength?: number;
}

export interface IndexedAnswer {
  id?: string;
  expected: unknown;
  expectedSha256: string;
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
      throw new ApiError(
        400,
        'DATASET_LINE_INVALID',
        `Dataset line ${index + 1} $unit must be an object`,
      );
    }
    if (!('input' in envelope)) {
      throw new ApiError(
        400,
        'DATASET_LINE_INVALID',
        `Dataset line ${index + 1} $unit is missing input`,
      );
    }
    const item = envelope as {
      id?: unknown;
      label?: unknown;
      input: unknown;
      expectedOutput?: unknown;
    };
    return {
      label: namedUnitId(item, index),
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
  invariant(
    response.status === 200,
    400,
    'DATASET_FETCH_FAILED',
    'Dataset URL did not return HTTP 200',
  );
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

export function parseJsonlAnswer(line: string, index: number): { id?: string; expected: unknown } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ApiError(400, 'ANSWER_LINE_INVALID', `Answer line ${index + 1} is not valid JSON`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && '$answer' in value) {
    const envelope = (value as { $answer?: unknown }).$answer;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new ApiError(
        400,
        'ANSWER_LINE_INVALID',
        `Answer line ${index + 1} $answer must be an object`,
      );
    }
    if (!('expected' in envelope)) {
      throw new ApiError(
        400,
        'ANSWER_LINE_INVALID',
        `Answer line ${index + 1} $answer is missing expected`,
      );
    }
    const item = envelope as { id?: unknown; expected: unknown };
    return {
      id: typeof item.id === 'string' ? item.id.slice(0, 120) : undefined,
      expected: item.expected,
    };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'expected' in value) {
    const item = value as { id?: unknown; expected: unknown };
    return {
      id: typeof item.id === 'string' ? item.id.slice(0, 120) : undefined,
      expected: item.expected,
    };
  }
  throw new ApiError(
    400,
    'ANSWER_LINE_INVALID',
    `Answer line ${index + 1} must be {id, expected} or {$answer:{id, expected}}`,
  );
}

export function indexJsonlAnswers(bytes: Buffer): IndexedAnswer[] {
  const answers: IndexedAnswer[] = [];
  for (const line of iterateJsonlLines(bytes)) {
    invariant(
      line.bytes.length <= DATASET_MAX_LINE_BYTES,
      400,
      'ANSWER_LINE_TOO_LARGE',
      `Answer line ${answers.length + 1} exceeds ${DATASET_MAX_LINE_BYTES} bytes`,
    );
    const parsed = parseJsonlAnswer(line.bytes.toString('utf8'), answers.length);
    answers.push({
      ...parsed,
      expectedSha256: inputDigest(parsed.expected),
      sourceOffset: line.offset,
      sourceLength: line.bytes.length,
    });
    invariant(
      answers.length <= DATASET_UNIT_MAX,
      400,
      'ANSWERS_TOO_MANY',
      `Answers exceed ${DATASET_UNIT_MAX} rows`,
    );
  }
  invariant(
    answers.length >= 2,
    400,
    'ANSWERS_TOO_SMALL',
    'Answers file must contain at least 2 rows',
  );
  return answers;
}

export function attachHostedAnswers(
  units: IndexedDatasetUnit[],
  answers: IndexedAnswer[],
  required: boolean,
): IndexedDatasetUnit[] {
  const byId = new Map<string, IndexedAnswer>();
  for (const answer of answers) {
    if (!answer.id) continue;
    invariant(
      !byId.has(answer.id),
      400,
      'ANSWER_ID_DUPLICATE',
      `Answer id ${answer.id} is duplicated`,
    );
    byId.set(answer.id, answer);
  }
  return units.map((unit, index) => {
    const matched = (unit.label && byId.get(unit.label)) || answers[index];
    if (!matched) {
      invariant(
        !required,
        400,
        'ANSWERS_INCOMPLETE',
        `No hosted answer for unit ${unit.label ?? index + 1}`,
      );
      return unit;
    }
    return {
      ...unit,
      expectedOutput: undefined,
      answerSha256: matched.expectedSha256,
      answerOffset: matched.sourceOffset,
      answerLength: matched.sourceLength,
    };
  });
}

export async function indexHttpsAnswers(
  url: string,
  fetchImpl: DatasetFetch = fetch,
): Promise<{ host: string; answers: IndexedAnswer[] }> {
  const bytes = await fetchHttpsBytes(
    url,
    fetchImpl,
    'ANSWER_FETCH_FAILED',
    'Answers URL did not return HTTP 200',
  );
  return { host: datasetHostname(url), answers: indexJsonlAnswers(bytes) };
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

export async function fetchDatasetExpected(
  url: string,
  answer: Pick<IndexedAnswer, 'sourceOffset' | 'sourceLength' | 'expectedSha256'>,
  fetchImpl: DatasetFetch = fetch,
): Promise<unknown> {
  const parsed = await fetchJsonlSlice(url, answer, fetchImpl);
  const expected = parseJsonlAnswer(parsed.toString('utf8'), 0).expected;
  invariant(
    inputDigest(expected) === answer.expectedSha256,
    409,
    'ANSWER_HASH_MISMATCH',
    'Hosted answer changed after publish',
  );
  return expected;
}

export async function fetchDatasetUnitLine(
  url: string,
  unit: Pick<IndexedDatasetUnit, 'sourceOffset' | 'sourceLength' | 'inputSha256'>,
  fetchImpl: DatasetFetch = fetch,
): Promise<TaskUnitDraft> {
  const parsed = parseJsonlUnit((await fetchJsonlSlice(url, unit, fetchImpl)).toString('utf8'), 0);
  invariant(
    inputDigest(parsed.input) === unit.inputSha256,
    409,
    'DATASET_HASH_MISMATCH',
    'Dataset unit changed after publish',
  );
  return parsed;
}

async function fetchHttpsBytes(
  url: string,
  fetchImpl: DatasetFetch,
  code: string,
  message: string,
): Promise<Buffer> {
  validateDatasetUrl(url);
  const response = await fetchImpl(url);
  invariant(response.status === 200, 400, code, message);
  const bytes = Buffer.from(await response.arrayBuffer());
  invariant(
    bytes.length <= DATASET_MAX_BYTES,
    400,
    'DATASET_TOO_LARGE',
    `Dataset exceeds ${DATASET_MAX_BYTES} bytes`,
  );
  invariant(bytes.length > 0, 400, 'DATASET_EMPTY', 'Dataset is empty');
  return bytes;
}

async function fetchJsonlSlice(
  url: string,
  span: { sourceOffset: number; sourceLength: number },
  fetchImpl: DatasetFetch,
): Promise<Buffer> {
  validateDatasetUrl(url);
  const end = span.sourceOffset + span.sourceLength - 1;
  const response = await fetchImpl(url, {
    headers: { Range: `bytes=${span.sourceOffset}-${end}` },
  });
  invariant(
    response.status === 206 || response.status === 200,
    502,
    'DATASET_FETCH_FAILED',
    'Hosted file did not return the requested line',
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  const slice =
    response.status === 206
      ? bytes
      : bytes.subarray(span.sourceOffset, span.sourceOffset + span.sourceLength);
  invariant(
    slice.length === span.sourceLength,
    502,
    'DATASET_LINE_MISMATCH',
    'Hosted line length no longer matches the published index',
  );
  return slice;
}

function iterateJsonlLines(bytes: Buffer): Array<{ bytes: Buffer; offset: number }> {
  const lines: Array<{ bytes: Buffer; offset: number }> = [];
  let offset = 0;
  let lineStart = 0;
  while (offset <= bytes.length) {
    const isEnd = offset === bytes.length;
    const atBreak = !isEnd && (bytes[offset] === 0x0a || bytes[offset] === 0x0d);
    if (!isEnd && !atBreak) {
      offset += 1;
      continue;
    }
    const lineEnd = offset;
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
    lines.push({ bytes: lineBytes, offset: lineEnd - lineBytes.length });
    if (isEnd) break;
  }
  return lines;
}

function namedUnitId(item: { id?: unknown; label?: unknown }, index: number): string {
  if (typeof item.id === 'string' && item.id.trim()) return item.id.trim().slice(0, 120);
  if (typeof item.label === 'string' && item.label.trim()) return item.label.trim().slice(0, 120);
  return labelFor(index);
}

function labelFor(index: number): string {
  return `Unit ${String(index + 1).padStart(4, '0')}`;
}
