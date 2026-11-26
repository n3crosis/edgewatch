const encoder = new TextEncoder();

export function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** First 32 hex chars (128 bits) of SHA-256, matching EdgeWatch\Laravel\Sql\SqlNormalizer::hash(). */
export async function shortHash(value: string): Promise<string> {
  return (await sha256Hex(value)).slice(0, 32);
}

/** KV key under which an API key's metadata is stored. Only the hash of the raw key is persisted. */
export async function apiKeyKvKey(rawKey: string): Promise<string> {
  return `apikey:${await sha256Hex(rawKey)}`;
}
