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

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from './pagination';
import type { AcquisitionEvent, DisposalEvent, AcquisitionKind } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';
import type { SchemeClassificationResult } from '@/lib/engines/investment-intelligence/tax/schemeClassification';
import type { ExitLoadSchedule } from '@/lib/engines/investment-intelligence/tax/exitLoad';
import type { DisposalTaxResult } from '@/lib/engines/investment-intelligence/tax/capitalGainsEngine';
import type { LotExitLoadResult } from '@/lib/engines/investment-intelligence/tax/exitLoad';
import { TAX_ENGINE_VERSION } from '@/lib/engines/investment-intelligence/tax/taxVersioning';

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
const DISPOSAL_TYPES = new Set(['redemption', 'switch_out']);

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

  const usable = txnRows.filter((r) => r.status !== 'reversed' && r.units !== null);
  if (usable.length === 0) {
    return { dataset: null, warnings, empty: true };
  }

  const acquisitionsByInstrument = new Map<string, AcquisitionEvent[]>();
  const disposalsByInstrument = new Map<string, DisposalEvent[]>();
  const salePricePerUnitByDisposal = new Map<string, number>();

  for (const r of usable) {
    const units = Number(r.units);
    const instrumentKey = r.instrument_id;
    if (r.transaction_type in ACQUISITION_TYPE_MAP) {
      const costPerUnit = r.price_per_unit !== null ? Number(r.price_per_unit) : units > 0 ? Number(r.gross_amount) / units : 0;
      const list = acquisitionsByInstrument.get(instrumentKey) ?? [];
      list.push({
        sourceEventId: r.id,
        instrumentKey,
        kind: ACQUISITION_TYPE_MAP[r.transaction_type],
        acquisitionDate: r.transaction_date,
        units,
        costPerUnit,
      });
      acquisitionsByInstrument.set(instrumentKey, list);
    } else if (DISPOSAL_TYPES.has(r.transaction_type)) {
      const saleValue = Math.abs(Number(r.gross_amount));
      const list = disposalsByInstrument.get(instrumentKey) ?? [];
      list.push({ sourceEventId: r.id, instrumentKey, disposalDate: r.transaction_date, units, saleValue });
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

  const instrumentIds = [...new Set(usable.map((r) => r.instrument_id))];
  const { data: instrumentRows } = await supabase.from('ii_instruments').select('id, instrument_name, country_of_domicile').in('id', instrumentIds);
  const instrumentNames = new Map((instrumentRows ?? []).map((r) => [r.id as string, r.instrument_name as string]));

  // --- Scheme tax classification (durable cache table, R6-P1's own). -----
  const classificationByInstrument = new Map<string, SchemeClassificationResult>();
  {
    const { data, error } = await supabase.from('ii_scheme_tax_classification').select('instrument_id, classification, domestic_equity_pct, basis, disclosure_date, note').in('instrument_id', instrumentIds);
    if (error && !isMissingTableError(error)) {
      warnings.push({ scope: 'classification', detail: `Scheme classification could not be read (${error.message}).` });
    } else if (error && isMissingTableError(error)) {
      warnings.push({ scope: 'classification', detail: 'ii_scheme_tax_classification is not yet available in this environment (migration 0045 not applied) — every scheme is treated as unresolved.' });
    } else {
      for (const row of data ?? []) {
        classificationByInstrument.set(row.instrument_id as string, {
          instrumentKey: row.instrument_id as string,
          classification: row.classification as SchemeClassificationResult['classification'],
          domesticEquityPct: row.domestic_equity_pct as number | null,
          basis: row.basis as SchemeClassificationResult['basis'],
          disclosureDate: row.disclosure_date as string | null,
          note: (row.note as string | null) ?? '',
        });
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
  const fmv31Jan2018ByInstrument = new Map<string, number | null>();
  {
    const { data, error } = await supabase
      .from('ii_prices_nav')
      .select('instrument_id, price_date, price')
      .in('instrument_id', instrumentIds)
      .lte('price_date', '2018-01-31')
      .order('instrument_id', { ascending: true })
      .order('price_date', { ascending: false }); // most recent on/before 31-Jan-2018 first
    if (error) {
      warnings.push({ scope: 'grandfathering_fmv', detail: `31-Jan-2018 FMV lookup failed (${error.message}) — grandfathering will use acquisition cost only.` });
    } else {
      const seen = new Set<string>();
      for (const row of data ?? []) {
        const id = row.instrument_id as string;
        if (seen.has(id)) continue; // first row per instrument is the closest date <= cutoff (DESC order)
        seen.add(id);
        fmv31Jan2018ByInstrument.set(id, Number(row.price));
      }
    }
  }
  for (const id of instrumentIds) {
    if (!fmv31Jan2018ByInstrument.has(id)) fmv31Jan2018ByInstrument.set(id, null);
  }

  // --- Exit-load schedules. ------------------------------------------------
  const exitLoadSchedules: ExitLoadSchedule[] = [];
  {
    const { data, error } = await supabase.from('ii_exit_load_schedules').select('instrument_id, tiers, effective_from, effective_to').in('instrument_id', instrumentIds);
    if (error && !isMissingTableError(error)) {
      warnings.push({ scope: 'exit_load', detail: `Exit-load schedules could not be read (${error.message}).` });
    } else if (error && isMissingTableError(error)) {
      warnings.push({ scope: 'exit_load', detail: 'ii_exit_load_schedules is not yet available in this environment (migration 0045 not applied) — exit load will not be shown.' });
    } else {
      for (const row of data ?? []) {
        exitLoadSchedules.push({
          instrumentKey: row.instrument_id as string,
          tiers: row.tiers as Array<{ uptoDays: number; loadPct: number }>,
          effectiveFrom: row.effective_from as string,
          effectiveTo: row.effective_to as string | null,
        });
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
    },
    warnings,
    empty: false,
  };
}

/**
 * Persist per-lot-consumption capital-gains + exit-load results. Service-
 * role write, `user_id` set from the SERVER-authenticated session only
 * (never accepted from a client payload) — mirrors persistR5Results's
 * anti-forgery convention. A persistence failure never blocks returning a
 * correct, freshly-computed answer to the caller.
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

    const payload = disposalResults.map((d) => {
      const exitLoad = exitLoadByLotAndDisposal.get(`${d.disposalEventId}:${d.lotId}`);
      return {
        user_id: userId,
        disposal_transaction_id: d.disposalEventId,
        lot_id: d.lotId.startsWith('lot:') ? d.lotId.slice(4) : d.lotId,
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
