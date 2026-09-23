/**
 * AIE retirement-statement AI-fallback adapter — maps the AI's
 * `RetirementDocumentFacts` onto the SAME `RetirementStatementExtraction`
 * shape the native parser (`lib/financial-data-hub/retirement/extraction.ts`)
 * already produces, so the rest of the pipeline — SMSF detection,
 * reconciliation, activity fingerprinting/dedupe, the canonical evidence
 * write, payslip and bank matching — runs completely unchanged.
 *
 * `jurisdiction`, `currencyCode`, `statementType` and `accountType` are NOT
 * read from the AI response. They are supplied by the caller from the upload's
 * own already-declared metadata — context established before the AI was ever
 * asked. `accountType` in particular decides which canonical retirement
 * catalogue an eventual proposal targets, and `jurisdiction` decides the whole
 * AU-vs-India ruleset; neither is a fact to be inferred from document prose.
 */

import type {
  RetirementStatementExtraction,
  RetirementActivityEvidence,
  RetirementPositionEvidence,
  RetirementStatementType,
  RetirementJurisdiction,
  RetirementAccountType,
} from '@/lib/financial-data-hub/retirement/types';
import type { RetirementDocumentFacts } from './schema';

export const AIE_RETIREMENT_PARSER_NAME = 'aie_retirement_statement_ai_fallback';
export const AIE_RETIREMENT_PARSER_VERSION = '1';

/** Minimum before this adapter will offer a draft for review. A statement
 * with neither a balance nor a single activity line is not usable retirement
 * evidence no matter how confidently the fund name was read — the same "not
 * usable evidence" bar the payslip adapter's own required-fields rule sets. */
function hasUsableEvidence(facts: RetirementDocumentFacts): boolean {
  return facts.activities.length > 0 || facts.closingBalance.value !== null || facts.openingBalance.value !== null;
}

/** The native type carries money as exact decimal STRINGS and uses
 * `undefined` — never `'0'` — to mean "the statement did not show this". That
 * distinction is load-bearing for reconciliation, so it is preserved exactly:
 * a null from the model becomes `undefined`, never a zero. */
function money(field: { value: string | null }): string | undefined {
  return field.value ?? undefined;
}

function text(field: { value: string | null }): string | undefined {
  return field.value ?? undefined;
}

export interface RetirementMappingContext {
  jurisdiction: RetirementJurisdiction;
  currencyCode: string;
  statementType: RetirementStatementType;
  accountType: RetirementAccountType;
}

/**
 * Builds a `RetirementStatementExtraction` from the AI's facts plus
 * caller-supplied, never-AI-derived context. Returns `null` when the document
 * yielded no usable evidence at all.
 */
export function mapRetirementFactsToExtraction(facts: RetirementDocumentFacts, context: RetirementMappingContext): RetirementStatementExtraction | null {
  if (!hasUsableEvidence(facts)) return null;

  const warnings: string[] = [];
  if (facts.documentMissingReasonCode) {
    warnings.push(`document_missing_reason:${facts.documentMissingReasonCode}`);
  }

  const activities: RetirementActivityEvidence[] = [];
  facts.activities.forEach((a, index) => {
    const amount = Number(a.amount);
    // A line whose amount is not a finite number is DROPPED rather than
    // coerced to zero: a zero-value activity is a real and different thing
    // from an unreadable one, and conflating them would corrupt the
    // reconciliation identity. The drop is surfaced as a warning so the user
    // is told the extraction was incomplete rather than silently shortened.
    if (!Number.isFinite(amount)) {
      warnings.push(`ai_activity_${index + 1}_unreadable_amount`);
      return;
    }
    activities.push({
      activityType: a.activityType,
      // POSITIVE MAGNITUDE ONLY — direction comes from
      // `RETIREMENT_ACTIVITY_DIRECTION`, never from a sign here.
      amount: Math.abs(amount).toFixed(2),
      currencyCode: context.currencyCode,
      activityDate: a.activityDate ?? undefined,
      descriptionRaw: a.descriptionRaw ?? undefined,
      employerNameRaw: a.employerNameRaw ?? undefined,
      isSummaryTotal: a.isSummaryTotal,
      isYearToDate: a.isYearToDate,
      sourceRowNumber: index + 1,
    });
  });

  const positions: RetirementPositionEvidence[] = facts.positions.map((p, index) => ({
    optionNameRaw: p.optionNameRaw,
    assetClassRaw: p.assetClassRaw ?? undefined,
    units: p.units ?? undefined,
    unitPrice: p.unitPrice ?? undefined,
    marketValue: p.marketValue ?? undefined,
    currencyCode: context.currencyCode,
    valuationDate: p.valuationDate ?? undefined,
    sourceRowNumber: index + 1,
  }));

  return {
    statementType: context.statementType,
    jurisdiction: context.jurisdiction,
    accountType: context.accountType,
    fundName: text(facts.fundName),
    maskedAccountIdentifier: text(facts.maskedAccountIdentifier),
    currencyCode: context.currencyCode,
    statementDate: text(facts.statementDate),
    statementStartDate: text(facts.statementStartDate),
    statementEndDate: text(facts.statementEndDate),
    openingBalance: money(facts.openingBalance),
    closingBalance: money(facts.closingBalance),
    employerContributions: money(facts.employerContributions),
    personalContributions: money(facts.personalContributions),
    salarySacrifice: money(facts.salarySacrifice),
    governmentContributions: money(facts.governmentContributions),
    rolloversIn: money(facts.rolloversIn),
    rolloversOut: money(facts.rolloversOut),
    withdrawals: money(facts.withdrawals),
    pensionPayments: money(facts.pensionPayments),
    investmentEarnings: money(facts.investmentEarnings),
    fees: money(facts.fees),
    insurancePremiums: money(facts.insurancePremiums),
    tax: money(facts.tax),
    // YTD SCALARS ARE DELIBERATELY NEVER ASKED OF THE AI. The native type has
    // `ytdEmployerContributions`/`ytdPersonalContributions`, but a YTD figure
    // has no independent document-internal check the way the opening/closing
    // balance identity does — there is nothing to cross-check an AI-guessed
    // YTD against. Asking for it would be exactly the "confidence without a
    // check" shape this programme's own design principles warn against. The
    // same decision, for the same reason, as the payslip adapter's YTD
    // exclusion.
    ytdEmployerContributions: undefined,
    ytdPersonalContributions: undefined,
    activities,
    positions,
    parserName: AIE_RETIREMENT_PARSER_NAME,
    parserVersion: AIE_RETIREMENT_PARSER_VERSION,
    // P4/REC-04: no confidence channel is trusted anywhere in this pipeline.
    // Recorded as 0, never used to gate anything — identical to the payslip
    // and bank-statement adapters.
    extractionConfidence: 0,
    warnings,
  };
}
