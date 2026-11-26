import { describe, expect, it } from 'vitest';
import { authTokenHash, defaultDisplayName, hashPassword, newAuthToken, normalizeEmail, passwordProblem, verifyPassword } from './passwords';

describe('account credential primitives', () => {
  it('salts passwords independently and verifies without trimming or normalizing secrets', async () => {
    const password = ' a long secret phrase 🔐 ';
    const a = await hashPassword(password);
    const b = await hashPassword(password);
    expect(a).not.toBe(b);
    expect(await verifyPassword(password, a)).toBe(true);
    expect(await verifyPassword(password.trim(), a)).toBe(false);
    expect(await verifyPassword('another long secret phrase', a)).toBe(false);
  });
  it('bounds input before hashing and rejects malformed stored formats', async () => {
    expect(passwordProblem('short')).toContain('8');
    expect(passwordProblem('🔐'.repeat(300))).toContain('1024');
    expect(passwordProblem('a sufficiently long password')).toBeNull();
    await expect(hashPassword('short')).rejects.toThrow('8');
    for (const hash of ['', 'scrypt-v2$bad$bad', `scrypt-v1$${'f'.repeat(32)}$00`]) {
      expect(await verifyPassword('a sufficiently long password', hash)).toBe(false);
    }
  });
  it('creates random opaque tokens and canonicalizes only email addresses', () => {
    const token = newAuthToken();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(newAuthToken()).not.toBe(token);
    expect(authTokenHash(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(authTokenHash(token)).toBe(authTokenHash(token));
    expect(normalizeEmail(' Owner@Example.com ')).toBe('owner@example.com');
    for (const email of ['', 'abc', '@example.com', 'a b@example.com', null]) expect(normalizeEmail(email)).toBeNull();
    expect(defaultDisplayName('admin@example.com')).toBe('Admin');
    expect(defaultDisplayName('alex.smith@example.com')).toBe('Alex Smith');
    expect(defaultDisplayName('...@example.com')).toBe('Owner');
  });
});
