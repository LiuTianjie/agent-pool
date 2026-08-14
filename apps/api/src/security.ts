import {
  createHash,
  randomBytes,
  randomInt,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LENGTH = 64;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await scrypt(password.normalize('NFKC'), salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, expected] = encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    Number(n) !== SCRYPT_N ||
    Number(r) !== SCRYPT_R ||
    Number(p) !== SCRYPT_P ||
    !salt ||
    !expected
  ) {
    return false;
  }
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'));
  const expectedBuffer = Buffer.from(expected, 'base64url');
  return expectedBuffer.length === actual.length && timingSafeEqual(expectedBuffer, actual);
}

export function randomOpaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 8; i += 1) {
    result += alphabet[randomInt(0, alphabet.length)];
  }
  return `${result.slice(0, 4)}-${result.slice(4)}`;
}
