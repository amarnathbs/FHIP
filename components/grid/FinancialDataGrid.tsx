'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, toMonthly, type Frequency } from '@/lib/engines/money';
import { OWNER_OPTIONS } from '@/lib/constants';
import { validateRow, findDuplicateCustomNames, type GridRow } from '@/lib/engines/data-quality';
import type { GridConfig } from '@/lib/grid/types';

interface MasterItem {
  item_key: string;
  item_label: string;
  sort_order: number;
}

interface SavedRecord {
  id: string;
  master_item_key: string | null;
  currency_code: string;
  owner: string;
  [key: string]: unknown;
}

interface Row extends GridRow {
  key: string;
  id: string | null;
  included: boolean;
  currency_code: string;
  expanded: boolean;
  source_type?: string; // R3 — 'investment_intelligence_published' | 'manual' | undefined (non-investments resources never set this)
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
    expanded: false,
    ...fieldDefaults(config),
  };
}

function rowFromRecord(record: SavedRecord, config: GridConfig, isCustom: boolean, label: string): Row {
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
    expanded: false,
  };
}

// R3 spec section 38/40 — direct-edit protection + source provenance badge.
// Fields Investment Intelligence certifies from a source document must not
// become independently editable here (matches the server-side enforcement
// in app/api/investments/[id]/route.ts's PROTECTED_ON_PUBLISHED_ROWS — kept
// in sync deliberately, both layers enforce the same rule). Only investments
// rows can ever carry source_type='investment_intelligence_published'
// (migration 0042); every other register's rows have no such field, so this
// is a no-op everywhere else in the shared grid.
const II_PUBLISHED_PROTECTED_FIELDS = new Set(['institution', 'current_value', 'cost_base', 'risk_profile', 'country_code']);
function isIiPublished(row: Row): boolean {
  return row.source_type === 'investment_intelligence_published';
}
function isFieldLockedForRow(row: Row, fieldName: string): boolean {
  return isIiPublished(row) && II_PUBLISHED_PROTECTED_FIELDS.has(fieldName);
}

function isRowSaveable(row: Row, config: GridConfig, duplicates: Set<string>): boolean {
  if (config.frequencyField && !row[config.frequencyField]) return false;
  if (!row.currency_code) return false;
  if (row.is_custom && duplicates.has(row.item_label.trim().toLowerCase())) return false;
  const value = row[config.valueField];
  return value !== '' && value !== undefined && value !== null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

type ZeroAnswer = 'yes' | 'no' | 'unsure' | null;

export function FinancialDataGrid({ config, subNav }: { config: GridConfig; subNav?: React.ReactNode }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
  const [defaultCurrency, setDefaultCurrency] = useState<'AUD' | 'INR'>('AUD');
  const [notApplicable, setNotApplicable] = useState(false);
  // Phase 0C: explicit Yes/No(/Not sure) confirmation for Liabilities and
  // Insurance — null means "not yet answered", distinct from 'yes' (which
  // isn't itself persisted; see handleZeroAnswer below).
  const [zeroAnswer, setZeroAnswer] = useState<ZeroAnswer>(null);
  // Phase 0C.1: the "I've added everything relevant to me" completion
  // confirmation — one row existing is only 'in_progress', not
  // 'reviewed_with_data', until this is explicitly set. Reversible.
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const rowsRef = useRef<Row[] | null>(null);
  rowsRef.current = rows;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [masterItems, savedRecords, profile, sectionStatusRows] = await Promise.all([
        fetchJson<MasterItem[]>(`/api/master-items?category=${config.category}`),
        fetchJson<SavedRecord[]>(`/api/${config.resource}`),
        fetchJson<{
          preferred_currency: 'AUD' | 'INR' | null;
          not_applicable_investments?: boolean;
          not_applicable_retirement?: boolean;
          not_applicable_insurance?: boolean;
        }>('/api/user/profile').catch(() => null),
        config.reviewSection
          ? fetchJson<{ section: string; status: string }[]>('/api/user/section-status').catch(() => [])
          : Promise.resolve([]),
      ]);
      if (cancelled) return;
      const currency = profile?.preferred_currency ?? 'AUD';
      setDefaultCurrency(currency);
      if (config.notApplicable) setNotApplicable(Boolean(profile?.[config.notApplicable.profileField]));
      if (config.zeroConfirmation) {
        const confirmed = sectionStatusRows.find((r) => r.section === config.zeroConfirmation!.section);
        // A "No" confirmation on record always shows as answered. Otherwise,
        // real rows already on file imply an unspoken "Yes" — the radio
        // reflects that rather than sitting blank above data that's clearly
        // already there.
        if (confirmed?.status === 'reviewed_zero') setZeroAnswer('no');
        else if (savedRecords.length > 0) setZeroAnswer('yes');
      }
      if (config.reviewSection) {
        const reviewed = sectionStatusRows.find((r) => r.section === config.reviewSection);
        // Only trust the confirmation while it's still backed by real rows —
        // matches effectiveSectionStatus()'s server-side "stale confirmation
        // reverts" rule, so the button doesn't show "Reviewed" for a section
        // whose rows were since deleted.
        setReviewConfirmed(reviewed?.status === 'reviewed_with_data' && savedRecords.length > 0);
      }

      const byMasterKey = new Map(savedRecords.filter((r) => r.master_item_key).map((r) => [r.master_item_key!, r]));
      const merged = masterItems
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((item) => {
          const saved = byMasterKey.get(item.item_key);
          return saved ? rowFromRecord(saved, config, false, item.item_label) : rowFromMaster(item, currency, config);
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
    updateRow(key, { [field]: value } as Partial<Row>);
    scheduleSave(key);
  }

  async function handleNotApplicableToggle(checked: boolean) {
    if (!config.notApplicable) return;
    const previous = notApplicable;
    setNotApplicable(checked);
    try {
      // Phase 0C.1 fix: the eligibility engine (computeHealthScoreEligibility,
      // scoreInvestment/scoreRetirement) reads exclusively from
      // user_financial_section_status now — the user_profiles boolean below
      // is kept only for backwards-compatible display/back-fill, it is no
      // longer what the score itself checks. Without this second write, a
      // NEW not-applicable confirmation made after Phase 0C shipped would
      // update the profile column but never actually reach the eligibility
      // engine, silently failing to exclude the section from the score.
      await Promise.all([
        fetchJson('/api/user/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [config.notApplicable.profileField]: checked }),
        }),
        config.reviewSection
          ? fetchJson('/api/user/section-status', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ section: config.reviewSection, status: checked ? 'not_applicable' : null }),
            })
          : Promise.resolve(),
      ]);
    } catch {
      setNotApplicable(previous); // best effort; revert the toggle if either save failed
    }
  }

  // Phase 0C: only 'no' is ever actually persisted (as a 'reviewed_zero'
  // section-status confirmation) — 'yes' and 'unsure' both clear any
  // standing confirmation, since real rows (for 'yes') or simply not
  // knowing yet (for 'unsure') aren't states that need to be remembered
  // explicitly. Reversible: switching answers always re-fires this.
  async function handleZeroAnswer(answer: 'yes' | 'no' | 'unsure') {
    if (!config.zeroConfirmation) return;
    const previous = zeroAnswer;
    setZeroAnswer(answer);
    await fetchJson('/api/user/section-status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        section: config.zeroConfirmation.section,
        status: answer === 'no' ? 'reviewed_zero' : null,
      }),
    }).catch(() => setZeroAnswer(previous)); // best effort; revert if the save failed
  }

  // Phase 0C.1: the explicit "I've added everything relevant to me"
  // confirmation for positive-data sections. Setting it persists
  // 'reviewed_with_data'; clearing it (the reversible "still adding" path)
  // deletes the confirmation so the section falls back to whatever
  // effectiveSectionStatus() derives from row presence alone (in_progress).
  async function handleReviewConfirm(confirmed: boolean) {
    if (!config.reviewSection) return;
    const previous = reviewConfirmed;
    setReviewConfirmed(confirmed);
    await fetchJson('/api/user/section-status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        section: config.reviewSection,
        status: confirmed ? 'reviewed_with_data' : null,
      }),
    }).catch(() => setReviewConfirmed(previous)); // best effort; revert if the save failed
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

        {config.zeroConfirmation && (
          <fieldset className="rounded-card border border-line bg-white p-3 text-sm">
            <legend className="px-1 font-medium text-ink">{config.zeroConfirmation.question}</legend>
            <div className="mt-1 flex flex-wrap gap-x-6 gap-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`zero-confirmation-${config.category}`}
                  checked={zeroAnswer === 'yes'}
                  onChange={() => handleZeroAnswer('yes')}
                />
                Yes
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`zero-confirmation-${config.category}`}
                  checked={zeroAnswer === 'no'}
                  onChange={() => handleZeroAnswer('no')}
                />
                {config.zeroConfirmation.noLabel}
              </label>
              {config.zeroConfirmation.includeUnsure && (
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`zero-confirmation-${config.category}`}
                    checked={zeroAnswer === 'unsure'}
                    onChange={() => handleZeroAnswer('unsure')}
                  />
                  Not sure / review later
                </label>
              )}
            </div>
            {zeroAnswer === 'no' && (
              <p className="mt-2 text-xs text-muted">
                Recorded — this counts as a confirmed answer in your Financial Health Score, not missing data.
              </p>
            )}
          </fieldset>
        )}

        {/* Phase 0C.1: completion confirmation for positive-data sections.
            Only shown once there's something to review, and hidden once a
            zero-confirmation ("No, I have none of this") already resolves
            the section — there's nothing left to mark complete. */}
        {config.reviewSection && included.length > 0 && zeroAnswer !== 'no' && !notApplicable && (
          <div className="rounded-card border border-line bg-white p-3 text-sm">
            {reviewConfirmed ? (
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">✓ Reviewed — you've confirmed {config.title} is complete.</span>
                <button onClick={() => handleReviewConfirm(false)} className="text-xs text-trust hover:underline">
                  Still adding more? Mark as in progress
                </button>
              </p>
            ) : (
              <p className="flex flex-wrap items-center gap-2">
                <span className="text-muted">
                  This section counts as still in progress until you confirm it's complete — that affects your Financial
                  Health Score confidence.
                </span>
                <button
                  onClick={() => handleReviewConfirm(true)}
                  className="rounded-full bg-primary px-4 py-1.5 text-xs font-medium text-white hover:opacity-90"
                >
                  I've added everything relevant to me
                </button>
              </p>
            )}
          </div>
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
                      disabled={isIiPublished(row)}
                      title={isIiPublished(row) ? 'Imported via Investment Intelligence — use Unpublish there to remove it from net worth.' : undefined}
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
                    {isIiPublished(row) && (
                      <div className="mt-1">
                        <span className="inline-block rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">Imported via Investment Intelligence</span>
                        <a href="/investment-intelligence" className="ml-2 text-[11px] text-blue-600 hover:underline">
                          Review
                        </a>
                      </div>
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
                      disabled={!row.included || isIiPublished(row)}
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
                  {config.fields.map((f) => (
                    <td key={f.name} className="px-3 py-2">
                      {f.type === 'checkbox' ? (
                        <input
                          type="checkbox"
                          checked={Boolean(row[f.name] ?? false)}
                          disabled={!row.included || isFieldLockedForRow(row, f.name)}
                          onChange={(e) => handleFieldChange(row.key, f.name, e.target.checked)}
                        />
                      ) : f.type === 'select' ? (
                        <select
                          value={String(row[f.name] ?? '')}
                          disabled={!row.included || isFieldLockedForRow(row, f.name)}
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
                          disabled={!row.included || isFieldLockedForRow(row, f.name)}
                          onChange={(e) =>
                            handleFieldChange(row.key, f.name, f.type === 'number' ? Number(e.target.value) : e.target.value)
                          }
                          className="w-28 rounded border px-2 py-1 disabled:bg-gray-50"
                        />
                      )}
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <select
                      value={row.currency_code}
                      disabled={!row.included || isIiPublished(row)}
                      onChange={(e) => handleFieldChange(row.key, 'currency_code', e.target.value)}
                      className="w-20 rounded border px-2 py-1 disabled:bg-gray-50"
                    >
                      <option value="AUD">AUD</option>
                      <option value="INR">INR</option>
                    </select>
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
                  {config.fields.map((f) => (
                    <div key={f.name}>
                      <label className="block text-xs text-muted">{f.label}</label>
                      {f.type === 'checkbox' ? (
                        <input
                          type="checkbox"
                          checked={Boolean(row[f.name] ?? false)}
                          onChange={(e) => handleFieldChange(row.key, f.name, e.target.checked)}
                        />
                      ) : f.type === 'select' ? (
                        <select
                          value={String(row[f.name] ?? '')}
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
                          onChange={(e) =>
                            handleFieldChange(row.key, f.name, f.type === 'number' ? Number(e.target.value) : e.target.value)
                          }
                          className="w-full rounded border px-2 py-1"
                        />
                      )}
                    </div>
                  ))}
                  <div>
                    <label className="block text-xs text-muted">Currency</label>
                    <select
                      value={row.currency_code}
                      onChange={(e) => handleFieldChange(row.key, 'currency_code', e.target.value)}
                      className="w-full rounded border px-2 py-1"
                    >
                      <option value="AUD">AUD</option>
                      <option value="INR">INR</option>
                    </select>
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
