import { describe, expect, it } from 'vitest';

import { hashOpaqueToken, hashPassword, randomOpaqueToken, verifyPassword } from './security.js';

describe('credentials', () => {
  it('stores password verifiers and validates exact passwords', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(encoded).not.toContain('correct horse');
    await expect(verifyPassword('correct horse battery staple', encoded)).resolves.toBe(true);
    await expect(verifyPassword('incorrect horse battery staple', encoded)).resolves.toBe(false);
    await expect(verifyPassword('anything', 'malformed')).resolves.toBe(false);
  });

  it('creates high entropy runner tokens and only persists a one-way digest', () => {
    const token = randomOpaqueToken('ap_runner_');
    const digest = hashOpaqueToken(token);
    expect(token).toMatch(/^ap_runner_[A-Za-z0-9_-]{40,}$/);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(token);
  });
});
