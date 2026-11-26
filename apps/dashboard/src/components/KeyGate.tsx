import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Checkbox } from '@cloudflare/kumo/components/checkbox';
import { Input } from '@cloudflare/kumo/components/input';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import {
  ArrowClockwiseIcon,
  BroadcastIcon,
  CheckCircleIcon,
  EyeIcon,
  EyeSlashIcon,
  InfoIcon,
  RocketLaunchIcon,
  SignInIcon,
  SparkleIcon,
  UserPlusIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
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
      <div role="status" className="ew-dot-grid grid min-h-full place-items-center bg-neutral-100 p-8 dark:bg-neutral-800">
        <div className="flex flex-col items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400">
          <BroadcastIcon size={24} weight="bold" className="text-neutral-900 dark:text-white" />
          <span className="font-mono text-xs uppercase tracking-widest">Checking session…</span>
        </div>
      </div>
    );
  }
  if (unavailable) {
    return (
      <div className="ew-dot-grid grid min-h-full place-items-center bg-neutral-100 p-8 dark:bg-neutral-800">
        <LayerCard className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-2xl shadow-black/[0.08] dark:border-neutral-800 dark:bg-neutral-900">
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
      <label htmlFor={id} className="block text-sm font-medium text-neutral-900 dark:text-neutral-200">
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
          className="h-11 w-full pr-11"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {visible ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
        </button>
      </div>
      {description && <div className="text-xs text-neutral-500 dark:text-neutral-400">{description}</div>}
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

  const title = mode === 'setup' ? 'Create owner account' : mode === 'invite' ? 'Accept invitation' : 'Sign in';

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
    /* 1:1 Nightwatch `GuestLayout-BNE8LsrV.js` + `SignIn-WdV4eG9v.js` */
    <div className="ew-dot-grid relative flex min-h-screen flex-col items-center justify-center bg-neutral-100 px-6 py-12 dark:bg-neutral-800">
      <div className="z-10 -mt-10 flex items-center gap-4 text-neutral-900 dark:text-neutral-300">
        <BroadcastIcon size={20} weight="bold" />
        <span className="font-mono text-sm font-semibold uppercase tracking-[0.24em]">EdgeWatch</span>
        {mode === 'setup' && (
          <Badge variant="info">
            <SparkleIcon />
            First setup
          </Badge>
        )}
      </div>

      <form
        onSubmit={submit}
        className="relative z-20 mt-10 flex w-full flex-col space-y-12 overflow-hidden rounded-xl border border-neutral-200 bg-white p-8 shadow-2xl backdrop-blur-sm sm:max-w-md md:mt-12 dark:border-neutral-800 dark:bg-neutral-900/50 dark:bg-[radial-gradient(100%_80%_at_50%_0%,rgba(30,30,30,0.3)_0%,#151515_100%)]"
        data-testid="account-gate"
      >
        <div className="flex h-3.5 w-12 flex-col self-center rounded-full border border-neutral-300 bg-neutral-300/50 dark:border-white/15 dark:bg-black/90" aria-hidden />

        <div className="flex flex-col items-center gap-2">
          <h1 className="text-center text-2xl leading-9 font-semibold text-neutral-900 md:text-3xl dark:text-white">
            {title}
          </h1>
        </div>

        <div className="space-y-8">
          {mode === 'invite' && entry.fromLink && entry.mode === 'invite' && token && (
            <div className="flex items-center gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
              <CheckCircleIcon size={16} className="shrink-0" />
              <span>Invitation link ready</span>
            </div>
          )}
          {mode !== 'invite' && (
            <Input
              label="Email"
              type="email"
              autoFocus
              autoComplete="email"
              placeholder="Enter email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-11"
            />
          )}
          {mode === 'invite' && (
            <Input
              label="Name"
              autoFocus
              autoComplete="name"
              placeholder="Your name"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-11"
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
              className="h-11"
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
              className="h-11"
            />
          )}
          <PasswordInput
            label="Password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'login' ? undefined : 8}
            placeholder={mode === 'login' ? 'Enter password' : 'At least 8 characters'}
            value={password}
            onChange={setPassword}
            description={
              mode !== 'login' ? (
                <span className={`inline-flex items-center gap-1.5 ${passwordReady ? 'text-kumo-success' : ''}`}>
                  {passwordReady ? <CheckCircleIcon size={13} className="shrink-0" /> : <InfoIcon size={13} className="shrink-0" />}
                  <span>
                    {passwordReady ? 'Password length looks good.' : `${Math.max(0, 8 - password.length)} more character${8 - password.length === 1 ? '' : 's'} needed (minimum 8).`}
                  </span>
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
              className="h-11"
            />
          )}
          <Checkbox label="Remember me" checked={remember} onCheckedChange={(value) => setRemember(value === true)} />

          <div className="flex flex-col items-center gap-4">
            <Button
              type="submit"
              variant="primary"
              icon={mode === 'login' ? SignInIcon : mode === 'setup' ? RocketLaunchIcon : UserPlusIcon}
              className="h-11 w-full justify-center rounded-lg"
              loading={busy}
              disabled={busy}
            >
              {mode === 'login' ? 'Sign in' : mode === 'setup' ? 'Create owner account' : 'Join workspace'}
            </Button>

            {(mode !== 'login' || setupRequired) && (
              <div className="w-full pt-2">
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
          </div>
        </div>
      </form>

      <div className="absolute bottom-0 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 py-8 font-mono text-xs font-light uppercase text-neutral-900 opacity-50 dark:text-white/50">
        <BroadcastIcon size={16} aria-hidden />
        <span>EdgeWatch</span>
      </div>
    </div>
  );
}
