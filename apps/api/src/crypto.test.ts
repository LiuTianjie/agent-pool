import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptJson, encryptJson, parseEncryptionKey } from './crypto.js';

describe('encrypted task fields', () => {
  it('round trips JSON with a fresh nonce each time', () => {
    const key = randomBytes(32);
    const value = { private: '题目内容', nested: [1, true, null] };
    const first = encryptJson(value, key);
    const second = encryptJson(value, key);
    expect(first).not.toBe(second);
    expect(first).not.toContain('题目内容');
    expect(decryptJson(first, key)).toEqual(value);
    expect(decryptJson(second, key)).toEqual(value);
  });

  it('rejects tampering and invalid key material', () => {
    const key = randomBytes(32);
    const sealed = encryptJson('secret', key);
    const parts = sealed.split('.');
    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    ciphertext[0] = ciphertext[0]! ^ 1;
    parts[3] = ciphertext.toString('base64url');
    const tampered = parts.join('.');
    expect(() => decryptJson(tampered, key)).toThrow();
    expect(() => parseEncryptionKey('too-short')).toThrow(/32-byte/);
    expect(parseEncryptionKey(key.toString('hex'))).toEqual(key);
    expect(parseEncryptionKey(key.toString('base64'))).toEqual(key);
  });
});
