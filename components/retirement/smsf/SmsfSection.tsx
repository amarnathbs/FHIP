'use client';

import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { fetchJson } from './format';
import { SmsfCreateForm } from './SmsfCreateForm';
import { SmsfFundCard } from './SmsfFundCard';
import type { SmsfFundRow } from './types';

// SMSF top-level section (spec s.4-9, s.34-38), rendered above the
// Retirement accounts grid (Retirement Planning -> Retirement Accounts ->
// SMSF, per spec s.34 hierarchy). Client-side AU gating here is convenience
// only for a clean IN experience (spec s.34: "SMSF creation option simply
// absent" — never shown as a disabled/explained option for IN) — the real
// gate is server-side (trg_retirement_accounts_smsf_au_gate, migration
// 0084), re-tested directly (not just through this UI) in this release's
// certification suite.
//
// GET /api/smsf is deliberately never jurisdiction-filtered (spec s.7,
// s.34-37: legacy/cross-border SMSF visibility) — an existing SMSF created
// while the user's home jurisdiction was AU stays fully visible after a
// move to India, only *new* SMSF creation follows the user's current
// country.
export function SmsfSection() {
  const [funds, setFunds] = useState<SmsfFundRow[] | null>(null);
  const [countryOfResidence, setCountryOfResidence] = useState<'AU' | 'IN' | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function reload() {
    const [fundList, profile] = await Promise.all([
      fetchJson<SmsfFundRow[]>('/api/smsf'),
      fetchJson<{ country_of_residence: 'AU' | 'IN' | null }>('/api/user/profile'),
    ]);
    setFunds(fundList);
    setCountryOfResidence(profile.country_of_residence);
  }

  useEffect(() => {
    (async () => {
      try {
        await reload();
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Could not load your SMSF details');
      }
    })();
  }, []);

  if (loadError) {
    return (
      <SectionCard title="SMSF" className="mb-6">
        <p className="text-sm text-risk">{loadError}</p>
      </SectionCard>
    );
  }

  if (!funds) {
    return (
      <SectionCard title="SMSF" className="mb-6">
        <p className="text-sm text-muted">Loading…</p>
      </SectionCard>
    );
  }

  const canCreate = countryOfResidence === 'AU';

  // Neither existing funds nor AU eligibility — this section has nothing to
  // show and no offer to make (spec s.34: "prefer removing irrelevant
  // options entirely" — an IN user with no SMSF sees no SMSF section at
  // all, not an explained absence).
  if (funds.length === 0 && !canCreate) return null;

  return (
    <SectionCard
      title="SMSF"
      description="Self-Managed Super Fund — track your fund as a single summary value, or build out Detailed Holdings."
      className="mb-6"
    >
      <div className="space-y-4">
        {funds.map((fund) => (
          <SmsfFundCard key={fund.id} fund={fund} onFundChanged={reload} />
        ))}

        {canCreate && !showCreate && (
          <button onClick={() => setShowCreate(true)} className="text-sm font-medium text-trust hover:underline">
            + Add {funds.length > 0 ? 'another ' : 'an '}SMSF
          </button>
        )}
        {canCreate && showCreate && (
          <SmsfCreateForm
            onCreated={() => {
              setShowCreate(false);
              reload();
            }}
            onCancel={() => setShowCreate(false)}
          />
        )}
      </div>
    </SectionCard>
  );
}
