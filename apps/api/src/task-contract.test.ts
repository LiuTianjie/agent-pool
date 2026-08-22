import { afterEach, describe, expect, it } from 'vitest';

import { validateDatasetUrl, validateWebhookUrl } from './task-contract.js';

describe('hosted URL policy', () => {
  const previous = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = previous;
  });

  it('allows loopback HTTP datasets outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(() => validateDatasetUrl('http://127.0.0.1:5174/examples/work.json')).not.toThrow();
    expect(() => validateDatasetUrl('http://localhost:5174/examples/units.jsonl')).not.toThrow();
  });

  it('rejects loopback and plain HTTP in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateDatasetUrl('http://127.0.0.1:5174/examples/work.json')).toThrow(
      /must use HTTPS/,
    );
    expect(() => validateDatasetUrl('https://127.0.0.1/work.json')).toThrow(/localhost|private/i);
    expect(() => validateDatasetUrl('https://files.example.com/work.json')).not.toThrow();
  });

  it('never allows loopback webhooks', () => {
    process.env.NODE_ENV = 'development';
    expect(() => validateWebhookUrl('http://127.0.0.1:5174/hook')).toThrow(/must use HTTPS/);
  });
});
