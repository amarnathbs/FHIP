/**
 * FDH-11 bridge — Portfolio Truth certification for an AU broker position
 * after Apply (canonical-upload WP-12, INV-G1).
 *
 * WHY NOT `recertifyPosition` (documentProcessing.ts). The plan asked for it,
 * and it is the right RULES -- but it cannot certify an AU position: it
 * resolves a source-document id as
 *   snapshot.source_document_id ?? account.source_document_id ?? accountId
 * and writes that into `ii_portfolio_truth_status.latest_source_document_id`,
 * which is a FOREIGN KEY to `ii_source_documents` (migration 0041:85). An AU
 * broker statement has no `ii_source_documents` row (its provenance is the FDH
 * evidence row), so the fallback writes an ACCOUNT id into that FK, the upsert
 * fails, and -- because that upsert's error is not checked -- nothing is
 * certified and nothing can ever be published. documentProcessing.ts is the
 * India CAS engine and is deliberately not modified by this package.
 *
 * So this module runs the SAME certification with the SAME pure functions
 * Investment Intelligence exports -- `determineHistoryCompleteness`,
 * `reconcilePosition`, `evaluateCertification`, the versioned
 * `loadActiveReconciliationConfig` -- over the same inputs (the account's
 * owner, the latest and previous snapshots, the unit history between them,
 * open blocking cases on the account), and records the result with
 * `latest_source_document_id = null`. No rule is restated here; only the
 * orchestration the private function performs is repeated, without its FK
 * defect. Every read is user-scoped (it used to read snapshots by account id
 * alone).
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { evaluateCertification } from '@/lib/services/investment-intelligence/certification';
import { isoDateDaysBetween } from '@/lib/services/investment-intelligence/dateNormalisation';
import { parseExactDecimal, scaledToDecimalString, ZERO } from '@/lib/services/investment-intelligence/decimal';
import { OPENING_BALANCE_SOURCE_REFERENCE } from '@/lib/services/investment-intelligence/openingBalanceMarker';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import { determineHistoryCompleteness, reconcilePosition, type ReconciliationTransactionInput } from '@/lib/services/investment-intelligence/reconciliation';
import { loadActiveReconciliationConfig } from '@/lib/services/investment-intelligence/reconciliationConfig';

export interface AuCertificationResult {
  accountId: string;
  instrumentId: string;
  status: string | null;
  blockingReasons: { code: string; message: string }[];
  warningReasons: { code: string; message: string }[];
  error: string | null;
}

export async function certifyAuPosition(userId: string, accountId: string, instrumentId: string): Promise<AuCertificationResult> {
  const admin = createAdminClient();
  const fail = (error: string): AuCertificationResult => ({ accountId, instrumentId, status: null, blockingReasons: [], warningReasons: [], error });

  const { data: account, error: accountErr } = await admin.from('ii_accounts').select('id, owner_member_id').eq('id', accountId).eq('user_id', userId).maybeSingle();
  if (accountErr || !account) return fail(accountErr?.message ?? 'Account not found or not owned by this user.');

  const { data: latest } = await admin
    .from('ii_holding_snapshots')
    .select('id, as_of_date, units')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .order('as_of_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return fail('No holding snapshot exists for this position yet.');

  const { data: earlier } = await admin
    .from('ii_holding_snapshots')
    .select('units, as_of_date')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .lt('as_of_date', latest.as_of_date as string)
    .order('as_of_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const allTxns = await fetchAllRows<{ transaction_type: string; units: number | null; transaction_date: string; source_reference: string | null }>(() =>
    admin
      .from('ii_transactions')
      .select('transaction_type, units, transaction_date, source_reference')
      .eq('user_id', userId)
      .eq('account_id', accountId)
      .eq('instrument_id', instrumentId)
      .lte('transaction_date', latest.as_of_date as string)
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true }),
  );

  const scaled = (v: unknown): bigint | null => {
    if (v === null || v === undefined) return null;
    const p = parseExactDecimal(String(v));
    return p.ok ? p.scaled : null;
  };
  const txnInputs: ReconciliationTransactionInput[] = allTxns
    .filter((t) => (earlier ? t.transaction_date > (earlier.as_of_date as string) : true))
    .map((t) => ({ canonicalType: t.transaction_type as ReconciliationTransactionInput['canonicalType'], unitsScaled: scaled(t.units) }));
  const hasExplicitOpeningBalanceTransaction = allTxns.some((t) => t.source_reference === OPENING_BALANCE_SOURCE_REFERENCE);
  const historyCompleteness = determineHistoryCompleteness({
    hasExplicitOpeningBalanceTransaction,
    hasAnyTransactionHistory: txnInputs.length > 0,
    hasClosingHoldingSnapshot: true,
    statementCoversFromInception: !earlier && txnInputs.length > 0 && !hasExplicitOpeningBalanceTransaction,
  });

  const config = await loadActiveReconciliationConfig();
  const reconciliation = reconcilePosition({
    openingUnitsScaled: earlier ? scaled(earlier.units) : null,
    transactions: txnInputs,
    statementClosingUnitsScaled: scaled(latest.units) ?? ZERO,
    historyCompleteness,
    config,
  });

  const { data: blockingCases } = await admin
    .from('ii_reconciliation_cases')
    .select('id, discrepancy_type, severity')
    .eq('user_id', userId)
    .eq('status', 'open')
    .eq('subject_id', accountId)
    .in('severity', ['blocking', 'high']);
  const cases = (blockingCases ?? []) as { discrepancy_type: string; severity: string }[];

  const today = new Date().toISOString().slice(0, 10);
  const staleDays = isoDateDaysBetween(latest.as_of_date as string, today);
  const certification = evaluateCertification({
    sourceDetected: true,
    parserFatalError: false,
    documentCorrupt: false,
    ownerUnresolved: !account.owner_member_id,
    // The instrument is the one the user confirmed at review (Apply refuses an
    // unmatched line), so it is resolved by construction.
    instrumentUnresolved: false,
    crossHouseholdConflict: false,
    invalidCanonicalRecord: false,
    hasOpenBlockingReconciliationCase: cases.length > 0,
    hasMaterialUnclassifiedTransaction: cases.some((c) => c.discrepancy_type === 'transaction_unclassified' && c.severity === 'high'),
    hasNonMaterialUnclassifiedTransaction: false,
    reconciliation,
    historyCompleteness,
    staleStatementDays: staleDays,
    staleThresholdDays: config.statementFreshnessWarningDays,
  });

  const nowIso = new Date().toISOString();
  const certified = certification.status === 'certified' || certification.status === 'certified_with_warnings';
  const { error: upsertErr } = await admin.from('ii_portfolio_truth_status').upsert(
    {
      user_id: userId,
      account_id: accountId,
      instrument_id: instrumentId,
      status: certification.status,
      history_completeness: historyCompleteness,
      latest_holding_snapshot_id: latest.id,
      // An AU broker statement has no ii_source_documents row; its provenance
      // is the FDH evidence row (positions.canonical_holding_snapshot_id).
      latest_source_document_id: null,
      reconciled_opening_units: reconciliation.reconciledOpeningUnitsScaled === null ? null : scaledToDecimalString(reconciliation.reconciledOpeningUnitsScaled),
      reconciled_closing_units: reconciliation.reconciledClosingUnitsScaled === null ? null : scaledToDecimalString(reconciliation.reconciledClosingUnitsScaled),
      statement_closing_units: scaledToDecimalString(reconciliation.statementClosingUnitsScaled),
      unit_variance: reconciliation.unitVarianceScaled === null ? null : scaledToDecimalString(reconciliation.unitVarianceScaled),
      unit_variance_within_tolerance: reconciliation.withinTolerance,
      statement_freshness_days: staleDays,
      blocking_reasons: certification.blockingReasons,
      warning_reasons: certification.warningReasons,
      certified_at: certified ? nowIso : null,
      last_evaluated_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: 'account_id,instrument_id' },
  );
  if (upsertErr) return fail(`ii_portfolio_truth_status: ${upsertErr.message}`);

  if (certified) {
    await admin.from('ii_holding_snapshots').update({ quality_status: 'certified' }).eq('id', latest.id).eq('user_id', userId);
    await emitAuditEvent({
      userId,
      eventType: certification.status === 'certified' ? 'portfolio_certified' : 'portfolio_certified_with_warnings',
      subjectType: 'ii_portfolio_truth_status',
      subjectId: `${accountId}:${instrumentId}`,
      actorType: 'system',
      metadata: { accountId, instrumentId, source: 'fdh11_au_statement', warnings: certification.warningReasons.map((w) => w.code) },
    });
  }

  return { accountId, instrumentId, status: certification.status, blockingReasons: certification.blockingReasons, warningReasons: certification.warningReasons, error: null };
}
