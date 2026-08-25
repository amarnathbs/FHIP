'use client';

import { useEffect, useState } from 'react';
import { fetchJson, formatMoneySafe } from './format';
import type { SmsfMemberRow, CurrencyCode } from './types';

interface RetirementMemberContext {
  self: { id: string; member_type: 'self' } | null;
  spouse: { id: string; member_type: 'spouse' } | null;
  spouseApplicable: boolean;
}

// Members UI (spec s.17-20). Reuses the certified retirement_members table
// for identity (no parallel member concept) — this component never invents
// its own member records, it only links/allocates against whichever
// self/spouse retirement_members rows already exist (lazily creating one on
// first use if genuinely absent, never overwriting an existing one).
// member_interest_amount is explicitly labelled as allocation/informational
// only here (spec s.18: "never add it on top of fund holdings") — the
// fund's own Current SMSF Value / Detailed Net Value is what is counted in
// Net Worth exactly once, regardless of how many members are attached or
// what their interests sum to; this is enforced structurally at the domain
// layer (migration 0084 — smsf_fund_members has no bearing on
// retirement_accounts.current_balance), this UI only must not misrepresent
// that fact.
export function SmsfMembers({ fundId, currency }: { fundId: string; currency: CurrencyCode }) {
  const [members, setMembers] = useState<SmsfMemberRow[] | null>(null);
  const [context, setContext] = useState<RetirementMemberContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interestDrafts, setInterestDrafts] = useState<Record<string, string>>({});

  async function reload() {
    const [m, c] = await Promise.all([
      fetchJson<SmsfMemberRow[]>(`/api/smsf/${fundId}/members`),
      fetchJson<RetirementMemberContext>('/api/retirement/members'),
    ]);
    setMembers(m);
    setContext(c);
  }

  useEffect(() => {
    (async () => {
      try {
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load members');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundId]);

  async function addMember(type: 'self' | 'spouse') {
    setBusy(true);
    setError(null);
    try {
      let retirementMemberId = type === 'self' ? context?.self?.id : context?.spouse?.id;
      if (!retirementMemberId) {
        // Lazily create the retirement_members row with no target age set
        // (age_source becomes 'needs_confirmation') — never overwrites an
        // existing row's age, only reached when one genuinely doesn't exist.
        const created = await fetchJson<{ id: string }>('/api/retirement/members', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_type: type, target_retirement_age: null }),
        });
        retirementMemberId = created.id;
      }
      await fetchJson(`/api/smsf/${fundId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retirement_member_id: retirementMemberId }),
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add member');
    } finally {
      setBusy(false);
    }
  }

  async function saveInterest(m: SmsfMemberRow) {
    const raw = interestDrafts[m.id];
    if (raw === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await fetchJson(`/api/smsf/${fundId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          retirement_member_id: m.retirement_member_id,
          member_interest_amount: raw === '' ? null : Number(raw),
        }),
      });
      await reload();
      setInterestDrafts((d) => {
        const next = { ...d };
        delete next[m.id];
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save member interest');
    } finally {
      setBusy(false);
    }
  }

  if (!members || !context) {
    return <p className="text-xs text-muted">Loading members…</p>;
  }

  const hasSelf = members.some((m) => m.retirement_members?.member_type === 'self');
  const hasSpouse = members.some((m) => m.retirement_members?.member_type === 'spouse');

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Members</h4>
      {members.length === 0 && <p className="mt-1 text-sm text-muted">No members recorded yet.</p>}
      <ul className="mt-1 space-y-1">
        {members.map((m) => {
          const label = m.retirement_members?.member_type === 'spouse' ? 'Spouse/Partner' : 'Self';
          const draft = interestDrafts[m.id] ?? (m.member_interest_amount != null ? String(m.member_interest_amount) : '');
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-ink">{label}</span>
              <input
                type="number"
                step="0.01"
                min={0}
                value={draft}
                placeholder="Member interest (optional)"
                aria-label={`${label} member interest allocation`}
                onChange={(e) => setInterestDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                className="w-40 rounded border border-line px-2 py-1 text-xs"
              />
              {interestDrafts[m.id] !== undefined && (
                <button onClick={() => saveInterest(m)} disabled={busy} className="text-xs text-trust hover:underline">
                  Save
                </button>
              )}
              {m.member_interest_amount != null && interestDrafts[m.id] === undefined && (
                <span className="text-xs text-muted">{formatMoneySafe(m.member_interest_amount, currency)} allocation</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[11px] text-muted">
        Member interest is an informational allocation only — it does not add to the fund&apos;s value shown in Net Worth.
      </p>
      <div className="mt-2 flex gap-3">
        {!hasSelf && (
          <button onClick={() => addMember('self')} disabled={busy} className="text-xs font-medium text-trust hover:underline">
            + Add Self
          </button>
        )}
        {!hasSpouse && context.spouseApplicable && (
          <button onClick={() => addMember('spouse')} disabled={busy} className="text-xs font-medium text-trust hover:underline">
            + Add Spouse/Partner
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-risk">{error}</p>}
    </div>
  );
}
