'use client';

import { useEffect, useState } from 'react';
import { formatMoney } from '@/lib/engines/money';
import {
  LINK_TYPE_LABELS,
  LINK_TYPE_VALUES,
  DEFAULT_LINK_TYPE_BY_PROPERTY_ITEM,
  type LinkType,
} from '@/lib/validation/propertyLiabilityLink';

interface LinkRow {
  id: string;
  linked_asset_id: string | null;
  linked_investment_id: string | null;
  liability_id: string;
  link_type: string;
  allocation_percent: number;
  is_active: boolean;
}

interface EligibleLiability {
  id: string;
  liability_name: string;
  balance: number;
  currency_code: string;
  lender: string | null;
}

interface EligibleProperty {
  id: string;
  name: string;
  value: number;
  currency_code: string;
  kind: 'asset' | 'investment';
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

// Spec s.14-18: "Financing" on the Property side / "Related / Secured
// Property" on the Liability side -- one canonical relationship, visible
// correctly from both pages (spec s.18: bidirectional, never two
// independent link records). This component is deliberately side-agnostic:
// it always talks to the same /api/property-liability-links endpoint, so a
// link created here is the exact same row the other side's instance of
// this component will read.
export function PropertyFinancingControl({
  side,
  propertyKind,
  propertyId,
  masterItemKey,
  liabilityId,
}: {
  side: 'property' | 'liability';
  propertyKind?: 'asset' | 'investment'; // required when side === 'property'
  propertyId?: string; // required when side === 'property'
  masterItemKey?: string | null; // used to pre-select a sensible default link_type
  liabilityId?: string; // required when side === 'liability'
}) {
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [eligibleLiabilities, setEligibleLiabilities] = useState<EligibleLiability[] | null>(null);
  const [eligibleProperties, setEligibleProperties] = useState<EligibleProperty[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [linkType, setLinkType] = useState<LinkType>(
    (masterItemKey && DEFAULT_LINK_TYPE_BY_PROPERTY_ITEM[masterItemKey]) || 'property_secured_other'
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = side === 'property' ? propertyId : liabilityId;
  const query = side === 'property' ? (propertyKind === 'asset' ? `asset_id=${id}` : `investment_id=${id}`) : `liability_id=${id}`;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchJson<LinkRow[]>(`/api/property-liability-links?${query}`)
      .then((data) => !cancelled && setLinks(data.filter((l) => l.is_active)))
      .catch(() => !cancelled && setLinks([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, side]);

  async function openPicker() {
    setPicking(true);
    setError(null);
    if (side === 'property' && !eligibleLiabilities) {
      const data = await fetchJson<EligibleLiability[]>('/api/property-liability-links?eligible_liabilities=1').catch(() => []);
      setEligibleLiabilities(data);
    }
    if (side === 'liability' && !eligibleProperties) {
      const [assets, investments] = await Promise.all([
        fetchJson<{ id: string; asset_name: string; current_value: number; currency_code: string; master_item_key: string | null }[]>('/api/assets').catch(() => []),
        fetchJson<{ id: string; investment_name: string; current_value: number; currency_code: string; master_item_key: string | null }[]>('/api/investments').catch(() => []),
      ]);
      setEligibleProperties([
        ...assets.map((a) => ({ id: a.id, name: a.asset_name, value: a.current_value, currency_code: a.currency_code, kind: 'asset' as const })),
        ...investments.map((i) => ({ id: i.id, name: i.investment_name, value: i.current_value, currency_code: i.currency_code, kind: 'investment' as const })),
      ]);
    }
  }

  async function submitLink() {
    if (!selectedId || !id) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { link_type: linkType, allocation_percent: 100, is_primary: true };
      if (side === 'property') {
        body.liability_id = selectedId;
        if (propertyKind === 'asset') body.linked_asset_id = id;
        else body.linked_investment_id = id;
      } else {
        body.liability_id = id;
        const chosen = eligibleProperties?.find((p) => p.id === selectedId);
        if (chosen?.kind === 'asset') body.linked_asset_id = selectedId;
        else body.linked_investment_id = selectedId;
      }
      const created = await fetchJson<LinkRow>('/api/property-liability-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setLinks((prev) => [...(prev ?? []), created]);
      setPicking(false);
      setSelectedId('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the link.');
    } finally {
      setBusy(false);
    }
  }

  async function unlink(linkId: string) {
    setBusy(true);
    try {
      await fetchJson(`/api/property-liability-links/${linkId}`, { method: 'DELETE' });
      setLinks((prev) => (prev ?? []).filter((l) => l.id !== linkId));
    } catch {
      // best effort
    } finally {
      setBusy(false);
    }
  }

  if (!id || links === null) return null;

  return (
    <div className="text-xs">
      {links.length === 0 && !picking && (
        <div className="flex items-center gap-2">
          <span className="text-muted">{side === 'property' ? 'No associated loan' : 'No related property'}</span>
          <button onClick={openPicker} className="text-trust hover:underline">
            + Link {side === 'property' ? 'loan' : 'property'}
          </button>
        </div>
      )}

      {links.map((l) => (
        <LinkChip key={l.id} link={l} side={side} onUnlink={() => unlink(l.id)} busy={busy} />
      ))}

      {links.length > 0 && !picking && (
        <button onClick={openPicker} className="mt-1 text-trust hover:underline">
          + Link another {side === 'property' ? 'loan' : 'property'}
        </button>
      )}

      {picking && (
        <div className="mt-1 space-y-1 rounded border border-line bg-gray-50 p-2">
          {side === 'property' ? (
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="w-full rounded border px-1 py-0.5">
              <option value="">Select an existing liability...</option>
              {(eligibleLiabilities ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.liability_name}{l.lender ? ` — ${l.lender}` : ''} — {formatMoney(l.balance, l.currency_code as 'AUD' | 'INR')}
                </option>
              ))}
            </select>
          ) : (
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="w-full rounded border px-1 py-0.5">
              <option value="">Select an existing property...</option>
              {(eligibleProperties ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {formatMoney(p.value, p.currency_code as 'AUD' | 'INR')}
                </option>
              ))}
            </select>
          )}
          <select value={linkType} onChange={(e) => setLinkType(e.target.value as LinkType)} className="w-full rounded border px-1 py-0.5">
            {LINK_TYPE_VALUES.map((t) => (
              <option key={t} value={t}>
                {LINK_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {error && <p className="text-risk">{error}</p>}
          <div className="flex gap-2">
            <button disabled={!selectedId || busy} onClick={submitLink} className="rounded bg-primary px-2 py-0.5 text-white disabled:opacity-50">
              Link
            </button>
            <button onClick={() => { setPicking(false); setError(null); }} className="text-muted hover:underline">
              Cancel
            </button>
          </div>
          {side === 'property' && (
            <p className="text-[11px] text-muted">
              Don&apos;t see the right liability? Add it on the{' '}
              <a href="/liabilities" className="text-trust hover:underline">
                Liabilities
              </a>{' '}
              page first, then link it here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LinkChip({ link, side, onUnlink, busy }: { link: LinkRow; side: 'property' | 'liability'; onUnlink: () => void; busy: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded bg-blue-50 px-2 py-1 text-blue-800">
      <span>
        {LINK_TYPE_LABELS[link.link_type as LinkType] ?? link.link_type}
        {link.allocation_percent < 100 ? ` (${link.allocation_percent}%)` : ''}
      </span>
      <button disabled={busy} onClick={onUnlink} className="text-[11px] text-risk hover:underline disabled:opacity-50">
        {side === 'property' ? 'Remove Link' : 'Unlink'}
      </button>
    </div>
  );
}
