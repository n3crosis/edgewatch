import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { SqlDatabase } from '@edgewatch/shared';
import { Accounts, type Account } from './accounts';
import { authTokenHash, defaultDisplayName, hashPassword, normalizeEmail, passwordProblem, verifyPassword } from './passwords';

type Bindings = {
  DB: SqlDatabase;
  DASHBOARD_ORIGIN?: string;
  OWNER_SETUP_TOKEN?: string;
  OWNER_EMAIL?: string;
  OWNER_PASSWORD?: string;
  OWNER_NAME?: string;
};

const COOKIE = 'edgewatch_session';
export const sessionToken = (c: Context) => getCookie(c, COOKIE) ?? '';
export function trustedOrigin(c: Pick<Context<{ Bindings: Bindings }>, 'req' | 'env'>): boolean {
  const origin = c.req.header('origin');
  return !!origin && (origin === new URL(c.req.url).origin || origin === c.env.DASHBOARD_ORIGIN);
}
const cookieOptions = (c: Context) => ({ httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax' as const, path: '/' });

const presetOwner = (c: Context<{ Bindings: Bindings }>) => Boolean(c.env.OWNER_EMAIL && c.env.OWNER_PASSWORD);
const SETUP_DISABLED = {
  unconfigured: 'Owner setup is disabled: set OWNER_SETUP_TOKEN (to claim the owner here) or OWNER_EMAIL and OWNER_PASSWORD on the API, then retry.',
  preset: 'Owner setup is disabled: the owner is created from OWNER_EMAIL and OWNER_PASSWORD. Check that OWNER_EMAIL is valid and OWNER_PASSWORD has at least 8 characters, or set OWNER_SETUP_TOKEN.',
};

async function maybeBootstrapOwner(c: Context<{ Bindings: Bindings }>, accounts: Accounts): Promise<void> {
  if (c.env.OWNER_EMAIL && c.env.OWNER_PASSWORD) {
    await accounts.ensureBootstrapOwner(c.env.OWNER_EMAIL, c.env.OWNER_PASSWORD, c.env.OWNER_NAME);
  }
}

async function issueSession(c: Context<{ Bindings: Bindings }>, accounts: Accounts, userId: string, remember: boolean) {
  const session = await accounts.newSession(userId, remember);
  if (!session) return null;
  const old = sessionToken(c);
  if (old) await accounts.logout(old);
  setCookie(c, COOKIE, session.token, { ...cookieOptions(c), ...(remember ? { maxAge: 30 * 86400 } : {}) });
  return accounts.session(session.token);
}

export const login = new Hono<{ Bindings: Bindings }>();
login.use('*', bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: 'Request is too large.' }, 413) }));
login.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(c.req.method) && !trustedOrigin(c)) return c.json({ error: 'This request origin is not allowed.' }, 403);
  await next();
});

async function throttle(c: Context<{ Bindings: Bindings }>, identity: string, maximum: number) {
  const now = Date.now();
  const window = Math.floor(now / 900000);
  const bucket = authTokenHash(`${identity}:${window}`);
  await c.env.DB.prepare(`INSERT INTO dashboard_auth_limits (bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = dashboard_auth_limits.attempts + 1`).bind(bucket, now + 900000).run();
  const count = await c.env.DB.prepare('SELECT attempts FROM dashboard_auth_limits WHERE bucket = ?').bind(bucket).first<number>('attempts');
  await c.env.DB.prepare('DELETE FROM dashboard_auth_limits WHERE expires_at < ?').bind(now).run();
  return (count ?? maximum + 1) <= maximum;
}

login.use('*', async (c, next) => {
  if (c.req.method === 'POST' && !await throttle(c, `ip:${c.req.header('cf-connecting-ip') ?? 'local'}`, 60)) {
    c.header('Retry-After', '900');
    return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  }
  await next();
});

login.get('/session', async (c) => {
  const accounts = new Accounts(c.env.DB);
  await maybeBootstrapOwner(c, accounts);
  const [account, ownerExists] = await Promise.all([
    sessionToken(c) ? accounts.session(sessionToken(c)) : Promise.resolve(null),
    accounts.hasOwner(),
  ]);
  return c.json({
    user: account,
    setup_required: !ownerExists,
    setup_token_required: Boolean(c.env.OWNER_SETUP_TOKEN),
    setup_available: !ownerExists && Boolean(c.env.OWNER_SETUP_TOKEN),
  });
});

login.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email || typeof body?.password !== 'string') return c.json({ error: 'Enter your email and password.' }, 422);
  if (!await throttle(c, `email:${email}`, 10)) {
    c.header('Retry-After', '900');
    return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  }
  const accounts = new Accounts(c.env.DB);
  await maybeBootstrapOwner(c, accounts);
  const record = await accounts.credentials(email);
  // Unknown accounts perform the same password work, without exposing whether the email exists.
  const dummy = `scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(64)}`;
  const valid = await verifyPassword(body.password, record?.password_hash ?? dummy);
  if (!valid || !record || record.disabled) return c.json({ error: 'Email or password is incorrect.' }, 401);
  const user = await issueSession(c, accounts, record.id, body.remember === true);
  if (!user) return c.json({ error: 'Email or password is incorrect.' }, 401);
  return c.json({ user });
});

login.post('/logout', async (c) => {
  if (sessionToken(c)) await new Accounts(c.env.DB).logout(sessionToken(c));
  deleteCookie(c, COOKIE, cookieOptions(c));
  return c.json({ ok: true });
});

login.post('/setup', async (c) => {
  const body = await c.req.json().catch(() => null);
  const accounts = new Accounts(c.env.DB);
  await maybeBootstrapOwner(c, accounts);
  // Fails closed: the public claim needs OWNER_SETUP_TOKEN; with only OWNER_EMAIL + OWNER_PASSWORD the owner is created from them.
  if (!c.env.OWNER_SETUP_TOKEN) {
    if (await accounts.hasOwner()) return c.json({ error: 'The owner account already exists.' }, 409);
    return c.json({ error: SETUP_DISABLED[presetOwner(c) ? 'preset' : 'unconfigured'], code: 'setup_disabled' }, 403);
  }
  if (typeof body?.token !== 'string' || authTokenHash(body.token) !== authTokenHash(c.env.OWNER_SETUP_TOKEN)) {
    return c.json({ error: 'Invalid setup token.' }, 403);
  }
  if (await accounts.hasOwner()) return c.json({ error: 'The owner account already exists.' }, 409);
  const email = normalizeEmail(body?.email);
  const problem = passwordProblem(body?.password);
  const rawName = body?.name;
  if (rawName !== undefined && rawName !== null && (typeof rawName !== 'string' || rawName.length > 100)) {
    return c.json({ error: 'Display name must be at most 100 characters.' }, 422);
  }
  if (!email || problem) return c.json({ error: problem ?? 'Enter a valid email address.' }, 422);
  const displayName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : defaultDisplayName(email);
  let account: Account;
  try {
    account = await accounts.createOwner(email, displayName, await hashPassword(body.password));
  } catch {
    if (await accounts.hasOwner()) return c.json({ error: 'The owner account already exists.' }, 409);
    throw new Error('Could not create the owner account.');
  }
  await issueSession(c, accounts, account.id, body?.remember === true);
  return c.json({ user: account }, 201);
});

login.post('/invitations', async (c) => {
  const accounts = new Accounts(c.env.DB);
  const actor = await accounts.session(sessionToken(c));
  if (!actor || actor.role !== 'owner') return c.json({ error: 'Only the owner can invite users.' }, 403);
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email || !['admin', 'viewer'].includes(body?.role)) return c.json({ error: 'Enter an email and choose a role.' }, 422);
  if (await accounts.credentials(email)) return c.json({ error: 'This email already has an account.' }, 409);
  const existing = await c.env.DB.prepare('SELECT email FROM dashboard_invites WHERE email = ?').bind(email).first();
  if (existing) return c.json({ error: 'An invitation already exists for this email.' }, 409);
  return c.json({ token: await accounts.invite(email, body.role, actor.id) }, 201);
});

login.post('/accept-invitation', async (c) => {
  const body = await c.req.json().catch(() => null);
  const problem = passwordProblem(body?.password);
  if (problem || typeof body?.token !== 'string' || body.token.length > 100 || typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 100) {
    return c.json({ error: problem ?? 'Enter your name and invitation token.' }, 422);
  }
  const accounts = new Accounts(c.env.DB);
  const user = await accounts.acceptInvite(body.token, body.name.trim(), await hashPassword(body.password));
  if (!user) return c.json({ error: 'This invitation is invalid or expired.' }, 410);
  await issueSession(c, accounts, user.id, body?.remember === true);
  return c.json({ user }, 201);
});

login.use('/manage/*', async (c, next) => {
  const actor = await new Accounts(c.env.DB).session(sessionToken(c));
  if (actor?.role !== 'owner') return c.json({ error: 'Only the owner can manage accounts.' }, 403);
  await next();
});
login.get('/manage/accounts', async (c) => {
  const { results: users } = await c.env.DB.prepare('SELECT id, email, name, role, disabled, created_at FROM dashboard_users ORDER BY created_at, id LIMIT 1000').all();
  const { results: invitations } = await c.env.DB.prepare('SELECT email, role, expires_at, created_at FROM dashboard_invites ORDER BY created_at, email LIMIT 1000').all();
  return c.json({ users, invitations });
});
login.post('/manage/revoke-invitation', async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return c.json({ error: 'Invalid email address.' }, 422);
  await c.env.DB.prepare('DELETE FROM dashboard_invites WHERE email = ?').bind(email).run();
  return c.json({ ok: true });
});
login.post('/manage/disable', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.id !== 'string' || body.id === 'owner') return c.json({ error: 'The owner account cannot be disabled.' }, 422);
  await new Accounts(c.env.DB).disable(body.id);
  return c.json({ ok: true });
});
