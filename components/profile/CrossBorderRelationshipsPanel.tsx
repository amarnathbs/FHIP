'use client';

// G3 section 9 — optional cross-border relationship declaration.
//
// This panel is a DECLARATION surface and nothing more. It reuses the G1
// table (`cross_border_relationships`, migration 0122) and the G1 API routes
// that already existed; it introduces no second cross-border store and no
// calculation whatsoever.
//
// Everything G3 forbids here is forbidden by construction rather than by
// convention: this component has no access to any total, no FX call, no
// domestic/overseas split, and no forecast. Adding a relationship sends
// exactly two fields — country and relationship type — to a route that
// writes exactly one row. It cannot change residence, primary country,
// billing country or reporting currency, because it never sends any of them.
import { useCallback, useEffect, useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { REGISTRATION_COUNTRY_OPTIONS } from '@/lib/services/countryGate';
import type { CountryCode } from '@/lib/services/jurisdiction';

const RELATIONSHIP_TYPE_OPTIONS = [
  { value: 'ASSET', label: 'Asset held there' },
  { value: 'INVESTMENT', label: 'Investment held there' },
  { value: 'PROPERTY', label: 'Property there' },
  { value: 'INCOME', label: 'Income from there' },
  { value: 'LIABILITY', label: 'Loan or liability there' },
  { value: 'RETIREMENT', label: 'Retirement account there' },
  { value: 'TAX', label: 'Tax obligation there' },
  { value: 'OTHER', label: 'Other connection' },
] as const;

interface RelationshipRow {
  id: string;
  country_code: string;
  relationship_type: string;
  status: string;
  effective_date: string | null;
  end_date: string | null;
}

const FRIENDLY_ERROR: Record<string, string> = {
  CROSS_BORDER_COUNTRY_IS_RESIDENCE:
    'That is your own country of residence — a cross-border relationship with it would not mean anything.',
  CROSS_BORDER_COUNTRY_NOT_AVAILABLE: 'That country is not available for cross-border declarations in this release.',
  DUPLICATE_RELATIONSHIP: 'You have already declared that relationship for that country.',
  GENERIC_EXPERIENCE_RESTRICTED: 'This is not available for your account yet.',
  COUNTRY_CONFIRMATION_REQUIRED: 'Please confirm your country of residence first.',
};

function friendly(raw: string): string {
  if (FRIENDLY_ERROR[raw]) return FRIENDLY_ERROR[raw];
  // The database raises its own guard messages with a stable PREFIX: detail
  // shape; surface the mapped prefix rather than leaking raw SQL text.
  const prefix = raw.split(':')[0]?.trim();
  return (prefix && FRIENDLY_ERROR[prefix]) || 'Something went wrong. Please try again.';
}

export function CrossBorderRelationshipsPanel({
  residenceCountry,
}: {
  residenceCountry: CountryCode | null;
}) {
  const [rows, setRows] = useState<RelationshipRow[] | null>(null);
  const [country, setCountry] = useState<string>('');
  const [relationshipType, setRelationshipType] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Fetches the caller's own declarations. Returns the rows rather than
  // setting state itself, so the two callers can each decide what to do:
  // the mount effect below discards a response that arrived after unmount,
  // while the post-mutation refresh always applies.
  async function fetchRows(): Promise<RelationshipRow[]> {
    const res = await fetch('/api/user/cross-border-relationships');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'LOAD_FAILED');
    return (json.data as RelationshipRow[]) ?? [];
  }

  // Initial load. Follows this app's established effect convention (see
  // app/(app)/profile/page.tsx): the async function is declared inside the
  // effect and a `cancelled` flag discards a late response, so nothing is
  // written to state after unmount.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await fetchRows();
        if (cancelled) return;
        setRows(next);
      } catch {
        if (cancelled) return;
        setRows([]);
        setError('We could not load your declarations. Please refresh the page.');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh after the user adds or ends a declaration. Always applies — this
  // only ever runs from an event handler on a mounted component.
  const reload = useCallback(async () => {
    try {
      setRows(await fetchRows());
    } catch {
      setRows([]);
      setError('We could not load your declarations. Please refresh the page.');
    }
  }, []);

  // The user's own country is removed from the list rather than offered and
  // then rejected — the same rule the database enforces
  // (trg_enforce_cross_border_country_is_foreign, migration 0127), expressed
  // where the user can act on it.
  const countryOptions = REGISTRATION_COUNTRY_OPTIONS.filter((o) => o.value !== residenceCountry);

  const active = (rows ?? []).filter((r) => r.status === 'ACTIVE');

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    if (!country || !relationshipType || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/user/cross-border-relationships', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country_code: country, relationship_type: relationshipType }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'SAVE_FAILED');
      setCountry('');
      setRelationshipType('');
      setStatus('Declaration added.');
      await reload();
    } catch (err) {
      setError(friendly(err instanceof Error ? err.message : ''));
    } finally {
      setBusy(false);
    }
  }

  async function handleEnd(id: string) {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/user/cross-border-relationships/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(typeof json.error === 'string' ? json.error : 'END_FAILED');
      }
      setStatus('Declaration ended.');
      await reload();
    } catch (err) {
      setError(friendly(err instanceof Error ? err.message : ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Cross-border connections (optional)"
      description="Tell us if you have financial connections to another country. This is optional and changes nothing else about your account."
    >
      <p className="text-xs text-muted">
        Declaring a connection does not change your country of residence, your reporting currency, or where any
        record is held. No cross-border calculations, conversions or combined totals are produced from these
        declarations in this release.
      </p>

      <form onSubmit={handleAdd} noValidate className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="cb-country" className="block text-xs font-medium text-muted">
            Country
          </label>
          <select
            id="cb-country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded border px-3 py-2 text-sm"
          >
            <option value="">Select…</option>
            {countryOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cb-type" className="block text-xs font-medium text-muted">
            Connection type
          </label>
          <select
            id="cb-type"
            value={relationshipType}
            onChange={(e) => setRelationshipType(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded border px-3 py-2 text-sm"
          >
            <option value="">Select…</option>
            {RELATIONSHIP_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={busy || !country || !relationshipType}
            className="w-full rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Add declaration
          </button>
        </div>
      </form>

      <div aria-live="polite" className="mt-2 min-h-[1.25rem]">
        {error && (
          <p role="alert" className="text-xs text-risk">
            {error}
          </p>
        )}
        {!error && status && <p className="text-xs text-muted">{status}</p>}
      </div>

      <div className="mt-4">
        {rows === null ? (
          <p className="text-xs text-muted">Loading your declarations…</p>
        ) : active.length === 0 ? (
          <p className="text-xs text-muted">You have not declared any cross-border connections.</p>
        ) : (
          <ul className="divide-y">
            {active.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  {REGISTRATION_COUNTRY_OPTIONS.find((o) => o.value === r.country_code)?.label ?? r.country_code}
                  {' — '}
                  {RELATIONSHIP_TYPE_OPTIONS.find((o) => o.value === r.relationship_type)?.label ??
                    r.relationship_type}
                </span>
                <button
                  type="button"
                  onClick={() => void handleEnd(r.id)}
                  disabled={busy}
                  className="text-xs text-muted underline hover:text-ink disabled:opacity-50"
                >
                  End
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}
