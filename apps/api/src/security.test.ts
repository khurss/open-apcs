import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './security.js';

describe('local password credentials', () => {
  it('uses unique salts and verifies only the correct password', async () => {
    const password = 'An offline operator password';
    const one = await hashPassword(password); const two = await hashPassword(password);
    expect(one).not.toBe(two);
    expect(one).not.toContain(password);
    expect(await verifyPassword(password, one)).toBe(true);
    expect(await verifyPassword('wrong password', one)).toBe(false);
  }, 5000);
  it('does not authenticate missing or malformed hashes', async () => {
    expect(await verifyPassword('some password', null)).toBe(false);
    expect(await verifyPassword('some password', 'scrypt$broken')).toBe(false);
  });
  it.each(['short', 'x'.repeat(257)])('rejects invalid password length', async (password) => {
    await expect(hashPassword(password)).rejects.toThrow(/password/i);
  });
});
