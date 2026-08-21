'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, toMonthly, type Frequency } from '@/lib/engines/money';
import { OWNER_OPTIONS, expectedCurrencyForCountry } from '@/lib/constants';
import { validateRow, findDuplicateCustomNames, type GridRow } from '@/lib/engines/data-quality';
import { currencyMismatch, currencyMismatchBlocked } from '@/lib/validation/currencyCountry';
import { resolveFieldVisibility, isMetadataFieldMissing } from '@/lib/grid/fieldVisibility';
import type { GridConfig } from '@/lib/grid/types';

interface MasterItem {
  item_key: string;
  item_label: string;
  sort_order: number;
  // Chunk 3a item 1 (Spec 1 §9) — category metadata (migrations 0033/0034),
  // read by resolveFieldVisibility() to conditionally show/hide/require
  // fields like purchase_date/purchase_price per catalogue item rather than
  // uniformly for the whole category. Optional/undefined degrades safely to
  // today's always-shown, never-required behaviour.
  requires_purchase_date?: boolean;
  supports_purchase_date?: boolean;
  requires_purchase_price?: boolean;
  supports_purchase_price?: boolean;
}

const ITEM_META_FIELDS = [
  'requires_purchase_date',
  'supports_purchase_date',
  'requires_purchase_price',
  'supports_purchase_price',
] as const;

function metaFromMaster(item: MasterItem): Partial<Row> {
  const meta: Partial<Row> = {};
  for (const key of ITEM_META_FIELDS) {
    if (item[key] !== undefined) meta[key] = item[key];
  }
  return meta;
}

interface SavedRecord {
  id: string;
  master_item_key: string | null;
  currency_code: string;
  currency_override?: boolean;
  owner: string;
  [key: string]: unknown;
}

interface Row extends GridRow {
  key: string;
  id: string | null;
  included: boolean;
  currency_code: string;
  // Explicit, user-set carve-out for a genuinely foreign-currency holding —
  // see currencyMismatch()/currencyMismatchBlocked() below. Never silently
  // defaulted true except for the 'foreign_currency' catalogue item, which
  // is inherently cross-currency by design.
  currency_override?: boolean;
  country_code?: string;
  expanded: boolean;
}

let customRowCounter = 0;

function fieldDefaults(config: GridConfig): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const f of config.fields) if (f.defaultValue !== undefined) defaults[f.name] = f.defaultValue;
  return defaults;
}

function rowFromMaster(item: MasterItem, defaultCurrency: string, config: GridConfig): Row {
  return {
    key: item.item_key,
    id: null,
    master_item_key: item.item_key,
    is_custom: false,
    item_label: item.item_label,
    included: false,
    owner: 'self',
    currency_code: defaultCurrency,
    // 'foreign_currency' is inherently a deliberate cross-currency holding
    // (Assets catalogue) — default its override on so it isn't silently
    // hard-blocked before the user ever touches country/currency.
    currency_override: item.item_key === 'foreign_currency',
    expanded: false,
    ...fieldDefaults(config),
    ...metaFromMaster(item),
  };
}

function rowFromRecord(record: SavedRecord, config: GridConfig, isCustom: boolean, label: string, item?: MasterItem): Row {
  return {
    ...record,
    key: record.master_item_key ?? `custom-${record.id}`,
    id: record.id,
    master_item_key: record.master_item_key,
    is_custom: isCustom,
    item_label: label,
    included: true,
    owner: record.owner,
    currency_code: record.currency_code,
    currency_override: Boolean(record.currency_override),
    expanded: false,
    // A saved row's own field values (e.g. an already-saved purchase_date)
    // take precedence over the spread above via ...record already having
    // set them; this only backfills the item's supports_*/requires_* flags,
    // which a saved record never carries itself.
    ...(item ? metaFromMaster(item) : {}),
  };
}

function isRowSaveable(row: Row, config: GridConfig, duplicates: Set<string>): boolean {
  if (config.frequencyField && !row[config.frequencyField]) return false;
  if (!row.currency_code) return false;
  if (row.is_custom && duplicates.has(row.item_label.trim().toLowerCase())) return false;
  if (currencyMismatchBlocked(row)) return false;
  // Chunk 3a item 1: a metadata-driven field the selected catalogue item
  // marks as required (requires_purchase_date/requires_purchase_price) must
  // be filled in before the row can save. Every populated item ships with
  // both flags false today (see migration 0034's notes), so this is a no-op
  // in practice until the Product Owner opts a specific item in.
  for (const f of config.fields) {
    if (f.metadataDriven && isMetadataFieldMissing(row, f)) return false;
  }
  const value = row[config.valueField];
  return value !== '' && value !== undefined && value !== null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

export function FinancialDataGrid({ config, subNav }: { config: GridConfig; subNav?: React.ReactNode }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
  const [defaultCurrency, setDefaultCurrency] = useState<'AUD' | 'INR'>('AUD');
  const [notApplicable, setNotApplicable] = useState(false);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const rowsRef = useRef<Row[] | null>(null);
  // Kept in sync via an effect rather than assigned during render — a plain
  // ref write in the render body trips react-hooks/refs ("Cannot access
  // refs during render"). rowsRef is only ever read from saveRow(), which
  // fires from an async setTimeout callback (scheduleSave), never from
  // another component's render, so this has no effect on behavior.
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [masterItems, savedRecords, profile] = await Promise.all([
        fetchJson<MasterItem[]>(`/api/master-items?category=${config.category}`),
        fetchJson<SavedRecord[]>(`/api/${config.resource}`),
        fetchJson<{
          preferred_currency: 'AUD' | 'INR' | null;
          not_applicable_investments?: boolean;
          not_applicable_retirement?: boolean;
          not_applicable_insurance?: boolean;
        }>('/api/user/profile').catch(() => null),
      ]);
      if (cancelled) return;
      const currency = profile?.preferred_currency ?? 'AUD';
      setDefaultCurrency(currency);
      if (config.notApplicable) setNotApplicable(Boolean(profile?.[config.notApplicable.profileField]));

      const byMasterKey = new Map(savedRecords.filter((r) => r.master_item_key).map((r) => [r.master_item_key!, r]));
      const merged = masterItems
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((item) => {
          const saved = byMasterKey.get(item.item_key);
          return saved
            ? rowFromRecord(saved, config, false, item.item_label, item)
            : rowFromMaster(item, currency, config);
        });
      const customRows = savedRecords
        .filter((r) => !r.master_item_key)
        .map((r) => rowFromRecord(r, config, true, String(r[config.nameField] ?? '')));

      setRows([...merged, ...customRows]);
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.resource, config.category]);

  function updateRow(key: string, patch: Partial<Row>) {
    setRows((prev) => (prev ? prev.map((r) => (r.key === key ? { ...r, ...patch } : r)) : prev));
  }

  function scheduleSave(key: string) {
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => void saveRow(key), 600);
  }

  async function saveRow(key: string) {
    // Reads the current row from a ref (kept in sync below), not via a
    // setRows() functional updater — React 18 Strict Mode intentionally
    // double-invokes updater functions in dev to catch impure updaters, and
    // the previous version fired fetchJson() from inside one, so every save
    // POSTed twice and created a duplicate row (there's no master_item_key
    // to upsert against for custom rows, so a second POST is a second insert,
    // not a no-op). The actual API call now lives in a plain async function,
    // which Strict Mode does not double-invoke.
    const row = rowsRef.current?.find((r) => r.key === key);
    // Recomputed from the ref (not the memoized `duplicates` from render
    // scope) so a save fired after the 600ms debounce always checks against
    // the latest row names, not a stale snapshot from when scheduleSave() was called.
    if (!row || !isRowSaveable(row, config, findDuplicateCustomNames(rowsRef.current ?? []))) return;

    const body: Record<string, unknown> = { owner: row.owner, currency_code: row.currency_code };
    // Only ever included when true. currency_override is a real DB column
    // only once migration 0032 is applied — omitting the key entirely for
    // the (overwhelmingly common) non-override case means an ordinary save
    // never touches that column at all, so it keeps working unchanged
    // whether or not the migration has landed yet. Only the narrow,
    // deliberate override path is affected until then (see
    // lib/validation/asset.ts's matching comment on the schema side).
    if (row.currency_override) body.currency_override = true;
    body[config.nameField] = row.item_label;
    if (row.master_item_key) body.master_item_key = row.master_item_key;
    for (const f of config.fields) body[f.name] = row[f.name] === '' ? undefined : row[f.name];

    const usePatch = row.is_custom && row.id;
    const url = usePatch ? `/api/${config.resource}/${row.id}` : `/api/${config.resource}`;
    const method = usePatch ? 'PATCH' : 'POST';

    try {
      const saved = await fetchJson<SavedRecord>(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      updateRow(key, { id: saved.id });
    } catch {
      // best effort; the row keeps its typed values and the next edit retries the save
    }
  }

  async function handleToggleInclude(row: Row, included: boolean) {
    updateRow(row.key, { included });
    if (!included) {
      clearTimeout(saveTimers.current[row.key]);
      if (row.id) {
        await fetchJson(`/api/${config.resource}/${row.id}`, { method: 'DELETE' }).catch(() => undefined);
      }
      if (row.is_custom) {
        setRows((prev) => (prev ? prev.filter((r) => r.key !== row.key) : prev));
      } else {
        updateRow(row.key, { id: null, included: false });
      }
    }
  }

  function handleFieldChange(key: string, field: string, value: unknown) {
    const patch: Partial<Row> = { [field]: value } as Partial<Row>;
    if (field === 'country_code') {
      // Country is the source of truth for currency, not the other way
      // around — auto-set currency to the new country's expected currency
      // every time country changes, and require the user to re-confirm any
      // override explicitly rather than silently carrying a stale one
      // across countries (that silent-carry-over is the original bug).
      const expected = expectedCurrencyForCountry(value as string);
      patch.currency_override = false;
      if (expected) patch.currency_code = expected;
    }
    updateRow(key, patch);
    scheduleSave(key);
  }

  async function handleNotApplicableToggle(checked: boolean) {
    if (!config.notApplicable) return;
    setNotApplicable(checked);
    await fetchJson('/api/user/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [config.notApplicable.profileField]: checked }),
    }).catch(() => setNotApplicable(!checked)); // best effort; revert the toggle if the save failed
  }

  function addCustomRow() {
    customRowCounter += 1;
    const key = `custom-new-${customRowCounter}`;
    setRows((prev) => [
      ...(prev ?? []),
      {
        key,
        id: null,
        master_item_key: null,
        is_custom: true,
        item_label: '',
        included: true,
        owner: 'self',
        currency_code: defaultCurrency,
        expanded: true,
        ...fieldDefaults(config),
      },
    ]);
  }

  const duplicates = useMemo(() => findDuplicateCustomNames(rows ?? []), [rows]);

  const visibleRows = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (hideEmpty && !r.included) return false;
      if (search && !r.item_label.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [rows, hideEmpty, search]);

  const included = useMemo(() => (rows ?? []).filter((r) => r.included), [rows]);

  const total = included.reduce((sum, r) => {
    const value = Number(r[config.valueField] ?? 0);
    if (config.isFlow && config.frequencyField) {
      return sum + toMonthly(value, r[config.frequencyField] as Frequency) * 12;
    }
    return sum + value;
  }, 0);

  const masterItemCount = (rows ?? []).filter((r) => !r.is_custom).length;
  const includedMasterCount = included.filter((r) => !r.is_custom).length;
  const completion = masterItemCount > 0 ? Math.round((includedMasterCount / masterItemCount) * 100) : 0;

  const missingRequiredCount = included.filter((r) => {
    if (!r.owner || !r.currency_code) return true;
    if (config.frequencyField && !r[config.frequencyField]) return true;
    if (config.fields.some((f) => f.metadataDriven && isMetadataFieldMissing(r, f))) return true;
    return false;
  }).length;

  // Duplicate custom names are a hard-blocking error (isRowSaveable rejects
  // them, so nothing gets persisted while the name collides) — kept in a
  // separate map from the soft warnings below so it can be styled and worded
  // distinctly ("this name is taken" vs. "double-check this value").
  const errorsByRow = new Map<string, string>();
  for (const r of included) {
    if (r.is_custom && duplicates.has(r.item_label.trim().toLowerCase())) {
      errorsByRow.set(r.key, 'This name is already used for another item — choose a different name to save it.');
    }
  }

  const warningsByRow = new Map<string, string[]>();
  for (const r of included) {
    const warnings = validateRow(config.category, r, config.valueField);
    if (warnings.length) warningsByRow.set(r.key, warnings);
  }
  const totalWarnings = Array.from(warningsByRow.values()).reduce((s, w) => s + w.length, 0);

  // Country/currency mismatch is a hard block (see isRowSaveable), with an
  // explicit override carve-out. The set below drives the checkbox+warning
  // UI and stays populated even once overridden, so the checkbox (and the
  // ability to un-check it) remains visible.
  const currencyMismatchRows = new Set<string>();
  for (const r of included) {
    if (currencyMismatch(r)) currencyMismatchRows.add(r.key);
  }

  if (!rows) {
    return (
      <>
        {subNav}
        <p className="text-muted">Loading...</p>
      </>
    );
  }

  return (
    <>
      {subNav}
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-trust">{config.title}</h1>
          <p className="mt-1 text-muted">{config.description}</p>
        </div>

        {config.notApplicable && (
          <label className="flex items-start gap-2 rounded-card border border-line bg-white p-3 text-sm">
            <input
              type="checkbox"
              checked={notApplicable}
              onChange={(e) => handleNotApplicableToggle(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-ink">{config.notApplicable.label}</span>
              <span className="block text-xs text-muted">
                This excludes {config.title} from your Financial Health Score instead of counting it as missing data.
              </span>
            </span>
          </label>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            placeholder="Search items..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 rounded border px-3 py-2 text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
            Hide empty rows
          </label>
        </div>

        {/* Desktop table */}
        <div className="hidden overflow-x-auto rounded-card border bg-white md:block">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-xs uppercase text-muted">
              <tr>
                <th className="w-10 px-3 py-2"></th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Owner</th>
                {config.fields.map((f) => (
                  <th key={f.name} className="px-3 py-2">
                    {f.label}
                  </th>
                ))}
                <th className="px-3 py-2">Currency</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.key} className={`border-b last:border-0 ${!row.included ? 'text-muted' : ''}`}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={row.included}
                      onChange={(e) => handleToggleInclude(row, e.target.checked)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    {row.is_custom ? (
                      <input
                        type="text"
                        value={row.item_label}
                        disabled={!row.included}
                        placeholder="Custom item name"
                        onChange={(e) => handleFieldChange(row.key, 'item_label', e.target.value)}
                        className={`w-full rounded border px-2 py-1 disabled:bg-gray-50 ${errorsByRow.has(row.key) ? 'border-risk' : ''}`}
                      />
                    ) : (
                      row.item_label
                    )}
                    {errorsByRow.has(row.key) && (
                      <p className="mt-1 text-xs text-risk">{errorsByRow.get(row.key)}</p>
                    )}
                    {warningsByRow.has(row.key) && (
                      <p className="mt-1 text-xs text-caution">{warningsByRow.get(row.key)!.join('; ')}</p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={row.owner}
                      disabled={!row.included}
                      onChange={(e) => handleFieldChange(row.key, 'owner', e.target.value)}
                      className="w-32 rounded border px-2 py-1 disabled:bg-gray-50"
                    >
                      {OWNER_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  {config.fields.map((f) => {
                    // Chunk 3a item 1 (Spec 1 §9): purchase_date/
                    // purchase_price (and any future metadataDriven field)
                    // are shown/required/read-only per-row based on the
                    // selected catalogue item — see lib/grid/fieldVisibility.ts.
                    // Every non-metadataDriven field keeps its unconditional
                    // always-shown behaviour exactly as before.
                    const vis = resolveFieldVisibility(row, f);
                    return (
                      <td key={f.name} className="px-3 py-2">
                        {!vis.show ? (
                          <span className="text-muted">—</span>
                        ) : f.type === 'checkbox' ? (
                          <input
                            type="checkbox"
                            checked={Boolean(row[f.name] ?? false)}
                            disabled={!row.included || vis.readOnly}
                            onChange={(e) => handleFieldChange(row.key, f.name, e.target.checked)}
                          />
                        ) : f.type === 'select' ? (
                          <select
                            value={String(row[f.name] ?? '')}
                            disabled={!row.included || vis.readOnly}
                            onChange={(e) => handleFieldChange(row.key, f.name, e.target.value)}
                            className="w-32 rounded border px-2 py-1 disabled:bg-gray-50"
                          >
                            <option value="">-</option>
                            {f.options?.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={f.type}
                            step={f.step}
                            value={String(row[f.name] ?? '')}
                            disabled={!row.included || vis.readOnly}
                            onChange={(e) =>
                              handleFieldChange(row.key, f.name, f.type === 'number' ? Number(e.target.value) : e.target.value)
                            }
                            className={`w-28 rounded border px-2 py-1 disabled:bg-gray-50 ${
                              vis.required && !String(row[f.name] ?? '') ? 'border-caution' : ''
                            }`}
                          />
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2">
                    <select
                      value={row.currency_code}
                      disabled={!row.included}
                      onChange={(e) => handleFieldChange(row.key, 'currency_code', e.target.value)}
                      className={`w-20 rounded border px-2 py-1 disabled:bg-gray-50 ${
                        currencyMismatchBlocked(row) ? 'border-risk' : ''
                      }`}
                    >
                      <option value="AUD">AUD</option>
                      <option value="INR">INR</option>
                    </select>
                    {currencyMismatchRows.has(row.key) && (
                      <div className="mt-1 w-44">
                        <p className={`text-xs ${currencyMismatchBlocked(row) ? 'text-risk' : 'text-muted'}`}>
                          {currencyMismatchBlocked(row)
                            ? `Doesn't match ${row.country_code === 'IN' ? "India's" : "Australia's"} currency (${expectedCurrencyForCountry(row.country_code)}) — won't save until fixed or confirmed.`
                            : 'Confirmed as an intentionally different currency.'}
                        </p>
                        <label className="mt-1 flex items-center gap-1 text-xs text-muted">
                          <input
                            type="checkbox"
                            checked={Boolean(row.currency_override)}
                            disabled={!row.included}
                            onChange={(e) => handleFieldChange(row.key, 'currency_override', e.target.checked)}
                          />
                          This holding is genuinely in a different currency
                        </label>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row.is_custom && (
                      <button onClick={() => handleToggleInclude(row, false)} className="text-xs text-risk">
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="space-y-3 md:hidden">
          {visibleRows.map((row) => (
            <div key={row.key} className="rounded-card border bg-white p-3">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 font-medium text-ink">
                  <input
                    type="checkbox"
                    checked={row.included}
                    onChange={(e) => handleToggleInclude(row, e.target.checked)}
                  />
                  {row.is_custom ? (
                    <input
                      type="text"
                      value={row.item_label}
                      disabled={!row.included}
                      placeholder="Custom item name"
                      onChange={(e) => handleFieldChange(row.key, 'item_label', e.target.value)}
                      className={`rounded border px-2 py-1 disabled:bg-gray-50 ${errorsByRow.has(row.key) ? 'border-risk' : ''}`}
                    />
                  ) : (
                    row.item_label
                  )}
                </label>
                {row.included && (
                  <button
                    onClick={() => updateRow(row.key, { expanded: !row.expanded })}
                    className="text-xs text-trust"
                  >
                    {row.expanded ? 'Collapse' : 'Expand'}
                  </button>
                )}
              </div>
              {errorsByRow.has(row.key) && (
                <p className="mt-1 text-xs text-risk">{errorsByRow.get(row.key)}</p>
              )}
              {warningsByRow.has(row.key) && (
                <p className="mt-1 text-xs text-caution">{warningsByRow.get(row.key)!.join('; ')}</p>
              )}
              {row.included && row.expanded && (
                <div className="mt-3 space-y-2">
                  <div>
                    <label className="block text-xs text-muted">Owner</label>
                    <select
                      value={row.owner}
                      onChange={(e) => handleFieldChange(row.key, 'owner', e.target.value)}
                      className="w-full rounded border px-2 py-1"
                    >
                      {OWNER_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {config.fields.map((f) => {
                    // See the desktop table's identical comment above —
                    // Chunk 3a item 1 (Spec 1 §9).
                    const vis = resolveFieldVisibility(row, f);
                    if (!vis.show) return null;
                    return (
                      <div key={f.name}>
                        <label className="block text-xs text-muted">
                          {f.label}
                          {vis.required && <span className="text-risk"> *</span>}
                        </label>
                        {f.type === 'checkbox' ? (
                          <input
                            type="checkbox"
                            checked={Boolean(row[f.name] ?? false)}
                            disabled={vis.readOnly}
                            onChange={(e) => handleFieldChange(row.key, f.name, e.target.checked)}
                          />
                        ) : f.type === 'select' ? (
                          <select
                            value={String(row[f.name] ?? '')}
                            disabled={vis.readOnly}
                            onChange={(e) => handleFieldChange(row.key, f.name, e.target.value)}
                            className="w-full rounded border px-2 py-1"
                          >
                            <option value="">-</option>
                            {f.options?.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={f.type}
                            step={f.step}
                            value={String(row[f.name] ?? '')}
                            disabled={vis.readOnly}
                            onChange={(e) =>
                              handleFieldChange(row.key, f.name, f.type === 'number' ? Number(e.target.value) : e.target.value)
                            }
                            className="w-full rounded border px-2 py-1"
                          />
                        )}
                      </div>
                    );
                  })}
                  <div>
                    <label className="block text-xs text-muted">Currency</label>
                    <select
                      value={row.currency_code}
                      onChange={(e) => handleFieldChange(row.key, 'currency_code', e.target.value)}
                      className={`w-full rounded border px-2 py-1 ${
                        currencyMismatchBlocked(row) ? 'border-risk' : ''
                      }`}
                    >
                      <option value="AUD">AUD</option>
                      <option value="INR">INR</option>
                    </select>
                    {currencyMismatchRows.has(row.key) && (
                      <div className="mt-1">
                        <p className={`text-xs ${currencyMismatchBlocked(row) ? 'text-risk' : 'text-muted'}`}>
                          {currencyMismatchBlocked(row)
                            ? `Doesn't match ${row.country_code === 'IN' ? "India's" : "Australia's"} currency (${expectedCurrencyForCountry(row.country_code)}) — won't save until fixed or confirmed.`
                            : 'Confirmed as an intentionally different currency.'}
                        </p>
                        <label className="mt-1 flex items-center gap-1 text-xs text-muted">
                          <input
                            type="checkbox"
                            checked={Boolean(row.currency_override)}
                            onChange={(e) => handleFieldChange(row.key, 'currency_override', e.target.checked)}
                          />
                          This holding is genuinely in a different currency
                        </label>
                      </div>
                    )}
                  </div>
                  {row.is_custom && (
                    <button onClick={() => handleToggleInclude(row, false)} className="text-xs text-risk">
                      Remove item
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <button onClick={addCustomRow} className="text-sm font-medium text-trust hover:underline">
          + Add Custom Item
        </button>

        <div className="grid grid-cols-2 gap-3 rounded-card border bg-gray-50 p-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <p className="text-muted">Active items</p>
            <p className="font-semibold text-ink">{included.length}</p>
          </div>
          <div>
            <p className="text-muted">{config.isFlow ? 'Total annual value' : 'Total value'}</p>
            <p className="font-semibold text-ink">{formatMoney(total, defaultCurrency)}</p>
          </div>
          <div>
            <p className="text-muted">Missing fields</p>
            <p className="font-semibold text-ink">{missingRequiredCount}</p>
          </div>
          <div>
            <p className="text-muted">Warnings</p>
            <p className="font-semibold text-ink">{totalWarnings}</p>
          </div>
          <div>
            <p className="text-muted">Completion</p>
            <p className="font-semibold text-ink">{completion}%</p>
          </div>
        </div>
      </div>
    </>
  );
}
