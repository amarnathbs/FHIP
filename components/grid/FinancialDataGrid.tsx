'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, toMonthly, type Frequency } from '@/lib/engines/money';
import { OWNER_OPTIONS } from '@/lib/constants';
import { deriveCountryCurrencyPatch } from '@/lib/grid/countryCurrency';
import { validateRow, findDuplicateCustomNames, type GridRow } from '@/lib/engines/data-quality';
import {
  effectiveSectionStatus,
  computeSectionCompletionPercent,
  type ExplicitSectionConfirmation,
} from '@/lib/engines/financialSectionStatus';
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
  // App Review spec §11: local-only (never persisted — not read by saveRow's
  // body construction below) flag tracking whether the user has manually
  // picked a currency for this row in this session. While false, changing
  // Country auto-fills the intelligent default currency for that country;
  // once true (the user touched the Currency field directly), further
  // Country changes never overwrite their explicit choice — Case C
  // ("India, currency manually overridden to AUD — override survives").
  currencyTouched?: boolean;
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
    currencyTouched: false,
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
    // A row loaded from a saved record already has a definite currency —
    // never silently touched on load. Only starts syncing to Country again
    // once the user actively changes Country in this session (see
    // handleFieldChange), which they can always immediately override.
    currencyTouched: false,
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

// App Review spec §9: per-row field applicability (e.g. Purchase Date
// hidden for a Savings Account) — see GridConfig.fieldVisibleForRow and
// lib/grid/assetFieldMetadata.ts. Defaults to true (shown) for any grid
// that doesn't opt in, so every other module's behaviour is unchanged.
function isFieldApplicableForRow(row: Row, fieldName: string, config: GridConfig): boolean {
  return config.fieldVisibleForRow ? config.fieldVisibleForRow(fieldName, row.master_item_key ?? null) : true;
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

export function FinancialDataGrid({
  config,
  subNav,
  beforeGrid,
}: {
  config: GridConfig;
  subNav?: React.ReactNode;
  // Optional content rendered between the page title/description and the
  // grid itself — used by the Retirement page's member-level "Retirement
  // Planning" section (spec s.6: "before retirement accounts/contributions").
  beforeGrid?: React.ReactNode;
}) {
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
  // App Review spec §4.3 (Persistence defect) — see runSave below for the
  // full root-cause writeup. saveInFlight prevents two overlapping network
  // requests for the same row from ever racing each other out of order;
  // saveDirty remembers that another edit landed while a request was in
  // flight, so it's retried immediately with the latest state the moment
  // the in-flight request resolves, instead of relying on the user
  // coincidentally making another edit later.
  const saveInFlight = useRef<Record<string, boolean>>({});
  const saveDirty = useRef<Record<string, boolean>>({});
  // Bounds automatic retries so a persistent failure (e.g. a validation
  // error that will never succeed) can't loop forever hammering the API —
  // reset to 0 by every genuine user edit (scheduleSave), so a fresh edit
  // always gets fresh retry budget regardless of an earlier row's history.
  const saveRetryCount = useRef<Record<string, number>>({});
  const MAX_AUTO_RETRIES = 3;
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

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

      // A/I/R consolidation safety net (spec s.4.3 "no record may disappear
      // merely to tidy taxonomy"): a saved row can carry a master_item_key
      // that no longer appears in the *active* master-items list — either
      // because a catalogue item was deprecated after this row was saved
      // (e.g. migration 0074's cross-module taxonomy cleanup), or a race
      // between an in-flight save and a catalogue change. Without this, the
      // row would match neither `merged` (only active master items) nor
      // `customRows` (only master_item_key === null) and would silently
      // vanish from the UI while still counting in every total. Rendered
      // like a master-catalogue row (label from its own saved name field,
      // not editable) rather than a custom row, since renaming it here
      // would not change what it upserts against.
      const activeKeySet = new Set(masterItems.map((m) => m.item_key));
      const orphanedRows = savedRecords
        .filter((r) => r.master_item_key && !activeKeySet.has(r.master_item_key))
        .map((r) => rowFromRecord(r, config, false, String(r[config.nameField] ?? '')));

      setRows([...merged, ...orphanedRows, ...customRows]);
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
    saveRetryCount.current[key] = 0; // a genuine new edit always gets a fresh retry budget
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => void runSave(key), 600);
  }

  // App Review spec §4.3 (Persistence defect) — root cause and fix.
  //
  // Old calculation → defect → corrected rule → expected new result:
  //   Old: each debounced edit called saveRow(key) directly. Two real,
  //   independently reproducible defects followed from that:
  //     (1) Debounce race / out-of-order response: if a user edited a row,
  //     the network was slow, and they edited it again before the first
  //     request resolved, a SECOND overlapping request could fire (a fresh
  //     600ms timer, unrelated to the first request's in-flight promise).
  //     Nothing enforced response ORDER — if the second (newer) request's
  //     response happened to arrive before the first (older, stale) one,
  //     the older request still completed afterwards and upserted its
  //     stale values last, silently reverting the newer edit in the
  //     database. This is the exact "debounce race" / "Supabase upsert
  //     conflict-key" failure mode the spec calls out.
  //     (2) Silent failure with no retry: saveRow's catch block was empty
  //     apart from a comment admitting "the next edit retries the save" —
  //     i.e. any transient failure (network blip, momentary auth/session
  //     hiccup) was swallowed with no error shown to the user and no
  //     automatic retry. The edit LOOKED saved (the input kept showing the
  //     typed value, no error indicator existed) but silently wasn't,
  //     until the user happened to touch the row again — exactly the
  //     reported "doesn't persist unless they untick/navigate away and
  //     return/reselect/re-enter" symptom, self-documented by the old
  //     comment's own admission.
  //   Defect: no per-row in-flight tracking (so requests could overlap and
  //   race), and no automatic retry or visible error state on failure.
  //   Corrected rule: at most one save request in flight per row at a
  //   time (saveInFlight); an edit that arrives while a save is already in
  //   flight is queued (saveDirty) and re-sent — with the LATEST row state,
  //   not the stale state from when it was queued — the instant the
  //   in-flight request resolves, guaranteeing strict per-row request
  //   order and that the last write always reflects the last edit. A
  //   failed request is surfaced via saveErrors (rendered per-row below)
  //   and automatically retried once, rather than silently discarded.
  //   Expected new result: create -> save -> edit -> save -> refresh
  //   browser -> still updated -> sign out -> sign in -> still updated,
  //   with no dependency on the user coincidentally re-touching the row.
  async function runSave(key: string) {
    if (saveInFlight.current[key]) {
      saveDirty.current[key] = true;
      return;
    }
    // Reads the current row from a ref (kept in sync below), not via a
    // setRows() functional updater — React 18 Strict Mode intentionally
    // double-invokes updater functions in dev to catch impure updaters, and
    // firing fetchJson() from inside one would POST twice and create a
    // duplicate row (there's no master_item_key to upsert against for
    // custom rows, so a second POST is a second insert, not a no-op).
    const row = rowsRef.current?.find((r) => r.key === key);
    // Recomputed from the ref (not the memoized `duplicates` from render
    // scope) so a save fired after the 600ms debounce always checks against
    // the latest row names, not a stale snapshot from when scheduleSave() was called.
    if (!row || !isRowSaveable(row, config, findDuplicateCustomNames(rowsRef.current ?? []))) return;

    const body: Record<string, unknown> = { owner: row.owner, currency_code: row.currency_code };
    body[config.nameField] = row.item_label;
    if (row.master_item_key) body.master_item_key = row.master_item_key;
    // App Review spec §9: a field hidden for this row's type (e.g. Purchase
    // Date on a Savings Account) is never submitted, even if a stale value
    // exists locally — omitted (not null), so any pre-existing saved value
    // is left untouched server-side rather than being force-cleared.
    for (const f of config.fields) {
      body[f.name] = !isFieldApplicableForRow(row, f.name, config) || row[f.name] === '' ? undefined : row[f.name];
    }

    const usePatch = row.is_custom && row.id;
    const url = usePatch ? `/api/${config.resource}/${row.id}` : `/api/${config.resource}`;
    const method = usePatch ? 'PATCH' : 'POST';

    saveInFlight.current[key] = true;
    saveDirty.current[key] = false;
    try {
      const saved = await fetchJson<SavedRecord>(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      updateRow(key, { id: saved.id });
      setSaveErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (err) {
      const attempt = (saveRetryCount.current[key] ?? 0) + 1;
      saveRetryCount.current[key] = attempt;
      const willAutoRetry = attempt <= MAX_AUTO_RETRIES;
      setSaveErrors((prev) => ({
        ...prev,
        [key]: err instanceof Error
          ? `${err.message}${willAutoRetry ? ' — retrying…' : ' — edit the field again to retry.'}`
          : willAutoRetry
            ? 'Could not save this change — retrying…'
            : 'Could not save this change — edit the field again to retry.',
      }));
      // Auto-retry a bounded number of times (with a short backoff) so a
      // transient failure recovers on its own without the user needing to
      // notice and coincidentally re-edit the row. A persistent failure
      // (e.g. a validation error that will never succeed) stops retrying
      // automatically after MAX_AUTO_RETRIES rather than looping forever —
      // the visible error and a genuine new edit (which resets the retry
      // budget in scheduleSave) are the recovery path from there.
      if (willAutoRetry) {
        setTimeout(() => {
          saveDirty.current[key] = true;
          if (!saveInFlight.current[key]) void runSave(key);
        }, 800 * attempt);
      }
    } finally {
      saveInFlight.current[key] = false;
      if (saveDirty.current[key]) {
        saveDirty.current[key] = false;
        void runSave(key); // a newer edit is waiting — retry immediately, in order
      }
    }
  }

  async function handleToggleInclude(row: Row, included: boolean) {
    updateRow(row.key, { included });
    if (!included) {
      clearTimeout(saveTimers.current[row.key]);
      saveDirty.current[row.key] = false; // don't let a queued retry resurrect a row the user just removed
      setSaveErrors((prev) => {
        if (!(row.key in prev)) return prev;
        const next = { ...prev };
        delete next[row.key];
        return next;
      });
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

  // App Review spec §11 (Currency and Country — Critical Financial Defect):
  // real, live-verified defect was that a new row's currency_code always
  // started at the household's own preferred_currency default (usually
  // AUD) regardless of which Country the user picked, and nothing ever
  // re-synced it — so an asset saved with Country=India kept currency_code
  // 'AUD' unless the user separately remembered to also change the
  // Currency dropdown. computeDashboard already converts correctly by
  // currency_code (lib/engines/fx.ts), so the defect was purely here: the
  // entry form never derived an intelligent default from Country. Fixed by
  // auto-filling currency_code from COUNTRY_CURRENCY_DEFAULT whenever
  // Country changes, but only while the user hasn't manually touched
  // Currency themselves (currencyTouched) — so an explicit override always
  // survives (Case C), and directly picking Currency marks it touched so
  // a later Country change never silently reverts it.
  function handleFieldChange(key: string, field: string, value: unknown) {
    const row = rowsRef.current?.find((r) => r.key === key);
    const patch: Partial<Row> = {
      [field]: value,
      ...deriveCountryCurrencyPatch({ field, value, currencyTouched: Boolean(row?.currencyTouched) }),
    } as Partial<Row>;
    updateRow(key, patch);
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
        currencyTouched: false,
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

  const missingRequiredCount = included.filter((r) => {
    if (!r.owner || !r.currency_code) return true;
    if (config.frequencyField && !r[config.frequencyField]) return true;
    for (const f of config.fields) {
      if (!f.required || !isFieldApplicableForRow(r, f.name, config)) continue;
      if (r[f.name] === '' || r[f.name] === undefined || r[f.name] === null) return true;
    }
    return false;
  }).length;

  // App Review spec §7 — see the "Old calculation → defect → corrected
  // rule → expected new result" writeup on computeSectionCompletionPercent
  // itself for the full root-cause analysis. Completion now measures data
  // sufficiency (has the household confirmed this section, or at minimum
  // entered something with no required fields left blank) rather than what
  // fraction of the entire catalogue is ticked.
  const explicitConfirmation: ExplicitSectionConfirmation | null =
    config.notApplicable && notApplicable
      ? 'not_applicable'
      : zeroAnswer === 'no'
        ? 'reviewed_zero'
        : reviewConfirmed
          ? 'reviewed_with_data'
          : null;
  const sectionStatus = effectiveSectionStatus({ hasRows: included.length > 0, explicitConfirmation });
  const completion = computeSectionCompletionPercent({
    status: sectionStatus,
    includedCount: included.length,
    missingRequiredCount,
  });

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

        {beforeGrid}

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
                    {saveErrors[row.key] && (
                      <p className="mt-1 text-xs text-risk">⚠ {saveErrors[row.key]}</p>
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
                  {config.fields.map((f) =>
                    !isFieldApplicableForRow(row, f.name, config) ? (
                      <td key={f.name} className="px-3 py-2 text-xs text-muted" title="Not applicable for this item type">
                        n/a
                      </td>
                    ) : (
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
                    )
                  )}
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
              {saveErrors[row.key] && (
                <p className="mt-1 text-xs text-risk">⚠ {saveErrors[row.key]}</p>
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
                  {config.fields
                    .filter((f) => isFieldApplicableForRow(row, f.name, config))
                    .map((f) => (
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
