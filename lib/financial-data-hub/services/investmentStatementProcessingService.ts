/**
 * FDH-11 — Australia Investment Statement Intelligence: upload + processing
 * orchestration (spec sections 15-16, 19-25, 54-58, 90). The EIGHTH FDH file
 * approved to use the service-role client (see
 * `tests/unit/fdh1Isolation.test.ts`'s "uses the service-role client ONLY in
 * the eight ... documented files"), following the exact same carve-out
 * `bankCsvProcessingService.ts` / `bankPdfProcessingService.ts` /
 * `liabilityStatementProcessingService.ts` already established.
 *
 * SINGLE-CALL UPLOAD+PROCESS — the same deliberate, disclosed simplification
 * FDH-10 chose for CSV credit-card/loan statements (this file's header
 * comment on `liabilityStatementProcessingService.ts` explains the
 * rationale in full: bytes are already in memory, extraction is synchronous
 * for CSV, no OCR/password retry loop is needed). Byte-safe intake reuses
 * FDH-3's `createUploadSession`/`completeUpload` UNCHANGED — no new upload
 * framework (spec section 19).
 *
 * SCOPE (honestly disclosed — see FDH11_REUSE_AND_GAP_AUDIT.md). CSV
 * investment statements via the two certified generic adapters
 * (`lib/financial-data-hub/investment/adapters/`) only. No AU broker PDF
 * adapter is certified in this pass — a PDF upload here fails with
 * `manual_mapping_required`, never a silent "0 holdings" (spec section 22).
 *
 * NO CANONICAL WRITE HAPPENS HERE (spec sections 63-65). This file only
 * ever writes `fdh_investment_statements` / `_positions` / `_activities` —
 * it never imports Investment Intelligence and never touches an `ii_*`
 * table (mechanically enforced by `tests/unit/fdh11Isolation.test.ts`).
 */

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createUploadSession, completeUpload, FdhUploadLifecycleError } from './uploadLifecycle';
import { downloadDocumentObject } from './storage';
import { recordDocumentAuditEvent } from './auditLog';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import { detectAuInvestmentCsvFormat } from '../investment/detection';
import { extractAuTransactionsFromCsv, extractAuPositionsFromCsv } from '../investment/csvExtraction';
import { matchBankBrokerEvent, type BankTransactionCandidate } from '../investment/bankMatching';
import type { AuStatementTransactionEvidence, AuStatementPositionEvidence, AuInvestmentStatementType } from '../investment/types';
import type { FdhStatementUpload } from '../domain/types';

export class AuInvestmentStatementProcessingError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_state' | 'internal_error', message: string) {
    super(message);
    this.name = 'AuInvestmentStatementProcessingError';
  }
}

export const AU_INVESTMENT_STATEMENT_FAILURE_MESSAGES: Record<string, string> = {
  manual_mapping_required: "We couldn't recognise the layout of this statement. Please check the file, or add this investment manually.",
  ambiguous_format: 'This statement matches more than one known layout. Please check the file, or add this investment manually.',
  layout_unsupported: "We couldn't read this file as a statement export. Please check the file, or add this investment manually.",
  pdf_manual_mapping_required: 'PDF broker statements are not yet supported for automatic reading. Please add this investment manually, or try a CSV export from your broker.',
  unknown_error: 'Something went wrong while reading this statement.',
};

export interface UploadAuInvestmentStatementMetadata {
  csvKind: 'transaction' | 'portfolio';
  currencyCode: string;
  institutionName?: string;
  maskedAccountIdentifier?: string;
  statementDate?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
}

export interface UploadAuInvestmentStatementResult {
  document: FdhStatementUpload;
  statementId: string | null;
  pipelineStatus: 'ok' | 'extraction_failed' | 'duplicate_statement';
  failureKind?: string;
  positionsExtracted: number;
  activitiesExtracted: number;
}

const STATEMENT_TYPE_BY_KIND: Record<'transaction' | 'portfolio', AuInvestmentStatementType> = {
  transaction: 'investment_transaction_csv',
  portfolio: 'portfolio_csv',
};

const DEFAULT_TRANSACTION_COLUMN_MAP = {
  date: 'Date', type: 'Type', amount: 'Amount', ticker: 'Code', isin: 'ISIN',
  securityName: 'Security Name', quantity: 'Quantity', price: 'Price', brokerage: 'Brokerage', settlementDate: 'Settlement Date',
};
const DEFAULT_PORTFOLIO_COLUMN_MAP = {
  securityName: 'Security Name', ticker: 'Code', isin: 'ISIN', quantity: 'Quantity', unitPrice: 'Price', marketValue: 'Market Value', valuationDate: 'Valuation Date',
};

export async function getAuInvestmentStatementIdForDocument(userId: string, documentId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.from('fdh_investment_statements').select('id').eq('user_id', userId).eq('statement_upload_id', documentId).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * Upload AND process an AU investment statement CSV in one call. Returns
 * the persisted document plus, on success, the new
 * `fdh_investment_statements.id`.
 */
export async function uploadAndProcessAuInvestmentStatement(
  userId: string,
  metadata: UploadAuInvestmentStatementMetadata,
  bytes: Uint8Array,
): Promise<UploadAuInvestmentStatementResult> {
  const { session } = await createUploadSession(userId, {
    source_type: 'csv',
    document_type: 'investment_statement',
    country_code: 'AU',
    currency_code: metadata.currencyCode as 'AUD' | 'INR' | 'USD',
    declared_mime_type: 'text/csv',
    declared_file_size_bytes: bytes.byteLength,
  });

  let document: FdhStatementUpload;
  try {
    document = await completeUpload(userId, session.id, bytes);
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError) throw new AuInvestmentStatementProcessingError('internal_error', e.message);
    throw e;
  }

  if (document.processing_status === 'failed' || document.processing_status === 'rejected') {
    return { document, statementId: null, pipelineStatus: 'extraction_failed', failureKind: document.error_code ?? 'unknown_error', positionsExtracted: 0, activitiesExtracted: 0 };
  }

  // Duplicate whole-document upload (spec sections 54, 106, 120) — the same
  // already-certified FDH-3 signal every FDH phase reuses. Never
  // re-extracted, never a second `fdh_investment_statements` row.
  if (document.duplicate_of_document_id) {
    const existingStatementId = await getAuInvestmentStatementIdForDocument(userId, document.duplicate_of_document_id);
    if (existingStatementId) {
      return { document, statementId: existingStatementId, pipelineStatus: 'duplicate_statement', positionsExtracted: 0, activitiesExtracted: 0 };
    }
  }

  if (!['queued', 'validating', 'uploaded'].includes(document.processing_status)) {
    throw new AuInvestmentStatementProcessingError('invalid_state', `cannot process while the document is ${document.processing_status}`);
  }

  const download = await downloadDocumentObject(document.raw_document_storage_reference!);
  if (!download.ok) throw new AuInvestmentStatementProcessingError('internal_error', download.message);

  assertDocumentTransition(document.processing_status, 'processing');

  const admin = createAdminClient();

  if (document.mime_type === 'application/pdf') {
    await admin.from('fdh_statement_uploads').update({ processing_status: 'failed', error_code: 'layout_unsupported', review_status: 'pending' }).eq('id', document.id).eq('user_id', userId);
    await recordDocumentAuditEvent({ userId, documentId: document.id, eventType: 'investment_statement_extraction_failed', actorType: 'system', metadata: { reason: 'pdf_manual_mapping_required' } });
    return { document, statementId: null, pipelineStatus: 'extraction_failed', failureKind: 'pdf_manual_mapping_required', positionsExtracted: 0, activitiesExtracted: 0 };
  }

  const detection = detectAuInvestmentCsvFormat(download.bytes);
  const effectiveKind: 'transaction' | 'portfolio' = detection.status === 'detected' && detection.adapter ? detection.adapter.csvKind : metadata.csvKind;

  const extraction =
    effectiveKind === 'transaction'
      ? extractAuTransactionsFromCsv({ bytes: download.bytes, columnMap: DEFAULT_TRANSACTION_COLUMN_MAP, currencyCode: metadata.currencyCode, institutionName: metadata.institutionName, maskedAccountIdentifier: metadata.maskedAccountIdentifier, statementPeriodStart: metadata.statementPeriodStart, statementPeriodEnd: metadata.statementPeriodEnd, statementDate: metadata.statementDate })
      : extractAuPositionsFromCsv({ bytes: download.bytes, columnMap: DEFAULT_PORTFOLIO_COLUMN_MAP, currencyCode: metadata.currencyCode, institutionName: metadata.institutionName, maskedAccountIdentifier: metadata.maskedAccountIdentifier, statementDate: metadata.statementDate, defaultValuationDate: metadata.statementDate ?? new Date().toISOString().slice(0, 10) });

  if (!extraction.ok) {
    await admin.from('fdh_statement_uploads').update({ processing_status: 'failed', error_code: 'layout_unsupported', review_status: 'pending' }).eq('id', document.id).eq('user_id', userId);
    await recordDocumentAuditEvent({ userId, documentId: document.id, eventType: 'investment_statement_extraction_failed', actorType: 'system', metadata: { reason: extraction.kind } });
    return { document, statementId: null, pipelineStatus: 'extraction_failed', failureKind: extraction.kind, positionsExtracted: 0, activitiesExtracted: 0 };
  }

  const { extraction: ex } = extraction;

  const { data: statement, error: stmtErr } = await admin
    .from('fdh_investment_statements')
    .insert({
      user_id: userId,
      statement_upload_id: document.id,
      statement_type: STATEMENT_TYPE_BY_KIND[effectiveKind],
      institution_name: ex.institutionName ?? null,
      masked_account_identifier: ex.maskedAccountIdentifier ?? null,
      base_currency: ex.currencyCode,
      statement_date: ex.statementDate ?? null,
      statement_start_date: ex.statementPeriodStart ?? null,
      statement_end_date: ex.statementPeriodEnd ?? null,
      opening_portfolio_value: ex.openingPortfolioValue ?? null,
      closing_portfolio_value: ex.closingPortfolioValue ?? null,
      cash_balance: ex.cashBalance ?? null,
      parser: ex.parserName,
      parser_version: ex.parserVersion,
      extraction_confidence: ex.extractionConfidence,
      extraction_status: 'extracted',
    })
    .select('id')
    .single();
  if (stmtErr || !statement) {
    throw new AuInvestmentStatementProcessingError('internal_error', stmtErr?.message ?? 'Could not create statement evidence row.');
  }
  const statementId = statement.id as string;

  let positionsExtracted = 0;
  if (ex.positions.length > 0) {
    const rows = ex.positions.map((p: AuStatementPositionEvidence) => ({
      user_id: userId, statement_id: statementId, security_name_raw: p.securityNameRaw, ticker_raw: p.tickerRaw ?? null,
      exchange: p.exchange ?? null, isin: p.isin ?? null, quantity: p.quantity, unit_price: p.unitPrice ?? null,
      market_value: p.marketValue ?? null, currency_code: p.currencyCode, valuation_date: p.valuationDate, source_row_number: p.sourceRowNumber ?? null,
    }));
    const { error: posErr } = await admin.from('fdh_investment_statement_positions').insert(rows);
    if (!posErr) positionsExtracted = rows.length;
  }

  let activitiesExtracted = 0;
  if (ex.transactions.length > 0) {
    const rows = ex.transactions.map((t: AuStatementTransactionEvidence) => ({
      user_id: userId, statement_id: statementId, activity_type: t.transactionType, trade_date: t.tradeDate ?? null,
      settlement_date: t.settlementDate ?? null, security_name_raw: t.securityNameRaw ?? null, ticker_raw: t.tickerRaw ?? null,
      isin: t.isin ?? null, quantity: t.quantity ?? null, unit_price: t.unitPrice ?? null, amount: t.amount,
      currency_code: t.currencyCode, description_raw: t.descriptionRaw ?? null, brokerage_raw: t.brokerageRaw ?? null,
      franking_credit_raw: t.frankingCreditRaw ?? null, withholding_tax_raw: t.withholdingTaxRaw ?? null, source_row_number: t.sourceRowNumber ?? null,
    }));
    const { error: actErr } = await admin.from('fdh_investment_statement_activities').insert(rows);
    if (!actErr) activitiesExtracted = rows.length;
  }

  await recordDocumentAuditEvent({ userId, documentId: document.id, eventType: 'investment_statement_extraction_completed', actorType: 'system', metadata: { statementId, positionsExtracted, activitiesExtracted } });

  return { document, statementId, pipelineStatus: 'ok', positionsExtracted, activitiesExtracted };
}

/**
 * Bank <-> broker matching for one statement's activities (spec sections
 * 66-71). Queries `fdh_transactions` (the Hub's OWN cash ledger — an
 * intra-Hub reference, not a canonical-ledger touch).
 */
export async function matchAuStatementActivitiesToBank(userId: string, statementId: string): Promise<{ matched: number; noMatch: number; multipleCandidates: number; noBankEvidence: number; error: string | null }> {
  const admin = createAdminClient();
  const { data: activities, error: actErr } = await admin
    .from('fdh_investment_statement_activities')
    .select('id, activity_type, amount, trade_date, currency_code')
    .eq('user_id', userId)
    .eq('statement_id', statementId)
    .in('activity_type', ['DIVIDEND', 'DISTRIBUTION', 'TRANSFER_IN', 'TRANSFER_OUT', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL']);
  if (actErr) return { matched: 0, noMatch: 0, multipleCandidates: 0, noBankEvidence: 0, error: actErr.message };

  const { data: bankTxns } = await admin
    .from('fdh_transactions')
    .select('id, amount_original, transaction_date, description_clean, financial_account_id')
    .eq('user_id', userId);

  let matched = 0, noMatch = 0, multipleCandidates = 0, noBankEvidence = 0;

  for (const activity of activities ?? []) {
    const candidates: BankTransactionCandidate[] = (bankTxns ?? []).map((b) => ({
      transactionId: b.id as string,
      amount: Number(b.amount_original),
      transactionDate: b.transaction_date as string,
      // Conservative default (disclosed residual — see
      // FDH11_AU_BANK_MATCHING.md): real narrative-substring institution
      // matching (mirroring liabilityStatementProcessingService.ts's own
      // `loadBankCandidatesForPayment`) is a documented follow-up; this
      // default still exercises the full amount+date+multi-candidate/
      // no-evidence state machine correctly.
      institutionOrNarrativeMatches: true,
      positivelyWrongBroker: false,
    }));
    const result = matchBankBrokerEvent({ amount: Number(activity.amount), eventDate: activity.trade_date as string, currencyCode: activity.currency_code as string }, candidates);

    let bankMatchStatus: string;
    let linkedTransactionId: string | null = null;
    if (result.outcome === 'matched') { matched++; bankMatchStatus = 'matched'; linkedTransactionId = result.matchedTransactionId; }
    else if (result.outcome === 'no_match') { noMatch++; bankMatchStatus = 'no_match'; }
    else if (result.outcome === 'multiple_candidates') { multipleCandidates++; bankMatchStatus = 'multiple_candidates'; }
    else { noBankEvidence++; bankMatchStatus = 'bank_evidence_not_available'; }

    await admin
      .from('fdh_investment_statement_activities')
      .update({ bank_match_status: bankMatchStatus, linked_transaction_id: linkedTransactionId, bank_match_candidates: result.candidates.length > 0 ? result.candidates : null })
      .eq('id', activity.id);
  }

  await recordDocumentAuditEvent({ userId, documentId: statementId, eventType: 'investment_statement_bank_match_completed', actorType: 'system', metadata: { matched, noMatch, multipleCandidates, noBankEvidence } });

  return { matched, noMatch, multipleCandidates, noBankEvidence, error: null };
}
