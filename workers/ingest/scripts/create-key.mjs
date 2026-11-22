#!/usr/bin/env node
// Usage: pnpm --filter @edgewatch/ingest create-key <project_id> [ingest|read|browser] [name] [--local]
// Prints a new API key once and stores only its SHA-256 hash in the API_KEYS KV namespace.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const [projectId, scopes = 'ingest', name = 'default'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!projectId) {
  console.error('Usage: create-key <project_id> [ingest|read|browser] [name] [--local]');
  process.exit(1);
}

const prefix = scopes.includes('ingest') ? 'ew_live' : scopes.includes('browser') ? 'ew_pub' : 'ew_read';
const key = `${prefix}_${randomBytes(24).toString('base64url')}`;
const kvKey = `apikey:${createHash('sha256').update(key).digest('hex')}`;
const value = JSON.stringify({ project_id: projectId, name, scopes: scopes.split(',') });

execFileSync('npx', ['wrangler', 'kv', 'key', 'put', '--binding', 'API_KEYS', kvKey, value, process.argv.includes('--local') ? '--local' : '--remote'], { stdio: 'inherit' });
console.log(`\nAPI key for ${projectId} (${scopes}): ${key}\nSet NIGHTWATCH_TOKEN=${key}`);
