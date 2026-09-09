'use client';

// LR-11 — Company entity workspace. LR-13 — Family Trust fast-follow: same
// page/schema, entity_type widened at migration 0136.

import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';

type BusinessEntityType = 'company' | 'family_trust';

const ENTITY_TYPE_LABEL: Record<BusinessEntityType, string> = {
  company: 'Company',
  family_trust: 'Family Trust',
};

interface BusinessEntity {
  id: string;
  name: string;
  entity_type: BusinessEntityType;
  country_code: string | null;
  currency_code: 'AUD' | 'INR';
  ownership_percentage: number;
  valuation_mode: 'summary' | 'detailed';
  summary_net_asset_value: number | null;
  is_active: boolean;
  notes: string | null;
}

interface LineItem {
  id: string;
  label: string;
  value: number;
  currency_code: 'AUD' | 'INR';
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

function formatCurrency(value: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currencyCode}`;
  }
}

export default function CompaniesPage() {
  const [entities, setEntities] = useState<BusinessEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEntityType, setNewEntityType] = useState<BusinessEntityType>('company');
  const [newOwnership, setNewOwnership] = useState('100');
  const [newCurrency, setNewCurrency] = useState<'AUD' | 'INR'>('AUD');
  const [newMode, setNewMode] = useState<'summary' | 'detailed'>('summary');
  const [newNav, setNewNav] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const data = await fetchJson<BusinessEntity[]>('/api/business-entities');
      setEntities(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your companies.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchJson<BusinessEntity[]>('/api/business-entities');
        if (!cancelled) setEntities(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load your companies.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submitCreate() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: newName.trim(),
        entity_type: newEntityType,
        ownership_percentage: Number(newOwnership),
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
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create company.');
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
      setError(e instanceof Error ? e.message : 'Could not archive company.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Companies &amp; Trusts</h1>
        <p className="mt-1 text-muted">
          Track a company or family trust you have an interest in, separate from your personal finances. Only your
          own share of its net value is added to your household Net Worth — its own assets and debts are never
          counted a second time as personally yours.
        </p>
      </div>

      {error && <p className="text-sm text-risk">{error}</p>}

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          {entities.map((entity) => (
            <CompanyCard key={entity.id} entity={entity} onChanged={load} onArchive={() => void archive(entity.id)} busy={busy} />
          ))}

          <SectionCard title="Add a company or trust" description="Record a company or family trust you have an interest in.">
            {!creating ? (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Add company or trust
              </button>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-muted">Type</label>
                    <select
                      value={newEntityType}
                      onChange={(e) => setNewEntityType(e.target.value as BusinessEntityType)}
                      className="mt-1 w-full rounded border px-3 py-2 text-sm"
                    >
                      <option value="company">Company</option>
                      <option value="family_trust">Family Trust</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted">Name</label>
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      className="mt-1 w-full rounded border px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted">Your ownership %</label>
                    <input
                      type="number"
                      min={0.01}
                      max={100}
                      step="0.01"
                      value={newOwnership}
                      onChange={(e) => setNewOwnership(e.target.value)}
                      className="mt-1 w-full rounded border px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted">Currency</label>
                    <select
                      value={newCurrency}
                      onChange={(e) => setNewCurrency(e.target.value as 'AUD' | 'INR')}
                      className="mt-1 w-full rounded border px-3 py-2 text-sm"
                    >
                      <option value="AUD">AUD</option>
                      <option value="INR">INR</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted">Valuation</label>
                    <select
                      value={newMode}
                      onChange={(e) => setNewMode(e.target.value as 'summary' | 'detailed')}
                      className="mt-1 w-full rounded border px-3 py-2 text-sm"
                    >
                      <option value="summary">I know its net value</option>
                      <option value="detailed">I&apos;ll add its assets and debts</option>
                    </select>
                  </div>
                  {newMode === 'summary' && (
                    <div>
                      <label className="block text-xs font-medium text-muted">Net value (assets minus debts)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={newNav}
                        onChange={(e) => setNewNav(e.target.value)}
                        className="mt-1 w-full rounded border px-3 py-2 text-sm"
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void submitCreate()}
                    disabled={busy || !newName.trim()}
                    className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
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

function CompanyCard({
  entity,
  onChanged,
  onArchive,
  busy,
}: {
  entity: BusinessEntity;
  onChanged: () => void | Promise<void>;
  onArchive: () => void;
  busy: boolean;
}) {
  const [assets, setAssets] = useState<LineItem[]>([]);
  const [liabilities, setLiabilities] = useState<LineItem[]>([]);
  const [navDraft, setNavDraft] = useState(String(entity.summary_net_asset_value ?? 0));
  const [savingNav, setSavingNav] = useState(false);
  const [addingAsset, setAddingAsset] = useState(false);
  const [addingLiability, setAddingLiability] = useState(false);
  const [lineLabel, setLineLabel] = useState('');
  const [lineValue, setLineValue] = useState('');

  async function loadLineItems() {
    if (entity.valuation_mode !== 'detailed') return;
    const [a, l] = await Promise.all([
      fetchJson<LineItem[]>(`/api/business-entities/${entity.id}/assets`),
      fetchJson<LineItem[]>(`/api/business-entities/${entity.id}/liabilities`),
    ]);
    setAssets(a);
    setLiabilities(l);
  }

  useEffect(() => {
    if (entity.valuation_mode !== 'detailed') return;
    let cancelled = false;
    (async () => {
      const [a, l] = await Promise.all([
        fetchJson<LineItem[]>(`/api/business-entities/${entity.id}/assets`),
        fetchJson<LineItem[]>(`/api/business-entities/${entity.id}/liabilities`),
      ]);
      if (!cancelled) {
        setAssets(a);
        setLiabilities(l);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entity.id, entity.valuation_mode]);

  const detailedNav = assets.reduce((s, a) => s + a.value, 0) - liabilities.reduce((s, l) => s + l.value, 0);

  async function saveNav() {
    setSavingNav(true);
    try {
      await fetchJson(`/api/business-entities/${entity.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary_net_asset_value: Number(navDraft) }),
      });
      await onChanged();
    } finally {
      setSavingNav(false);
    }
  }

  async function addLine(kind: 'assets' | 'liabilities') {
    await fetchJson(`/api/business-entities/${entity.id}/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: lineLabel.trim(), value: Number(lineValue), currency_code: entity.currency_code }),
    });
    setLineLabel('');
    setLineValue('');
    setAddingAsset(false);
    setAddingLiability(false);
    await loadLineItems();
  }

  async function removeLine(kind: 'assets' | 'liabilities', id: string) {
    await fetchJson(`/api/business-entities/${entity.id}/${kind}/${id}`, { method: 'DELETE' });
    await loadLineItems();
  }

  const displayedNav = entity.valuation_mode === 'summary' ? (entity.summary_net_asset_value ?? 0) : detailedNav;
  const ownershipValue = (entity.ownership_percentage / 100) * displayedNav;

  return (
    <SectionCard
      title={`${entity.name} · ${ENTITY_TYPE_LABEL[entity.entity_type]}`}
      description={`${entity.ownership_percentage}% owned · ${entity.valuation_mode === 'summary' ? 'Net value entered directly' : 'Valued from its own assets and debts'}`}
    >
      <div className="space-y-3">
        <p className="text-sm text-ink">
          Net value: <span className="font-medium">{formatCurrency(displayedNav, entity.currency_code)}</span>
          {' · '}Your share:{' '}
          <span className="font-medium">{formatCurrency(ownershipValue, entity.currency_code)}</span> (counted in your
          Net Worth)
        </p>

        {entity.valuation_mode === 'summary' ? (
          <div className="flex items-center gap-3">
            <input
              type="number"
              step="0.01"
              value={navDraft}
              onChange={(e) => setNavDraft(e.target.value)}
              className="w-40 rounded border px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => void saveNav()}
              disabled={savingNav}
              className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-60"
            >
              {savingNav ? 'Saving…' : 'Update net value'}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium text-muted">Assets</p>
              <ul className="mt-1 space-y-1">
                {assets.map((a) => (
                  <li key={a.id} className="flex items-center justify-between text-sm">
                    <span>
                      {a.label} — {formatCurrency(a.value, a.currency_code)}
                    </span>
                    <button type="button" onClick={() => void removeLine('assets', a.id)} className="text-xs text-risk hover:underline">
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              {addingAsset ? (
                <div className="mt-2 flex items-center gap-2">
                  <input placeholder="Label" value={lineLabel} onChange={(e) => setLineLabel(e.target.value)} className="w-28 rounded border px-2 py-1 text-xs" />
                  <input type="number" placeholder="Value" value={lineValue} onChange={(e) => setLineValue(e.target.value)} className="w-24 rounded border px-2 py-1 text-xs" />
                  <button type="button" onClick={() => void addLine('assets')} className="text-xs text-trust hover:underline">
                    Add
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setAddingAsset(true)} className="mt-1 text-xs text-trust hover:underline">
                  + Add asset
                </button>
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-muted">Liabilities</p>
              <ul className="mt-1 space-y-1">
                {liabilities.map((l) => (
                  <li key={l.id} className="flex items-center justify-between text-sm">
                    <span>
                      {l.label} — {formatCurrency(l.value, l.currency_code)}
                    </span>
                    <button type="button" onClick={() => void removeLine('liabilities', l.id)} className="text-xs text-risk hover:underline">
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              {addingLiability ? (
                <div className="mt-2 flex items-center gap-2">
                  <input placeholder="Label" value={lineLabel} onChange={(e) => setLineLabel(e.target.value)} className="w-28 rounded border px-2 py-1 text-xs" />
                  <input type="number" placeholder="Value" value={lineValue} onChange={(e) => setLineValue(e.target.value)} className="w-24 rounded border px-2 py-1 text-xs" />
                  <button type="button" onClick={() => void addLine('liabilities')} className="text-xs text-trust hover:underline">
                    Add
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setAddingLiability(true)} className="mt-1 text-xs text-trust hover:underline">
                  + Add liability
                </button>
              )}
            </div>
          </div>
        )}

        <button type="button" onClick={onArchive} disabled={busy} className="text-xs text-gray-500 hover:underline">
          Archive company
        </button>
      </div>
    </SectionCard>
  );
}
