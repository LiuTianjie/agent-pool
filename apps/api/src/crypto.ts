import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const AAD = Buffer.from('agent-pool/task-field/v1', 'utf8');

export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('TASK_ENCRYPTION_KEY must be 32-byte base64 or 64-character hex');
  }
  return key;
}

export function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptJson<T = unknown>(sealed: string, key: Buffer): T {
  const [version, encodedIv, encodedTag, encodedCiphertext, extra] = sealed.split('.');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext || extra) {
    throw new Error('Invalid encrypted task field');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encodedIv, 'base64url'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
