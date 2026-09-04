// Investment Intelligence R6-P1 — data-access layer for India Tax & Cost
// Intelligence.
//
// SECURITY MODEL — identical discipline to r5Repository.ts/analyticsRepository.ts:
//   * Every read is scoped by the SERVER-RESOLVED `userId` from the
//     authenticated session. No account/instrument id is ever accepted from
//     the client and used as a filter.
//   * Reads use the RLS-respecting request client passed in by the caller.
//   * Writes (ii_capital_gains_computations, ii_tax_lot_consumptions) go
//     through the service-role client with `user_id` set server-side only,
//     mirroring persistR5Results's anti-forgery convention — never trust a
//     client-supplied user_id.
//   * Reference data (ii_tax_rule_versions, ii_scheme_tax_classification,
//     ii_exit_load_schedules, ii_prices_nav) is read-only here; nothing in
//     this file ever writes classification/rule/exit-load reference data —
//     that is an admin/maintenance concern (see computeAndCacheClassification).
//
// GRACEFUL DEGRADATION: migration 0045's new tables
// (ii_scheme_tax_classification / ii_exit_load_schedules /
// ii_tax_lot_consumptions / ii_capital_gains_computations) may not be applied
// to a given environment yet (this session had no DDL capability against
// DEV — see scripts/ii_r6p1_schema_probe.mjs). Every read against a
// not-yet-applied table degrades to "no data" with an explicit warning
// rather than throwing, so this module works unmodified the moment the
// migration lands.
//
// READ-ONLY GUARANTEE with respect to FHIP financial registers: this module
// contains NO insert/update/upsert/delete against investments, assets,
// retirement_accounts, income, expenses, liabilities, or any R3 publication
// table. Tax simulation cannot change net worth.

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from './pagination';
import type { AcquisitionEvent, DisposalEvent, AcquisitionKind, TaxLot } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';
import type { SchemeClassificationResult } from '@/lib/engines/investment-intelligence/tax/schemeClassification';
import type { ExitLoadSchedule } from '@/lib/engines/investment-intelligence/tax/exitLoad';
import type { DisposalTaxResult } from '@/lib/engines/investment-intelligence/tax/capitalGainsEngine';
import type { LotExitLoadResult } from '@/lib/engines/investment-intelligence/tax/exitLoad';
import { TAX_ENGINE_VERSION } from '@/lib/engines/investment-intelligence/tax/taxVersioning';
import type { TaxProfileInput, TaxpayerType, TaxResidencyStatus } from '@/lib/engines/investment-intelligence/tax/taxProfile';

export interface LoadWarning {
  scope: string;
  detail: string;
}

const ACQUISITION_TYPE_MAP: Record<string, AcquisitionKind> = {
  purchase: 'purchase',
  sip: 'sip',
  switch_in: 'switch_in',
  reinvestment: 'dividend_reinvestment',
  bonus: 'bonus',
  split: 'split_in',
};
// R12 added 'sale' (direct-equity/ETF market disposal) to ii_transactions'
// transaction_type vocabulary (migration 0092) — it is economically a
// disposal exactly like a mutual-fund 'redemption'/'switch_out' for FIFO/
// capital-gains purposes, and must be included here or R6's tax engine
// silently reports "no disposals found" for every real R12 equity/ETF sale
// (found during R12's own live-DEV certification, 2026-08-27). Exit-load
// application below is unaffected: it is keyed off ii_exit_load_schedules
// rows, which are only ever populated for mutual-fund schemes, so a direct-
// equity instrument naturally resolves to zero applicable exit-load
// schedules without any special-casing here.
// II-PC2: exported (previously module-private) so the workspace Overview can
// ask "does this user have any disposal at all?" using EXACTLY the vocabulary
// the tax engine itself consumes. The Overview must never re-derive or
// re-guess this set — a second copy would drift and the Tax card would then
// claim "no disposals" for transaction types R6 actually taxes.
export const DISPOSAL_TYPES = new Set(['redemption', 'switch_out', 'sale']);

export interface TaxDataset {
  userId: string;
  asOfDate: string;
  acquisitionsByInstrument: Map<string, AcquisitionEvent[]>;
  disposalsByInstrument: Map<string, DisposalEvent[]>;
  salePricePerUnitByDisposal: Map<string, number>;
  classificationByInstrument: Map<string, SchemeClassificationResult>;
  fmv31Jan2018ByInstrument: Map<string, number | null>;
  exitLoadSchedules: ExitLoadSchedule[];
  instrumentNames: Map<string, string>;
  /** Every canonical account id that appears in this user's usable
   * transactions, per instrument. Exposed so callers that must name a
   * specific folio (the redemption simulator) can resolve and validate an
   * account against canonical truth instead of trusting client input. */
  accountIdsByInstrument: Map<string, string[]>;
  /** Display label per canonical account id (institution + folio), for
   * disambiguating "which folio did you mean?" back to the user. Never used
   * for matching — matching is always on the canonical id. */
  accountLabels: Map<string, string>;
}

/** true iff a Supabase error looks like "relation does not exist" — i.e. the
 * migration hasn't landed yet — vs. a genuine query error worth surfacing. */
function isMissingTableError(error: { message: string; code?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || /relation .* does not exist/i.test(error.message) || /Could not find the table/i.test(error.message);
}

export async function loadTaxDataset(supabase: SupabaseClient, userId: string, options: { asOfDate?: string } = {}): Promise<{ dataset: TaxDataset | null; warnings: LoadWarning[]; empty: boolean }> {
  const warnings: LoadWarning[] = [];

  interface TxnRow {
    id: string;
    account_id: string;
    instrument_id: string;
    transaction_type: string;
    transaction_date: string;
    units: number | null;
    price_per_unit: number | null;
    gross_amount: number;
    status: string;
  }
  const txnRows = await fetchAllRows<TxnRow>(() =>
    supabase
      .from('ii_transactions')
      .select('id, account_id, instrument_id, transaction_type, transaction_date, units, price_per_unit, gross_amount, status')
      .eq('user_id', userId)
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true })
  );

  // R11: also exclude 'review_required' (unresolved cross-source
  // conflict/ambiguity) — same exclusion discipline as 'reversed'.
  const usable = txnRows.filter((r) => r.status !== 'reversed' && r.status !== 'review_required' && r.units !== null);
  if (usable.length === 0) {
    return { dataset: null, warnings, empty: true };
  }

  const acquisitionsByInstrument = new Map<string, AcquisitionEvent[]>();
  const disposalsByInstrument = new Map<string, DisposalEvent[]>();
  const salePricePerUnitByDisposal = new Map<string, number>();
  // II-PC1-F1: which canonical accounts hold each instrument. Built from the
  // SAME server-side, user-scoped transaction read as everything else — this
  // is the only thing any caller is allowed to resolve a folio against.
  const accountIdsByInstrument = new Map<string, string[]>();

  for (const r of usable) {
    const units = Number(r.units);
    const instrumentKey = r.instrument_id;
    // II-PC1-F1: the canonical `ii_accounts.id` (folio / demat account) that
    // owns this transaction. NOT NULL on ii_transactions, so always present.
    // FIFO candidacy is scoped to (accountKey, instrumentKey) — see
    // taxLotEngine.ts's LOT SCOPE header and
    // docs/investment-intelligence/II_PC1_F1_FIFO_SCOPE_DECISION.md.
    const accountKey = r.account_id;
    if (r.transaction_type in ACQUISITION_TYPE_MAP) {
      const costPerUnit = r.price_per_unit !== null ? Number(r.price_per_unit) : units > 0 ? Number(r.gross_amount) / units : 0;
      const list = acquisitionsByInstrument.get(instrumentKey) ?? [];
      list.push({
        sourceEventId: r.id,
        accountKey,
        instrumentKey,
        kind: ACQUISITION_TYPE_MAP[r.transaction_type],
        acquisitionDate: r.transaction_date,
        units,
        costPerUnit,
      });
      acquisitionsByInstrument.set(instrumentKey, list);
      const accounts = accountIdsByInstrument.get(instrumentKey) ?? [];
      if (!accounts.includes(accountKey)) accounts.push(accountKey);
      accountIdsByInstrument.set(instrumentKey, accounts);
    } else if (DISPOSAL_TYPES.has(r.transaction_type)) {
      const saleValue = Math.abs(Number(r.gross_amount));
      const list = disposalsByInstrument.get(instrumentKey) ?? [];
      list.push({ sourceEventId: r.id, accountKey, instrumentKey, disposalDate: r.transaction_date, units, saleValue });
      disposalsByInstrument.set(instrumentKey, list);
      salePricePerUnitByDisposal.set(r.id, units > 0 ? saleValue / units : 0);
    }
    // Every other transaction_type (dividend/fee/tax/transfer/merger/
    // adjustment/stp/swp/reversal/segregation/unclassified) is deliberately
    // NOT treated as a tax-lot event here — dividend (non-reinvested) is a
    // cash event with its own (out-of-scope) taxation, and the others carry
    // no unit-level cost-basis meaning for FIFO purposes.
  }

  for (const list of acquisitionsByInstrument.values()) list.sort((a, b) => (a.acquisitionDate < b.acquisitionDate ? -1 : 1));
  for (const list of disposalsByInstrument.values()) list.sort((a, b) => (a.disposalDate < b.disposalDate ? -1 : 1));

  // NOTE ON PAGINATION: every read below that can return more than one row
  // per instrument (or, for a large-enough household, more than 1000 rows
  // total across ALL matched instrument ids) goes through fetchAllRows, not
  // a bare `.in(...)` select — see lib/services/investment-intelligence/
  // pagination.ts's header for why a bare select silently truncates at
  // PostgREST's db-max-rows with no error anywhere. This was audited and
  // fixed in the R6-FINAL closure pass (2026-08-22): the ii_prices_nav read
  // below is the sharpest case — a single equity-oriented fund's daily NAV
  // history up to the 31-Jan-2018 grandfathering cutoff can itself exceed
  // 1000 rows, and a silent truncation there does not just drop rows, it
  // silently DENIES a real grandfathering tax benefit for instruments whose
  // price rows fall past the truncation point (reported as
  // fmv_unavailable instead of the true FMV). Each query below carries a
  // unique, deterministic order (a single-column primary/unique key, or a
  // composite unique-together pair) as fetchAllRows's contract requires.
  const instrumentIds = [...new Set(usable.map((r) => r.instrument_id))];

  interface InstrumentRow {
    id: string;
    instrument_name: string;
    country_of_domicile: string | null;
  }
  let instrumentNames = new Map<string, string>();
  try {
    const instrumentRows = await fetchAllRows<InstrumentRow>(() =>
      supabase.from('ii_instruments').select('id, instrument_name, country_of_domicile').in('id', instrumentIds).order('id', { ascending: true })
    );
    instrumentNames = new Map(instrumentRows.map((r) => [r.id, r.instrument_name]));
  } catch (e) {
    warnings.push({ scope: 'instruments', detail: `Instrument names could not be read (${e instanceof Error ? e.message : String(e)}).` });
  }

  // --- Canonical account labels (II-PC1-F1). ------------------------------
  // Display-only: lets the redemption simulator say "you hold this scheme in
  // Folio X and Folio Y — which one?" instead of silently guessing. Matching
  // is ALWAYS on the canonical account id, never on these strings. Read with
  // the RLS-respecting client, so a label can only ever be this user's own.
  const accountLabels = new Map<string, string>();
  {
    const accountIds = [...new Set(usable.map((r) => r.account_id))];
    interface AccountRow {
      id: string;
      institution_name: string;
      folio_number: string | null;
      account_number_masked: string | null;
    }
    try {
      const rows = await fetchAllRows<AccountRow>(() =>
        supabase.from('ii_accounts').select('id, institution_name, folio_number, account_number_masked').in('id', accountIds).order('id', { ascending: true })
      );
      for (const row of rows) {
        const ref = row.folio_number ?? row.account_number_masked;
        accountLabels.set(row.id, ref ? `${row.institution_name} — ${ref}` : row.institution_name);
      }
    } catch (e) {
      warnings.push({ scope: 'accounts', detail: `Account labels could not be read (${e instanceof Error ? e.message : String(e)}) — folios will be identified by id only.` });
    }
  }

  // --- Scheme tax classification (durable cache table, R6-P1's own). -----
  const classificationByInstrument = new Map<string, SchemeClassificationResult>();
  {
    interface ClassificationRow {
      instrument_id: string;
      classification: string;
      domestic_equity_pct: number | null;
      basis: string;
      disclosure_date: string | null;
      note: string | null;
    }
    try {
      const rows = await fetchAllRows<ClassificationRow>(() =>
        supabase
          .from('ii_scheme_tax_classification')
          .select('instrument_id, classification, domestic_equity_pct, basis, disclosure_date, note')
          .in('instrument_id', instrumentIds)
          .order('instrument_id', { ascending: true }) // unique(instrument_id) — single-column key is sufficient
      );
      for (const row of rows) {
        classificationByInstrument.set(row.instrument_id, {
          instrumentKey: row.instrument_id,
          classification: row.classification as SchemeClassificationResult['classification'],
          domesticEquityPct: row.domestic_equity_pct,
          basis: row.basis as SchemeClassificationResult['basis'],
          disclosureDate: row.disclosure_date,
          note: row.note ?? '',
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isMissingTableError({ message })) {
        warnings.push({ scope: 'classification', detail: 'ii_scheme_tax_classification is not yet available in this environment (migration 0058 not applied) — every scheme is treated as unresolved.' });
      } else {
        warnings.push({ scope: 'classification', detail: `Scheme classification could not be read (${message}).` });
      }
    }
  }
  for (const id of instrumentIds) {
    if (!classificationByInstrument.has(id)) {
      classificationByInstrument.set(id, {
        instrumentKey: id,
        classification: 'unresolved',
        domesticEquityPct: null,
        basis: 'unresolved_no_data',
        disclosureDate: null,
        note: 'No scheme tax classification is on record for this instrument — excluded from confident tax figures.',
      });
    }
  }

  // --- 31-Jan-2018 grandfathering FMV, from R2's ii_prices_nav series. ---
  // Deliberately paginated (fetchAllRows), not a bare select: a single
  // instrument's full pre-1961-cutoff daily NAV history can itself exceed
  // 1000 rows, and the query below needs EVERY row (not just the first
  // page) to correctly pick the closest date <= 2018-01-31 per instrument —
  // see the module-level pagination note above.
  const fmv31Jan2018ByInstrument = new Map<string, number | null>();
  {
    interface PriceRow {
      instrument_id: string;
      price_date: string;
      price: number;
    }
    try {
      const rows = await fetchAllRows<PriceRow>(() =>
        supabase
          .from('ii_prices_nav')
          .select('instrument_id, price_date, price')
          .in('instrument_id', instrumentIds)
          .lte('price_date', '2018-01-31')
          .order('instrument_id', { ascending: true })
          .order('price_date', { ascending: false }) // unique(instrument_id, price_date) — composite key, most recent on/before cutoff first
      );
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.instrument_id)) continue; // first row per instrument is the closest date <= cutoff (DESC order)
        seen.add(row.instrument_id);
        fmv31Jan2018ByInstrument.set(row.instrument_id, Number(row.price));
      }
    } catch (e) {
      warnings.push({ scope: 'grandfathering_fmv', detail: `31-Jan-2018 FMV lookup failed (${e instanceof Error ? e.message : String(e)}) — grandfathering will use acquisition cost only.` });
    }
  }
  for (const id of instrumentIds) {
    if (!fmv31Jan2018ByInstrument.has(id)) fmv31Jan2018ByInstrument.set(id, null);
  }

  // --- Exit-load schedules. ------------------------------------------------
  const exitLoadSchedules: ExitLoadSchedule[] = [];
  {
    interface ExitLoadRow {
      instrument_id: string;
      tiers: Array<{ uptoDays: number; loadPct: number }>;
      effective_from: string;
      effective_to: string | null;
    }
    try {
      const rows = await fetchAllRows<ExitLoadRow>(() =>
        supabase
          .from('ii_exit_load_schedules')
          .select('instrument_id, tiers, effective_from, effective_to')
          .in('instrument_id', instrumentIds)
          .order('instrument_id', { ascending: true })
          .order('effective_from', { ascending: true }) // unique(instrument_id, effective_from) — composite key; a scheme can have >1 schedule version over time
      );
      for (const row of rows) {
        exitLoadSchedules.push({
          instrumentKey: row.instrument_id,
          tiers: row.tiers,
          effectiveFrom: row.effective_from,
          effectiveTo: row.effective_to,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isMissingTableError({ message })) {
        warnings.push({ scope: 'exit_load', detail: 'ii_exit_load_schedules is not yet available in this environment (migration 0058 not applied) — exit load will not be shown.' });
      } else {
        warnings.push({ scope: 'exit_load', detail: `Exit-load schedules could not be read (${message}).` });
      }
    }
  }

  const latestTxnDate = usable[usable.length - 1].transaction_date;
  const asOfDate = options.asOfDate && options.asOfDate <= latestTxnDate ? options.asOfDate : latestTxnDate;

  return {
    dataset: {
      userId,
      asOfDate,
      acquisitionsByInstrument,
      disposalsByInstrument,
      salePricePerUnitByDisposal,
      classificationByInstrument,
      fmv31Jan2018ByInstrument,
      exitLoadSchedules,
      instrumentNames,
      accountIdsByInstrument,
      accountLabels,
    },
    warnings,
    empty: false,
  };
}

// ---------------------------------------------------------------------------
// R6-FINAL live-DEV fix (found during this dispatch's LIVE-R6-001 case):
// `ii_capital_gains_computations.lot_id` carries a NOT-NULL foreign key to
// `ii_tax_lots(id)` (migration 0058), but NOTHING in R6-P1 ever wrote a row
// to `ii_tax_lots` — lots are computed purely in-memory by taxLotEngine.ts
// and never persisted. The original code passed the RAW acquisition
// transaction id (stripped of the "lot:" prefix) as `lot_id`, which is
// never a real `ii_tax_lots.id` — so EVERY real disposal's persistence
// attempt failed the FK constraint, silently (the try/catch below swallowed
// it into a non-fatal `warnings` entry), meaning ii_capital_gains_computations
// has never actually held a row in any environment despite the feature
// "working" (recomputed fresh every request). Confirmed live: DEV showed
// `violates foreign key constraint "ii_capital_gains_computations_lot_id_fkey"`
// on every real tax/summary call before this fix.
//
// FIX: actually populate ii_tax_lots (the table's own schema — user_id,
// account_id, instrument_id, opening_transaction_id, status,
// acquisition_date, units_acquired/remaining, cost_per_unit — matches
// TaxLot exactly, confirming this was the intended design, just never
// wired up) using a DETERMINISTIC id derived from the lot's own stable
// `lotId` (`lot:${sourceEventId}`, already unique per acquisition
// transaction). Determinism — not `gen_random_uuid()` — is deliberate: it
// makes lot persistence naturally idempotent (Section 43) without needing
// a new unique index this session cannot add via DDL, and it is what lets
// `persistCapitalGainsComputations` below derive the SAME id independently
// to satisfy the FK, without a redundant lookup round-trip.
// ---------------------------------------------------------------------------

const TAX_LOT_ID_NAMESPACE = '6f1e9d2a-2c3b-4a10-9e77-9b6f0b6f5a11'; // fixed, arbitrary namespace for this app's deterministic tax-lot uuids

/** RFC 4122 UUID v5 (SHA-1-based, deterministic) — no external dependency. */
export function deterministicLotId(lotKey: string): string {
  const namespaceBytes = Buffer.from(TAX_LOT_ID_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespaceBytes).update(lotKey, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Upsert the current lot state (from `runTaxSimulation`'s `lots` output)
 * into `ii_tax_lots`, so `ii_capital_gains_computations.lot_id` has a real
 * row to reference. Idempotent: re-running against unchanged inputs
 * produces the SAME row ids with the SAME field values (Section 43) —
 * `deterministicLotId` guarantees this without needing a DB-level unique
 * constraint this session cannot add.
 *
 * II-PC2-F1 FIX — `closed_at` PROVENANCE (found via a live-DEV read-side-
 * mutation review, tests/live-dev/iiPc2F1ReadSideMutationLiveDev.test.ts
 * §T5): every column here is a genuinely idempotent re-derivation from
 * canonical inputs EXCEPT `closed_at`, which used to be re-stamped to
 * `new Date().toISOString()` on every upsert of an already-closed lot —
 * meaning simply re-opening `/tax/summary` (a GET) kept silently rewriting
 * "when this lot closed" to "just now", forever, for as long as the lot
 * stayed closed. Nothing in the app currently reads this column, so it was
 * not an economically-visible defect, but it violates the provenance
 * guarantee this whole review exists to check, and would mislead the first
 * future feature (or direct DB/admin inspection) that does read it.
 *
 * FIX: read back any already-persisted `closed_at` for the lot ids in this
 * batch FIRST, and reuse it verbatim when present — a lot is stamped with
 * a real wall-clock closed_at exactly ONCE, at its first transition to
 * closed, and never again. A lot closing for the first time in this run
 * still gets `new Date().toISOString()`, same as before.
 */
export async function persistTaxLots(userId: string, lots: readonly TaxLot[]): Promise<{ persisted: number; error: string | null }> {
  if (lots.length === 0) return { persisted: 0, error: null };
  try {
    const admin = createAdminClient();
    const closingLotIds = lots.filter((l) => l.unitsRemaining <= 1e-6).map((l) => deterministicLotId(l.lotId));
    const existingClosedAtById = new Map<string, string>();
    if (closingLotIds.length > 0) {
      const { data: existingRows, error: existingErr } = await admin.from('ii_tax_lots').select('id, closed_at').in('id', closingLotIds);
      if (existingErr) return { persisted: 0, error: existingErr.message };
      for (const row of existingRows ?? []) {
        if (row.closed_at) existingClosedAtById.set(row.id as string, row.closed_at as string);
      }
    }
    const nowIso = new Date().toISOString();
    const payload = lots.map((l) => {
      const sourceEventId = l.lotId.startsWith('lot:') ? l.lotId.slice(4) : l.lotId;
      // II-PC1-F1: the account now travels ON the lot (it is half of the
      // lot's FIFO scope key), so it is read straight off the lot rather
      // than re-derived from a side map keyed by transaction id. This
      // removes the possibility of the persisted `account_id` disagreeing
      // with the account the engine actually matched the lot under.
      const id = deterministicLotId(l.lotId);
      const isClosed = l.unitsRemaining <= 1e-6;
      return {
        id,
        user_id: userId,
        account_id: l.accountKey || null,
        instrument_id: l.instrumentKey,
        opening_transaction_id: sourceEventId,
        status: isClosed ? 'closed' : l.unitsRemaining < l.unitsAcquired ? 'partially_closed' : 'open',
        acquisition_date: l.acquisitionDate,
        units_acquired: l.unitsAcquired,
        units_remaining: l.unitsRemaining,
        cost_per_unit: l.costPerUnit,
        // Stamped once, at first closure — never re-stamped on a later
        // idempotent re-read of the same already-closed lot (see header).
        closed_at: isClosed ? (existingClosedAtById.get(id) ?? nowIso) : null,
      };
    });
    const missingAccount = payload.filter((p) => !p.account_id);
    if (missingAccount.length > 0) {
      return { persisted: 0, error: `${missingAccount.length} lot(s) had no resolvable account_id — not persisted (ii_tax_lots.account_id is NOT NULL).` };
    }
    const { error } = await admin.from('ii_tax_lots').upsert(payload, { onConflict: 'id', ignoreDuplicates: false });
    if (error) return { persisted: 0, error: error.message };
    return { persisted: payload.length, error: null };
  } catch (e) {
    return { persisted: 0, error: e instanceof Error ? e.message : 'Unknown error persisting tax lots.' };
  }
}

// ---------------------------------------------------------------------------
// R6-FINAL live-DEV fix (found while building the Section 30 DB-inspection
// checks): `ii_tax_lot_consumptions` (migration 0058's own FIFO consumption
// ledger table — "which lot(s) a redemption consumed, how many units from
// each") was declared in the schema and mentioned in this file's OWN header
// comment, but NOTHING ever wrote to it — same defect class, same root
// cause (schema built ahead of the write path, wiring never finished) as
// the ii_tax_lots gap fixed above. Fixed the same way: derive the payload
// straight from the certified DisposalTaxResult[] (which now carries
// `costBasisPreGrandfathering` — see capitalGainsEngine.ts), using the SAME
// deterministic lot_id so the FK resolves.
// ---------------------------------------------------------------------------
export async function persistTaxLotConsumptions(userId: string, disposalResults: DisposalTaxResult[]): Promise<{ persisted: number; error: string | null }> {
  if (disposalResults.length === 0) return { persisted: 0, error: null };
  try {
    const admin = createAdminClient();
    // II-PC1-F2: one timestamp for the whole run — see persistCapitalGainsComputations.
    const runAt = new Date().toISOString();
    const payload = disposalResults
      .filter((d) => d.classification !== 'unresolved') // unresolved disposals never opened a real lot_id-backed consumption record
      .map((d) => ({
        user_id: userId,
        disposal_transaction_id: d.disposalEventId,
        lot_id: deterministicLotId(d.lotId),
        units_consumed: d.unitsConsumed,
        cost_basis_pre_grandfathering: d.costBasisPreGrandfathering,
        sale_value_apportioned: d.saleValue,
        engine_version: TAX_ENGINE_VERSION,
        created_at: runAt,
      }));
    if (payload.length === 0) return { persisted: 0, error: null };
    const { error } = await admin.from('ii_tax_lot_consumptions').upsert(payload, { onConflict: 'disposal_transaction_id,lot_id', ignoreDuplicates: false });
    if (error) return { persisted: 0, error: error.message };
    return { persisted: payload.length, error: null };
  } catch (e) {
    return { persisted: 0, error: e instanceof Error ? e.message : 'Unknown error persisting tax lot consumptions.' };
  }
}

/**
 * Persist per-lot-consumption capital-gains + exit-load results. Service-
 * role write, `user_id` set from the SERVER-authenticated session only
 * (never accepted from a client payload) — mirrors persistR5Results's
 * anti-forgery convention. A persistence failure never blocks returning a
 * correct, freshly-computed answer to the caller.
 *
 * CALL ORDER: `persistTaxLots` must be called first (and awaited) so the
 * `lot_id` FK this function writes actually resolves — see that function's
 * header for the full defect history.
 */
export async function persistCapitalGainsComputations(
  userId: string,
  disposalResults: DisposalTaxResult[],
  exitLoadResults: LotExitLoadResult[]
): Promise<{ persisted: number; error: string | null }> {
  if (disposalResults.length === 0) return { persisted: 0, error: null };
  try {
    const admin = createAdminClient();
    const exitLoadByLotAndDisposal = new Map(exitLoadResults.map((e) => [`${e.disposalEventId}:${e.lotId}`, e]));

    // ---------------------------------------------------------------------
    // II-PC1-F2: `computed_at` is stamped EXPLICITLY, once for the whole run.
    //
    // The column has DEFAULT now(), but a column default does not re-fire on
    // the UPDATE half of an upsert — so before this dispatch a row that had
    // been recomputed a dozen times still reported its ORIGINAL insert time
    // (verified against live DEV). That made `computed_at` useless as a
    // freshness marker, which is precisely what
    // `loadCurrentCapitalGainsComputations` below needs in order to tell a
    // row produced by the latest run from one left behind by an earlier one.
    //
    // One timestamp for the whole run (not `new Date()` per row) is what
    // makes selection DETERMINISTIC: every row of a run shares one exact
    // value, so "the latest run" is a total order over runs rather than a
    // race between rows. See docs/investment-intelligence/
    // II_PC1_F2_CURRENT_RESULT_SELECTION_DECISION.md §5.
    // ---------------------------------------------------------------------
    const runAt = new Date().toISOString();

    const payload = disposalResults.map((d) => {
      const exitLoad = exitLoadByLotAndDisposal.get(`${d.disposalEventId}:${d.lotId}`);
      return {
        user_id: userId,
        disposal_transaction_id: d.disposalEventId,
        lot_id: deterministicLotId(d.lotId),
        instrument_id: d.instrumentKey,
        classification: d.classification,
        gain_type: d.gainType,
        holding_days: d.holdingDays,
        rule_version: d.ruleVersion,
        rule_version_placeholder: d.ruleVersionPlaceholder,
        sale_value: d.saleValue,
        cost_basis_used: d.costBasisUsed,
        taxable_gain: d.taxableGain,
        grandfathering_eligible: d.grandfathering?.eligible ?? false,
        grandfathering_basis_source: d.grandfathering?.basisSource ?? null,
        exit_load_pct: exitLoad?.applicableLoadPct ?? null,
        exit_load_amount: exitLoad?.exitLoadAmount ?? null,
        engine_version: TAX_ENGINE_VERSION,
        computed_at: runAt,
        note: d.note,
      };
    });

    const { error } = await admin.from('ii_capital_gains_computations').upsert(payload, { onConflict: 'disposal_transaction_id,lot_id', ignoreDuplicates: false });
    if (error) return { persisted: 0, error: error.message };
    return { persisted: payload.length, error: null };
  } catch (e) {
    return { persisted: 0, error: e instanceof Error ? e.message : 'Unknown persistence error' };
  }
}

// ---------------------------------------------------------------------------
// II-PC1-F2 — CURRENT-RESULT SELECTION over persisted capital-gains rows.
//
// THE PROBLEM
// -----------
// `ii_capital_gains_computations` upserts on (disposal_transaction_id,
// lot_id). That key silently assumes the SET OF LOTS a disposal consumes
// never changes. II-PC1-F1 changed exactly that — FIFO candidacy moved from
// (instrument) to (account, instrument) — so for a user holding one scheme
// in two folios a disposal now consumes a DIFFERENT lot. The v3 write lands
// on a NEW key, and the row the old rule wrote is neither updated nor
// deleted. Nothing in this codebase ever deletes from this table, so the
// orphan is permanent.
//
// Proven live against DEV (tests/live-dev/
// iiPc1F2EngineVersionConsumersLiveDev.test.ts): a superseded v2 row
// carrying gain_type 'ltcg' / taxable_gain 30,000 survived alongside the
// correct v3 answer (stcg, 22,000 total) for the SAME disposal, and Review
// Centre — the only reader of this table — raised a real, open, user-facing
// item from it.
//
// TWO INDEPENDENT STALENESS AXES
// ------------------------------
// A. ENGINE GENERATION — a v2 row outliving a v3 recomputation.
// B. DATA FRESHNESS AT THE SAME VERSION — a legitimate new backdated
//    acquisition re-matches FIFO under the SAME v3 engine, orphaning a v3
//    row. Also proven live (F2-T04).
//
// Axis B is why filtering on engine version ALONE is not the fix: it would
// answer F2's literal question while leaving an identical defect one
// transaction away.
//
// THE RULE — LATEST_VALID_COMPUTATION_FOR_CURRENT_ENGINE
// ------------------------------------------------------
// A row is CURRENT for a disposal iff (1) its engine_version equals what the
// currently deployed code would produce, and (2) its computed_at is the
// newest among rows satisfying (1) for that same disposal.
//
// Clause (1) is written against the TAX_ENGINE_VERSION CONSTANT, never a
// literal 'v3'. A future v4 bump therefore re-scopes every consumer with no
// consumer edit — this function must not become the next version's defect.
// It also gives the honest answer when a user has ONLY pre-bump rows: no
// current computation exists, so none is returned, rather than falling back
// on an arbitrary historical row.
//
// Clause (2) is scoped PER DISPOSAL because the disposal is the calculation
// context. Post-fix per-disposal and per-user coincide (a run always
// recomputes every disposal for the user); per-disposal simply degrades more
// gracefully on rows written before this change.
//
// HISTORY IS NOT DESTROYED: superseded rows are retained in the table for
// provenance and are merely never presented as current.
//
// Full reasoning, rejected alternatives and the disclosed residual:
// docs/investment-intelligence/II_PC1_F2_CURRENT_RESULT_SELECTION_DECISION.md
// ---------------------------------------------------------------------------

/** One persisted capital-gains computation, as consumers read it back. */
export interface PersistedCapitalGainsRow {
  id: string;
  disposal_transaction_id: string;
  lot_id: string;
  instrument_id: string;
  classification: string;
  gain_type: string;
  exit_load_pct: number | null;
  engine_version: string;
  computed_at: string;
}

/**
 * Reduce a raw row set to only those that are CURRENT under
 * LATEST_VALID_COMPUTATION_FOR_CURRENT_ENGINE. Exported separately from the
 * query so the rule itself is unit-testable without a database.
 *
 * Deterministic: `computed_at` is stamped once per run (see
 * persistCapitalGainsComputations), so all rows of a run share one exact
 * value and "latest" orders runs, not rows. Ties on an identical timestamp
 * are all kept — they are by construction the same run.
 *
 * `computed_at` is compared as a STRING, deliberately. Every value here comes
 * from the same `timestamptz` column through PostgREST, so all of them arrive
 * in one identical ISO-8601 UTC format — and for a fixed format, lexicographic
 * order IS chronological order (the fractional part compares digit-by-digit
 * like a decimal, and the '+' of the offset sorts below every digit, so a
 * shorter fraction correctly compares as smaller). Parsing to Date instead
 * would silently truncate Postgres's microseconds to JavaScript milliseconds
 * and could collapse two genuinely distinct runs into a tie.
 */
export function selectCurrentCapitalGainsRows<T extends { disposal_transaction_id: string; engine_version: string; computed_at: string }>(
  rows: readonly T[]
): T[] {
  const atCurrentEngine = rows.filter((r) => r.engine_version === TAX_ENGINE_VERSION);
  const newestByDisposal = new Map<string, string>();
  for (const r of atCurrentEngine) {
    const seen = newestByDisposal.get(r.disposal_transaction_id);
    if (seen === undefined || r.computed_at > seen) newestByDisposal.set(r.disposal_transaction_id, r.computed_at);
  }
  return atCurrentEngine.filter((r) => r.computed_at === newestByDisposal.get(r.disposal_transaction_id));
}

/**
 * THE canonical read of persisted R6 capital-gains results. Every consumer
 * that needs "the user's current tax computation" must come through here
 * rather than querying `ii_capital_gains_computations` directly — that is
 * what keeps current-result semantics in ONE place instead of being
 * re-derived (differently, eventually wrongly) per consumer.
 *
 * `supabase` is the caller's client: pass an RLS-respecting request client
 * for user-initiated reads. `userId` must be the SERVER-resolved id, never
 * client-supplied — same discipline as every other read in this module.
 *
 * Paging goes through `fetchAllRows` with a unique, deterministic order (the
 * table's primary key), so a user with more than one PostgREST page of
 * history cannot have rows silently truncated away — see pagination.ts.
 */
export async function loadCurrentCapitalGainsComputations(
  supabase: SupabaseClient,
  userId: string
): Promise<{ rows: PersistedCapitalGainsRow[]; supersededCount: number }> {
  const all = await fetchAllRows<PersistedCapitalGainsRow>(() =>
    supabase
      .from('ii_capital_gains_computations')
      .select('id, disposal_transaction_id, lot_id, instrument_id, classification, gain_type, exit_load_pct, engine_version, computed_at')
      .eq('user_id', userId)
      .order('id', { ascending: true })
  );
  const rows = selectCurrentCapitalGainsRows(all);
  return { rows, supersededCount: all.length - rows.length };
}

// ---------------------------------------------------------------------------
// R6-FINAL (Sections 20-23) — explicit tax-profile persistence.
//
// GRACEFUL DEGRADATION: migration 0060's ii_tax_profiles table requires DDL
// this session cannot execute against DEV (see that migration's own header)
// — it is NOT applied as of this dispatch. Reads degrade to "no profile on
// record" (indistinguishable from a genuine, valid "not declared yet"
// state — never a crash); writes return an explicit, honest "not available
// in this environment yet" error rather than silently no-op'ing or throwing
// an opaque 500.
// ---------------------------------------------------------------------------

export interface TaxProfileRecord {
  taxpayerType: TaxpayerType;
  taxResidencyStatus: TaxResidencyStatus & ('RESIDENT' | 'NON_RESIDENT');
  taxYear: string | null;
  updatedAt: string;
}

export async function loadTaxProfile(supabase: SupabaseClient, userId: string): Promise<{ profile: TaxProfileRecord | null; available: boolean }> {
  const { data, error } = await supabase
    .from('ii_tax_profiles')
    .select('taxpayer_type, tax_residency_status, tax_year, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return { profile: null, available: false };
    throw error;
  }
  if (!data) return { profile: null, available: true };
  return {
    available: true,
    profile: {
      taxpayerType: data.taxpayer_type as TaxpayerType,
      taxResidencyStatus: data.tax_residency_status as 'RESIDENT' | 'NON_RESIDENT',
      taxYear: data.tax_year,
      updatedAt: data.updated_at,
    },
  };
}

export async function saveTaxProfile(userId: string, input: TaxProfileInput): Promise<{ saved: boolean; error: string | null }> {
  if (!input.taxpayerType) return { saved: false, error: 'taxpayerType is required.' };
  const residencyStatus: 'RESIDENT' | 'NON_RESIDENT' = input.taxpayerType === 'NON_RESIDENT_INDIVIDUAL' ? 'NON_RESIDENT' : 'RESIDENT';
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from('ii_tax_profiles')
      .upsert(
        { user_id: userId, taxpayer_type: input.taxpayerType, tax_residency_status: residencyStatus, tax_year: input.taxYear ?? null, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
    if (error) {
      if (isMissingTableError(error)) return { saved: false, error: 'Tax-profile persistence is not yet available in this environment (migration 0060 pending). Your profile was not saved — pass it explicitly with each request in the meantime.' };
      return { saved: false, error: error.message };
    }
    return { saved: true, error: null };
  } catch (e) {
    return { saved: false, error: e instanceof Error ? e.message : 'Unknown error saving tax profile.' };
  }
}

/** Convert a persisted/explicit profile record into the engine's
 * `TaxProfileInput` shape. Used identically whether the profile came from
 * the DB (once 0060 lands) or from an explicit per-request override. */
export function toTaxProfileInput(record: { taxpayerType?: string | null; taxResidencyStatus?: string | null; taxYear?: string | null } | null): TaxProfileInput {
  if (!record) return {};
  return {
    taxpayerType: (record.taxpayerType as TaxpayerType) ?? null,
    taxResidencyStatus: (record.taxResidencyStatus as TaxResidencyStatus) ?? null,
    taxYear: record.taxYear ?? null,
  };
}
