import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';
import { BunSqliteDatabase, migrateSqlite } from '../apps/server/src/sqlite';
import { Accounts } from '../workers/api/src/accounts';
import { authTokenHash, verifyPassword } from '../workers/api/src/passwords';
import { interpolateSql, main, parseWranglerD1Json } from './accounts';

let db: BunSqliteDatabase;
let accounts: Accounts;

beforeEach(() => {
  db = new BunSqliteDatabase();
  migrateSqlite(db, join(import.meta.dir, '../workers/migrations'));
  accounts = new Accounts(db);
});

afterEach(() => db.raw.close());

it('creates one owner and canonicalizes identities', async () => {
  expect(await accounts.hasOwner()).toBe(false);
  const owner = await accounts.createOwner(' Owner@Example.com ', 'Owner', 'hash');
  expect(await accounts.hasOwner()).toBe(true);
  expect(owner.email).toBe('owner@example.com');
  expect((await accounts.credentials('OWNER@example.com'))?.role).toBe('owner');
  await expect(accounts.createOwner('other@example.com', 'Other', 'hash')).rejects.toThrow();
  await expect(accounts.disable('owner')).rejects.toThrow('owner');
});

it('bootstraps an owner from env defaults idempotently and skips invalid inputs', async () => {
  expect(await accounts.ensureBootstrapOwner('not-an-email', 'longpassword')).toBeNull();
  expect(await accounts.ensureBootstrapOwner('admin@example.com', 'short')).toBeNull();
  const created = await accounts.ensureBootstrapOwner('admin.ops@example.com', 'longpassword');
  expect(created).toMatchObject({ id: 'owner', email: 'admin.ops@example.com', name: 'Admin Ops', role: 'owner' });
  expect(await accounts.ensureBootstrapOwner('other@example.com', 'longpassword')).toBeNull();
});

it('consumes invitations once and preserves the invited role and email', async () => {
  const token = await accounts.invite('Reader@example.com', 'viewer', 'owner', 1000);
  const user = await accounts.acceptInvite(token, 'Reader', 'hash', 1001);
  expect(user).toMatchObject({ email: 'reader@example.com', role: 'viewer' });
  expect(await accounts.acceptInvite(token, 'Attacker', 'hash', 1002)).toBeNull();
  expect(db.raw.query('SELECT count(*) AS n FROM dashboard_invites').get()).toEqual({ n: 0 });
  await expect(accounts.invite('reader@example.com', 'admin', 'owner')).rejects.toThrow('already');
});

it('rejects expired and unknown invitations', async () => {
  const token = await accounts.invite('expired@example.com', 'admin', 'owner', 1000);
  expect(await accounts.acceptInvite(token, 'Expired', 'hash', 1000 + 7 * 86400000)).toBeNull();
  expect(await accounts.acceptInvite('unknown', 'Unknown', 'hash')).toBeNull();
});

it('stores session digests, enforces expiry and revokes sessions on logout or disable', async () => {
  const invite = await accounts.invite('user@example.com', 'admin', 'owner', 1000);
  const user = await accounts.acceptInvite(invite, 'User', 'hash', 1001);
  const session = await accounts.newSession(user!.id, false, 2000);
  expect(session).not.toBeNull();
  expect(await accounts.session(session!.token, 2001)).toMatchObject({ id: user!.id, role: 'admin' });
  expect(await accounts.session(session!.token, session!.expiresAt)).toBeNull();
  expect(JSON.stringify(db.raw.query('SELECT * FROM dashboard_sessions').all())).not.toContain(session!.token);
  await accounts.logout(session!.token);
  expect(await accounts.session(session!.token, 2001)).toBeNull();
  const second = await accounts.newSession(user!.id, true, 2000);
  expect(second!.expiresAt).toBe(2000 + 30 * 86400000);
  await accounts.disable(user!.id);
  expect(await accounts.session(second!.token, 2001)).toBeNull();
  expect(await accounts.newSession(user!.id)).toBeNull();
});

it('creates accounts and resets passwords via CLI without deleting other accounts or sessions', async () => {
  const lines: string[] = [];
  const out = (line: string) => lines.push(line);

  expect(await main(['list'], db, { out })).toBe(0);
  expect(lines.at(-1)).toBe('No accounts.');

  // First create defaults to owner when no owner exists.
  expect(await main(['create', '--email', 'boss@example.com', '--password', 'old-password-1'], db, { out })).toBe(0);
  expect(lines.at(-1)).toContain('Created owner account: boss@example.com (Boss)');

  // Second create without --role refuses to overwrite owner; with --role admin creates teammate.
  expect(await main(['create', '--email', 'teammate@example.com', '--password', 'team-pass-1'], db, { out })).toBe(1);
  expect(
    await main(['create', '--email', 'teammate@example.com', '--role', 'admin', '--name', 'Alex', '--password-stdin'], db, {
      out,
      readStdin: async () => 'team-pass-1\n',
    }),
  ).toBe(0);

  const ownerSession = await accounts.newSession('owner', false, 2000);
  const teammate = await accounts.credentials('teammate@example.com');
  const teammateSession = await accounts.newSession(teammate!.id, false, 2000);

  // Seed a login throttle entry for the owner to ensure reset clears it.
  const now = Date.now();
  const bucket = authTokenHash(`email:boss@example.com:${Math.floor(now / 900000)}`);
  await db.prepare('INSERT INTO dashboard_auth_limits (bucket, attempts, expires_at) VALUES (?, 10, ?)').bind(bucket, now + 900000).run();

  // Reset owner password and email via --owner without touching teammate or their session.
  expect(
    await main(['reset-password', '--owner', '--new-email', 'owner@example.com', '--password', 'fresh-password-2'], db, { out }),
  ).toBe(0);

  const updatedOwner = await accounts.credentials('owner@example.com');
  expect(updatedOwner?.id).toBe('owner');
  expect(await verifyPassword('fresh-password-2', updatedOwner!.password_hash)).toBe(true);
  expect(await verifyPassword('old-password-1', updatedOwner!.password_hash)).toBe(false);
  expect(await accounts.session(ownerSession!.token, 2001)).toBeNull();
  expect(await accounts.session(teammateSession!.token, 2001)).toMatchObject({ email: 'teammate@example.com' });
  expect(await db.prepare('SELECT attempts FROM dashboard_auth_limits WHERE bucket = ?').bind(bucket).first()).toBeNull();

  // Disable teammate, then re-enable via reset-password --enable.
  await accounts.disable(teammate!.id);
  expect(await main(['reset-password', '--email', 'teammate@example.com', '--password', 'team-pass-2', '--enable'], db, { out })).toBe(0);
  const enabledTeammate = await accounts.credentials('teammate@example.com');
  expect(enabledTeammate?.disabled).toBe(0);
  expect(await verifyPassword('team-pass-2', enabledTeammate!.password_hash)).toBe(true);

  lines.length = 0;
  expect(await main(['list'], db, { out })).toBe(0);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('owner@example.com');
  expect(lines[1]).toContain('teammate@example.com');
});

it('interpolates SQL literals safely for wrangler d1 execute', () => {
  expect(interpolateSql("SELECT * FROM dashboard_users WHERE email = ? AND name = ? AND disabled = ? AND id != '?'", ["o'reilly@example.com", null, false])).toBe(
    "SELECT * FROM dashboard_users WHERE email = 'o''reilly@example.com' AND name = NULL AND disabled = 0 AND id != '?'",
  );
  expect(() => interpolateSql('SELECT ?', ['bad\0value'])).toThrow('NUL');
  expect(() => interpolateSql('SELECT ?, ?', ['only-one'])).toThrow('Missing');
  expect(() => interpolateSql('SELECT ?', ['one', 'two'])).toThrow('Unused');
});

it('parses wrangler d1 JSON output even when preceded by [WARNING] banners', () => {
  const noisy = '▲ [WARNING] Proxy environment variables detected.\n\n[\n  {\n    "results": [{ "id": "owner" }],\n    "success": true,\n    "meta": { "changes": 0 }\n  }\n]\n';
  expect(parseWranglerD1Json(noisy)).toEqual([{ results: [{ id: 'owner' }], success: true, meta: { changes: 0 } }]);
});
