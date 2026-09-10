'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, toMonthly, type Frequency } from '@/lib/engines/money';
import { OWNER_OPTIONS, expectedCurrencyForCountry } from '@/lib/constants';
import { validateRow, findDuplicateCustomNames, type GridRow } from '@/lib/engines/data-quality';
import { currencyMismatch, currencyMismatchBlocked } from '@/lib/validation/currencyCountry';
import {
  effectiveSectionStatus,
  computeSectionCompletionPercent,
  type ExplicitSectionConfirmation,
} from '@/lib/engines/financialSectionStatus';
import type { GridConfig } from '@/lib/grid/types';
import { PropertyFinancingControl } from '@/components/property-liability/PropertyFinancingControl';
import { isPropertyEligibleForLinking, isLiabilityEligibleForLinking } from '@/lib/validation/propertyLiabilityLink';
import { GoalLinkControl } from '@/components/investments/GoalLinkControl';
import type { ModuleKey } from '@/lib/services/appCapability';
import { useModuleWriteAvailability } from '@/lib/nav/useModuleWriteAvailability';
import { LockedFeatureCard } from '@/components/ui/LockedFeatureCard';

interface MasterItem {
  item_key: string;
  item_label: string;
  sort_order: number;
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
  // App Review spec §11: explicit, user-set carve-out for a genuinely
  // foreign-currency holding — see currencyMismatch()/currencyMismatchBlocked()
  // below. Never silently defaulted true except for the 'foreign_currency'
  // catalogue item, which is inherently cross-currency by design.
  currency_override?: boolean;
  country_code?: string;
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
    // 'foreign_currency' is inherently a deliberate cross-currency holding
    // (Assets catalogue) — default its override on so it isn't silently
    // hard-blocked before the user ever touches country/currency.
    currency_override: item.item_key === 'foreign_currency',
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
    currency_override: Boolean(record.currency_override),
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

// App Review tier-2 Fix 4: per-row field applicability (e.g. Purchase Date
// hidden for a Savings Account) — see GridConfig.fieldVisibleForRow and
// lib/grid/assetFieldMetadata.ts. Defaults to true (shown) for any grid
// that doesn't opt in, so every other module's behaviour is unchanged.
function isFieldApplicableForRow(row: Row, fieldName: string, config: GridConfig): boolean {
  return config.fieldVisibleForRow ? config.fieldVisibleForRow(fieldName, row.master_item_key ?? null) : true;
}

// Property <-> Liability Linking (spec s.14-18, s.56-59): whether this
// specific saved row should show the Financing / Related Property control
// at all. Requires a saved row (id, not a not-yet-persisted draft) that is
// currently included, and -- for catalogue rows -- a plausible property or
// non-consumer liability type (spec s.13-14: offered without hard-blocking
// legitimate exceptions; custom rows are always eligible).
function showsPropertyLinkControl(config: GridConfig, row: Row): boolean {
  if (!config.propertyLinkSide || !row.id || !row.included) return false;
  if (config.propertyLinkSide === 'property') {
    return isPropertyEligibleForLinking(config.category === 'asset' ? 'asset' : 'investment', row.master_item_key ?? null);
  }
  return isLiabilityEligibleForLinking(row.master_item_key ?? null);
}

function isRowSaveable(row: Row, config: GridConfig, duplicates: Set<string>): boolean {
  if (config.frequencyField && !row[config.frequencyField]) return false;
  if (!row.currency_code) return false;
  if (row.is_custom && duplicates.has(row.item_label.trim().toLowerCase())) return false;
  // App Review spec §11 (Currency/Country hard block): a genuine, unconfirmed
  // country/currency mismatch blocks save entirely client-side, before any
  // network call — the server-side Zod refine (lib/validation/*.ts) backs
  // this up independently for every write path.
  if (currencyMismatchBlocked(row)) return false;
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

// LR-2 (2026-09-07): singular item labels for the Add/Edit form's heading
// and the "+ Add ..." button, keyed by category rather than naively
// stripping a trailing "s" off config.title (found live: that broke on
// "Liabilities" -> "Liabilitie"). Income/Insurance stay as their own mass
// noun ("Add Income", not "Add Incom"); Investment/Retirement use a plain
// "an item" since neither reads naturally as "Add Investment"/"Add
// Retirement" for a single holding.
const SINGULAR_ITEM_LABEL: Record<GridConfig['category'], string> = {
  income: 'Income',
  expense: 'Expense',
  asset: 'Asset',
  liability: 'Liability',
  investment: 'an item',
  retirement: 'an item',
  insurance: 'an item',
};

// LR-2 (2026-09-07): the shared grid's interaction model changed from
// "every catalogue item is always an inline-editable table row" to a
// form-first pattern: status/confirmation controls -> Add action -> one
// manual Add/Edit form -> saved records listed read-only below -> clicking
// a saved record loads it back into the form. This file keeps every
// existing business rule (race-safe save, currency/country hard-block,
// property/goal linking, II-published protection, SMSF exclusion, per-row
// field visibility, write-availability gating, section-status completion)
// completely unchanged — only the rendering/interaction layer changed, and
// the component's public props are identical, so no page that renders
// <FinancialDataGrid ... /> needed to change.
export function FinancialDataGrid({
  config,
  subNav,
  beforeGrid,
  moduleKey,
}: {
  config: GridConfig;
  subNav?: React.ReactNode;
  // Optional content rendered between the page title/description and the
  // grid itself — used by the Retirement page's member-level "Retirement
  // Planning" section (spec s.6: "before retirement accounts/contributions").
  beforeGrid?: React.ReactNode;
  // G4 closure item 2 (Product Owner, 2026-09-05): which capability module
  // this grid instance belongs to, so it can ask whether a live create/edit
  // control is safe to show right now (useModuleWriteAvailability()).
  moduleKey: ModuleKey;
}) {
  const { available: writeAvailable, resolved: writeResolved, deleteAvailable } = useModuleWriteAvailability(moduleKey);
  const writeUnavailable = writeResolved && !writeAvailable;
  // G5B Phase 2 (2026-09-06): CREATE/UPDATE and DELETE can now genuinely
  // diverge for a GENERIC caller — see appCapability.ts's
  // OPERATIONS_G5B_WRITE_CERTIFIED comment. `removeUnavailable` gates ONLY
  // the Remove action in the saved-records list below.
  const removeUnavailable = writeResolved && !deleteAvailable;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [search, setSearch] = useState('');
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
  const rowsRef = useRef<Row[] | null>(null);
  rowsRef.current = rows;
  // App Review spec §4.3 (Persistence defect) — see saveRowNow below. Kept
  // from the pre-LR-2 grid's race-safety discipline, adapted for the new
  // explicit-Save model: saveInFlight is a defensive guard against a
  // reentrant call for the same row (the form's Save button is itself
  // disabled while `saving` is true, so this should never actually trigger
  // in practice — it exists so a future caller can't accidentally
  // reintroduce the double-submit race the old per-keystroke autosave once
  // had). A failed save auto-retries a bounded number of times rather than
  // being silently dropped (AC-06 — exactly-once writes, not zero writes).
  const saveInFlight = useRef<Record<string, boolean>>({});
  const saveRetryCount = useRef<Record<string, number>>({});
  const MAX_AUTO_RETRIES = 3;
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  // --- Form-first state (LR-2) -------------------------------------------
  // `draft` holds the row currently being composed/edited in the top form.
  // It is intentionally NOT part of `rows` until Save succeeds — Cancel
  // simply discards it (NEG-03: cancel retains stale values), and nothing
  // downstream (totals, saved-record list, other modules) ever sees an
  // uncommitted draft.
  const [formOpen, setFormOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null); // null while adding a brand-new item
  const [draft, setDraft] = useState<Row | null>(null);
  const [pickedKey, setPickedKey] = useState<string>(''); // '' = nothing picked yet, 'custom' = custom item, else a catalogue row's key
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // LR-7 WP-03 — owner values this household's country doesn't support
  // (config.restrictedOwnerValues), computed once the profile loads below.
  // Empty for every grid that doesn't declare a restriction (every grid but
  // Insurance today) — zero behaviour change for them.
  const [hiddenOwnerValues, setHiddenOwnerValues] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [rawMasterItems, rawSavedRecords, profile, sectionStatusRows] = await Promise.all([
        fetchJson<MasterItem[]>(`/api/master-items?category=${config.category}`),
        fetchJson<SavedRecord[]>(`/api/${config.resource}`),
        fetchJson<{
          preferred_currency: 'AUD' | 'INR' | null;
          not_applicable_investments?: boolean;
          not_applicable_retirement?: boolean;
          not_applicable_insurance?: boolean;
          country_of_residence?: 'AU' | 'IN' | null;
        }>('/api/user/profile').catch(() => null),
        config.reviewSection
          ? fetchJson<{ section: string; status: string }[]>('/api/user/section-status').catch(() => [])
          : Promise.resolve([]),
      ]);
      if (cancelled) return;
      const currency = profile?.preferred_currency ?? 'AUD';
      setDefaultCurrency(currency);

      // LR-7 WP-03 — see GridConfig.restrictedOwnerValues' own doc comment.
      // A household whose country isn't yet known/confirmed keeps every
      // owner value available (fail-open on ambiguity, not fail-closed on
      // an already-existing selection) rather than guessing.
      if (config.restrictedOwnerValues?.length) {
        const householdCountry = profile?.country_of_residence ?? null;
        const hidden = new Set(
          config.restrictedOwnerValues
            .filter((r) => householdCountry !== null && r.requiredCountry !== householdCountry)
            .map((r) => r.value)
        );
        setHiddenOwnerValues(hidden);
      }

      // SMSF-UI: strip out any master_item_key this grid must never edit
      // directly (see GridConfig.excludeMasterItemKeys comment) from both
      // the catalogue list and the saved records BEFORE any of the
      // completion/zero-confirmation/merge logic below runs, so an excluded
      // item is fully invisible to this grid rather than merely
      // uneditable — it still exists and still counts financially, just
      // through its own dedicated UI, not here.
      const excludedKeys = new Set(config.excludeMasterItemKeys ?? []);
      const masterItems = excludedKeys.size
        ? rawMasterItems.filter((m) => !excludedKeys.has(m.item_key))
        : rawMasterItems;
      const savedRecords = excludedKeys.size
        ? rawSavedRecords.filter((r) => !r.master_item_key || !excludedKeys.has(r.master_item_key))
        : rawSavedRecords;
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

  // Race-safe save for a single, fully-formed row — reused by the form's
  // explicit Save button. Takes the row directly (rather than looking it up
  // from `rows`/`rowsRef`) so it never depends on a render having completed
  // between committing the draft and saving it.
  async function saveRowNow(row: Row): Promise<{ ok: true; saved: SavedRecord } | { ok: false; error: string }> {
    const key = row.key;
    if (saveInFlight.current[key]) {
      // Defensive only — see the comment on saveInFlight above. Refuses the
      // reentrant call rather than silently dropping or misordering it.
      return { ok: false, error: 'A save for this item is already in progress.' };
    }

    const body: Record<string, unknown> = { owner: row.owner, currency_code: row.currency_code };
    // Only ever included when true. currency_override is a real DB column
    // only once its migration is applied — omitting the key entirely for
    // the (overwhelmingly common) non-override case means an ordinary save
    // never touches that column at all, so it keeps working unchanged
    // whether or not the migration has landed yet (see lib/validation/
    // asset.ts's matching comment on the schema side).
    if (row.currency_override) body.currency_override = true;
    body[config.nameField] = row.item_label;
    if (row.master_item_key) body.master_item_key = row.master_item_key;
    // App Review tier-2 Fix 4: a field hidden for this row's type (e.g.
    // Purchase Date on a Savings Account) is never submitted, even if a
    // stale value exists locally — omitted (not null), so any pre-existing
    // saved value is left untouched server-side rather than force-cleared.
    //
    // LR-5/LR-6 SMSF certification (2026-09-10) — CRITICAL FIX: every
    // optional field here (interest_rate, credit_limit, lender, notes,
    // country_code, ...) is declared `.optional()` in every register's Zod
    // schema, which accepts the key being ABSENT but never accepts an
    // explicit `null` (Zod's own `invalid_type` rejection: "expected
    // number, received null"). A row's client-side `''` (from
    // fieldDefaults() on a brand-new draft) correctly hit the `=== ''`
    // branch below and got omitted — but a row hydrated from a real GET
    // response has a genuine SQL NULL for the same unset column, which
    // deserializes to JS `null`, not `''`, and was passed straight through
    // unchanged. Net effect: editing ANY row with ANY blank optional field
    // worked once, immediately after creating it in the same session, but
    // permanently failed with this exact Zod dump the moment the page was
    // reloaded and the row was re-edited from its real server
    // representation — reproduced live across every register (Liabilities,
    // and by the same code path every other register sharing this
    // component). `== null` (loose, deliberate) catches both `null` and
    // `undefined` without touching `0`, `false`, or `''` (already handled).
    for (const f of config.fields) {
      body[f.name] =
        !isFieldApplicableForRow(row, f.name, config) || row[f.name] === '' || row[f.name] == null ? undefined : row[f.name];
    }

    const usePatch = row.is_custom && row.id;
    const url = usePatch ? `/api/${config.resource}/${row.id}` : `/api/${config.resource}`;
    const method = usePatch ? 'PATCH' : 'POST';

    saveInFlight.current[key] = true;
    try {
      const saved = await fetchJson<SavedRecord>(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      saveRetryCount.current[key] = 0;
      setSaveErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      applySavedRow(row, saved);
      return { ok: true, saved };
    } catch (err) {
      const attempt = (saveRetryCount.current[key] ?? 0) + 1;
      saveRetryCount.current[key] = attempt;
      const willAutoRetry = attempt <= MAX_AUTO_RETRIES;
      const message =
        err instanceof Error
          ? `${err.message}${willAutoRetry ? ' — retrying…' : ' — try Save again.'}`
          : willAutoRetry
            ? 'Could not save this change — retrying…'
            : 'Could not save this change — try Save again.';
      setSaveErrors((prev) => ({ ...prev, [key]: message }));
      if (willAutoRetry) {
        // A transient failure (network blip) retries on its own with the
        // SAME row that failed, rather than being silently dropped — the
        // caller (handleFormSave) has already returned by this point, so a
        // retry that later succeeds must independently reconcile `rows`
        // and the form (applySavedRow below), not rely on the original
        // caller still being around to do it.
        setTimeout(() => {
          if (!saveInFlight.current[key]) void saveRowNow(row);
        }, 800 * attempt);
      }
      return { ok: false, error: message };
    } finally {
      saveInFlight.current[key] = false;
    }
  }

  // Reconciles a successful save into `rows`, and — if the form is still
  // open on this exact row (true for the normal explicit-Save path; also
  // reachable from a background auto-retry that succeeds after the
  // original call already returned) — closes it. Never touches `rows` for
  // a row the user has since navigated away from or already removed.
  function applySavedRow(row: Row, saved: SavedRecord) {
    const finalRow: Row = { ...row, id: saved.id || row.id };
    setRows((prev) => {
      if (!prev) return [finalRow];
      const exists = prev.some((r) => r.key === finalRow.key);
      return exists ? prev.map((r) => (r.key === finalRow.key ? finalRow : r)) : [...prev, finalRow];
    });
    setDraft((prevDraft) => {
      if (prevDraft?.key !== finalRow.key) return prevDraft;
      closeForm();
      return null;
    });
  }

  async function handleToggleInclude(row: Row, included: boolean) {
    updateRow(row.key, { included });
    if (!included) {
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

  function updateRow(key: string, patch: Partial<Row>) {
    setRows((prev) => (prev ? prev.map((r) => (r.key === key ? { ...r, ...patch } : r)) : prev));
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

  // --- Form-first handlers (LR-2) -----------------------------------------

  function closeForm() {
    setFormOpen(false);
    setEditingKey(null);
    setDraft(null);
    setPickedKey('');
    setFormError(null);
  }

  // NEG-01/blank row reappearing has no equivalent in the new model — a
  // catalogue item only ever shows editable fields once explicitly picked
  // in the Add form, never as an always-visible blank row.
  function openAddForm() {
    closeForm();
    setFormOpen(true);
  }

  // NEG-02 (edit creates duplicate instead of update): editing always
  // reuses the row's own existing key/id — the same POST-upsert-by-
  // master_item_key or PATCH-by-id routing in saveRowNow that already
  // applied before LR-2, never a fresh insert.
  // NEG-05 (owner reset on edit): the draft is a full copy of the existing
  // row (`{ ...row }`), so owner/every other field starts exactly as saved.
  function openEditForm(row: Row) {
    setFormOpen(true);
    setEditingKey(row.key);
    setPickedKey(row.is_custom ? 'custom' : row.key);
    setDraft({ ...row, included: true });
    setFormError(null);
  }

  // NEG-03 (cancel retains stale values): `draft` is never written into
  // `rows` until Save succeeds, so discarding it here is a true cancel —
  // nothing was ever visible to totals, the saved list, or another module.
  function handleFormCancel() {
    closeForm();
  }

  function handlePickCatalogItem(key: string) {
    setPickedKey(key);
    setFormError(null);
    if (key === 'custom') {
      customRowCounter += 1;
      setDraft({
        key: `custom-new-${customRowCounter}`,
        id: null,
        master_item_key: null,
        is_custom: true,
        item_label: '',
        included: true,
        owner: 'self',
        currency_code: defaultCurrency,
        currency_override: false,
        expanded: true,
        ...fieldDefaults(config),
      });
    } else if (key) {
      const catalogRow = (rows ?? []).find((r) => r.key === key);
      setDraft(catalogRow ? { ...catalogRow, included: true } : null);
    } else {
      setDraft(null);
    }
  }

  // App Review spec §11 (Currency and Country — Critical Financial Defect):
  // Country is the source of truth for currency, not the other way around —
  // auto-set currency to the new country's expected currency every time
  // Country changes, and reset any standing override rather than silently
  // carrying a stale one across countries.
  function updateDraftField(field: string, value: unknown) {
    setDraft((prev) => {
      if (!prev) return prev;
      const patch: Partial<Row> = { [field]: value } as Partial<Row>;
      if (field === 'country_code') {
        const expected = expectedCurrencyForCountry(value as string);
        patch.currency_override = false;
        if (expected) patch.currency_code = expected;
      }
      return { ...prev, ...patch };
    });
  }

  // NEG-04 (frequency annualised twice): the form writes `draft[frequencyField]`
  // exactly once per change and the saved value is read back verbatim on
  // reload/edit — nothing in this file multiplies or re-derives an annual
  // figure from an already-annualised one; toMonthly()/annualisation only
  // ever happens once, in the read-only totals footer below.
  async function handleFormSave() {
    if (!draft) return;
    const otherRows = (rows ?? []).filter((r) => r.key !== draft.key);
    const dupCheck = findDuplicateCustomNames([...otherRows, draft]);
    if (draft.is_custom && !draft.item_label.trim()) {
      setFormError('Enter a name for this item.');
      return;
    }
    if (!isRowSaveable(draft, config, dupCheck)) {
      setFormError(
        dupCheck.has(draft.item_label.trim().toLowerCase())
          ? 'This name is already used for another item — choose a different name.'
          : currencyMismatchBlocked(draft)
            ? `Doesn't match the expected currency for this country — fix it or confirm it's intentionally different.`
            : 'Fill in the required fields before saving.'
      );
      return;
    }
    setSaving(true);
    setFormError(null);
    const result = await saveRowNow(draft);
    setSaving(false);
    // On success, saveRowNow's own applySavedRow() has already updated
    // `rows` and closed the form. On failure the error is already surfaced
    // via saveErrors and the form stays open with the draft intact.
    void result;
  }

  async function handleRemove(row: Row) {
    await handleToggleInclude(row, false);
  }

  const included = useMemo(() => (rows ?? []).filter((r) => r.included), [rows]);
  const visibleIncluded = useMemo(
    () => included.filter((r) => !search || r.item_label.toLowerCase().includes(search.toLowerCase())),
    [included, search]
  );
  // Catalogue items not yet added — the Add form's picker choices.
  const availableCatalogItems = useMemo(() => (rows ?? []).filter((r) => !r.is_custom && !r.included), [rows]);

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
    return false;
  }).length;

  // App Review spec §7 — see the "Old calculation → defect → corrected
  // rule → expected new result" writeup on computeSectionCompletionPercent
  // itself (lib/engines/financialSectionStatus.ts) for the full root-cause
  // analysis. Completion measures data sufficiency (has the household
  // confirmed this section, or at minimum entered something with no
  // required fields left blank), not catalogue coverage.
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

  const warningsByRow = new Map<string, string[]>();
  for (const r of included) {
    const warnings = validateRow(config.category, r, config.valueField);
    if (warnings.length) warningsByRow.set(r.key, warnings);
  }
  const totalWarnings = Array.from(warningsByRow.values()).reduce((s, w) => s + w.length, 0);

  // Live validation for the row currently open in the form.
  const draftDuplicateNames = draft
    ? findDuplicateCustomNames([...(rows ?? []).filter((r) => r.key !== draft.key), draft])
    : new Set<string>();
  const draftHasDuplicateName = Boolean(draft?.is_custom && draftDuplicateNames.has(draft.item_label.trim().toLowerCase()));
  const draftCurrencyMismatch = draft ? currencyMismatch(draft) : false;
  const draftCurrencyMismatchBlocked = draft ? currencyMismatchBlocked(draft) : false;
  const draftWarnings = draft ? validateRow(config.category, draft, config.valueField) : [];

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

        {writeUnavailable && (
          <LockedFeatureCard
            title="Adding and editing isn't available for your country yet"
            description="You can view this module, but data capture here hasn't been independently certified safe for your country yet — that's the next capability phase, not an error. The fields below are read-only until then."
          />
        )}

        {/* G4 closure item 2: everything below that can create, edit or
            delete a row is wrapped in a single native <fieldset disabled>
            — a genuine HTML mechanism, not a CSS effect. Read-only display
            (the status text, the saved-records list itself) stays outside
            it so a write-unavailable user can still see their own data. */}
        <fieldset disabled={writeUnavailable} className="contents border-0 p-0 m-0">
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
                  {`This excludes ${config.title} from your Financial Health Score instead of counting it as missing data.`}
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
                  <span className="font-medium text-ink">{`✓ Reviewed — you've confirmed ${config.title} is complete.`}</span>
                  <button onClick={() => handleReviewConfirm(false)} className="text-xs text-trust hover:underline">
                    Still adding more? Mark as in progress
                  </button>
                </p>
              ) : (
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-muted">
                    This section counts as still in progress until you confirm it&apos;s complete — that affects your Financial
                    Health Score confidence.
                  </span>
                  <button
                    onClick={() => handleReviewConfirm(true)}
                    className="rounded-full bg-primary px-4 py-1.5 text-xs font-medium text-white hover:opacity-90"
                  >
                    I&apos;ve added everything relevant to me
                  </button>
                </p>
              )}
            </div>
          )}

          {/* Add action — opens the form below. No "Import" CTA: WP-01
              discovery confirmed no real import backend exists for any of
              these 7 modules today (NEG-07: never point a button at a
              nonexistent route), so none is shown until one genuinely does. */}
          {!formOpen && (
            <button
              onClick={openAddForm}
              className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              {`+ Add ${SINGULAR_ITEM_LABEL[config.category]}`}
            </button>
          )}

          {/* --- The manual Add/Edit form --------------------------------- */}
          {formOpen && (
            <div className="rounded-card border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">
                {editingKey === null ? `Add ${SINGULAR_ITEM_LABEL[config.category]}` : `Edit ${draft?.item_label || SINGULAR_ITEM_LABEL[config.category]}`}
              </h2>

              {editingKey === null && (
                <div className="mt-3">
                  <label className="block text-xs text-muted">What are you adding?</label>
                  <select
                    value={pickedKey}
                    onChange={(e) => handlePickCatalogItem(e.target.value)}
                    className="mt-1 w-full max-w-sm rounded border px-3 py-2 text-sm sm:w-auto"
                    autoFocus
                  >
                    <option value="">Choose an item…</option>
                    {availableCatalogItems.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.item_label}
                      </option>
                    ))}
                    <option value="custom">Custom item…</option>
                  </select>
                </div>
              )}

              {draft && (
                <div className="mt-4 space-y-3">
                  {isIiPublished(draft) && (
                    <div className="rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800">
                      <span className="inline-block rounded-full bg-blue-100 px-2 py-0.5 font-medium text-blue-700">
                        Imported via Investment Intelligence
                      </span>{' '}
                      Some fields are locked here — use{' '}
                      <a href="/investment-intelligence/data" className="underline">
                        Unpublish
                      </a>{' '}
                      there to remove it from net worth.
                    </div>
                  )}

                  {draft.is_custom ? (
                    <div>
                      <label className="block text-xs text-muted">Name</label>
                      <input
                        type="text"
                        value={draft.item_label}
                        placeholder="Item name"
                        onChange={(e) => updateDraftField('item_label', e.target.value)}
                        className={`mt-1 w-full max-w-sm rounded border px-3 py-2 text-sm sm:w-auto ${draftHasDuplicateName ? 'border-risk' : ''}`}
                      />
                      {draftHasDuplicateName && (
                        <p className="mt-1 text-xs text-risk">This name is already used for another item — choose a different name.</p>
                      )}
                    </div>
                  ) : (
                    <div>
                      <label className="block text-xs text-muted">Item</label>
                      <p className="text-sm font-medium text-ink">{draft.item_label}</p>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs text-muted">Owner</label>
                    <select
                      value={draft.owner}
                      disabled={isIiPublished(draft)}
                      onChange={(e) => updateDraftField('owner', e.target.value)}
                      className="mt-1 w-full max-w-xs rounded border px-3 py-2 text-sm disabled:bg-gray-50"
                    >
                      {OWNER_OPTIONS.filter((o) => o.value === draft.owner || !hiddenOwnerValues.has(o.value)).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {config.fields
                    .filter((f) => isFieldApplicableForRow(draft, f.name, config))
                    .map((f) => (
                      <div key={f.name}>
                        <label className="block text-xs text-muted">
                          {f.label}
                          {f.required && <span className="text-risk"> *</span>}
                        </label>
                        {f.type === 'checkbox' ? (
                          <input
                            type="checkbox"
                            checked={Boolean(draft[f.name] ?? false)}
                            disabled={isFieldLockedForRow(draft, f.name)}
                            onChange={(e) => updateDraftField(f.name, e.target.checked)}
                            className="mt-1"
                          />
                        ) : f.type === 'select' ? (
                          <select
                            value={String(draft[f.name] ?? '')}
                            disabled={isFieldLockedForRow(draft, f.name)}
                            onChange={(e) => updateDraftField(f.name, e.target.value)}
                            className="mt-1 w-full max-w-xs rounded border px-3 py-2 text-sm disabled:bg-gray-50"
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
                            value={String(draft[f.name] ?? '')}
                            disabled={isFieldLockedForRow(draft, f.name)}
                            onChange={(e) => updateDraftField(f.name, f.type === 'number' ? Number(e.target.value) : e.target.value)}
                            className="mt-1 w-full max-w-xs rounded border px-3 py-2 text-sm disabled:bg-gray-50"
                          />
                        )}
                      </div>
                    ))}

                  <div>
                    <label className="block text-xs text-muted">Currency</label>
                    <select
                      value={draft.currency_code}
                      disabled={isIiPublished(draft)}
                      onChange={(e) => updateDraftField('currency_code', e.target.value)}
                      className={`mt-1 w-full max-w-[8rem] rounded border px-3 py-2 text-sm disabled:bg-gray-50 ${
                        draftCurrencyMismatchBlocked ? 'border-risk' : ''
                      }`}
                    >
                      <option value="AUD">AUD</option>
                      <option value="INR">INR</option>
                    </select>
                    {draftCurrencyMismatch && (
                      <div className="mt-1 max-w-sm">
                        <p className={`text-xs ${draftCurrencyMismatchBlocked ? 'text-risk' : 'text-muted'}`}>
                          {draftCurrencyMismatchBlocked
                            ? `Doesn't match ${draft.country_code === 'IN' ? "India's" : "Australia's"} currency (${expectedCurrencyForCountry(draft.country_code)}) — won't save until fixed or confirmed.`
                            : 'Confirmed as an intentionally different currency.'}
                        </p>
                        <label className="mt-1 flex items-center gap-1 text-xs text-muted">
                          <input
                            type="checkbox"
                            checked={Boolean(draft.currency_override)}
                            onChange={(e) => updateDraftField('currency_override', e.target.checked)}
                          />
                          This holding is genuinely in a different currency
                        </label>
                      </div>
                    )}
                  </div>

                  {/* Property/goal linking only makes sense once a row is
                      actually saved (has a real id) — shown in Edit mode
                      only, matching showsPropertyLinkControl's own gate. */}
                  {config.propertyLinkSide && editingKey !== null && showsPropertyLinkControl(config, draft) && (
                    <div>
                      <label className="block text-xs text-muted">
                        {config.propertyLinkSide === 'property' ? 'Financing' : 'Related Property'}
                      </label>
                      <PropertyFinancingControl
                        side={config.propertyLinkSide}
                        propertyKind={config.propertyLinkSide === 'property' ? (config.category === 'asset' ? 'asset' : 'investment') : undefined}
                        propertyId={config.propertyLinkSide === 'property' ? draft.id! : undefined}
                        liabilityId={config.propertyLinkSide === 'liability' ? draft.id! : undefined}
                        masterItemKey={draft.master_item_key}
                      />
                    </div>
                  )}
                  {config.goalLinkable && editingKey !== null && draft.id && (
                    <div>
                      <label className="block text-xs text-muted">Goals</label>
                      <GoalLinkControl investmentId={draft.id} />
                    </div>
                  )}

                  {draftWarnings.length > 0 && (
                    <p className="text-xs text-caution">{draftWarnings.join('; ')}</p>
                  )}
                  {formError && <p className="text-xs text-risk">{formError}</p>}
                  {saveErrors[draft.key] && <p className="text-xs text-risk">⚠ {saveErrors[draft.key]}</p>}

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={handleFormSave}
                      disabled={saving}
                      className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={handleFormCancel} className="text-sm text-muted hover:underline">
                      Cancel
                    </button>
                    {editingKey !== null && (
                      <button
                        onClick={() => handleRemove(draft).then(closeForm)}
                        disabled={removeUnavailable}
                        title={removeUnavailable ? "Removing isn't available for your country yet" : undefined}
                        className="ml-auto text-xs text-risk disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* --- Saved records list ---------------------------------------- */}
          {included.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                placeholder="Search your saved items..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-56 rounded border px-3 py-2 text-sm"
              />
            </div>
          )}

          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-card border bg-white md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Owner</th>
                  <th className="px-3 py-2">{config.title === 'Income' || config.title === 'Expenses' ? 'Amount' : 'Value'}</th>
                  <th className="px-3 py-2">Currency</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visibleIncluded.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-muted">
                      {included.length === 0 ? `No ${config.title.toLowerCase()} added yet — use "+ Add" above to get started.` : 'No items match your search.'}
                    </td>
                  </tr>
                )}
                {visibleIncluded.map((row) => (
                  <tr key={row.key} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      {row.item_label}
                      {isIiPublished(row) && (
                        <span className="ml-2 inline-block rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                          Imported via Investment Intelligence
                        </span>
                      )}
                      {warningsByRow.has(row.key) && (
                        <p className="mt-1 text-xs text-caution">{warningsByRow.get(row.key)!.join('; ')}</p>
                      )}
                    </td>
                    <td className="px-3 py-2">{OWNER_OPTIONS.find((o) => o.value === row.owner)?.label ?? row.owner}</td>
                    <td className="px-3 py-2">{formatMoney(Number(row[config.valueField] ?? 0), row.currency_code as 'AUD' | 'INR')}</td>
                    <td className="px-3 py-2">{row.currency_code}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => openEditForm(row)} className="text-xs font-medium text-trust hover:underline">
                        Edit
                      </button>
                      <button
                        onClick={() => handleRemove(row)}
                        disabled={isIiPublished(row) || removeUnavailable}
                        title={
                          isIiPublished(row)
                            ? 'Use Unpublish in Investment Intelligence to remove it from net worth.'
                            : removeUnavailable
                              ? "Removing isn't available for your country yet"
                              : undefined
                        }
                        className="ml-3 text-xs text-risk disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {included.length === 0 && (
              <p className="rounded-card border bg-white p-3 text-center text-sm text-muted">
                {`No ${config.title.toLowerCase()} added yet — use "+ Add" above to get started.`}
              </p>
            )}
            {visibleIncluded.map((row) => (
              <div key={row.key} className="rounded-card border bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-medium text-ink">{row.item_label}</p>
                    <p className="text-xs text-muted">
                      {OWNER_OPTIONS.find((o) => o.value === row.owner)?.label ?? row.owner} · {formatMoney(Number(row[config.valueField] ?? 0), row.currency_code as 'AUD' | 'INR')}
                    </p>
                    {isIiPublished(row) && (
                      <span className="mt-1 inline-block rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                        Imported via Investment Intelligence
                      </span>
                    )}
                    {warningsByRow.has(row.key) && (
                      <p className="mt-1 text-xs text-caution">{warningsByRow.get(row.key)!.join('; ')}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <button onClick={() => openEditForm(row)} className="text-xs font-medium text-trust hover:underline">
                      Edit
                    </button>
                    <button
                      onClick={() => handleRemove(row)}
                      disabled={isIiPublished(row) || removeUnavailable}
                      title={
                        isIiPublished(row)
                          ? 'Use Unpublish in Investment Intelligence to remove it from net worth.'
                          : removeUnavailable
                            ? "Removing isn't available for your country yet"
                            : undefined
                      }
                      className="text-xs text-risk disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </fieldset>

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
