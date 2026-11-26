#!/usr/bin/env bun
/**
 * Dashboard account management for Cloudflare D1 (Workers) and standalone SQL databases.
 * Creates accounts and resets passwords without deleting telemetry or other accounts.
 *
 *   accounts list [--remote | --local]
 *   accounts create --email <email> [--password <pw> | --password-stdin] [--role owner|admin|viewer] [--name <name>]
 *   accounts reset-password (--email <email> | --owner) [--password <pw> | --password-stdin] [--new-email <email>] [--name <name>] [--enable]
 *
 * Runs wrangler d1 execute from workers/api: --remote (default) or --local [--persist-to <dir>],
 * using the D1 database_name from workers/api/wrangler.jsonc (override with --db <name>).
 * Passwords can also be supplied via EDGEWATCH_PASSWORD or piped with --password-stdin.
 * For external databases, pass --postgres <url>, --mysql <url>, or --libsql <url> (with LIBSQL_AUTH_TOKEN).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlDatabase, SqlResult, SqlStatement } from '../packages/shared/src/storage';
import { connectLibsql } from '../packages/shared/src/libsql-client';
import { connectMysql } from '../packages/shared/src/mysql2';
import { connectPostgres } from '../packages/shared/src/postgres-js';
import { Accounts, type AccountRole } from '../workers/api/src/accounts';
import { defaultDisplayName, hashPassword, normalizeEmail, passwordProblem } from '../workers/api/src/passwords';

export class AccountCliError extends Error {}

/** Formats a value as a SQLite literal for wrangler d1 execute --file. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AccountCliError('Non-finite numeric SQL parameter.');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') {
    if (value.includes('\0')) throw new AccountCliError('SQL parameter cannot contain NUL bytes.');
    return `'${value.replace(/'/g, "''")}'`;
  }
  throw new AccountCliError(`Unsupported SQL parameter type: ${typeof value}`);
}

/** Replaces positional `?` placeholders outside single-quoted literals with escaped SQLite literals. */
export function interpolateSql(sql: string, params: unknown[]): string {
  let out = '';
  let paramIndex = 0;
  let inSingleQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingleQuote) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i++;
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      out += ch;
    } else if (ch === '?') {
      if (paramIndex >= params.length) throw new AccountCliError('Missing SQL parameter for placeholder.');
      out += sqlLiteral(params[paramIndex++]);
    } else {
      out += ch;
    }
  }
  if (paramIndex !== params.length) throw new AccountCliError(`Unused SQL parameter(s): expected ${paramIndex}, got ${params.length}.`);
  return out;
}

interface WranglerD1Statement extends SqlStatement {
  readonly __sql: string;
  readonly __params: unknown[];
}

interface WranglerD1JsonEntry {
  results?: Record<string, unknown>[];
  meta?: { changes?: number };
  success?: boolean;
}

/** Extracts the JSON array from `wrangler d1 execute --json` stdout, ignoring leading `[WARNING]` banners. */
export function parseWranglerD1Json(stdout: string): WranglerD1JsonEntry[] {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as WranglerD1JsonEntry[];
  }
  const match = /\r?\n(\[\s*[\r\n]*\s*\{[\s\S]*\])\s*$/.exec(stdout);
  if (match) {
    return JSON.parse(match[1]) as WranglerD1JsonEntry[];
  }
  const fallback = stdout.lastIndexOf('\n[');
  if (fallback >= 0) {
    return JSON.parse(stdout.slice(fallback + 1)) as WranglerD1JsonEntry[];
  }
  throw new AccountCliError(`Unexpected wrangler output: ${trimmed}`);
}

/** Reads the D1 database_name from workers/api/wrangler.jsonc (fallback: "edgewatch"). */
export function defaultD1DatabaseName(apiDir: string): string {
  const configPath = join(apiDir, 'wrangler.jsonc');
  if (!existsSync(configPath)) return 'edgewatch';
  const raw = readFileSync(configPath, 'utf8');
  const match = /"database_name"\s*:\s*"([^"]+)"/.exec(raw);
  return match?.[1] || 'edgewatch';
}

/** SqlDatabase backed by `wrangler d1 execute --command --json` (only scrypt password hashes are sent, never plaintext). */
export function wranglerD1Database(options: { dbName: string; local: boolean; persistTo?: string; cwd: string }): SqlDatabase {
  const target = options.local ? ['--local', ...(options.persistTo ? ['--persist-to', options.persistTo] : [])] : ['--remote'];

  const executeStatements = (statements: { sql: string; params: unknown[] }[]): SqlResult<Record<string, unknown>>[] => {
    const script = statements.map((s) => `${interpolateSql(s.sql, s.params)};`).join(' ');
    const res = spawnSync('bunx', ['wrangler', 'd1', 'execute', options.dbName, '--command', script, '--json', ...target], {
      cwd: options.cwd,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      const detail = (res.stderr || res.stdout || '').trim();
      throw new AccountCliError(`wrangler d1 execute failed: ${detail || `exit ${res.status}`}`);
    }
    const parsed = parseWranglerD1Json(res.stdout ?? '');
    return parsed.map((entry) => ({
      results: entry.results ?? [],
      meta: { changes: entry.meta?.changes },
    }));
  };

  const makeStatement = (sql: string, params: unknown[] = []): WranglerD1Statement => ({
    __sql: sql,
    __params: params,
    bind(...values: unknown[]) {
      return makeStatement(sql, values);
    },
    async first<T = unknown>(column?: string): Promise<T | null> {
      const [res] = executeStatements([{ sql, params }]);
      const row = res?.results[0];
      if (!row) return null;
      if (column !== undefined) return (row[column] as T) ?? null;
      return row as T;
    },
    async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
      const [res] = executeStatements([{ sql, params }]);
      return (res ?? { results: [], meta: {} }) as SqlResult<T>;
    },
    async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
      const [res] = executeStatements([{ sql, params }]);
      return (res ?? { results: [], meta: {} }) as SqlResult<T>;
    },
  });

  return {
    prepare(sql: string) {
      return makeStatement(sql);
    },
    async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      const resolved = statements.map((s) => {
        const w = s as WranglerD1Statement;
        return { sql: w.__sql, params: w.__params };
      });
      return executeStatements(resolved) as SqlResult<T>[];
    },
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const VALUED_FLAGS = new Set([
  '--email',
  '--password',
  '--role',
  '--name',
  '--new-email',
  '--db',
  '--persist-to',
  '--postgres',
  '--mysql',
  '--libsql',
]);

async function resolvePassword(argv: string[], readStdin: () => Promise<string>): Promise<string | undefined> {
  const fromFlag = flag(argv, 'password');
  if (fromFlag !== undefined) return fromFlag;
  if (argv.includes('--password-stdin')) {
    return (await readStdin()).replace(/\r?\n$/, '');
  }
  return process.env.EDGEWATCH_PASSWORD;
}

const USAGE = [
  'Usage:',
  '  accounts list [--remote | --local]',
  '  accounts create --email <email> [--password <pw> | --password-stdin] [--role owner|admin|viewer] [--name <name>]',
  '  accounts reset-password (--email <email> | --owner) [--password <pw> | --password-stdin] [--new-email <email>] [--name <name>] [--enable]',
].join('\n');

export async function main(
  argv: string[],
  db: SqlDatabase,
  options?: { out?: (line: string) => void; readStdin?: () => Promise<string> },
): Promise<number> {
  const out = options?.out ?? console.log;
  const readStdin = options?.readStdin ?? (() => new Response(Bun.stdin).text());
  const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUED_FLAGS.has(argv[i - 1] ?? ''));
  const [command, ...rest] = positional;
  const accounts = new Accounts(db);

  try {
    switch (command) {
      case 'list': {
        const rows = await accounts.list();
        if (!rows.length) {
          out('No accounts.');
          return 0;
        }
        for (const row of rows) {
          const status = row.disabled ? 'disabled' : 'active';
          const ts = Number(row.created_at);
          const created = Number.isFinite(ts) ? new Date(ts).toISOString() : String(row.created_at ?? '-');
          out(`${row.id.padEnd(36)}  ${row.role.padEnd(6)}  ${status.padEnd(8)}  ${row.email}  (${row.name})  created ${created}`);
        }
        return 0;
      }

      case 'create': {
        const rawEmail = flag(argv, 'email') ?? rest[0];
        const email = normalizeEmail(rawEmail);
        if (!email) throw new AccountCliError('Provide a valid email address with --email <email>.');
        const password = await resolvePassword(argv, readStdin);
        const problem = passwordProblem(password);
        if (problem) throw new AccountCliError(problem);

        const requestedRole = flag(argv, 'role');
        let role: AccountRole;
        if (requestedRole) {
          if (!['owner', 'admin', 'viewer'].includes(requestedRole)) {
            throw new AccountCliError(`Invalid role "${requestedRole}": use owner, admin, or viewer.`);
          }
          role = requestedRole as AccountRole;
        } else if (!(await accounts.hasOwner())) {
          role = 'owner';
        } else {
          throw new AccountCliError('An owner account already exists. Pass --role admin or --role viewer, or use `accounts reset-password`.');
        }

        const rawName = flag(argv, 'name');
        const name = rawName?.trim() ? rawName.trim().slice(0, 100) : defaultDisplayName(email);
        const created = await accounts.createAccount(email, name, await hashPassword(password!), role);
        out(`Created ${created.role} account: ${created.email} (${created.name})`);
        return 0;
      }

      case 'reset-password': {
        const useOwner = argv.includes('--owner');
        const rawEmail = flag(argv, 'email') ?? rest[0];
        if (!useOwner && !rawEmail) {
          throw new AccountCliError('Specify the account with --email <email> or --owner.');
        }
        const password = await resolvePassword(argv, readStdin);
        const problem = passwordProblem(password);
        if (problem) throw new AccountCliError(problem);

        const updated = await accounts.resetPassword(
          useOwner ? { owner: true } : { email: rawEmail },
          await hashPassword(password!),
          {
            newEmail: flag(argv, 'new-email'),
            name: flag(argv, 'name'),
            enable: argv.includes('--enable'),
          },
        );
        if (!updated) {
          throw new AccountCliError(useOwner ? 'No owner account exists yet. Use `accounts create` instead.' : `No account found for ${rawEmail}.`);
        }
        out(`Reset password for ${updated.role} account: ${updated.email} (${updated.name}). Existing sessions for this account were revoked.`);
        return 0;
      }

      default:
        throw new AccountCliError(USAGE);
    }
  } catch (error) {
    if (error instanceof AccountCliError || error instanceof Error) {
      out(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const pgUrl = flag(argv, 'postgres');
  const mysqlUrl = flag(argv, 'mysql');
  const libsqlUrl = flag(argv, 'libsql');

  if (pgUrl) {
    const pg = connectPostgres(pgUrl, { max: 1 });
    const code = await main(argv, pg.db).finally(() => pg.close());
    process.exit(code);
  }
  if (mysqlUrl) {
    const my = connectMysql(mysqlUrl, { max: 1 });
    const code = await main(argv, my.db).finally(() => my.close());
    process.exit(code);
  }
  if (libsqlUrl) {
    const lib = connectLibsql(libsqlUrl, process.env.LIBSQL_AUTH_TOKEN);
    const code = await main(argv, lib.db).finally(() => lib.close());
    process.exit(code);
  }

  const cwd = join(dirname(fileURLToPath(import.meta.url)), '..', 'workers', 'api');
  const dbName = flag(argv, 'db') ?? defaultD1DatabaseName(cwd);
  const db = wranglerD1Database({ dbName, local: argv.includes('--local'), persistTo: flag(argv, 'persist-to'), cwd });
  process.exit(await main(argv, db));
}
