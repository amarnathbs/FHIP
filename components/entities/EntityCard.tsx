'use client';

import { useCallback, useEffect, useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { fetchJson, formatMoneySafe } from '@/components/retirement/smsf/format';
import { formatDateShort } from '@/lib/engines/date';
import { EntityCashFlowSummary } from './EntityCashFlowSummary';
import { EntityFlowPanel } from './EntityFlowPanel';
import { EntityLinesPanel } from './EntityLinesPanel';
import { EntityModeChooser, type EntityRecordingMode } from './EntityModeChooser';

type Currency = 'AUD' | 'INR';
export type BusinessEntityType = 'company' | 'family_trust' | 'huf';

export interface BusinessEntityRecord {
  id: string;
  name: string;
  entity_type: BusinessEntityType;
  country_code: string | null;
  currency_code: Currency;
  ownership_percentage: number;
  valuation_mode: EntityRecordingMode;
  summary_net_asset_value: number | null;
  is_active: boolean;
  notes: string | null;
  /** Derived by the database from the active lines while itemised (GET one entity). */
  derived_net?: number | null;
}

export const ENTITY_TYPE_LABEL: Record<BusinessEntityType, string> = {
  company: 'Company',
  family_trust: 'Family Trust',
  huf: 'HUF (Hindu Undivided Family)',
};

interface HistoryPayload {
  modes: { id: string; action: string; net_before: number | null; net_after: number | null; created_at: string }[];
  changes: { id: string; table_name: string; action: string; created_at: string }[];
}
const MODE_ACTION: Record<string, string> = { to_itemised: 'Switched to itemised assets and liabilities', to_net_only: 'Switched to a net value only', undo: 'Undid the last change' };
const CHANGE_TABLE: Record<string, string> = {
  business_entity_assets: 'an asset',
  business_entity_liabilities: 'a liability',
  entity_income_items: 'income',
  entity_expense_items: 'an expense',
};
const CHANGE_ACTION: Record<string, string> = { insert: 'Added', update: 'Changed', retire: 'Removed', moved_from_personal: 'Moved in' };

/**
 * One Company, Family Trust or HUF at ENTITY level (PO review 20-10-2026, F23b): how it is recorded (itemised OR a net value only), its assets and
 * liabilities, its income and its expenses. Entity data is entered here and kept apart from your personal pages, the family Net Worth adds the
 * entity back at reporting time only (Trust and HUF in full, a Company by your ownership share).
 */
export function EntityCard({ entity: initial, onArchive, onChanged, busy }: { entity: BusinessEntityRecord; onArchive: () => void; onChanged: () => void | Promise<void>; busy: boolean }) {
  const apiBase = `/api/business-entities/${initial.id}`;
  const [entity, setEntity] = useState<BusinessEntityRecord>(initial);
  const [refresh, setRefresh] = useState(0);
  const [propertyAssets, setPropertyAssets] = useState<{ id: string; name: string }[]>([]);
  const [navDraft, setNavDraft] = useState(String(initial.summary_net_asset_value ?? 0));
  const [savingNav, setSavingNav] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const reloadEntity = useCallback(async () => {
    try {
      const fresh = await fetchJson<BusinessEntityRecord>(apiBase);
      setEntity(fresh);
      setNavDraft(String(fresh.summary_net_asset_value ?? 0));
      if (fresh.valuation_mode === 'detailed') {
        const assets = await fetchJson<{ id: string; label: string; asset_type: string | null }[]>(`${apiBase}/assets`);
        setPropertyAssets(assets.filter((a) => a.asset_type === 'property').map((a) => ({ id: a.id, name: a.label })));
      } else {
        setPropertyAssets([]);
      }
    } catch {
      /* the list reload below refreshes the card anyway */
    }
  }, [apiBase]);

  useEffect(() => {
    (async () => {
      await reloadEntity();
    })();
  }, [reloadEntity, refresh]);

  const changed = () => {
    setRefresh((n) => n + 1);
    void onChanged();
  };

  async function saveNav() {
    setSavingNav(true);
    setNavError(null);
    try {
      await fetchJson(apiBase, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary_net_asset_value: Number(navDraft) }) });
      changed();
    } catch (e) {
      setNavError(e instanceof Error ? e.message : 'Could not update the net value');
    } finally {
      setSavingNav(false);
    }
  }

  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next) {
      try {
        setHistory(await fetchJson<HistoryPayload>(`${apiBase}/history`));
      } catch {
        setHistory({ modes: [], changes: [] });
      }
    }
  }

  const share = entity.entity_type === 'company' ? entity.ownership_percentage : 100;
  const net = entity.valuation_mode === 'summary' ? entity.summary_net_asset_value : entity.derived_net ?? null;
  const counted = net === null ? null : Math.round(net * (share / 100) * 100) / 100;

  return (
    <SectionCard
      title={`${entity.name} · ${ENTITY_TYPE_LABEL[entity.entity_type]}`}
      description={`${entity.entity_type === 'company' ? `${entity.ownership_percentage}% owned` : 'Counted in full'} · ${entity.valuation_mode === 'summary' ? 'Recorded as a net value only' : 'Itemised: assets and liabilities, the net is worked out'}`}
    >
      <div className="space-y-5">
        <p className="text-sm text-ink" data-testid="entity-card-net">
          Net value: <span className="font-medium">{net === null ? '—' : formatMoneySafe(net, entity.currency_code)}</span>
          {' · '}Counted in your family Net Worth:{' '}
          <span className="font-medium">{counted === null ? '—' : formatMoneySafe(counted, entity.currency_code)}</span>
          {entity.entity_type === 'company' ? ` (your ${share}% share)` : ' (in full)'}. Never in your personal Net Worth.
        </p>

        <EntityModeChooser entityId={entity.id} mode={entity.valuation_mode} currency={entity.currency_code} onChanged={changed} />

        {entity.valuation_mode === 'detailed' ? (
          <EntityLinesPanel key={`lines-${refresh}`} apiBase={apiBase} currency={entity.currency_code} netDerived={entity.derived_net ?? null} onChanged={changed} />
        ) : (
          <section aria-label="Net value of the entity">
            <h4 className="text-sm font-semibold text-ink">Net value</h4>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label htmlFor={`nav-${entity.id}`} className="sr-only">Net value (assets minus debts)</label>
              <input id={`nav-${entity.id}`} type="number" inputMode="decimal" step="0.01" value={navDraft} onChange={(e) => setNavDraft(e.target.value)} className="w-44 rounded border border-line px-3 py-2 text-sm" />
              <button type="button" onClick={() => void saveNav()} disabled={savingNav} className="rounded border border-line px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-60">
                {savingNav ? 'Saving…' : 'Update net value'}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-muted">The assets and liabilities cannot be entered while the entity is recorded as a net value only. Choose &quot;Itemised assets and liabilities&quot; above to enter them.</p>
            {navError && <p role="alert" className="mt-1 text-sm text-risk">{navError}</p>}
          </section>
        )}

        <EntityFlowPanel key={`inc-${refresh}`} flow="income" apiBase={apiBase} currency={entity.currency_code} assetLinkField="business_entity_asset_id" assetOptions={propertyAssets} onChanged={changed} />
        <EntityFlowPanel key={`exp-${refresh}`} flow="expenses" apiBase={apiBase} currency={entity.currency_code} onChanged={changed} />
        <EntityCashFlowSummary apiBase={apiBase} currency={entity.currency_code} refreshKey={refresh} />

        <div className="flex flex-wrap items-center gap-4 border-t border-line pt-3">
          <button type="button" onClick={() => void toggleHistory()} aria-expanded={showHistory} className="text-xs text-trust hover:underline">
            {showHistory ? 'Hide history' : 'Show history'}
          </button>
          <button type="button" onClick={onArchive} disabled={busy} className="text-xs text-muted hover:underline">
            Archive this entity
          </button>
        </div>
        {showHistory && history && (
          <div className="text-sm" data-testid="entity-history">
            {history.modes.length === 0 && history.changes.length === 0 && <p className="text-muted">No changes recorded yet.</p>}
            <ul className="space-y-1">
              {history.modes.map((m) => (
                <li key={m.id}>
                  {formatDateShort(m.created_at.slice(0, 10), entity.currency_code)}: {MODE_ACTION[m.action] ?? m.action}. Net {formatMoneySafe(m.net_before, entity.currency_code)} to {formatMoneySafe(m.net_after, entity.currency_code)}.
                </li>
              ))}
              {history.changes.slice(0, 30).map((c) => (
                <li key={c.id} className="text-muted">
                  {formatDateShort(c.created_at.slice(0, 10), entity.currency_code)}: {CHANGE_ACTION[c.action] ?? c.action} {CHANGE_TABLE[c.table_name] ?? c.table_name}.
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
