import { useState, type FormEvent } from 'react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { Table } from '@cloudflare/kumo/components/table';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { CopyIcon, KeyIcon } from '@phosphor-icons/react';
import { accountRequest, useSessionUser } from '@/lib/auth';
import { useAsync } from '@/lib/api';
import { Empty, ErrorState, Loading, PageHeader, Panel } from '@/components/common';

interface Member { id: string; name: string; email: string; role: string; disabled: number }
interface Invitation { email: string; role: string; expires_at: number }
interface Directory { users: Member[]; invitations: Invitation[] }

const roleVariant = (role: string): 'primary' | 'info' | 'secondary' =>
  role === 'owner' ? 'primary' : role === 'admin' ? 'info' : 'secondary';

export default function AccountsPage() {
  const user = useSessionUser();
  const [revision, setRevision] = useState(0);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'admin'>('viewer');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const [confirmation, setConfirmation] = useState<{ path: string; body: object; label: string; actionLabel: string } | null>(null);
  const toasts = useKumoToastManager();
  const owner = user?.role === 'owner';
  const { data, error, loading } = useAsync<Directory | null>(() => owner ? accountRequest('manage/accounts') : Promise.resolve(null), [owner, revision]);
  const notify = (err: unknown) => toasts.add({ variant: 'error', title: err instanceof Error ? err.message : 'Please try again.' });

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setLink('');
    try {
      const result = await accountRequest('invitations', { email, role });
      setLink(`${window.location.origin}/#invite=${encodeURIComponent(result.token)}`);
      setEmail('');
      setRevision((n) => n + 1);
      toasts.add({ variant: 'success', title: 'Invitation created. Share the link with your teammate.' });
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!confirmation || busy) return;
    setBusy(true);
    try {
      await accountRequest(confirmation.path, confirmation.body);
      setConfirmation(null);
      setLink('');
      setRevision((n) => n + 1);
      toasts.add({ variant: 'success', title: 'Account access updated.' });
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Accounts" subtitle="Manage who can access this EdgeWatch installation" />
      {!owner ? (
        <Panel>
          <Empty icon={<KeyIcon size={32} className="text-kumo-subtle" />} description="Ask the installation owner to invite teammates or change access.">
            Account management is restricted to the owner
          </Empty>
        </Panel>
      ) : (
        <div className="space-y-6">
          <Panel title="Invite a teammate">
            <form onSubmit={invite} className="space-y-5 p-6">
              <div className="flex flex-wrap items-end gap-4">
                <div className="min-w-64 flex-1 sm:max-w-sm">
                  <Input label="Email" type="email" required maxLength={254} placeholder="teammate@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
                </div>
                <Select label="Role" className="w-40" value={role} onValueChange={(value) => setRole(value as 'viewer' | 'admin')}>
                  <Select.Option value="viewer">Viewer</Select.Option>
                  <Select.Option value="admin">Admin</Select.Option>
                </Select>
                <Button type="submit" variant="primary" loading={busy} disabled={busy}>Create invitation</Button>
              </div>
              <p className="max-w-2xl text-xs leading-relaxed text-kumo-subtle">
                Viewers can investigate telemetry. Admins can also triage issues and replay dead letters. Invitations expire after seven days.
              </p>
              {link && (
                <div className="space-y-2.5 rounded-xl border border-kumo-hairline bg-kumo-elevated/60 p-5">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-64 flex-1">
                      <Input label="Invitation link" readOnly value={link} onFocus={(event) => event.target.select()} />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      icon={CopyIcon}
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(link)
                          .then(() => toasts.add({ title: 'Invitation link copied.', variant: 'success' }))
                          .catch(notify);
                      }}
                    >
                      Copy link
                    </Button>
                  </div>
                  <p className="text-xs text-kumo-subtle">Shown once. Share it only with the invited person. No email is sent automatically.</p>
                </div>
              )}
            </form>
          </Panel>

          {error ? (
            <ErrorState error={error} />
          ) : loading ? (
            <Loading />
          ) : data && (
            <>
              <Panel title={`Members (${data.users.length})`}>
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Name</Table.Head>
                      <Table.Head>Email</Table.Head>
                      <Table.Head>Role</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head className="text-right">Actions</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.users.map((member) => (
                      <Table.Row key={member.id} className="transition-colors hover:bg-kumo-tint/50">
                        <Table.Cell className="font-medium text-kumo-strong">
                          <span className="inline-flex items-center gap-2.5">
                            <span>{member.name}</span>
                            {user?.email === member.email && <Badge variant="outline">You</Badge>}
                          </span>
                        </Table.Cell>
                        <Table.Cell className="font-mono text-xs text-kumo-subtle">{member.email}</Table.Cell>
                        <Table.Cell><Badge variant={roleVariant(member.role)} className="capitalize">{member.role}</Badge></Table.Cell>
                        <Table.Cell><Badge variant={member.disabled ? 'secondary' : 'success'}>{member.disabled ? 'Disabled' : 'Active'}</Badge></Table.Cell>
                        <Table.Cell className="text-right">
                          {member.role !== 'owner' && !member.disabled && (
                            <Button
                              variant="secondary-destructive"
                              size="sm"
                              onClick={() => setConfirmation({
                                path: 'manage/disable',
                                body: { id: member.id },
                                label: `Disable access for ${member.email}? All their active sessions will end immediately.`,
                                actionLabel: 'Disable account',
                              })}
                            >
                              Disable
                            </Button>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </Panel>

              <Panel title={`Pending invitations (${data.invitations.length})`}>
                {data.invitations.length ? (
                  <ul className="divide-y divide-kumo-hairline">
                    {data.invitations.map((invitation) => {
                      const expired = invitation.expires_at <= Date.now();
                      return (
                        <li key={invitation.email} className="flex flex-wrap items-center justify-between gap-4 px-6 py-4.5 transition-colors hover:bg-kumo-tint/50">
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2.5">
                              <span className="font-mono text-xs font-medium text-kumo-strong">{invitation.email}</span>
                              <Badge variant={roleVariant(invitation.role)} className="capitalize">{invitation.role}</Badge>
                              {expired && <Badge variant="warning">Expired</Badge>}
                            </div>
                            <p className="text-xs text-kumo-subtle">
                              {expired ? 'Expired invitation' : `Expires ${new Date(invitation.expires_at).toLocaleString()}`}
                            </p>
                          </div>
                          <Button
                            variant="secondary-destructive"
                            size="sm"
                            onClick={() => setConfirmation({
                              path: 'manage/revoke-invitation',
                              body: { email: invitation.email },
                              label: `Revoke the invitation for ${invitation.email}?`,
                              actionLabel: 'Revoke invitation',
                            })}
                          >
                            Revoke
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <Empty>No pending invitations</Empty>
                )}
              </Panel>
            </>
          )}
        </div>
      )}
      <Dialog.Root open={confirmation !== null} onOpenChange={(open) => { if (!open && !busy) setConfirmation(null); }}>
        <Dialog className="space-y-5 p-6 sm:p-7">
          <div className="space-y-2">
            <Dialog.Title className="text-lg font-semibold text-kumo-strong">Confirm access change</Dialog.Title>
            <Dialog.Description className="text-sm leading-relaxed text-kumo-subtle">{confirmation?.label}</Dialog.Description>
          </div>
          <div className="flex justify-end gap-2.5 pt-1">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button>
            <Button variant="destructive" size="sm" disabled={busy} loading={busy} onClick={confirm}>{confirmation?.actionLabel ?? 'Confirm'}</Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}
