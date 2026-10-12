import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, result) => {
    if (error) reject(error); else resolve(result);
  });
});

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Password must contain 12 to 256 characters');
  const salt = randomBytes(32).toString('hex');
  const hash = await derive(password, salt);
  return `scrypt$32768$8$3$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 256) return false;
  const match = hash?.match(/^scrypt\$32768\$8\$3\$([a-f0-9]{64})\$([a-f0-9]{128})$/);
  // Missing users still incur the same KDF cost to avoid a cheap enumeration path.
  const actual = await derive(password, match?.[1] ?? '0'.repeat(64));
  const expected = match ? Buffer.from(match[2]!, 'hex') : Buffer.alloc(64);
  const equal = timingSafeEqual(actual, expected);
  return Boolean(match) && equal;
}
