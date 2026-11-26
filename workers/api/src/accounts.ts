import type { SqlDatabase } from '@edgewatch/shared';
import { authTokenHash, defaultDisplayName, hashPassword, newAuthToken, normalizeEmail, passwordProblem } from './passwords';

export type AccountRole = 'owner' | 'admin' | 'viewer';
export interface Account { id: string; email: string; name: string; role: AccountRole }
export interface AccountCredentials extends Account { password_hash: string; disabled: number }
export interface AccountSummary extends Account { disabled: number; created_at: number }
const fields = 'id, email, name, role';

export class Accounts {
  constructor(private db: SqlDatabase) {}

  async hasOwner(): Promise<boolean> {
    return Boolean(await this.db.prepare('SELECT id FROM dashboard_users WHERE id = ?').bind('owner').first());
  }

  async list(): Promise<AccountSummary[]> {
    const { results } = await this.db
      .prepare(`SELECT ${fields}, disabled, created_at FROM dashboard_users ORDER BY CASE WHEN id = 'owner' THEN 0 ELSE 1 END, created_at ASC`)
      .all<AccountSummary>();
    return results;
  }

  async createOwner(email: string, name: string, passwordHash: string, now = Date.now()): Promise<Account> {
    const canonical = normalizeEmail(email);
    if (!canonical) throw new Error('Invalid email address.');
    const displayName = name.trim() || defaultDisplayName(canonical);
    // Fixed ID ensures concurrent bootstrap attempts cannot create multiple owners.
    await this.db.prepare('INSERT INTO dashboard_users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('owner', canonical, displayName, passwordHash, 'owner', now).run();
    return { id: 'owner', email: canonical, name: displayName, role: 'owner' };
  }

  /** Creates an owner, admin, or viewer account directly without deleting or resetting any existing data. */
  async createAccount(email: string, name: string, passwordHash: string, role: AccountRole, now = Date.now()): Promise<Account> {
    const canonical = normalizeEmail(email);
    if (!canonical) throw new Error('Invalid email address.');
    if (!['owner', 'admin', 'viewer'].includes(role)) throw new Error('Role must be owner, admin, or viewer.');
    if (role === 'owner') {
      if (await this.hasOwner()) throw new Error('An owner account already exists. Use reset-password to change its password.');
      return this.createOwner(canonical, name, passwordHash, now);
    }
    if (await this.credentials(canonical)) throw new Error('An account with this email already exists.');
    const id = crypto.randomUUID();
    const displayName = name.trim().slice(0, 100) || defaultDisplayName(canonical);
    await this.db.prepare('INSERT INTO dashboard_users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, canonical, displayName, passwordHash, role, now).run();
    return { id, email: canonical, name: displayName, role };
  }

  /**
   * Resets an account's password (and optionally updates its email/name or re-enables it), revokes only that
   * account's active sessions, and clears its current login throttle bucket without touching any other data.
   */
  async resetPassword(
    target: { email?: string; owner?: boolean },
    passwordHash: string,
    options?: { newEmail?: string; name?: string; enable?: boolean; now?: number },
  ): Promise<Account | null> {
    let existing: AccountCredentials | null = null;
    if (target.owner) {
      existing = await this.db
        .prepare(`SELECT ${fields}, password_hash, disabled FROM dashboard_users WHERE id = ?`)
        .bind('owner')
        .first<AccountCredentials>();
    } else {
      const canonical = normalizeEmail(target.email);
      if (!canonical) throw new Error('Invalid email address.');
      existing = await this.credentials(canonical);
    }
    if (!existing) return null;

    let nextEmail = existing.email;
    if (options?.newEmail !== undefined) {
      const canonicalNew = normalizeEmail(options.newEmail);
      if (!canonicalNew) throw new Error('Invalid new email address.');
      if (canonicalNew !== existing.email) {
        const conflict = await this.credentials(canonicalNew);
        if (conflict && conflict.id !== existing.id) throw new Error('Another account already uses that email address.');
      }
      nextEmail = canonicalNew;
    }

    const nextName = options?.name !== undefined
      ? (options.name.trim().slice(0, 100) || defaultDisplayName(nextEmail))
      : existing.name;
    const nextDisabled = options?.enable ? 0 : existing.disabled;
    const now = options?.now ?? Date.now();
    const window = Math.floor(now / 900000);
    const oldBucket = authTokenHash(`email:${existing.email}:${window}`);
    const newBucket = authTokenHash(`email:${nextEmail}:${window}`);

    await this.db.batch([
      this.db
        .prepare('UPDATE dashboard_users SET password_hash = ?, email = ?, name = ?, disabled = ? WHERE id = ?')
        .bind(passwordHash, nextEmail, nextName, nextDisabled, existing.id),
      this.db.prepare('DELETE FROM dashboard_sessions WHERE user_id = ?').bind(existing.id),
      this.db.prepare('DELETE FROM dashboard_auth_limits WHERE bucket = ? OR bucket = ?').bind(oldBucket, newBucket),
    ]);

    return { id: existing.id, email: nextEmail, name: nextName, role: existing.role };
  }

  /**
   * Idempotently creates the initial owner from environment defaults (OWNER_EMAIL + OWNER_PASSWORD)
   * if no owner account exists yet. Returns the created account, or null if skipped/already exists.
   */
  async ensureBootstrapOwner(email?: string, password?: string, name?: string, now = Date.now()): Promise<Account | null> {
    const canonical = normalizeEmail(email);
    if (!canonical || passwordProblem(password)) return null;
    if (await this.hasOwner()) return null;
    const displayName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : defaultDisplayName(canonical);
    try {
      return await this.createOwner(canonical, displayName, await hashPassword(password!), now);
    } catch {
      // Another concurrent request or instance already created the owner row.
      if (await this.hasOwner()) return null;
      throw new Error('Could not create the initial owner account.');
    }
  }

  credentials(email: string): Promise<AccountCredentials | null> {
    return this.db.prepare(`SELECT ${fields}, password_hash, disabled FROM dashboard_users WHERE email = ?`).bind(normalizeEmail(email) ?? '').first<AccountCredentials>();
  }

  async invite(email: string, role: 'admin' | 'viewer', actor: string, now = Date.now()): Promise<string> {
    const canonical = normalizeEmail(email);
    if (!canonical || !['admin', 'viewer'].includes(role)) throw new Error('Invalid invitation.');
    if (await this.credentials(canonical)) throw new Error('This email already has an account.');
    const token = newAuthToken();
    await this.db.prepare('INSERT INTO dashboard_invites (token_hash, email, role, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(authTokenHash(token), canonical, role, now + 7 * 86400000, actor, now).run();
    return token;
  }

  async acceptInvite(token: string, name: string, passwordHash: string, now = Date.now()): Promise<Account | null> {
    const id = crypto.randomUUID();
    const hash = authTokenHash(token);
    await this.db.batch([
      this.db.prepare(`INSERT INTO dashboard_users (id, email, name, password_hash, role, created_at)
        SELECT ?, email, ?, ?, role, ? FROM dashboard_invites WHERE token_hash = ? AND expires_at > ?`)
        .bind(id, name, passwordHash, now, hash, now),
      this.db.prepare('DELETE FROM dashboard_invites WHERE token_hash = ? AND EXISTS (SELECT 1 FROM dashboard_users WHERE id = ?)').bind(hash, id),
    ]);
    return this.db.prepare(`SELECT ${fields} FROM dashboard_users WHERE id = ?`).bind(id).first<Account>();
  }

  async newSession(userId: string, remember = false, now = Date.now()): Promise<{ token: string; expiresAt: number } | null> {
    const token = newAuthToken();
    const hash = authTokenHash(token);
    const expiresAt = now + (remember ? 30 * 86400000 : 12 * 3600000);
    await this.db.prepare(`INSERT INTO dashboard_sessions (token_hash, user_id, expires_at, created_at)
      SELECT ?, id, ?, ? FROM dashboard_users WHERE id = ? AND disabled = 0`).bind(hash, expiresAt, now, userId).run();
    return await this.session(token, now) ? { token, expiresAt } : null;
  }

  session(token: string, now = Date.now()): Promise<Account | null> {
    return this.db.prepare(`SELECT u.id, u.email, u.name, u.role FROM dashboard_sessions s
      JOIN dashboard_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`)
      .bind(authTokenHash(token), now).first<Account>();
  }

  async logout(token: string): Promise<void> {
    await this.db.prepare('DELETE FROM dashboard_sessions WHERE token_hash = ?').bind(authTokenHash(token)).run();
  }

  async disable(userId: string): Promise<void> {
    if (userId === 'owner') throw new Error('The owner cannot be disabled.');
    await this.db.batch([
      this.db.prepare('UPDATE dashboard_users SET disabled = 1 WHERE id = ?').bind(userId),
      this.db.prepare('DELETE FROM dashboard_sessions WHERE user_id = ?').bind(userId),
    ]);
  }
}
