'use client';

// Resources Admin — Users & Roles (post-closure hotfix, spec §6/§28/§29).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ResourceLoadingSkeleton, ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';
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
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [assignRole, setAssignRole] = useState<Record<string, ResourceRole>>({});
  const [confirmTarget, setConfirmTarget] = useState<{ userId: string; role: ResourceRole; email: string; isSelf: boolean } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qp = new URLSearchParams();
      if (search) qp.set('q', search);
      const res = await fetch(`/api/admin/resources/users?${qp.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load Resources users.');
      setItems(json.data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
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

  async function doAssign(userId: string) {
    const role = assignRole[userId];
    if (!role) return;
    setBusyKey(`assign-${userId}`);
    setActionError(null);
    try {
      const res = await fetch('/api/admin/resources/users/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Could not assign this role.');
      setReloadToken((t) => t + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not assign this role.');
    } finally {
      setBusyKey(null);
    }
  }

  function requestRemove(user: UserRow, role: ResourceRole) {
    setActionError(null);
    setConfirmTarget({ userId: user.id, role, email: user.email, isSelf: user.id === currentUserId });
  }

  async function confirmRemove() {
    if (!confirmTarget) return;
    const { userId, role } = confirmTarget;
    setBusyKey(`remove-${userId}-${role}`);
    setConfirmTarget(null);
    setActionError(null);
    try {
      const res = await fetch('/api/admin/resources/users/roles', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Could not remove this role.');
      setReloadToken((t) => t + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not remove this role.');
    } finally {
      setBusyKey(null);
    }
  }

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
        <label htmlFor="resource-user-search" className="sr-only left-0 top-0">
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

        {actionError && (
          <p role="alert" className="mt-2 text-xs font-medium text-risk">
            {actionError}
          </p>
        )}

        <div className="mt-4">
          {loading ? (
            <ResourceLoadingSkeleton />
          ) : error ? (
            <ResourceErrorState message={error} onRetry={() => setReloadToken((t) => t + 1)} />
          ) : items.length === 0 ? (
            <ResourceEmptyState title={search ? 'No matching users found.' : 'No users currently hold a Resources role.'} message={search ? 'Try a different name or email.' : 'Search above to find a real FHIP user to assign a role to.'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
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
                        <td className="max-w-[240px] py-2.5 pr-3">
                          <p className="truncate font-medium text-ink">{u.fullName || '(no name on file)'}</p>
                          <p className="truncate text-xs text-muted">{u.email}</p>
                          {u.isSuperAdmin && <span className="mt-1 inline-block rounded-full bg-ai/10 px-2 py-0.5 text-xs font-semibold text-ai">FHIP Super Admin</span>}
                        </td>
                        <td className="py-2.5 pr-3">
                          {activeRoles.length === 0 && !u.isSuperAdmin ? (
                            <span className="text-xs text-muted">No Resources roles</span>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {activeRoles.map((r) => (
                                <span key={r.role} className="inline-flex items-center gap-1 rounded-full bg-trust/10 px-2 py-0.5 text-xs font-semibold text-trust">
                                  {ROLE_LABELS[r.role]}
                                  <button
                                    type="button"
                                    aria-label={`Remove ${ROLE_LABELS[r.role]} from ${u.email}`}
                                    disabled={busyKey === `remove-${u.id}-${r.role}`}
                                    onClick={() => requestRemove(u, r.role)}
                                    className="ml-0.5 rounded-full text-trust hover:text-risk disabled:opacity-50"
                                  >
                                    ×
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-muted">{u.lastUpdated ? formatAdminDate(u.lastUpdated) : '—'}</td>
                        <td className="py-2.5 pl-3">
                          <div className="flex items-center gap-2">
                            <label className="sr-only left-0 top-0" htmlFor={`assign-role-${u.id}`}>
                              Assign a Resources role to {u.email}
                            </label>
                            <select
                              id={`assign-role-${u.id}`}
                              value={assignRole[u.id] ?? ''}
                              onChange={(e) => setAssignRole((m) => ({ ...m, [u.id]: e.target.value as ResourceRole }))}
                              className="rounded border border-line bg-white px-2 py-1 text-xs text-ink"
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
                              disabled={!assignRole[u.id] || busyKey === `assign-${u.id}`}
                              onClick={() => doAssign(u.id)}
                              className="rounded-full bg-trust px-3 py-1 text-xs font-semibold text-white hover:bg-trust/90 disabled:opacity-50"
                            >
                              Assign
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
