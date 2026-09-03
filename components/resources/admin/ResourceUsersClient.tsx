'use client';

// Resources Admin — Users & Roles (post-closure hotfix, spec §6/§28/§29).
//
// Admin A0.2 Wave 5 changes, all of them defects found by this Wave's own
// inventory of this screen:
//   - Assigning or removing a role gave NO confirmation at all. The only
//     evidence was that a pill appeared or disappeared after a skeleton
//     flash, which a screen-reader user could not perceive. Both outcomes
//     are now announced in a live region naming the person and the role
//     (§9 `success`, §10, §11).
//   - A 403 was rendered in the red "we couldn't load … Try again." panel
//     with a Retry button that could never succeed. Failures are now
//     classified and the non-retryable ones render without a Retry (§9).
//   - The error headline said "Resources content" on a screen about people.
//   - The table had no mobile fallback, no result count, and the per-row
//     Assign button's accessible name was the bare word "Assign" on every
//     row (§11, §12).
//   - `await res.json()` was unguarded, so a non-JSON edge response
//     surfaced a raw `SyntaxError` to the administrator (§19).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { AdminActionStatus, useAdminActionStatus } from '@/components/admin/AdminActionStatus';
import { ResourceLoadingSkeleton, ResourceEmptyState, ResourceFailureState } from '@/components/resources/admin/ResourceStates';
import { actionFailureMessage, failureFromResponse, failureFromThrown, readJsonSafely, type AdminFailure } from '@/lib/resources/admin/resultState';
import { formatAdminDate } from '@/lib/resources/admin/labels';
import type { ResourceRole } from '@/lib/resources/types';

const ALL_ROLES: ResourceRole[] = ['resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher', 'analyst'];

const ROLE_LABELS: Record<ResourceRole, string> = {
  resource_admin: 'Resource Administrator',
  author: 'Author',
  editor: 'Editor',
  compliance_reviewer: 'Compliance Reviewer',
  publisher: 'Publisher',
  analyst: 'Analyst',
};

const ROLE_DESCRIPTIONS: Record<ResourceRole, string> = {
  resource_admin: 'Manages Resources content configuration and user roles.',
  author: 'Creates/edits Resource content according to permissions.',
  editor: 'Performs editorial review.',
  compliance_reviewer: 'Reviews AMBER compliance-sensitive content.',
  publisher: 'Controls final publishing/scheduling.',
  analyst: 'Read/analytics functions as defined.',
};

interface RoleRow {
  role: ResourceRole;
  is_active: boolean;
  assigned_at: string;
  assigned_by: string | null;
  updated_at: string;
}

interface UserRow {
  id: string;
  email: string;
  fullName: string | null;
  isSuperAdmin: boolean;
  roles: RoleRow[];
  lastUpdated: string | null;
  createdAt: string;
}

export function ResourceUsersClient({ currentUserId }: { currentUserId: string }) {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [assignRole, setAssignRole] = useState<Record<string, ResourceRole>>({});
  const [confirmTarget, setConfirmTarget] = useState<{ userId: string; role: ResourceRole; email: string; isSelf: boolean } | null>(null);
  const { outcome, reportSuccess, reportFailure, clearOutcome } = useAdminActionStatus();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const qp = new URLSearchParams();
      if (search) qp.set('q', search);
      const res = await fetch(`/api/admin/resources/users?${qp.toString()}`);
      const json = await readJsonSafely(res);
      if (!res.ok) {
        setFailure(failureFromResponse(res.status, json, 'FHIP users and their Resources roles'));
        setItems([]);
        return;
      }
      const data = json?.data as { items?: UserRow[] } | undefined;
      setItems(data?.items ?? []);
    } catch (e) {
      setFailure(failureFromThrown(e, 'FHIP users and their Resources roles'));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [load, reloadToken]);

  async function doAssign(user: UserRow) {
    const role = assignRole[user.id];
    if (!role) return;
    setBusyKey(`assign-${user.id}`);
    clearOutcome();
    try {
      const res = await fetch('/api/admin/resources/users/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, role }),
      });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'assign this role'));
        return;
      }
      reportSuccess(
        `${ROLE_LABELS[role]} assigned to ${user.email}. They may need to sign out and back in before the new access takes effect.`
      );
      setAssignRole((m) => ({ ...m, [user.id]: '' as ResourceRole }));
      setReloadToken((t) => t + 1);
    } catch {
      reportFailure('Could not reach the server, so nothing was changed. Check your connection and try again.');
    } finally {
      setBusyKey(null);
    }
  }

  function requestRemove(user: UserRow, role: ResourceRole) {
    clearOutcome();
    setConfirmTarget({ userId: user.id, role, email: user.email, isSelf: user.id === currentUserId });
  }

  async function confirmRemove() {
    if (!confirmTarget) return;
    const { userId, role, email } = confirmTarget;
    setBusyKey(`remove-${userId}-${role}`);
    setConfirmTarget(null);
    clearOutcome();
    try {
      const res = await fetch('/api/admin/resources/users/roles', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role }),
      });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'remove this role'));
        return;
      }
      reportSuccess(`${ROLE_LABELS[role]} removed from ${email}. Their past work and historical assignments are unchanged.`);
      setReloadToken((t) => t + 1);
    } catch {
      reportFailure('Could not reach the server, so nothing was changed. Check your connection and try again.');
    } finally {
      setBusyKey(null);
    }
  }

  const rolePills = (u: UserRow, activeRoles: RoleRow[]) =>
    activeRoles.length === 0 && !u.isSuperAdmin ? (
      <span className="text-xs text-muted">No Resources roles</span>
    ) : (
      <div className="flex flex-wrap gap-1.5">
        {activeRoles.map((r) => (
          <span key={r.role} className="inline-flex items-center gap-1 rounded-full bg-trust/10 py-0.5 pl-2 pr-0.5 text-xs font-semibold text-trust">
            {ROLE_LABELS[r.role]}
            <button
              type="button"
              aria-label={`Remove ${ROLE_LABELS[r.role]} from ${u.email}`}
              disabled={busyKey === `remove-${u.id}-${r.role}`}
              onClick={() => requestRemove(u, r.role)}
              className="ml-0.5 flex min-h-11 min-w-11 items-center justify-center rounded-full text-base leading-none text-trust hover:text-risk disabled:opacity-50"
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        ))}
      </div>
    );

  const assignControls = (u: UserRow, activeRoles: RoleRow[]) => (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`assign-role-${u.id}`}>
        Assign a Resources role to {u.email}
      </label>
      <select
        id={`assign-role-${u.id}`}
        value={assignRole[u.id] ?? ''}
        onChange={(e) => setAssignRole((m) => ({ ...m, [u.id]: e.target.value as ResourceRole }))}
        className="min-h-11 rounded border border-line bg-white px-2 py-1 text-xs text-ink"
      >
        <option value="">Select role…</option>
        {ALL_ROLES.map((r) => (
          <option key={r} value={r} disabled={activeRoles.some((ar) => ar.role === r)}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label={`Assign the selected role to ${u.email}`}
        disabled={!assignRole[u.id] || busyKey === `assign-${u.id}`}
        onClick={() => doAssign(u)}
        className="min-h-11 rounded-full bg-trust px-3 py-1 text-xs font-semibold text-white hover:bg-trust/90 disabled:opacity-50"
      >
        {busyKey === `assign-${u.id}` ? 'Assigning…' : 'Assign'}
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={!!confirmTarget}
        title={confirmTarget?.isSelf ? 'Remove your own role?' : 'Remove this role?'}
        message={
          confirmTarget
            ? confirmTarget.isSelf
              ? `You are about to remove your own ${ROLE_LABELS[confirmTarget.role]} role. If this is your only Resources role, you will lose access to Resources administration immediately.`
              : `Remove the ${ROLE_LABELS[confirmTarget.role]} role from ${confirmTarget.email}? They will no longer appear as eligible for new Author/Reviewer/Compliance Reviewer assignments, or be able to perform this role's actions. Content they are already assigned to keeps that historical assignment.`
            : ''
        }
        confirmLabel="Remove Role"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setConfirmTarget(null)}
      />

      <div>
        <h1 className="text-2xl font-semibold text-ink">Users &amp; Roles</h1>
        <p className="mt-1 text-sm text-muted">
          Assign or remove Resources roles for real FHIP users. Author, Editorial Reviewer, and Compliance Reviewer eligibility in the content editor is driven entirely from the roles assigned here.
        </p>
      </div>

      <AdminTaskHelp taskId="ADM-18" />

      <div className="rounded-card border border-line bg-white p-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Resources Roles</h2>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {ALL_ROLES.map((r) => (
            <div key={r} className="rounded-compact border border-line/60 p-2">
              <dt className="text-sm font-semibold text-ink">{ROLE_LABELS[r]}</dt>
              <dd className="text-xs text-muted">{ROLE_DESCRIPTIONS[r]}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-card border border-line bg-white p-4">
        <label htmlFor="resource-user-search" className="sr-only">
          Search users by name or email
        </label>
        <input
          id="resource-user-search"
          type="search"
          placeholder="Search by name or email to find a user to assign…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-md rounded border border-line bg-white px-3 py-1.5 text-sm text-ink sm:w-64"
        />
        <p className="mt-1 text-xs text-muted">{search ? 'Showing matching FHIP users.' : 'Showing users who already hold a Resources role, or are FHIP Super Admins. Search to find someone new.'}</p>

        <AdminActionStatus outcome={outcome} className="mt-3" />

        {/* Result count, announced politely so a filter change is perceivable
            without sight (§11). Rendered only once loading has resolved so it
            never claims a count for a list that is still arriving. */}
        <p role="status" aria-live="polite" className="mt-3 text-xs text-muted">
          {loading || failure ? '' : `${items.length} ${items.length === 1 ? 'person' : 'people'} shown.`}
        </p>

        <div className="mt-2">
          {loading ? (
            <ResourceLoadingSkeleton label="Loading users and roles" />
          ) : failure ? (
            <ResourceFailureState failure={failure} onRetry={() => setReloadToken((t) => t + 1)} />
          ) : items.length === 0 ? (
            <ResourceEmptyState title={search ? 'No matching users found.' : 'No users currently hold a Resources role.'} message={search ? 'Try a different name or email.' : 'Search above to find a real FHIP user to assign a role to.'} />
          ) : (
            <>
              {/* Table from `sm` up; a stacked card list below it, so a
                  320px viewport is not asked to horizontally scroll a row
                  containing a select and a button (§12). */}
              {/* `relative` — the sr-only caption is position:absolute; see
                  ResourceContentTable. */}
              <div className="relative hidden overflow-x-auto sm:block">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">FHIP users and the Resources roles they currently hold</caption>
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                      <th scope="col" className="py-2 pr-3 font-semibold">
                        User
                      </th>
                      <th scope="col" className="py-2 pr-3 font-semibold">
                        Resources Roles
                      </th>
                      <th scope="col" className="py-2 pr-3 font-semibold">
                        Last Updated
                      </th>
                      <th scope="col" className="py-2 pl-3 font-semibold">
                        Assign
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((u) => {
                      const activeRoles = u.roles.filter((r) => r.is_active);
                      return (
                        <tr key={u.id} className="border-b border-line/60 align-top hover:bg-gray-50">
                          <th scope="row" className="max-w-[240px] py-2.5 pr-3 text-left font-normal">
                            <span className="block truncate font-medium text-ink">{u.fullName || '(no name on file)'}</span>
                            <span className="block truncate text-xs text-muted">{u.email}</span>
                            {u.isSuperAdmin && <span className="mt-1 inline-block rounded-full bg-ai/10 px-2 py-0.5 text-xs font-semibold text-ai">FHIP Super Admin</span>}
                          </th>
                          <td className="py-2.5 pr-3">{rolePills(u, activeRoles)}</td>
                          <td className="py-2.5 pr-3 text-muted">{u.lastUpdated ? formatAdminDate(u.lastUpdated) : '—'}</td>
                          <td className="py-2.5 pl-3">{assignControls(u, activeRoles)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <ul className="space-y-2 sm:hidden">
                {items.map((u) => {
                  const activeRoles = u.roles.filter((r) => r.is_active);
                  return (
                    <li key={u.id} className="rounded-compact border border-line p-3">
                      <p className="truncate font-medium text-ink">{u.fullName || '(no name on file)'}</p>
                      <p className="truncate text-xs text-muted">{u.email}</p>
                      {u.isSuperAdmin && <span className="mt-1 inline-block rounded-full bg-ai/10 px-2 py-0.5 text-xs font-semibold text-ai">FHIP Super Admin</span>}
                      <div className="mt-2">{rolePills(u, activeRoles)}</div>
                      <p className="mt-2 text-xs text-muted">Last updated {u.lastUpdated ? formatAdminDate(u.lastUpdated) : '—'}</p>
                      <div className="mt-2">{assignControls(u, activeRoles)}</div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
