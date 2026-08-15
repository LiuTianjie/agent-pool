import { describe, expect, it } from 'vitest';

import {
  fetchDatasetInput,
  indexHttpsDataset,
  indexJsonlBytes,
  inputDigest,
  parseJsonlUnit,
} from './dataset-index.js';

function jsonl(lines: unknown[]): Buffer {
  return Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
}

describe('dataset index', () => {
  it('indexes ordinary JSONL objects and $unit envelopes', () => {
    const first = { question: '1+1' };
    const second = { $unit: { label: 'q-2', input: { question: '2+2' }, expectedOutput: { answer: 4 } } };
    const units = indexJsonlBytes(jsonl([first, second]));
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({
      label: 'Unit 0001',
      input: first,
      inputSha256: inputDigest(first),
      sourceOffset: 0,
    });
    expect(units[1]?.label).toBe('q-2');
    expect(units[1]?.expectedOutput).toEqual({ answer: 4 });
    expect(units[1]?.inputSha256).toBe(inputDigest({ question: '2+2' }));
  });

  it('rejects a single-line dataset', () => {
    expect(() => indexJsonlBytes(jsonl([{ only: true }]))).toThrow(/at least 2/);
  });

  it('parses a wrapped unit', () => {
    expect(parseJsonlUnit(JSON.stringify({ $unit: { input: 'plain' } }), 3)).toEqual({
      label: 'Unit 0004',
      input: 'plain',
      expectedOutput: undefined,
    });
  });

  it('indexes over HTTPS and later fetches one hashed line', async () => {
    const body = jsonl([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const url = 'https://files.example.test/batch.jsonl';
    const fetchImpl = async (requestUrl: string, init?: { headers?: Record<string, string> }) => {
      expect(requestUrl).toBe(url);
      const range = init?.headers?.Range;
      if (range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        expect(match).not.toBeNull();
        const start = Number(match?.[1]);
        const end = Number(match?.[2]);
        return {
          status: 206,
          headers: { get: () => 'bytes' },
          arrayBuffer: async () => body.subarray(start, end + 1),
        };
      }
      return {
        status: 200,
        headers: { get: () => String(body.length) },
        arrayBuffer: async () => body,
      };
    };

    const indexed = await indexHttpsDataset(url, fetchImpl);
    expect(indexed.host).toBe('files.example.test');
    expect(indexed.units).toHaveLength(3);
    const second = indexed.units[1]!;
    await expect(fetchDatasetInput(url, second, fetchImpl)).resolves.toEqual({ n: 2 });
  });

  it('rejects a mutated line', async () => {
    const original = jsonl([{ n: 1 }, { n: 2 }]);
    const mutated = jsonl([{ n: 1 }, { n: 9 }]);
    const url = 'https://files.example.test/changed.jsonl';
    const indexed = await indexHttpsDataset(url, async () => ({
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => original,
    }));
    await expect(
      fetchDatasetInput(url, indexed.units[1]!, async () => ({
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => mutated,
      })),
    ).rejects.toMatchObject({ code: 'DATASET_HASH_MISMATCH' });
  });
});
