import { describe, expect, it } from 'vitest';

import { loadWorkPackage } from './work-package.js';

describe('loadWorkPackage', () => {
  it('resolves relative unit and answer files against the package URL', async () => {
    const fetched: string[] = [];
    const fetchImpl = async (url: string) => {
      fetched.push(url);
      return {
        status: 200,
        arrayBuffer: async () =>
          Buffer.from(
            JSON.stringify({
              version: 'ap-work/1',
              title: 'Relative arithmetic',
              publicSummary: 'Units sit next to the work package.',
              category: 'math',
              execution: { adapter: 'mock', model: 'mock-v1' },
              task: {
                version: 'ap-task/1',
                goal: 'Solve each hosted question',
                inputDescription: 'One JSON object per line',
                outputDescription: 'JSON object with an answer field',
                constraints: ['Return JSON only'],
                examples: [{ input: { expression: '1+1' }, output: { answer: '2' } }],
                delivery: { format: 'json', maxBytes: 2048 },
                acceptance: { mode: 'hidden_exact', criteria: ['exact'] },
              },
              units: { url: './units.jsonl' },
              answers: { url: './answers.jsonl' },
              delivery: { mode: 'platform' },
            }),
          ),
      };
    };

    const loaded = await loadWorkPackage('https://files.example.com/job/work.json', fetchImpl);
    expect(fetched).toEqual(['https://files.example.com/job/work.json']);
    expect(loaded.package.units.url).toBe('https://files.example.com/job/units.jsonl');
    expect(loaded.package.answers?.url).toBe('https://files.example.com/job/answers.jsonl');
  });
});
