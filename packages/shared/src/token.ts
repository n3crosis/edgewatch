const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface IngestTokenClaims {
  /** project id */
  p: string;
  /** expiry, unix seconds */
  exp: number;
}

export const INGEST_TOKEN_PREFIX = 'ewt.';

/** Short-lived token returned by POST /api/agent-auth: ewt.<base64url(claims)>.<base64url(hmac)> */
export async function signIngestToken(claims: IngestTokenClaims, secret: string): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body)));
  return `${INGEST_TOKEN_PREFIX}${body}.${b64url(sig)}`;
}

export async function verifyIngestToken(token: string, secret: string, now = Date.now() / 1000): Promise<IngestTokenClaims | null> {
  if (!token.startsWith(INGEST_TOKEN_PREFIX)) return null;
  const parts = token.slice(INGEST_TOKEN_PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  // Only the canonical base64url of the 32-byte HMAC: the unused low bits of the last character must not vary.
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig) || !/[AEIMQUYcgkosw048]$/.test(sig)) return null;
  try {
    const valid = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(sig), encoder.encode(body));
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as IngestTokenClaims;
    return typeof claims.p === 'string' && typeof claims.exp === 'number' && claims.exp > now ? claims : null;
  } catch {
    return null;
  }
}
