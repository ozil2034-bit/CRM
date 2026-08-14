import { useEffect, useState, type FormEvent } from 'react';

import { Alert, Badge, Button, Field } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { refuseSelfAction, type Role } from '@/domain/authorization';
import {
  createEmployee,
  observeUsers,
  setUserActive,
  setUserRole,
  type EmployeeRecord,
} from '@/services/users.service';

/**
 * Staff management. Owner only.
 *
 * Every mutation here goes through a Cloud Function: roles live in Auth custom
 * claims, which no client can write. The interface cannot change a role even if
 * this component were tampered with — it can only ask the server to.
 */
export function UsersPage() {
  const { t } = useT();
  const { principal } = useAuth();
  const [users, setUsers] = useState<EmployeeRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  useEffect(() => observeUsers(setUsers, (message) => setError(message)), []);

  async function run(uid: string, action: () => Promise<void>, success: string): Promise<void> {
    if (busyUid !== null) return;

    setBusyUid(uid);
    setError(null);
    setNotice(null);

    try {
      await action();
      setNotice(success);
    } catch (caught) {
      setError((caught as { message?: string }).message ?? 'That change could not be applied.');
    } finally {
      setBusyUid(null);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <p className="label-caps">{t('users.administration')}</p>
      <h1 className="display mt-2 text-3xl text-ink-900">{t('nav.staff')}</h1>
      <p className="mt-3 max-w-prose text-sm text-ink-600">
        Employees set their own passwords through an emailed link. No password is ever chosen here,
        seen here, or stored by this application.
      </p>

      {error && (
        <Alert tone="error" className="mt-6">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" className="mt-6">
          {notice}
        </Alert>
      )}

      <CreateEmployeeForm
        onCreated={(message) => {
          setNotice(message);
          setError(null);
        }}
        onFailed={(message) => {
          setError(message);
          setNotice(null);
        }}
      />

      <section className="mt-14">
        <h2 className="label-caps">{t('users.accounts')}</h2>

        {users === null && <p className="mt-4 text-sm text-ink-400" role="status">{t('state.loading')}</p>}

        {users?.length === 0 && (
          <p className="mt-4 text-sm text-ink-400">No employee accounts yet.</p>
        )}

        <ul className="mt-4 divide-y divide-ink-100">
          {users?.map((user) => {
            const isSelf = user.uid === principal?.uid;
            const busy = busyUid === user.uid;

            return (
              <li key={user.uid} className="flex flex-wrap items-center gap-4 py-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink-900">{user.name}</p>
                  <p className="truncate text-xs text-ink-400">{user.email}</p>
                </div>

                <Badge tone={user.role === 'OWNER' ? 'gold' : 'neutral'}>
                  {user.role === 'OWNER' ? 'Owner' : 'Staff'}
                </Badge>

                <Badge tone={user.active ? 'success' : 'danger'}>
                  {user.active ? 'Active' : 'Deactivated'}
                </Badge>

                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy}
                    // Self-demotion can leave the boutique with no owner and no
                    // route back. Refused here and again in the Function.
                    disabled={
                      refuseSelfAction(principal?.uid ?? '', user.uid, 'changeRole') !== null
                    }
                    onClick={() =>
                      void run(
                        user.uid,
                        () =>
                          setUserRole({
                            targetUid: user.uid,
                            role: user.role === 'OWNER' ? 'STAFF' : 'OWNER',
                          }),
                        `${user.name} is now ${user.role === 'OWNER' ? 'staff' : 'an owner'}.`,
                      )
                    }
                  >
                    {user.role === 'OWNER' ? 'Make staff' : 'Make owner'}
                  </Button>

                  <Button
                    variant={user.active ? 'danger' : 'secondary'}
                    size="sm"
                    loading={busy}
                    disabled={
                      refuseSelfAction(principal?.uid ?? '', user.uid, 'deactivate') !== null
                    }
                    onClick={() =>
                      void run(
                        user.uid,
                        () => setUserActive({ targetUid: user.uid, active: !user.active }),
                        `${user.name} has been ${user.active ? 'deactivated' : 'reactivated'}.`,
                      )
                    }
                  >
                    {user.active ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </div>

                {isSelf && (
                  <span className="w-full text-xs text-ink-400">This is your account.</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}

function CreateEmployeeForm({
  onCreated,
  onFailed,
}: {
  onCreated: (message: string) => void;
  onFailed: (message: string) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('STAFF');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    try {
      await createEmployee({ name, email, role });
      onCreated(`${name} has been added. They will receive an email to set their password.`);
      setName('');
      setEmail('');
      setRole('STAFF');
    } catch (caught) {
      // Input is preserved so nothing is retyped after a failure.
      onFailed((caught as { message?: string }).message ?? 'The account could not be created.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-10 border-t border-ink-100 pt-8">
      <h2 className="label-caps">{t('users.addEmployee')}</h2>

      <div className="mt-4 grid gap-6 sm:grid-cols-3">
        <Field
          label={t('users.name')}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={submitting}
        />
        <Field
          label={t('users.email')}
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
        />
        <div className="flex flex-col gap-1.5">
          <span className="label-caps">{t('users.role')}</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            disabled={submitting}
            className="h-11 border-0 border-b border-ink-200 bg-transparent px-0 pb-1 text-base text-ink-900 focus:border-gold-500 focus:outline-none"
          >
            <option value="STAFF">{t('role.STAFF')}</option>
            <option value="OWNER">{t('role.OWNER')}</option>
          </select>
        </div>
      </div>

      <div className="mt-6">
        <Button type="submit" loading={submitting}>
          Add employee
        </Button>
      </div>
    </form>
  );
}
