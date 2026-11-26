import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Checkbox } from '@cloudflare/kumo/components/checkbox';
import { Input } from '@cloudflare/kumo/components/input';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { ArrowClockwiseIcon, BroadcastIcon, CheckCircleIcon, EyeIcon, EyeSlashIcon, SparkleIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { accountRequest, refreshSession, setSessionUser, useSessionStatus, useSessionUser } from '@/lib/auth';
import { USING_MOCK } from '@/lib/config';

type Mode = 'login' | 'setup' | 'invite';

export default function KeyGate({ children }: { children: ReactNode }) {
  const user = useSessionUser();
  const [checking, setChecking] = useState(!USING_MOCK);
  const [unavailable, setUnavailable] = useState(false);
  const check = async () => {
    setChecking(true);
    setUnavailable(false);
    try {
      await refreshSession();
    } catch {
      setUnavailable(true);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (!USING_MOCK) void check();
  }, []);
  if (USING_MOCK) return children;
  if (checking) {
    return (
      <div role="status" className="grid min-h-full place-items-center p-8">
        <div className="flex flex-col items-center gap-4 text-sm text-kumo-subtle">
          <div className="grid size-11 place-items-center rounded-xl bg-kumo-brand text-white shadow-xs">
            <BroadcastIcon size={22} weight="bold" />
          </div>
          <span>Checking your session…</span>
        </div>
      </div>
    );
  }
  if (unavailable) {
    return (
      <div className="grid min-h-full place-items-center p-8">
        <LayerCard className="w-full max-w-md p-8 text-center">
          <WarningCircleIcon size={32} className="mx-auto text-kumo-danger" />
          <h1 className="mt-4 text-lg font-semibold text-kumo-strong">Could not connect to EdgeWatch</h1>
          <p className="mt-2 text-sm text-kumo-subtle">Check that the API server is reachable and try again.</p>
          <Button variant="primary" icon={ArrowClockwiseIcon} className="mt-6" onClick={check}>
            Try again
          </Button>
        </LayerCard>
      </div>
    );
  }
  return user ? children : <SignIn />;
}

function PasswordInput({
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  description,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  minLength?: number;
  description?: ReactNode;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-kumo-default">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          required
          minLength={minLength}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full pr-11"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-strong"
        >
          {visible ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
        </button>
      </div>
      {description && <div className="text-xs text-kumo-subtle">{description}</div>}
    </div>
  );
}

function SignIn() {
  const { setupRequired, setupTokenRequired } = useSessionStatus();
  const [entry] = useState(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const setup = hash.get('setup');
    const invite = hash.get('invite');
    return {
      mode: (setup ? 'setup' : invite ? 'invite' : setupRequired ? 'setup' : 'login') as Mode,
      token: setup ?? invite ?? '',
      fromLink: Boolean(setup || invite),
    };
  });
  useEffect(() => {
    if (entry.token) history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [entry.token]);

  const [mode, setMode] = useState<Mode>(entry.mode);
  const [token, setToken] = useState(entry.token);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(entry.mode === 'setup');
  const [busy, setBusy] = useState(false);
  const toasts = useKumoToastManager();

  const needsSetupToken = mode === 'setup' && (setupTokenRequired || (entry.fromLink && entry.mode === 'setup'));
  const needsInviteToken = mode === 'invite' && !(entry.fromLink && entry.mode === 'invite' && token);

  const title = mode === 'setup' ? 'Set up your owner account' : mode === 'invite' ? 'Accept your invitation' : 'Sign in to EdgeWatch';
  const subtitle = mode === 'setup'
    ? 'Choose an email and password to claim this EdgeWatch installation.'
    : mode === 'invite'
      ? 'Choose your display name and a password to join this workspace.'
      : 'Monitor your applications and investigate what happened.';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (mode === 'login') {
        const data = await accountRequest('login', { email, password, remember });
        setSessionUser(data.user);
      } else if (mode === 'setup') {
        const data = await accountRequest('setup', {
          email,
          password,
          remember,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(token ? { token } : {}),
        });
        setSessionUser(data.user);
        toasts.add({ title: 'Owner account created. Welcome to EdgeWatch.', variant: 'success' });
      } else {
        const data = await accountRequest('accept-invitation', { name, password, token, remember });
        setSessionUser(data.user);
        toasts.add({ title: 'Welcome to EdgeWatch.', variant: 'success' });
      }
    } catch (error) {
      toasts.add({ id: 'sign-in-error', title: error instanceof Error ? error.message : 'Could not sign in. Try again.', variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const passwordReady = password.length >= 8;

  return (
    <div className="grid min-h-full place-items-center px-6 py-12">
      <form
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-6 rounded-2xl bg-kumo-elevated p-8 ring ring-kumo-line shadow-sm"
        data-testid="account-gate"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-kumo-brand text-white shadow-xs">
              <BroadcastIcon size={20} weight="bold" />
            </div>
            <div>
              <div className="text-[15px] font-semibold leading-tight text-kumo-strong">EdgeWatch</div>
              <div className="mt-0.5 text-xs text-kumo-subtle">Nightwatch APM</div>
            </div>
          </div>
          {mode === 'setup' && (
            <Badge variant="info">
              <SparkleIcon />
              First setup
            </Badge>
          )}
        </div>
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-strong">{title}</h1>
          <p className="text-sm leading-relaxed text-kumo-subtle">{subtitle}</p>
        </div>
        <div className="flex flex-col gap-4">
          {mode === 'invite' && entry.fromLink && entry.mode === 'invite' && token && (
            <div className="flex items-center gap-2.5 rounded-lg border border-kumo-hairline bg-kumo-success-tint px-3.5 py-2.5 text-xs text-kumo-success">
              <CheckCircleIcon size={16} className="shrink-0" />
              <span>Invitation link ready</span>
            </div>
          )}
          {mode !== 'invite' && (
            <Input
              label="Email"
              type="email"
              autoComplete="username"
              placeholder="admin@example.com"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
          {mode === 'invite' && (
            <Input
              label="Name"
              autoComplete="name"
              placeholder="Your name"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          {needsSetupToken && (
            <Input
              label="Setup token"
              type="password"
              placeholder="From OWNER_SETUP_TOKEN"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          )}
          {needsInviteToken && (
            <Input
              label="Invitation token"
              type="password"
              placeholder="Paste the token from your invite link"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          )}
          <PasswordInput
            label="Password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'login' ? undefined : 8}
            placeholder={mode === 'login' ? 'Enter your password' : 'At least 8 characters'}
            value={password}
            onChange={setPassword}
            description={
              mode !== 'login' ? (
                <span className={passwordReady ? 'text-kumo-success' : undefined}>
                  {passwordReady ? 'Password length looks good.' : `${Math.max(0, 8 - password.length)} more character${8 - password.length === 1 ? '' : 's'} needed (minimum 8).`}
                </span>
              ) : undefined
            }
          />
          {mode === 'setup' && (
            <Input
              label="Display name (optional)"
              autoComplete="name"
              placeholder="Defaults from your email"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <Checkbox label="Remember me for 30 days" checked={remember} onCheckedChange={(value) => setRemember(value === true)} />
        </div>
        <Button type="submit" variant="primary" className="w-full justify-center" loading={busy} disabled={busy}>
          {mode === 'login' ? 'Sign in' : mode === 'setup' ? 'Create owner account' : 'Join workspace'}
        </Button>
        {(mode !== 'login' || setupRequired) && (
          <div className="border-t border-kumo-hairline pt-4">
            {mode === 'login' ? (
              <Button type="button" variant="ghost" size="sm" className="w-full justify-center" onClick={() => setMode('setup')}>
                Set up owner account
              </Button>
            ) : (
              <Button type="button" variant="ghost" size="sm" className="w-full justify-center" onClick={() => setMode('login')}>
                Already have an account? Sign in
              </Button>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
