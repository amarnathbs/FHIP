// Investment Intelligence -- per-position reconciliation and certification (moved unchanged from documentProcessing.ts, Document2 (4)
// WP-J, so that both the synchronous pipeline and the resumable statement job share ONE implementation).
//
// The only addition is an OPTIONAL per-call cache for the open blocking cases of an account (`certifyCache`): the query depends on the
// account and the source document only, so certifying many positions of one account in a row asks it once instead of once per
// position. Without the cache the behaviour is exactly what it was.

import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import { fetchAllRows } from './pagination';
import { loadAccountOwnership } from './accountOwnership';
import { reconcilePosition, determineHistoryCompleteness, evaluateDerivedZeroUnitClosure, type ReconciliationTransactionInput } from './reconciliation';
import { evaluateCertification } from './certification';
import { loadActiveReconciliationConfig } from './reconciliationConfig';
import { scaledToDecimalString, ZERO } from './decimal';
import { isoDateDaysBetween } from './dateNormalisation';
import { OPENING_BALANCE_SOURCE_REFERENCE } from './openingBalanceMarker';
import { filterCertificationBlockingCases } from './crossSourceReviewPolicy';

/** Open blocking cases of one (account, source document), shared by the positions of that account within one slice or run. */
export type CertifyCache = Map<string, Promise<Array<{ id: string; discrepancy_type: string; severity: string }>>>;

// R2 API surface — "certify/re-certify portfolio" (spec section 51).
// Re-runs the certification evaluation for one position on demand (e.g.
// after a user resolves a reconciliation case) WITHOUT requiring a fresh
// document upload — gathers the current owner/instrument-resolution state
// fresh from the database rather than reusing a stale in-memory flag from
// whatever the last processing run happened to compute.
export async function recertifyPosition(userId: string, accountId: string, instrumentId: string): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();

  const { data: account, error: accountErr } = await admin.from('ii_accounts').select('id, owner_member_id, source_document_id').eq('id', accountId).eq('user_id', userId).maybeSingle();
  if (accountErr || !account) return { ok: false, error: accountErr?.message ?? 'Account not found or not owned by this user.' };

  const { data: latestSnapshot } = await admin
    .from('ii_holding_snapshots')
    .select('source_document_id')
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .order('as_of_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const sourceDocumentId = (latestSnapshot?.source_document_id as string | null) ?? (account.source_document_id as string | null) ?? accountId;

  const config = await loadActiveReconciliationConfig();
  // An entity / joint owner is a DECIDED owner (owner_member_id is null by
  // design) -- only a genuinely unassigned account is "unresolved".
  const effectiveOwnership = await loadAccountOwnership(admin, userId, accountId);
  const ownerUnresolved = effectiveOwnership ? effectiveOwnership.ownership.kind === 'unassigned' : !account.owner_member_id;

  const { data: instrumentCases } = await admin
    .from('ii_reconciliation_cases')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'open')
    .eq('discrepancy_type', 'ambiguous_instrument')
    .eq('source_document_id', sourceDocumentId);
  const anyInstrumentUnresolved = (instrumentCases ?? []).length > 0;

  // Unchanged/out of scope (II-PC3 finding, see the primary call site in
  // processSourceDocument for the full rationale): this manual re-certify
  // path has no fresh ParsedDocumentOutput to inspect, only already-
  // persisted state, so it cannot know about a parse-time error without a
  // separate lookup — deliberately not expanded here to keep the fix
  // narrow to the one call site that actually has the signal.
  await evaluatePositionAndCertify(admin, userId, accountId, instrumentId, sourceDocumentId, config, ownerUnresolved, anyInstrumentUnresolved, false);
  return { ok: true, error: null };
}

// FULLY-REDEEMED / ZERO-UNIT POSITION FIX (Document2 final non-benchmark
// closure, mission item #6, 2026-09-30). Known defect: a fully redeemed
// position (every unit switched/redeemed/transferred out) can never be
// re-evaluated/certified — it stays stuck at whatever status it had before
// the redemption, forever, purely because `evaluatePositionAndCertify`
// below has nothing to certify against.
//
// ROOT CAUSE (traced transactions -> reconciliation -> holding/position
// state -> certification rules, per this mission's own instruction, not
// assumed): section 6 above ("Holding snapshots") only ever writes a row
// for a scheme that appears in `parsed.holdings` — the statement's OWN
// "current holdings" table. A fully redeemed position holds nothing, so it
// is never printed in ANY subsequent statement's holdings section — there
// is nothing left to print. No terminal units=0 snapshot is therefore ever
// written for it. `evaluatePositionAndCertify` then either finds NO
// snapshot at all (returns early, nothing certified) or a STALE
// pre-redemption snapshot with a real positive unit balance (certifies
// against out-of-date data, oblivious to the redemption). Either way the
// position is permanently invisible to certification.
//
// FIX: derive a canonical closing snapshot directly from the
// already-persisted, already-reconciled transaction ledger whenever doing
// so PROVES (never assumes) the position is fully redeemed to zero units as
// of its own last transaction. This is exactly the case
// `ii_holding_snapshots.source_document_id`'s own migration-0033 comment
// already anticipated ("nullable: can also be derived by replaying
// ii_transactions") — no new table, no new column, no new status value.
// Once a derived row exists, the UNCHANGED `evaluateCertification` below
// naturally reaches 'certified'/'certified_with_warnings' with
// reconciledClosingUnits=0 and value=0 — it never fabricates a non-zero
// holding and never needs a current NAV (units=0 implies value=0
// unconditionally, see reconcilePosition/unitDeltaForTransaction).
//
// Safety: only ever moves a position TOWARDS a zero-unit terminal state
// when the transaction stream since the last known baseline proves it
// nets to zero within the configured unit tolerance; a genuine reduction to
// a NON-zero balance, a negative-unit reconciliation error, or a stream
// that opens with an outflow (missing earlier history, not a complete
// one) are all left completely untouched — those remain real, separate
// reconciliation problems this fix does not paper over. Idempotent: the
// unique index on (account_id, instrument_id, as_of_date) makes a repeated
// call either a no-op upsert of the same row or a genuine progression to a
// later as-of date; it never creates a duplicate canonical position.
// The DECISION (does this transaction stream prove full redemption to zero
// units?) is pure logic, unit-tested independently in
// tests/unit/iiZeroUnitClosureReconciliation.test.ts — see
// `evaluateDerivedZeroUnitClosure` in reconciliation.ts for the full
// negative-control contract (A-I in the mission's own list: genuine full
// redemption, erroneous negative units, rounding-only apparent zero,
// partial redemption, redeem-then-repurchase, no-current-NAV, unresolved
// owner/instrument left blocked, idempotent repeat, no duplicate publish).
// This function is only the DB I/O: fetch the transaction stream since the
// last known baseline, ask the pure function, and only ever WRITE when it
// says 'fully_redeemed'.
async function ensureDerivedZeroUnitClosingSnapshot(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  accountId: string,
  instrumentId: string,
  config: Awaited<ReturnType<typeof loadActiveReconciliationConfig>>,
  existingLatestSnapshot: Record<string, unknown> | null
): Promise<Record<string, unknown> | null> {
  const { parseExactDecimal } = await import('./decimal');
  const baselineDate = existingLatestSnapshot ? (existingLatestSnapshot.as_of_date as string) : null;

  const txnsSinceBaseline = await fetchAllRows<{ transaction_type: string; units: string | number | null; transaction_date: string; currency_code: string }>(() => {
    const query = admin
      .from('ii_transactions')
      .select('transaction_type, units, transaction_date, currency_code')
      .eq('account_id', accountId)
      .eq('instrument_id', instrumentId)
      .neq('status', 'reversed') // WP-H3: a replaced row is out of the figures
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true });
    return baselineDate ? query.gt('transaction_date', baselineDate) : query;
  });

  const existingSnapshotUnitsScaled = existingLatestSnapshot
    ? (() => {
        const parsedUnits = parseExactDecimal(String(existingLatestSnapshot.units));
        return parsedUnits.ok ? parsedUnits.scaled : null;
      })()
    : null;

  const outcome = evaluateDerivedZeroUnitClosure({
    hasExistingSnapshot: !!existingLatestSnapshot,
    existingSnapshotUnitsScaled,
    transactionsSinceBaseline: txnsSinceBaseline.map((t) => {
      const unitsParsed = t.units === null ? null : parseExactDecimal(String(t.units));
      return { canonicalType: t.transaction_type as ReconciliationTransactionInput['canonicalType'], unitsScaled: unitsParsed && unitsParsed.ok ? unitsParsed.scaled : null };
    }),
    config,
  });
  if (outcome.kind !== 'fully_redeemed') return existingLatestSnapshot; // no_new_activity / malformed_existing_units / insufficient_history / not_fully_redeemed — all leave existing behaviour untouched

  const asOfDate = txnsSinceBaseline[outcome.asOfTransactionIndex].transaction_date;
  const currencyCode = (existingLatestSnapshot?.currency_code as string | undefined) ?? txnsSinceBaseline[outcome.asOfTransactionIndex].currency_code;

  const { data: derived, error } = await admin
    .from('ii_holding_snapshots')
    .upsert(
      {
        user_id: userId,
        account_id: accountId,
        instrument_id: instrumentId,
        source_document_id: null, // derived by replaying ii_transactions, not printed on any one statement — see migration 0033's own column comment
        currency_code: currencyCode,
        quality_status: 'warning', // same convention as a statement-derived row — upgraded to 'certified' below once evaluateCertification passes
        as_of_date: asOfDate,
        units: '0',
        value: '0',
        parser_code: 'system_derived_zero_unit_closure',
      },
      { onConflict: 'account_id,instrument_id,as_of_date' }
    )
    .select('*')
    .single();
  if (error || !derived) {
    console.error('[investment-intelligence] derived zero-unit closing snapshot upsert failed', { userId, accountId, instrumentId, error: error?.message });
    return existingLatestSnapshot;
  }
  return derived as Record<string, unknown>;
}

export async function evaluatePositionAndCertify(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  accountId: string,
  instrumentId: string,
  sourceDocumentId: string,
  config: Awaited<ReturnType<typeof loadActiveReconciliationConfig>>,
  ownerUnresolved: boolean,
  anyInstrumentUnresolved: boolean,
  parserHasFatalError: boolean,
  certifyCache?: CertifyCache
) {
  const { data: fetchedLatestSnapshot } = await admin
    .from('ii_holding_snapshots')
    .select('*')
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .order('as_of_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestSnapshot = await ensureDerivedZeroUnitClosingSnapshot(admin, userId, accountId, instrumentId, config, fetchedLatestSnapshot);
  if (!latestSnapshot) return; // no certified closing balance for this position yet — nothing to certify

  // R6-P0: unbounded before. This is the unit-reconciliation input that
  // decides whether a position can be CERTIFIED, so a silently truncated
  // transaction history produces a wrong derived unit balance and therefore a
  // wrong certification verdict. A long-running daily/weekly SIP in one scheme
  // passes 1000 transactions. `transaction_date` repeats, so `id` supplies the
  // unique tie-breaker.
  const allTxns = await fetchAllRows<{ transaction_type: string; units: number; transaction_date: string; source_reference: string | null }>(() =>
    admin
      .from('ii_transactions')
      .select('transaction_type, units, transaction_date, source_reference')
      .eq('account_id', accountId)
      .eq('instrument_id', instrumentId)
      .neq('status', 'reversed') // WP-H3: a replaced row is out of the figures
      .lte('transaction_date', latestSnapshot.as_of_date as string)
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true })
  );

  const { data: earlierSnapshot } = await admin
    .from('ii_holding_snapshots')
    .select('units, as_of_date')
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .lt('as_of_date', latestSnapshot.as_of_date as string)
    .order('as_of_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { parseExactDecimal } = await import('./decimal');
  const openingScaled = earlierSnapshot ? (parseExactDecimal(String(earlierSnapshot.units)).ok ? (parseExactDecimal(String(earlierSnapshot.units)) as { ok: true; scaled: bigint }).scaled : null) : null;

  const txnInputs: ReconciliationTransactionInput[] = (allTxns ?? [])
    .filter((t) => (earlierSnapshot ? (t.transaction_date as string) > (earlierSnapshot.as_of_date as string) : true))
    .map((t) => {
      const parsedUnits = t.units === null ? null : parseExactDecimal(String(t.units));
      return { canonicalType: t.transaction_type as ReconciliationTransactionInput['canonicalType'], unitsScaled: parsedUnits && parsedUnits.ok ? parsedUnits.scaled : null };
    });

  // FS1 fix (dispatch sections 4, 17, 28): this was previously hardcoded
  // `false` unconditionally, meaning `determineHistoryCompleteness` could
  // never return 'complete_from_known_opening_balance' for ANY document —
  // a genuine printed "Opening Balance" line (camsFolioStatementParser.ts's
  // OPENING_BALANCE_SOURCE_REFERENCE marker, an 'adjustment'-typed
  // transaction that is never a purchase/acquisition — see that file's
  // header comment) is detected here across this position's FULL
  // transaction history to date, not just the current reconciliation
  // window, so a position that had a known opening balance established at
  // its very first import keeps reporting that honestly on every later
  // reimport/recertify too, rather than reverting to a misleading
  // 'complete_from_inception' just because the marker row itself predates
  // the current window's filter.
  const hasExplicitOpeningBalanceTransaction = (allTxns ?? []).some((t) => t.source_reference === OPENING_BALANCE_SOURCE_REFERENCE);

  const historyCompleteness = determineHistoryCompleteness({
    hasExplicitOpeningBalanceTransaction,
    hasAnyTransactionHistory: txnInputs.length > 0,
    hasClosingHoldingSnapshot: true,
    statementCoversFromInception: !earlierSnapshot && txnInputs.length > 0 && !hasExplicitOpeningBalanceTransaction,
  });

  const statementClosingParsed = parseExactDecimal(String(latestSnapshot.units));
  const statementClosingUnitsScaled = statementClosingParsed.ok ? statementClosingParsed.scaled : ZERO;

  const reconciliation = reconcilePosition({
    openingUnitsScaled: openingScaled,
    transactions: txnInputs,
    statementClosingUnitsScaled,
    historyCompleteness,
    config,
  });

  const loadOpenBlockingCases = async () => {
    const { data } = await admin
      .from('ii_reconciliation_cases')
      .select('id, discrepancy_type, severity')
      .eq('user_id', userId)
      .eq('status', 'open')
      .in('severity', ['blocking', 'high'])
      .or(`subject_id.eq.${accountId},subject_id.eq.${sourceDocumentId}`);
    return (data ?? []) as Array<{ id: string; discrepancy_type: string; severity: string }>;
  };
  let openBlockingCasesRaw: Array<{ id: string; discrepancy_type: string; severity: string }>;
  if (certifyCache) {
    const cacheKey = `${accountId}:${sourceDocumentId}`;
    let pending = certifyCache.get(cacheKey);
    if (!pending) {
      pending = loadOpenBlockingCases();
      certifyCache.set(cacheKey, pending);
    }
    openBlockingCasesRaw = await pending;
  } else {
    openBlockingCasesRaw = await loadOpenBlockingCases();
  }
  // Document2 D-5 (PO 2026-10-03): an open cross-source (statement vs manual)
  // probable duplicate is highlighted for the user but NEVER blocks
  // certification -- including a legacy case opened at 'high' severity before
  // this rule. Detection is unchanged; only its power to block is removed.
  const openBlockingCases = filterCertificationBlockingCases(openBlockingCasesRaw);

  const asOfDate = latestSnapshot.as_of_date as string;
  const today = new Date().toISOString().slice(0, 10);
  const staleDays = isoDateDaysBetween(asOfDate, today);

  const certification = evaluateCertification({
    sourceDetected: true,
    parserFatalError: parserHasFatalError,
    documentCorrupt: false,
    ownerUnresolved,
    instrumentUnresolved: anyInstrumentUnresolved,
    crossHouseholdConflict: false,
    invalidCanonicalRecord: false,
    hasOpenBlockingReconciliationCase: (openBlockingCases ?? []).length > 0,
    hasMaterialUnclassifiedTransaction: (openBlockingCases ?? []).some((c) => c.discrepancy_type === 'transaction_unclassified' && c.severity === 'high'),
    hasNonMaterialUnclassifiedTransaction: (openBlockingCases ?? []).some((c) => c.discrepancy_type === 'transaction_unclassified' && c.severity === 'low'),
    reconciliation,
    historyCompleteness,
    staleStatementDays: staleDays,
    staleThresholdDays: config.statementFreshnessWarningDays,
  });

  const nowIso = new Date().toISOString();
  await admin.from('ii_portfolio_truth_status').upsert(
    {
      user_id: userId,
      account_id: accountId,
      instrument_id: instrumentId,
      status: certification.status,
      history_completeness: historyCompleteness,
      latest_holding_snapshot_id: latestSnapshot.id,
      latest_source_document_id: sourceDocumentId,
      reconciled_opening_units: reconciliation.reconciledOpeningUnitsScaled === null ? null : scaledToDecimalString(reconciliation.reconciledOpeningUnitsScaled),
      reconciled_closing_units: reconciliation.reconciledClosingUnitsScaled === null ? null : scaledToDecimalString(reconciliation.reconciledClosingUnitsScaled),
      statement_closing_units: scaledToDecimalString(reconciliation.statementClosingUnitsScaled),
      unit_variance: reconciliation.unitVarianceScaled === null ? null : scaledToDecimalString(reconciliation.unitVarianceScaled),
      unit_variance_within_tolerance: reconciliation.withinTolerance,
      statement_freshness_days: staleDays,
      blocking_reasons: certification.blockingReasons,
      warning_reasons: certification.warningReasons,
      certified_at: certification.status === 'certified' || certification.status === 'certified_with_warnings' ? nowIso : null,
      last_evaluated_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: 'account_id,instrument_id' }
  );

  if (certification.status === 'certified') {
    await admin.from('ii_holding_snapshots').update({ quality_status: 'certified' }).eq('id', latestSnapshot.id);
    await emitAuditEvent({ userId, eventType: 'portfolio_certified', subjectType: 'ii_portfolio_truth_status', subjectId: `${accountId}:${instrumentId}`, actorType: 'system', metadata: { accountId, instrumentId, sourceDocumentId } });
  } else if (certification.status === 'certified_with_warnings') {
    await admin.from('ii_holding_snapshots').update({ quality_status: 'certified' }).eq('id', latestSnapshot.id);
    await emitAuditEvent({ userId, eventType: 'portfolio_certified_with_warnings', subjectType: 'ii_portfolio_truth_status', subjectId: `${accountId}:${instrumentId}`, actorType: 'system', metadata: { accountId, instrumentId, sourceDocumentId, warnings: certification.warningReasons } });
  } else if (certification.status === 'failed') {
    await emitAuditEvent({ userId, eventType: 'portfolio_failed', subjectType: 'ii_portfolio_truth_status', subjectId: `${accountId}:${instrumentId}`, actorType: 'system', metadata: { accountId, instrumentId, sourceDocumentId, blockers: certification.blockingReasons } });
  }
}
