import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';

// Versioned, fixed parameters prevent stored values from requesting unbounded work.
// 32 MiB per derivation; p=3 increases work without increasing peak memory.
const PREFIX = 'scrypt-v1';
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 32, OPTIONS, (error, key) => error ? reject(error) : resolve(key));
});

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8) return 'Use a password with at least 8 characters.';
  if (new TextEncoder().encode(password).length > 1024) return 'Use a password shorter than 1024 bytes.';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = randomBytes(16).toString('hex');
  return `${PREFIX}$${salt}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || new TextEncoder().encode(password).length > 1024) return false;
  const match = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded);
  if (!match) return false;
  return timingSafeEqual(await derive(password, match[1]), Buffer.from(match[2], 'hex'));
}

/** Store only the digest; the random bearer value is returned to the client once. */
export const newAuthToken = () => randomBytes(32).toString('base64url');
export const authTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Derives a friendly display name from an email address when none is supplied during setup. */
export function defaultDisplayName(email: string): string {
  const local = email.split('@')[0] ?? '';
  const words = local
    .split(/[._+-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  const candidate = words.join(' ').slice(0, 100).trim();
  return candidate || 'Owner';
}
