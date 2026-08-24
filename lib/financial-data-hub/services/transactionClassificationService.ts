/**
 * R8 — Transaction Categorisation & Merchant Intelligence: persistence
 * orchestration.
 *
 * ORCHESTRATION vs ENGINE (mirrors bankCsvProcessingService.ts's own
 * documented split). This file does the DATABASE work — reading reference
 * data, calling the PURE engine functions in `lib/financial-data-hub/
 * classification/*`, and persisting results. It contains no classification
 * logic of its own.
 *
 * SERVICE-ROLE CARVE-OUT (spec sections 51-52, 59-60; R8_ASSUMPTION_
 * RECONCILIATION.md section 5). Migration 0067 adds DB triggers blocking the
 * `authenticated` role from writing R8's newly-authoritative columns on
 * `fdh_transactions`/`fdh_transaction_links`/`fdh_recurring_transactions`/
 * `fdh_classification_history` directly. This file is therefore a FIFTH
 * sanctioned service-role file (alongside storage.ts, auditLog.ts, purge.ts
 * and bankCsvProcessingService.ts — see `tests/unit/fdh1Isolation.test.ts`,
 * updated in this same change). Every read this file performs uses the
 * ordinary RLS-scoped session client (reads need no elevated privilege —
 * RLS already limits a user to their own rows, which is exactly the scope
 * this file needs); only writes to newly-authoritative columns use the
 * admin client, and every admin write is explicitly re-scoped by
 * `.eq('user_id', userId)` regardless of RLS bypass, matching the
 * established discipline.
 *
 * IDEMPOTENT AND NEVER OVERWRITES A HUMAN DECISION. `user_override = true`
 * rows are excluded from every stage before the engine ever sees them — a
 * confirmed correction survives reprocessing forever (spec section 46).
 * Re-running this function is always safe: unchanged results write nothing,
 * and existing `fdh_transaction_links`/`fdh_recurring_transactions` rows are
 * detected and never duplicated (enforced additionally at the database by
 * `uq_fdh_links_pair`/`uq_fdh_links_open`).
 */

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '../bank-csv/pagination';
import { recordDocumentAuditEvent } from './auditLog';
import {
  categoriesRepository,
  financialAccountsRepository,
  globalClassificationRulesRepository,
  merchantAliasesRepository,
  merchantsRepository,
  subcategoriesRepository,
  transactionLinksRepository,
  userClassificationRulesRepository,
} from '../repositories';
import { classifyTransaction } from '../classification/economicTypeEngine';
import { matchInternalTransfers, openCandidateLink, type TransferCandidateTxn } from '../classification/transferMatching';
import { matchRefundsToOriginals, type RefundCandidateTxn } from '../classification/refundReversalMatching';
import { detectRecurringSeries, type RecurringCandidateTxn } from '../classification/recurringDetection';
import { CONFIDENCE_SCORE, type ClassifiableTransaction, type ClassificationReferenceData } from '../classification/types';
import type { FdhAccountType } from '../constants/enums';
import type { FdhTransaction } from '../domain/types';

export interface ClassificationRunSummary {
  transactionsConsidered: number;
  transactionsClassified: number;
  transactionsUnresolved: number;
  transactionsSkippedUserOverride: number;
  transferLinksProposed: number;
  refundLinksProposed: number;
  recurringSeriesDetected: number;
}

async function loadReferenceData(): Promise<ClassificationReferenceData> {
  // FDH-6 (spec sections 101-103): uses the pagination-safe *All() readers
  // (repositories/base.ts) rather than a single capped `.listActive(N)`
  // call — FDH-2's merchant/alias library is exactly the kind of table that
  // can realistically exceed PostgREST's 1,000-row page cap as it grows,
  // and a silently-truncated alias set means real merchants silently stop
  // matching past row 1,000.
  const [categories, subcategories, merchants, merchantAliases, globalRules] = await Promise.all([
    categoriesRepository.listActiveAll(),
    subcategoriesRepository.listActiveAll(),
    merchantsRepository.listActiveAll(),
    merchantAliasesRepository.listActiveAll(),
    globalClassificationRulesRepository.listActiveAll(),
  ]);
  return {
    categories: categories.data ?? [],
    subcategories: subcategories.data ?? [],
    merchants: merchants.data ?? [],
    merchantAliases: merchantAliases.data ?? [],
    globalRules: globalRules.data ?? [],
    userRules: [],
  };
}

async function loadUserTransactions(userId: string): Promise<FdhTransaction[]> {
  const supabase = await createClient();
  return fetchAllRows<FdhTransaction>(() =>
    supabase
      .from('fdh_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true }),
  );
}

/**
 * Runs the full R8 classification pipeline for one user: economic
 * type/category/merchant classification, transfer/settlement/refund
 * linking, and recurring-series detection. Safe to re-run at any time
 * (e.g. after a new statement import, or after reference data changes).
 */
export async function classifyUserTransactions(userId: string): Promise<ClassificationRunSummary> {
  const [transactions, userRulesResult, accountsResult] = await Promise.all([
    loadUserTransactions(userId),
    userClassificationRulesRepository.listForUserAll(userId),
    financialAccountsRepository.listForUserAll(userId),
  ]);
  const ref = await loadReferenceData();
  ref.userRules = (userRulesResult.data ?? []).filter((r) => r.active);

  const accounts = accountsResult.data ?? [];
  const institutionByAccount = new Map(accounts.map((a) => [a.id, a.institution_id]));
  const accountTypeByAccount = new Map<string, FdhAccountType>(accounts.map((a) => [a.id, a.account_type]));

  const admin = createAdminClient();

  let classified = 0;
  let unresolved = 0;
  let skippedOverride = 0;
  const resolvedByTxnId = new Map<string, ReturnType<typeof classifyTransaction>>();

  for (const txn of transactions) {
    if (txn.user_override) {
      skippedOverride += 1;
      continue;
    }

    const classifiable: ClassifiableTransaction = {
      id: txn.id,
      financial_account_id: txn.financial_account_id,
      transaction_date: txn.transaction_date,
      description_clean: txn.description_clean,
      merchant_raw: txn.merchant_raw,
      amount_original: txn.amount_original,
      currency_original: txn.currency_original,
      credit_debit: txn.credit_debit,
      transaction_type_hint: txn.transaction_type_hint,
      user_override: txn.user_override,
    };
    const result = classifyTransaction(classifiable, institutionByAccount.get(txn.financial_account_id) ?? null, ref);
    resolvedByTxnId.set(txn.id, result);

    const changed =
      result.economicTransactionType !== txn.economic_transaction_type ||
      result.categoryId !== txn.category_id ||
      result.subcategoryId !== txn.subcategory_id ||
      result.merchantId !== txn.merchant_id ||
      result.classificationMethod !== txn.classification_method;

    if (result.source.kind === 'unresolved') {
      unresolved += 1;
      if (changed || txn.review_status === 'not_required') {
        await admin
          .from('fdh_transactions')
          .update({ review_status: 'pending' })
          .eq('id', txn.id)
          .eq('user_id', userId);
      }
      continue;
    }

    if (!changed) continue;
    classified += 1;

    await admin
      .from('fdh_transactions')
      .update({
        economic_transaction_type: result.economicTransactionType,
        category_id: result.categoryId,
        subcategory_id: result.subcategoryId,
        merchant_id: result.merchantId,
        transfer_flag: result.transferFlag,
        subscription_flag: result.subscriptionFlag,
        classification_confidence: CONFIDENCE_SCORE[result.confidence],
        classification_method: result.classificationMethod,
      })
      .eq('id', txn.id)
      .eq('user_id', userId);

    await admin.from('fdh_classification_history').insert({
      user_id: userId,
      transaction_id: txn.id,
      previous_economic_transaction_type: txn.economic_transaction_type,
      new_economic_transaction_type: result.economicTransactionType,
      previous_category_id: txn.category_id,
      new_category_id: result.categoryId,
      previous_subcategory_id: txn.subcategory_id,
      new_subcategory_id: result.subcategoryId,
      classification_method: result.classificationMethod,
      confidence: CONFIDENCE_SCORE[result.confidence],
      changed_by_type: 'system',
      changed_by_user: null,
      global_rule_id: result.source.kind === 'verified_global_rule' || result.source.kind === 'narrative_pattern' ? (result.source.ruleId ?? null) : null,
      user_rule_id: result.source.kind === 'user_rule' ? (result.source.ruleId ?? null) : null,
    });
  }

  // --- Transfer / settlement / loan-payment matching (batch, cross-account) ---
  const eligible = transactions.filter((t) => !t.user_override);
  const transferCandidates: TransferCandidateTxn[] = eligible.map((t) => ({
    id: t.id,
    financialAccountId: t.financial_account_id,
    transactionDate: t.transaction_date,
    amountOriginal: t.amount_original,
    currencyOriginal: t.currency_original,
    creditDebit: t.credit_debit,
    descriptionClean: t.description_clean,
    sourceReference: t.source_reference,
  }));
  // FDH-6 (spec sections 101-103): a household with more than 1,000 links
  // must never have its later links silently invisible to this dedup check
  // — that would let a duplicate transfer/refund link be proposed on top of
  // an existing one past row 1,000.
  const existingLinksResult = await transactionLinksRepository.listForUserAll(userId);
  const existingLinkedIds = new Set(
    (existingLinksResult.data ?? []).flatMap((l) => [l.transaction_id_from, l.transaction_id_to].filter(Boolean) as string[]),
  );

  const proposedTransfers = matchInternalTransfers(
    transferCandidates.filter((t) => !existingLinkedIds.has(t.id)),
    accountTypeByAccount,
  );
  let transferLinksProposed = 0;
  for (const link of proposedTransfers) {
    const { error } = await admin.from('fdh_transaction_links').insert({
      user_id: userId,
      transaction_id_from: link.transactionIdFrom,
      transaction_id_to: link.transactionIdTo,
      link_type: link.linkType,
      confidence: link.confidence,
      status: 'pending',
      created_by_method: 'algorithm',
      user_confirmed: false,
      match_evidence: link.evidence,
    });
    if (!error) transferLinksProposed += 1;
  }

  // Open (unpaired) candidates flagged by the per-transaction engine.
  for (const [txnId, result] of resolvedByTxnId) {
    if (!result.flaggedCandidate) continue;
    if (existingLinkedIds.has(txnId)) continue;
    if (proposedTransfers.some((p) => p.transactionIdFrom === txnId || p.transactionIdTo === txnId)) continue;
    const open = openCandidateLink(txnId, result.flaggedCandidate);
    await admin.from('fdh_transaction_links').insert({
      user_id: userId,
      transaction_id_from: open.transactionId,
      transaction_id_to: null,
      link_type: open.linkType,
      confidence: open.confidence,
      status: 'pending',
      created_by_method: 'algorithm',
      user_confirmed: false,
      match_evidence: open.evidence,
    });
  }

  // --- Refund / reversal linking ---
  const refundCandidates: RefundCandidateTxn[] = eligible.map((t) => ({
    id: t.id,
    financialAccountId: t.financial_account_id,
    transactionDate: t.transaction_date,
    amountOriginal: t.amount_original,
    currencyOriginal: t.currency_original,
    creditDebit: t.credit_debit,
    isRefundClassified: resolvedByTxnId.get(t.id)?.economicTransactionType === 'refund',
  }));
  const proposedRefunds = matchRefundsToOriginals(refundCandidates.filter((t) => !existingLinkedIds.has(t.id)));
  let refundLinksProposed = 0;
  for (const link of proposedRefunds) {
    const { error } = await admin.from('fdh_transaction_links').insert({
      user_id: userId,
      transaction_id_from: link.refundTransactionId,
      transaction_id_to: link.originalTransactionId,
      link_type: link.linkType,
      confidence: link.confidence,
      status: 'pending',
      created_by_method: 'algorithm',
      user_confirmed: false,
      match_evidence: link.evidence,
    });
    if (!error) refundLinksProposed += 1;
  }

  // --- Recurring series detection ---
  const recurringCandidates: RecurringCandidateTxn[] = eligible
    .filter((t) => t.recurring_transaction_id === null)
    .map((t) => ({
      id: t.id,
      transactionDate: t.transaction_date,
      amountOriginal: t.amount_original,
      currencyOriginal: t.currency_original,
      creditDebit: t.credit_debit,
      merchantId: t.merchant_id,
      descriptionClean: t.description_clean,
      financialAccountId: t.financial_account_id,
    }));
  const detectedSeries = detectRecurringSeries(recurringCandidates);
  let recurringSeriesDetected = 0;
  for (const series of detectedSeries) {
    if (series.memberTransactionIds.length < 2) continue;
    const { data: created, error } = await admin
      .from('fdh_recurring_transactions')
      .insert({
        user_id: userId,
        merchant_id: series.merchantId,
        financial_account_id: series.financialAccountId,
        frequency: series.frequency,
        expected_amount: series.expectedAmount,
        amount_tolerance: series.amountTolerance,
        currency_code: series.currencyCode,
        next_expected_date: series.nextExpectedDate,
        status: series.insufficientHistory ? 'candidate' : 'active',
        confidence: CONFIDENCE_SCORE[series.confidence],
        user_confirmed: false,
      })
      .select('id')
      .single();
    if (error || !created) continue;
    recurringSeriesDetected += 1;
    await admin
      .from('fdh_transactions')
      .update({ recurring_transaction_id: created.id, recurring_flag: true })
      .in('id', series.memberTransactionIds)
      .eq('user_id', userId);
  }

  const summary: ClassificationRunSummary = {
    transactionsConsidered: transactions.length,
    transactionsClassified: classified,
    transactionsUnresolved: unresolved,
    transactionsSkippedUserOverride: skippedOverride,
    transferLinksProposed,
    refundLinksProposed,
    recurringSeriesDetected,
  };

  await recordDocumentAuditEvent({
    userId,
    documentId: null,
    eventType: 'transaction_classification_run',
    actorType: 'system',
    actorId: null,
    metadata: summary as unknown as Record<string, unknown>,
  });

  return summary;
}
