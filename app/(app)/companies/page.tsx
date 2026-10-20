'use client';

import { PageBackLink } from '@/components/navigation/PageBackLink';

// LR-11 — Company entity workspace. LR-13 — Family Trust fast-follow: same
// page/schema, entity_type widened at migration 0136. M4B — HUF fast-follow
// on exactly the same line, entity_type widened again at migration 0154,
// with one difference Family Trust did not need: HUF is INDIA-ONLY.
//
// DOCUMENT2 (4) review 20-10-2026, F23b: this page is now the ENTITY workspace. Each Company, Family Trust or HUF records, at entity level and
// apart from the personal pages: how it is recorded (itemised assets and liabilities OR a net value only, never both), its assets, its
// liabilities, its income and its expenses (components/entities/EntityCard). The family Net Worth adds the entity back at reporting time only.
//
// The client-side country check below is CONVENIENCE ONLY, and is written
// the way `components/retirement/smsf/SmsfSection.tsx` already writes the
// mirror-image AU-only check for SMSF: fetch `/api/user/profile`, read
// `country_of_residence`, and simply do not offer the option. The real gates
// are server-side — `app/api/business-entities/route.ts`'s 403 and
// `trg_business_entities_huf_india_gate` (migration 0154) — and are tested
// directly, not merely through this UI.
//
// Like SMSF's own rule, an EXISTING HUF stays fully visible and editable
// after a move out of India: only the offer to create a NEW one follows the
// user's current country. `ENTITY_TYPE_LABEL` therefore covers 'huf'
// unconditionally.

import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { EntityCard, type BusinessEntityRecord } from '@/components/entities/EntityCard';
import { ENTITY_NET_ONLY_NOTE } from '@/components/entities/EntityModeChooser';
import type { BusinessEntityType } from '@/lib/validation/businessEntity';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? json.error ?? 'Request failed');
  return json.data as T;
}

function CompaniesPageContent() {
  const [entities, setEntities] = useState<BusinessEntityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEntityType, setNewEntityType] = useState<BusinessEntityType>('company');
  const [newOwnership, setNewOwnership] = useState('100');
  const [newCurrency, setNewCurrency] = useState<'AUD' | 'INR'>('AUD');
  const [newMode, setNewMode] = useState<'summary' | 'detailed'>('detailed');
  const [newNav, setNewNav] = useState('');
  const [busy, setBusy] = useState(false);
  // M4B — null until the profile has loaded, so the HUF option is never
  // flashed to a non-India user while the answer is still unknown.
  const [countryOfResidence, setCountryOfResidence] = useState<string | null>(null);

  async function load() {
    try {
      const data = await fetchJson<BusinessEntityRecord[]>('/api/business-entities');
      setEntities(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your entities.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [data, profile] = await Promise.all([
          fetchJson<BusinessEntityRecord[]>('/api/business-entities'),
          fetchJson<{ country_of_residence: string | null }>('/api/user/profile'),
        ]);
        if (!cancelled) {
          setEntities(data);
          setCountryOfResidence(profile.country_of_residence);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load your entities.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fails CLOSED: an unresolved country offers no HUF option, exactly as a
  // confirmed non-India one does.
  const canCreateHuf = countryOfResidence === 'IN';

  async function submitCreate() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: newName.trim(),
        entity_type: newEntityType,
        // A Trust or HUF is counted in full whatever percentage is recorded (PO decision 16-10-2026), so only a Company asks for the share.
        ownership_percentage: newEntityType === 'company' ? Number(newOwnership) : 100,
        currency_code: newCurrency,
        valuation_mode: newMode,
      };
      if (newMode === 'summary') body.summary_net_asset_value = Number(newNav || 0);
      await fetchJson('/api/business-entities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setCreating(false);
      setNewName('');
      setNewEntityType('company');
      setNewOwnership('100');
      setNewNav('');
      setNewMode('detailed');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the entity.');
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string) {
    setBusy(true);
    try {
      await fetchJson(`/api/business-entities/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not archive the entity.');
    } finally {
      setBusy(false);
    }
  }

  const field = 'mt-1 w-full rounded border border-line px-3 py-2 text-sm';
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">{canCreateHuf ? 'Companies, Trusts & HUF' : 'Companies & Trusts'}</h1>
        <p className="mt-1 text-muted">
          Your {canCreateHuf ? 'companies, family trusts and HUF' : 'companies and family trusts'} are recorded here, separately from your personal finances. For each one enter what it owns and owes, its
          income and its expenses; FHIP works out its net value. Your personal net worth never includes them. Your family net worth adds them back, clearly labelled: a trust{canCreateHuf ? ' or HUF' : ''} in full, a
          company at your ownership share.
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-risk">{error}</p>}

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          {entities.map((entity) => (
            <EntityCard key={entity.id} entity={entity} onChanged={load} onArchive={() => void archive(entity.id)} busy={busy} />
          ))}

          <SectionCard
            title={canCreateHuf ? 'Add a company, trust or HUF' : 'Add a company or trust'}
            description={canCreateHuf ? 'Record a company, family trust or Hindu Undivided Family you have an interest in.' : 'Record a company or family trust you have an interest in.'}
          >
            {!creating ? (
              <button type="button" onClick={() => setCreating(true)} className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90">
                {canCreateHuf ? 'Add company, trust or HUF' : 'Add company or trust'}
              </button>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="entity-new-type" className="block text-xs font-medium text-muted">Type</label>
                    <select id="entity-new-type" value={newEntityType} onChange={(e) => setNewEntityType(e.target.value as BusinessEntityType)} className={field}>
                      <option value="company">Company</option>
                      <option value="family_trust">Family Trust</option>
                      {/* M4B: India-only. Following SMSF's own precedent
                          (spec s.34, SmsfSection.tsx) the option is simply
                          ABSENT for a non-India user — never rendered as a
                          disabled or explained choice. */}
                      {canCreateHuf && <option value="huf">HUF (Hindu Undivided Family)</option>}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="entity-new-name" className="block text-xs font-medium text-muted">Name</label>
                    <input id="entity-new-name" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} className={field} />
                  </div>
                  {newEntityType === 'company' && (
                    <div>
                      <label htmlFor="entity-new-share" className="block text-xs font-medium text-muted">Your ownership %</label>
                      <input id="entity-new-share" type="number" min={0.01} max={100} step="0.01" value={newOwnership} onChange={(e) => setNewOwnership(e.target.value)} className={field} />
                    </div>
                  )}
                  <div>
                    <label htmlFor="entity-new-currency" className="block text-xs font-medium text-muted">Currency</label>
                    <select id="entity-new-currency" value={newCurrency} onChange={(e) => setNewCurrency(e.target.value as 'AUD' | 'INR')} className={field}>
                      <option value="AUD">AUD</option>
                      <option value="INR">INR</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <fieldset>
                      <legend className="block text-xs font-medium text-muted">How do you want to record it?</legend>
                      <div className="mt-1 space-y-1 text-sm">
                        <label className="flex items-start gap-2">
                          <input type="radio" name="entity-new-mode" checked={newMode === 'detailed'} onChange={() => setNewMode('detailed')} className="mt-1" />
                          <span>Itemised assets and liabilities (recommended): you add them next, FHIP works out the net</span>
                        </label>
                        <label className="flex items-start gap-2">
                          <input type="radio" name="entity-new-mode" checked={newMode === 'summary'} onChange={() => setNewMode('summary')} className="mt-1" />
                          <span>Net value only</span>
                        </label>
                      </div>
                      {newMode === 'summary' && <p className="mt-1 text-[11px] text-muted">{ENTITY_NET_ONLY_NOTE}</p>}
                    </fieldset>
                  </div>
                  {newMode === 'summary' && (
                    <div>
                      <label htmlFor="entity-new-nav" className="block text-xs font-medium text-muted">Net value (assets minus debts)</label>
                      <input id="entity-new-nav" type="number" step="0.01" value={newNav} onChange={(e) => setNewNav(e.target.value)} className={field} />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => void submitCreate()} disabled={busy || !newName.trim()} className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" onClick={() => setCreating(false)} className="text-sm text-gray-500 hover:underline">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard).
export default function CompaniesPage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <CompaniesPageContent />
    </>
  );
}
