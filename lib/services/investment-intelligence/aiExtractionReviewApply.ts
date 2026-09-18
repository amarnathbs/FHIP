// Investment Intelligence — AI-fallback document extraction: explicit
// accept/reject (2026-09-17 PO addendum).
//
// HARD REQUIREMENT: canonical ii_transactions/ii_holding_snapshots rows are
// written ONLY from applyAiExtractionReview(), which is ONLY ever called
// from the accept API route after the user has explicitly reviewed and
// accepted a pending ii_ai_extraction_reviews row. Nothing in
// aiFallbackDocumentExtraction.ts writes a single canonical row.
//
// Reuses the SAME primitives documentProcessing.ts's deterministic path
// uses — resolveOrCreateAccount, resolveScheme, computeTransactionFingerprint,
// recertifyPosition, detectMissingTransactions, the OPENING_BALANCE_SOURCE_
// REFERENCE marker convention — rather than a second, parallel
// implementation of dedup/certification/reconciliation math. The only new
// orchestration here is the loop wiring those primitives together for a
// small, already-reviewed AI-extracted batch (no PDF extraction, no source
// detection, no multi-AMC resolution complexity — that's all upstream of
// this module).

import { createAdminClient } from '@/lib/supabase/admin';
import { resolveOrCreateAccount } from './accountResolution';
import { resolveScheme, type AliasMapRow, type ExistingInstrumentForResolution } from './schemeResolution';
import { normaliseSchemeName } from './parsers/textUtils';
import { computeTransactionFingerprint } from './fingerprint';
import { fromPlainNumber, scaledToDecimalString } from './decimal';
import { fetchAllRows } from './pagination';
import { recertifyPosition } from './documentProcessing';
import { detectMissingTransactions } from './missingTransactionDetection';
import { openReconciliationCase } from './reconciliationCases';
import { OPENING_BALANCE_SOURCE_REFERENCE } from './openingBalanceMarker';
import type { AieExtractedHolding } from './aiFallbackDocumentExtraction';
import type { IiTransactionType, IiPlanType, IiOptionType } from './types';

const VALID_TRANSACTION_TYPES = new Set<IiTransactionType>([
  'purchase', 'sip', 'redemption', 'switch_in', 'switch_out', 'dividend', 'reinvestment', 'transfer', 'merger', 'fee', 'tax', 'adjustment',
  'stp_in', 'stp_out', 'swp', 'transfer_in', 'transfer_out', 'reversal', 'segregation', 'unclassified', 'bonus', 'split', 'sale',
]);

/** Never trust an AI-supplied type string blindly — validated against the
 * SAME closed enum documentProcessing.ts's own database CHECK constraint
 * enforces. An unrecognised value degrades to 'unclassified' (already an
 * existing, certification-visible category) rather than being rejected or
 * silently coerced into something economically wrong like 'purchase'. */
function validateCanonicalType(raw: string): IiTransactionType {
  return VALID_TRANSACTION_TYPES.has(raw as IiTransactionType) ? (raw as IiTransactionType) : 'unclassified';
}

export interface ApplyAiExtractionReviewResult {
  ok: boolean;
  error: string | null;
  summary?: {
    accountsFound: number;
    schemesFound: number;
    newTransactionsCount: number;
    duplicateTransactionsLinked: number;
    missingTransactionsCount: number;
  };
}

export async function applyAiExtractionReview(userId: string, reviewId: string): Promise<ApplyAiExtractionReviewResult> {
  const admin = createAdminClient();

  const { data: review, error: reviewErr } = await admin
    .from('ii_ai_extraction_reviews')
    .select('*')
    .eq('id', reviewId)
    .eq('user_id', userId)
    .maybeSingle();
  if (reviewErr || !review) return { ok: false, error: 'AI extraction review not found.' };
  if (review.status !== 'pending_review') return { ok: false, error: `This review has already been ${review.status}.` };

  const { data: doc } = await admin.from('ii_source_documents').select('country_code, owner_member_id').eq('id', review.source_document_id).eq('user_id', userId).maybeSingle();
  if (!doc) return { ok: false, error: 'Source document not found.' };
  const countryCode = doc.country_code as string;
  const currencyCode = countryCode === 'IN' ? 'INR' : 'AUD';

  const holdings = review.extracted_holdings as AieExtractedHolding[];

  // Bulk-load the existing instrument universe once, matching
  // documentProcessing.ts step 4's own bulk-load pattern (R6-P0 pagination
  // discipline — see that file's comment for why an unbounded select here
  // would be dangerous, not just incomplete).
  const existingIdentifierRows = await fetchAllRows<{ instrument_id: string; identifier_scheme: string; identifier_value: string; country_code: string }>(() =>
    admin.from('ii_instrument_identifiers').select('instrument_id, identifier_scheme, identifier_value, country_code').eq('is_active', true).order('id', { ascending: true })
  );
  const existingInstrumentRows = await fetchAllRows<{
    id: string; instrument_name: string; amc_name: string | null; plan_type: string | null; option_type: string | null; country_of_domicile: string;
  }>(() => admin.from('ii_instruments').select('id, instrument_name, amc_name, plan_type, option_type, country_of_domicile').eq('is_active', true).order('id', { ascending: true }));
  const aliasRowsRaw = await fetchAllRows<Record<string, unknown>>(() => admin.from('ii_scheme_alias_map').select('*').eq('is_active', true).order('id', { ascending: true }));

  const existingForResolution: ExistingInstrumentForResolution[] = existingInstrumentRows.map((r) => ({
    instrumentId: r.id,
    isin: existingIdentifierRows.find((i) => i.instrument_id === r.id && i.identifier_scheme === 'isin')?.identifier_value ?? null,
    amfiSchemeCode: existingIdentifierRows.find((i) => i.instrument_id === r.id && i.identifier_scheme === 'amfi_scheme_code')?.identifier_value ?? null,
    internalProvisionalCode: existingIdentifierRows.find((i) => i.instrument_id === r.id && i.identifier_scheme === 'internal_provisional')?.identifier_value ?? null,
    normalisedSchemeName: normaliseSchemeName(r.instrument_name),
    amcName: r.amc_name,
    planType: (r.plan_type as IiPlanType) ?? null,
    optionType: (r.option_type as IiOptionType) ?? null,
    countryCode: r.country_of_domicile,
  }));
  const aliasRows: AliasMapRow[] = aliasRowsRaw.map((a) => ({
    rawSchemeNameNormalised: a.raw_scheme_name_normalised as string,
    amcName: (a.amc_name as string) ?? null,
    planType: (a.plan_type as IiPlanType) ?? null,
    optionType: (a.option_type as IiOptionType) ?? null,
    countryCode: (a.country_code as string) ?? null,
    resolvedInstrumentId: a.resolved_instrument_id as string,
  }));

  const accountsTouched = new Set<string>();
  const schemesTouched = new Set<string>();
  let newTransactionsCount = 0;
  let duplicateTransactionsLinked = 0;
  const coveredPositions: { accountId: string; instrumentId: string }[] = [];
  const confirmedFingerprintsByPosition = new Map<string, Set<string>>();
  const existingFingerprintsByAccount = new Map<string, Map<string, string>>(); // accountId -> fingerprint -> transactionId

  async function loadExistingFingerprints(accountId: string): Promise<Map<string, string>> {
    const cached = existingFingerprintsByAccount.get(accountId);
    if (cached) return cached;
    const rows = await fetchAllRows<{ id: string; transaction_fingerprint: string }>(() =>
      admin.from('ii_transactions').select('id, transaction_fingerprint').eq('user_id', userId).eq('account_id', accountId)
    );
    const map = new Map(rows.map((r) => [r.transaction_fingerprint, r.id]));
    existingFingerprintsByAccount.set(accountId, map);
    return map;
  }

  for (const holding of holdings) {
    const resolvedAccount = await resolveOrCreateAccount(userId, {
      accountType: 'mf_folio',
      institutionName: holding.amcName ?? 'Unknown AMC',
      countryCode,
      currencyCode,
      folioNumber: holding.folioNumber,
      ownerMemberId: (doc.owner_member_id as string | null) ?? null,
      sourceDocumentId: review.source_document_id as string,
    });
    if (!resolvedAccount.accountId) continue;
    const accountId = resolvedAccount.accountId;
    accountsTouched.add(accountId);

    const normalisedSchemeName = normaliseSchemeName(holding.schemeName);
    const outcome = resolveScheme(
      { isin: holding.isin, amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName, amcName: holding.amcName ?? '', planType: 'not_applicable', optionType: 'not_applicable', countryCode },
      existingForResolution,
      aliasRows
    );

    let instrumentId: string | null = null;
    if (outcome.kind === 'resolved') {
      instrumentId = outcome.instrumentId;
    } else if (outcome.kind === 'unresolved') {
      const { data: created } = await admin
        .from('ii_instruments')
        .insert({
          instrument_name: holding.schemeName,
          instrument_class: 'mutual_fund',
          country_of_domicile: countryCode,
          base_currency: currencyCode,
          isin: holding.isin,
          status: 'provisional',
          amc_name: holding.amcName,
        })
        .select('id')
        .single();
      if (created) {
        instrumentId = created.id as string;
        existingForResolution.push({
          instrumentId,
          isin: holding.isin,
          amfiSchemeCode: null,
          internalProvisionalCode: null,
          normalisedSchemeName,
          amcName: holding.amcName,
          planType: null,
          optionType: null,
          countryCode,
        });
        if (holding.isin) {
          await admin.from('ii_instrument_identifiers').insert({ instrument_id: instrumentId, identifier_scheme: 'isin', identifier_value: holding.isin, country_code: countryCode });
        }
      }
    } else {
      // ambiguous — never guess; flag for a human, skip this holding.
      await openReconciliationCase(userId, {
        subjectType: 'account',
        subjectId: accountId,
        discrepancyType: 'ambiguous_instrument',
        severity: 'high',
        sourceDocumentId: review.source_document_id as string,
        details: { scheme: holding.schemeName, matchedVia: outcome.matchedVia, candidateInstrumentIds: outcome.candidateInstrumentIds, reason: outcome.reason, source: 'ai_extraction_review' },
      });
      continue;
    }
    if (!instrumentId) continue;
    schemesTouched.add(instrumentId);
    coveredPositions.push({ accountId, instrumentId });

    const existingFingerprints = await loadExistingFingerprints(accountId);
    const positionKey = `${accountId}:${instrumentId}`;

    for (const t of holding.transactions) {
      const canonicalType = validateCanonicalType(t.canonicalType);
      const amountScaled = fromPlainNumber(t.amount);
      const unitsScaled = t.units === null ? null : fromPlainNumber(t.units);
      const navScaled = t.navPrice === null ? null : fromPlainNumber(t.navPrice);
      const fingerprint = computeTransactionFingerprint({
        sourceKey: 'ai_fallback',
        accountId,
        instrumentId,
        transactionDateIso: t.dateIso,
        transactionType: canonicalType,
        amountScaled,
        unitsScaled,
        navScaled,
        sourceReference: null,
      });
      const set = confirmedFingerprintsByPosition.get(positionKey) ?? new Set<string>();
      set.add(fingerprint);
      confirmedFingerprintsByPosition.set(positionKey, set);

      const existingTxnId = existingFingerprints.get(fingerprint);
      if (existingTxnId) {
        await admin
          .from('ii_transaction_source_links')
          .upsert(
            { user_id: userId, transaction_id: existingTxnId, source_document_id: review.source_document_id, is_originating: false },
            { onConflict: 'transaction_id,source_document_id', ignoreDuplicates: true }
          );
        duplicateTransactionsLinked++;
        continue;
      }

      const { data: inserted } = await admin
        .from('ii_transactions')
        .insert({
          user_id: userId,
          account_id: accountId,
          instrument_id: instrumentId,
          source_document_id: review.source_document_id,
          currency_code: currencyCode,
          status: 'parsed',
          transaction_type: canonicalType,
          transaction_date: t.dateIso,
          units: unitsScaled === null ? null : scaledToDecimalString(unitsScaled),
          price_per_unit: navScaled === null ? null : scaledToDecimalString(navScaled),
          gross_amount: scaledToDecimalString(amountScaled, 2),
          source_reference: null,
          parser_code: 'ai_fallback',
          parser_version_used: 'ai-fallback-v1',
          source_description: t.description,
          confidence: review.provider_confidence ?? null,
          transaction_fingerprint: fingerprint,
        })
        .select('id')
        .single();
      if (inserted) {
        existingFingerprints.set(fingerprint, inserted.id as string);
        newTransactionsCount++;
        await admin.from('ii_transaction_source_links').insert({ user_id: userId, transaction_id: inserted.id, source_document_id: review.source_document_id, is_originating: true });
      }
    }

    // No transaction-level detail was offered by the extraction. For a
    // BRAND NEW position (nothing on file yet), fall back to the existing
    // "known opening balance" marker convention (openingBalanceMarker.ts —
    // the same one a genuine printed "Opening Balance" line uses) so this
    // position has at least one economically-real anchor for cost basis
    // and history-completeness, rather than a holding snapshot with no
    // transaction behind it at all. For an EXISTING position, fabricating a
    // transaction would be guessing at cost basis this task has no
    // evidence for — an honest, non-blocking note is opened instead and the
    // holding snapshot (valuation) is still updated.
    if (holding.transactions.length === 0) {
      const alreadyHasHistory = existingFingerprints.size > 0;
      if (!alreadyHasHistory) {
        const openingUnitsScaled = fromPlainNumber(holding.units);
        const openingCostScaled = fromPlainNumber(holding.costValue);
        const fingerprint = computeTransactionFingerprint({
          sourceKey: 'ai_fallback',
          accountId,
          instrumentId,
          transactionDateIso: holding.asOfDateIso,
          transactionType: 'adjustment',
          amountScaled: openingCostScaled,
          unitsScaled: openingUnitsScaled,
          navScaled: null,
          sourceReference: OPENING_BALANCE_SOURCE_REFERENCE,
        });
        const set = confirmedFingerprintsByPosition.get(positionKey) ?? new Set<string>();
        set.add(fingerprint);
        confirmedFingerprintsByPosition.set(positionKey, set);
        const { data: inserted } = await admin
          .from('ii_transactions')
          .insert({
            user_id: userId,
            account_id: accountId,
            instrument_id: instrumentId,
            source_document_id: review.source_document_id,
            currency_code: currencyCode,
            status: 'parsed',
            transaction_type: 'adjustment',
            transaction_date: holding.asOfDateIso,
            units: scaledToDecimalString(openingUnitsScaled),
            price_per_unit: null,
            gross_amount: scaledToDecimalString(openingCostScaled, 2),
            source_reference: OPENING_BALANCE_SOURCE_REFERENCE,
            parser_code: 'ai_fallback',
            parser_version_used: 'ai-fallback-v1',
            source_description: 'AI-extracted known opening balance (cost of investment as printed) — no transaction-level detail was available.',
            confidence: review.provider_confidence ?? null,
            transaction_fingerprint: fingerprint,
          })
          .select('id')
          .single();
        if (inserted) {
          newTransactionsCount++;
          await admin.from('ii_transaction_source_links').insert({ user_id: userId, transaction_id: inserted.id, source_document_id: review.source_document_id, is_originating: true });
        }
      } else {
        await openReconciliationCase(userId, {
          subjectType: 'account',
          subjectId: accountId,
          discrepancyType: 'other',
          severity: 'info',
          sourceDocumentId: review.source_document_id as string,
          details: {
            instrumentId,
            reason:
              'The AI-assisted extraction provided a valuation (cost value, market value, units) for this already-known position but no transaction-level detail. The valuation was recorded; no transaction was fabricated to explain the change.',
          },
        });
      }
    }

    await admin.from('ii_holding_snapshots').upsert(
      {
        user_id: userId,
        account_id: accountId,
        instrument_id: instrumentId,
        source_document_id: review.source_document_id,
        currency_code: currencyCode,
        quality_status: 'warning',
        as_of_date: holding.asOfDateIso,
        units: String(holding.units),
        value: String(holding.marketValue),
        parser_code: 'ai_fallback',
        parser_version_used: 'ai-fallback-v1',
      },
      { onConflict: 'account_id,instrument_id,as_of_date', ignoreDuplicates: true }
    );
  }

  // Missing-transaction detection — only attempted when the extraction
  // itself stated a coverage period (see aiFallbackDocumentExtraction.ts);
  // without one, there is no honest way to tell "no activity" apart from
  // "this small top-up statement simply doesn't cover that far back",
  // exactly the same principle documentProcessing.ts's own step 6.5 already
  // applies.
  const periodStartIso = (review.statement_period_start as string | null) ?? null;
  const periodEndIso = (review.statement_period_end as string | null) ?? null;
  const missingCases = await detectMissingTransactions(
    admin as unknown as import('./missingTransactionDetection').MissingTransactionQueryClient,
    userId,
    review.source_document_id as string,
    coveredPositions,
    confirmedFingerprintsByPosition,
    periodStartIso,
    periodEndIso
  );
  let missingTransactionsCount = 0;
  for (const { accountId, instrumentId, missing } of missingCases) {
    missingTransactionsCount += missing.length;
    await openReconciliationCase(userId, {
      subjectType: 'account',
      subjectId: accountId,
      discrepancyType: 'transaction_missing_from_restatement',
      severity: 'medium',
      sourceDocumentId: review.source_document_id as string,
      details: { instrumentId, missingTransactionIds: missing.map((m) => m.id), missingTransactionCount: missing.length, source: 'ai_extraction_review' },
      evidence: { missingTransactions: missing },
    });
  }

  for (const { accountId, instrumentId } of coveredPositions) {
    await recertifyPosition(userId, accountId, instrumentId);
  }

  const nowIso = new Date().toISOString();
  await admin.from('ii_ai_extraction_reviews').update({ status: 'accepted', decided_at: nowIso, decided_by: userId }).eq('id', reviewId);
  await admin.from('ii_source_documents').update({ status: 'parsed', parse_completed_at: nowIso }).eq('id', review.source_document_id);

  return {
    ok: true,
    error: null,
    summary: {
      accountsFound: accountsTouched.size,
      schemesFound: schemesTouched.size,
      newTransactionsCount,
      duplicateTransactionsLinked,
      missingTransactionsCount,
    },
  };
}

export async function rejectAiExtractionReview(userId: string, reviewId: string): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();
  const { data: review } = await admin.from('ii_ai_extraction_reviews').select('id, status, source_document_id, trigger_reason').eq('id', reviewId).eq('user_id', userId).maybeSingle();
  if (!review) return { ok: false, error: 'AI extraction review not found.' };
  if (review.status !== 'pending_review') return { ok: false, error: `This review has already been ${review.status}.` };

  const nowIso = new Date().toISOString();
  await admin.from('ii_ai_extraction_reviews').update({ status: 'rejected', decided_at: nowIso, decided_by: userId }).eq('id', reviewId);
  // Revert the document to the honest original failure status it would
  // have shown had AI-fallback never been attempted (see documentProcessing
  // .ts's honestFailureMessage — the "you declined" wording is derived from
  // re-reading this same review row, not stored twice).
  const revertedStatus = review.trigger_reason === 'parse_failed' ? 'parse_failed' : 'unsupported';
  await admin.from('ii_source_documents').update({ status: revertedStatus }).eq('id', review.source_document_id);

  return { ok: true, error: null };
}
