// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// Assembles the "Holdings" table shape from the Product Owner's own
// reference workbook: one row per (account, instrument) position, with
// Folio No. / ISIN / Cost Value / Unit Balance / NAV Date / NAV / Market
// Value / Registrar / Gain-Loss / Return % / XIRR.
//
// READ-ONLY, same guarantee as analyticsRepository.ts (spec section 58):
// no write to any FHIP financial register. The only writes anywhere in this
// feature are the AI-fallback cache rows in aiFallbackReconciliation.ts,
// which land in ii_reconciliation_cases — the same table every other R2
// reconciliation finding already uses.
//
// Per-scheme XIRR is NOT recomputed with a third formula here: it is read
// straight from the same PerformanceEngine.computeSchemePerformance() this
// tab's SchemeTable already displays (via loadAnalyticsDataset + runAnalytics),
// so the Holdings row and the "Scheme performance" row never show two
// different numbers for the same position.

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAnalyticsDataset } from './analyticsRepository';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { schemeReconciliationFailed, getAiFallbackReconciliation, describeUnmaskedLedgerForAudit } from './aiFallbackReconciliation';
import { insufficientHistory, type CalculationOutcome } from '@/lib/engines/investment-intelligence/calculationStatus';
import { unitDeltaForTransaction, type ReconciliationTransactionInput } from './reconciliation';
import { computeCostValue, type CostBasisTransaction } from './costBasis';

type XirrOutcome = CalculationOutcome<{ rate: number }>;

export type DataQualityStatus = 'ok' | 'ai_corrected' | 'unresolved';

export interface HoldingRow {
  accountId: string;
  instrumentId: string;
  folioNumber: string | null;
  isin: string | null;
  schemeCode: string | null; // AMFI scheme code, if resolved as an identifier — not always present
  schemeName: string;
  registrar: string | null; // e.g. 'CAMS' — from the certified source document's detected source
  costValue: number | null; // sum of ii_tax_lots.units_remaining * cost_per_unit for this position
  unitBalance: number | null;
  navDate: string | null;
  nav: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  returnPct: number | null;
  xirr: XirrOutcome;
  currencyCode: string;
  dataQuality: {
    status: DataQualityStatus;
    detail: string | null;
  };
}

export interface HoldingsTableResult {
  holdings: HoldingRow[];
  warnings: Array<{ scope: string; detail: string }>;
  empty: boolean;
}

interface TruthRow {
  account_id: string;
  instrument_id: string;
  status: string;
  unit_variance_within_tolerance: boolean | null;
  latest_source_document_id: string | null;
}

interface AccountRow {
  id: string;
  folio_number: string | null;
  institution_name: string;
  currency_code: string;
}

interface InstrumentRow {
  id: string;
  instrument_name: string;
  isin: string | null;
}

interface SnapshotRow {
  account_id: string;
  instrument_id: string;
  as_of_date: string;
  units: number;
  value: number;
  source_document_id: string | null;
  quality_status: string;
}

interface CostTxRow {
  account_id: string;
  instrument_id: string;
  transaction_type: string;
  gross_amount: number;
  units: number | null;
}

export async function loadHoldingsTable(supabase: SupabaseClient, userId: string): Promise<HoldingsTableResult> {
  const warnings: Array<{ scope: string; detail: string }> = [];

  const { dataset, warnings: analyticsWarnings, empty } = await loadAnalyticsDataset(supabase, userId);
  warnings.push(...analyticsWarnings);
  if (empty || !dataset) return { holdings: [], warnings, empty: true };

  const analytics = runAnalytics(dataset);
  const investorXirrByInstrument = new Map(analytics.schemes.map((s) => [s.instrumentId, s.investorXirr]));

  const { data: truthRows } = await supabase
    .from('ii_portfolio_truth_status')
    .select('account_id, instrument_id, status, unit_variance_within_tolerance, latest_source_document_id')
    .eq('user_id', userId);

  const { data: accountRows } = await supabase.from('ii_accounts').select('id, folio_number, institution_name, currency_code').eq('user_id', userId);
  const accountById = new Map(((accountRows ?? []) as AccountRow[]).map((a) => [a.id, a]));

  const instrumentIds = [...new Set((truthRows ?? []).map((t) => t.instrument_id as string))];
  const { data: instrumentRows } = instrumentIds.length
    ? await supabase.from('ii_instruments').select('id, instrument_name, isin').in('id', instrumentIds)
    : { data: [] as InstrumentRow[] };
  const instrumentById = new Map(((instrumentRows ?? []) as InstrumentRow[]).map((i) => [i.id, i]));

  // PC6 scheme master (migration 0155, real write path added 2026-09-20):
  // AMFI's own canonical scheme name, cross-referenced by instrument_id
  // (the same FK the ingest job resolved the real ISIN/AMFI code against).
  // A statement's own RTA-printed name routinely carries an internal scheme
  // code prefix ("108MFGPG-UTI MNC Fund...") the customer never sees on any
  // real document, aggregator or website -- this is real evidence, never
  // guessed, and only used when a current (effective_to is null) row
  // actually exists for this instrument; otherwise the parsed name is kept.
  const { data: schemeMasterRows } = instrumentIds.length
    ? await supabase.from('ii_scheme_master').select('instrument_id, scheme_name').in('instrument_id', instrumentIds).is('effective_to', null)
    : { data: [] as { instrument_id: string; scheme_name: string }[] };
  const canonicalNameByInstrument = new Map((schemeMasterRows ?? []).map((r) => [r.instrument_id, r.scheme_name]));

  const { data: snapshotRows } = await supabase
    .from('ii_holding_snapshots')
    .select('account_id, instrument_id, as_of_date, units, value, source_document_id, quality_status')
    .eq('user_id', userId)
    .order('as_of_date', { ascending: false });
  const latestSnapshotByPosition = new Map<string, SnapshotRow>();
  for (const s of (snapshotRows ?? []) as SnapshotRow[]) {
    const key = `${s.account_id}:${s.instrument_id}`;
    if (!latestSnapshotByPosition.has(key)) latestSnapshotByPosition.set(key, s); // first hit is the latest, thanks to the descending order
  }

  // Cost Value — computed directly from each position's own transaction
  // history (average-cost, see costBasis.ts), NOT from ii_tax_lots.
  // Found live: ii_tax_lots is only ever populated as a side effect of the
  // Tax & Cost tab's capital-gains simulation, which does nothing at all
  // for a position with zero disposals — the overwhelmingly common case,
  // and every position in the Product Owner's own real statement. Under
  // that design, Cost Value could never appear for a pure buy-and-hold
  // holding no matter which tab was visited. This needs no tax-lot record
  // at all — see costBasis.ts's own header for why that is the deliberate,
  // correct choice for this display-only purpose.
  const { data: costTxRows } = await supabase
    .from('ii_transactions')
    .select('account_id, instrument_id, transaction_type, gross_amount, units')
    .eq('user_id', userId)
    .order('transaction_date', { ascending: true })
    .order('id', { ascending: true });
  const costValueByPosition = new Map<string, number>();
  const txsByPosition = new Map<string, CostBasisTransaction[]>();
  for (const t of (costTxRows ?? []) as CostTxRow[]) {
    const key = `${t.account_id}:${t.instrument_id}`;
    const unitsNum = t.units === null ? null : Number(t.units);
    const delta = Number(
      unitDeltaForTransaction({
        canonicalType: t.transaction_type as ReconciliationTransactionInput['canonicalType'],
        unitsScaled: unitsNum === null ? null : BigInt(Math.round(unitsNum * 1_000_000)),
      })
    ) / 1_000_000;
    const list = txsByPosition.get(key) ?? [];
    list.push({ grossAmount: Number(t.gross_amount), unitDelta: delta });
    txsByPosition.set(key, list);
  }
  for (const [key, txs] of txsByPosition) {
    const { costValue } = computeCostValue(txs);
    if (costValue !== null) costValueByPosition.set(key, costValue);
  }

  // Registrar — the certified source document's own detected source key,
  // reached via the latest holding snapshot's source_document_id. Loaded in
  // one bulk query, not one per row.
  const sourceDocIds = [...new Set(((snapshotRows ?? []) as SnapshotRow[]).map((s) => s.source_document_id).filter(Boolean))] as string[];
  const { data: sourceDocRows } = sourceDocIds.length
    ? await supabase.from('ii_source_documents').select('id, source_detected').in('id', sourceDocIds)
    : { data: [] as Array<{ id: string; source_detected: string | null }> };
  const registrarBySourceDoc = new Map((sourceDocRows ?? []).map((d) => [d.id, d.source_detected]));

  const holdings: HoldingRow[] = [];

  for (const truth of (truthRows ?? []) as TruthRow[]) {
    const key = `${truth.account_id}:${truth.instrument_id}`;
    const account = accountById.get(truth.account_id);
    const instrument = instrumentById.get(truth.instrument_id);
    if (!account || !instrument) continue; // orphaned truth row — shouldn't happen, but never fabricate a row from partial data

    const snapshot = latestSnapshotByPosition.get(key);
    const costValue = costValueByPosition.get(key) ?? null;
    const unitBalance = snapshot ? Number(snapshot.units) : null;
    const marketValue = snapshot ? Number(snapshot.value) : null;
    const gainLoss = costValue !== null && marketValue !== null ? marketValue - costValue : null;
    const returnPct = costValue !== null && costValue !== 0 && gainLoss !== null ? gainLoss / costValue : null;
    const registrarKey = snapshot?.source_document_id ? registrarBySourceDoc.get(snapshot.source_document_id) : null;

    const reconciliationFailed = schemeReconciliationFailed({
      status: truth.status,
      unitVarianceWithinTolerance: truth.unit_variance_within_tolerance,
    });

    let dataQuality: HoldingRow['dataQuality'] = { status: 'ok', detail: null };
    let displayUnitBalance = unitBalance;
    let displayMarketValue = marketValue;
    let displayCostValue = costValue;
    let displayGainLoss = gainLoss;
    let displayReturnPct = returnPct;
    let displayXirr: XirrOutcome =
      investorXirrByInstrument.get(truth.instrument_id) ?? insufficientHistory<{ rate: number }>('INSUFFICIENT_HISTORY', 'No XIRR calculation is available for this scheme.');

    if (reconciliationFailed) {
      const fallback = await getAiFallbackReconciliation({
        userId,
        accountId: truth.account_id,
        instrumentId: truth.instrument_id,
        sourceDocumentId: truth.latest_source_document_id,
        request: {
          maskedLedgerText: describeUnmaskedLedgerForAudit(0, String(snapshot?.units ?? '')),
          statementClosingUnits: String(snapshot?.units ?? ''),
        },
      });

      if (fallback.outcome === 'corrected' || fallback.outcome === 'cached') {
        dataQuality = {
          status: 'ai_corrected',
          detail: 'The deterministic parser could not reconcile this scheme against its own statement. An AI-assisted re-extraction produced a corrected, reconciled figure, shown here instead.',
        };
        const correctedUnits = Number(fallback.result.correctedClosingUnits);
        displayUnitBalance = Number.isFinite(correctedUnits) ? correctedUnits : unitBalance;
        // Market value/cost/XIRR are not independently re-derived from the
        // AI-corrected unit count in this task (the AI-fallback pipeline
        // itself is a future-wired seam — see aiFallbackReconciliation.ts) —
        // shown as unresolved rather than silently recomputed against a
        // number this task cannot independently verify end-to-end.
        displayMarketValue = null;
        displayCostValue = null;
        displayGainLoss = null;
        displayReturnPct = null;
        displayXirr = insufficientHistory<{ rate: number }>('PARTIAL_TRANSACTION_HISTORY', 'AI-corrected figure available for units only; value-based metrics withheld pending full AI-fallback wiring.');
      } else {
        const reason =
          fallback.outcome === 'disabled'
            ? 'This scheme’s statement did not reconcile against its own transaction history, and AI-assisted reconciliation is disabled in this environment.'
            : fallback.outcome === 'unavailable'
              ? `This scheme’s statement did not reconcile against its own transaction history. ${fallback.reason}`
              : `This scheme’s statement did not reconcile against its own transaction history, and the AI-assisted reconciliation attempt also failed: ${fallback.reason}`;
        dataQuality = { status: 'unresolved', detail: reason };
        displayUnitBalance = null;
        displayMarketValue = null;
        displayCostValue = null;
        displayGainLoss = null;
        displayReturnPct = null;
        displayXirr = insufficientHistory<{ rate: number }>('PARTIAL_TRANSACTION_HISTORY', 'Withheld — this scheme has an unresolved data-quality issue (see badge).');
      }
    }

    holdings.push({
      accountId: truth.account_id,
      instrumentId: truth.instrument_id,
      folioNumber: account.folio_number,
      isin: instrument.isin,
      schemeCode: null,
      schemeName: canonicalNameByInstrument.get(truth.instrument_id) ?? instrument.instrument_name,
      registrar: registrarKey ? registrarKey.toUpperCase() : null,
      costValue: displayCostValue,
      unitBalance: displayUnitBalance,
      navDate: snapshot?.as_of_date ?? null,
      nav: snapshot && Number(snapshot.units) > 0 ? Number(snapshot.value) / Number(snapshot.units) : null,
      marketValue: displayMarketValue,
      gainLoss: displayGainLoss,
      returnPct: displayReturnPct,
      xirr: displayXirr,
      currencyCode: account.currency_code,
      dataQuality,
    });
  }

  holdings.sort((a, b) => a.schemeName.localeCompare(b.schemeName));
  return { holdings, warnings, empty: holdings.length === 0 };
}
