/**
 * AIE AU investment-statement (FDH-11) AI-fallback adapter — maps the AI's
 * `AuInvestmentDocumentFacts` onto the EXACT extraction shape the native CSV
 * extractor already produces (`AuInvestmentStatementExtraction`), so that
 * every downstream step — the canonical evidence write, security matching,
 * holdings reconciliation, bank matching, approval, the apply bridge — runs
 * completely unchanged over an AI-read statement.
 *
 * This file maps and validates. It decides nothing, writes nothing, and calls
 * nothing.
 *
 * IDENTITY AND JURISDICTION ARE NEVER READ FROM THE AI RESPONSE. `country`,
 * `currencyCode`, `statementType` and `maskedAccountIdentifier` all come from
 * the `context` argument — values the caller established from the upload
 * session and the user's own form entry before the AI was ever asked. That is
 * the same rule every other adapter in `lib/aie/adapters/` follows, and it is
 * what makes this pipeline's AU-only/AUD-only guarantee (enforced at the
 * upload route by an authoritative home-country check) survive the fallback
 * path intact: a model that misread a statement as American cannot make one
 * AUD row become USD.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not reconcile, does not decide
 * whether the statement "adds up", does not match a security to an instrument
 * and does not judge whether the holdings are plausible. FDH-11's own
 * already-certified deterministic code answers all of those better, and
 * answering them twice is how two implementations start disagreeing.
 */

import type {
  AuInvestmentStatementExtraction,
  AuInvestmentStatementType,
  AuStatementPositionEvidence,
  AuStatementTransactionEvidence,
} from '@/lib/financial-data-hub/investment/types';
import type { AuInvestmentDocumentFacts } from './schema';

export const AIE_AU_INVESTMENT_PARSER_NAME = 'aie_au_investment_statement_ai_fallback';
export const AIE_AU_INVESTMENT_PARSER_VERSION = '1';

/**
 * The confidence recorded on an AI-read statement.
 *
 * Deliberately BELOW the native extractor's own clean-run value (0.95, see
 * `csvExtraction.ts`) and below its degraded value (0.7/0.6): a reading
 * produced by a language model from an unrecognised layout, however plausible,
 * is weaker evidence than a column-mapped parse of a layout the detector
 * recognised, and the number a reviewer sees should say so. This is NOT a
 * model-reported confidence — the schema has no confidence field at all
 * (P4/REC-04) — it is this adapter's own fixed statement about the provenance
 * of the row.
 */
export const AIE_AU_INVESTMENT_EXTRACTION_CONFIDENCE = 0.5;

/** Minimum before this adapter will offer a draft for review at all. A
 * statement with neither a holding nor an activity line is not usable
 * investment evidence no matter how confidently the header was read — the
 * same "not usable evidence" bar the bank-statement adapter's
 * `AIE_BANK_STATEMENT_MIN_TRANSACTIONS` sets. */
export const AIE_AU_INVESTMENT_MIN_ROWS = 1;

/** Caller context — every field here is established BEFORE the AI is asked,
 * and none of it may come from the AI response. */
export interface AuInvestmentMappingContext {
  /** From the user's own "statement contains" choice on the upload form, via
   * the service's `STATEMENT_TYPE_BY_KIND` — never the model's impression of
   * what kind of document it read. */
  statementType: AuInvestmentStatementType;
  /** From the upload session (AUD for this AU-only pipeline). */
  currencyCode: string;
  /** What the user typed on the upload form, if anything. Wins over the
   * model's reading, which is only ever a fallback for an empty box. */
  institutionName?: string;
  /** Typed by the user. Never AI-derived — see `schema.ts`'s header on why
   * this adapter does not even ask. */
  maskedAccountIdentifier?: string;
  statementDate?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  /** Used only as the last-resort valuation date for a holdings row whose own
   * "as at" date the statement did not print, mirroring the native portfolio
   * extractor's `defaultValuationDate` exactly. */
  fallbackValuationDate: string;
}

function textOrUndefined(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Builds the native extraction shape from the AI's facts.
 *
 * Returns `null` when there is no usable row, which is the one "this
 * extraction is not worth showing anyone" judgement this adapter makes.
 */
export function mapAuInvestmentFactsToExtraction(
  facts: AuInvestmentDocumentFacts,
  context: AuInvestmentMappingContext,
): AuInvestmentStatementExtraction | null {
  const warnings: string[] = [];

  const positions: AuStatementPositionEvidence[] = facts.holdings.map((h, index) => ({
    securityNameRaw: h.securityNameRaw.trim(),
    tickerRaw: textOrUndefined(h.tickerRaw),
    // `exchange` is NOT asked for and NOT inferred. An AU statement rarely
    // prints it explicitly, and guessing "ASX" from a three-letter code is
    // precisely the kind of plausible invention this contract exists to
    // prevent — `securityMatching.ts` resolves the instrument without it.
    exchange: undefined,
    isin: textOrUndefined(h.isin),
    quantity: h.quantity,
    unitPrice: textOrUndefined(h.unitPrice),
    marketValue: textOrUndefined(h.marketValue),
    currencyCode: context.currencyCode,
    // A holdings row whose own valuation date the layout did not print falls
    // back to the statement's date, exactly as the native portfolio extractor
    // does (`defaultValuationDate`). The model is never asked to invent one.
    valuationDate: h.valuationDate ?? context.statementDate ?? context.fallbackValuationDate,
    sourceRowNumber: index + 1,
  }));

  const transactions: AuStatementTransactionEvidence[] = facts.transactions.map((t, index) => {
    if (t.amount.startsWith('-')) {
      // The schema and the prompt both require a positive magnitude, with
      // meaning carried by `transactionType`. A negative here means the model
      // double-encoded direction; the magnitude is taken and the fact is
      // recorded, rather than letting a sign silently invert an amount that
      // downstream code (and the bank matcher) reads as a magnitude.
      warnings.push(`ai_activity_${index + 1}_negative_amount_normalised`);
    }
    return {
      transactionType: t.transactionType,
      tradeDate: t.tradeDate ?? undefined,
      settlementDate: t.settlementDate ?? undefined,
      securityNameRaw: textOrUndefined(t.securityNameRaw),
      tickerRaw: textOrUndefined(t.tickerRaw),
      // ISIN is deliberately not asked for on an ACTIVITY line: AU activity
      // tables print a code, not an ISIN, and an ISIN the model produced for a
      // trade line would be a derived identifier rather than a reading.
      isin: undefined,
      quantity: textOrUndefined(t.quantity),
      unitPrice: textOrUndefined(t.unitPrice),
      amount: t.amount.replace(/^-/, ''),
      currencyCode: context.currencyCode,
      // `descriptionRaw` is not asked for. The native CSV extractor fills it
      // from a narrative column when the export has one; a model-written
      // description would be prose ABOUT the line rather than the line's own
      // printed text, which is the opposite of what a "raw" field means.
      descriptionRaw: undefined,
      brokerageRaw: textOrUndefined(t.brokerage),
      frankingCreditRaw: undefined,
      withholdingTaxRaw: undefined,
      sourceRowNumber: index + 1,
    };
  });

  if (positions.length + transactions.length < AIE_AU_INVESTMENT_MIN_ROWS) return null;

  if (!facts.allRowsListed) warnings.push('ai_reported_rows_incomplete');
  if (facts.documentMissingReasonCode) warnings.push(`document_missing_reason:${facts.documentMissingReasonCode}`);
  warnings.push('read_by_ai_fallback_not_native_parser');

  return {
    statementType: context.statementType,
    // AU-ONLY BY CONSTRUCTION. The upload route already refused any user whose
    // authoritative home country is not AU; this literal keeps that true on
    // the fallback path rather than re-deriving a country from the page.
    country: 'AU',
    currencyCode: context.currencyCode,
    institutionName: context.institutionName ?? textOrUndefined(facts.institutionName.value),
    maskedAccountIdentifier: context.maskedAccountIdentifier,
    statementDate: context.statementDate ?? facts.statementDate.value ?? undefined,
    statementPeriodStart: context.statementPeriodStart ?? facts.statementPeriodStart.value ?? undefined,
    statementPeriodEnd: context.statementPeriodEnd ?? facts.statementPeriodEnd.value ?? undefined,
    // Portfolio totals are NOT asked for and NOT summed here. The native
    // extractor reads them when the export declares them; a total this adapter
    // computed by adding up the rows it just read would look like independent
    // evidence while being nothing of the kind — and `holdingsReconciliation`
    // would then be checking the rows against themselves.
    openingPortfolioValue: undefined,
    closingPortfolioValue: undefined,
    cashBalance: undefined,
    positions,
    transactions,
    parserName: AIE_AU_INVESTMENT_PARSER_NAME,
    parserVersion: AIE_AU_INVESTMENT_PARSER_VERSION,
    extractionConfidence: AIE_AU_INVESTMENT_EXTRACTION_CONFIDENCE,
    warnings,
  };
}
