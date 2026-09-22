/**
 * AIE payslip AI-fallback adapter — maps the AI's `PayslipDocumentFacts`
 * response onto the SAME `PayrollExtraction` shape the native parser
 * (`lib/financial-data-hub/payslip/parser.ts`'s `parsePayslipText`) already
 * produces, so the rest of the pipeline (`reconcileGrossToNet`,
 * `persistPayrollEvidence`) is used completely unchanged — no second write
 * shape, matching this codebase's "REUSE, NOT DUPLICATION" convention
 * (`payslipProcessingService.ts`'s own header).
 *
 * `country`/`currencyCode`/`parserName`/`parserVersion` are NOT read from the
 * AI response — they are supplied by the caller from context that was
 * already known before the AI was ever asked (the document's own declared
 * `country_code`), never derived from document text (see `types.ts`'s
 * header).
 */

import type { PayFrequency, PayrollExtraction } from '@/lib/financial-data-hub/payslip/types';
import type { PayslipDocumentFacts } from './schema';
import { PAYSLIP_AI_REQUIRED_FIELDS_ANY_OF } from './types';

export const AIE_PAYSLIP_ADAPTER_PARSER_NAME = 'aie_payslip_ai_fallback';
export const AIE_PAYSLIP_ADAPTER_PARSER_VERSION = '1';

function money(field: PayslipDocumentFacts['grossPay']): number | undefined {
  if (field.value === null) return undefined;
  const n = Number(field.value);
  return Number.isFinite(n) ? n : undefined;
}

function text(field: PayslipDocumentFacts['employerName']): string | undefined {
  return field.value ?? undefined;
}

function date(field: PayslipDocumentFacts['payPeriodStart']): string | undefined {
  return field.value ?? undefined;
}

/**
 * Builds a `PayrollExtraction` from the AI's facts plus caller-supplied,
 * never-AI-derived context. Returns `null` when neither `grossPay` nor
 * `netPay` was read — the same "not usable payroll evidence" bar
 * `PAYSLIP_AI_REQUIRED_FIELDS_ANY_OF` documents, checked here so every
 * caller gets the identical rule rather than re-implementing it.
 */
export function mapPayslipFactsToExtraction(
  facts: PayslipDocumentFacts,
  context: { country: 'AU' | 'IN'; currencyCode: string },
): PayrollExtraction | null {
  const grossPay = money(facts.grossPay);
  const netPay = money(facts.netPay);
  const hasRequired = PAYSLIP_AI_REQUIRED_FIELDS_ANY_OF.some((f) => (f === 'grossPay' ? grossPay !== undefined : netPay !== undefined));
  if (!hasRequired) return null;

  const payFrequency = (facts.payFrequency.value ?? 'unknown') as PayFrequency;

  return {
    country: context.country,
    currencyCode: context.currencyCode,
    employerName: text(facts.employerName),
    payPeriodStart: date(facts.payPeriodStart),
    payPeriodEnd: date(facts.payPeriodEnd),
    paymentDate: date(facts.paymentDate),
    payFrequency,
    payFrequencySource: 'stated_on_payslip',
    grossPay,
    basePay: money(facts.basePay),
    overtimePay: money(facts.overtimePay),
    bonusPay: money(facts.bonusPay),
    commissionPay: money(facts.commissionPay),
    allowancesTotal: money(facts.allowancesTotal),
    reimbursementsTotal: money(facts.reimbursementsTotal),
    otherEarnings: money(facts.otherEarnings),
    taxWithheld: money(facts.taxWithheld),
    employeeDeductionsTotal: money(facts.employeeDeductionsTotal),
    salarySacrifice: money(facts.salarySacrifice),
    professionalTax: money(facts.professionalTax),
    employerRetirementContribution: money(facts.employerRetirementContribution),
    employeeRetirementContribution: money(facts.employeeRetirementContribution),
    employerNpsContribution: money(facts.employerNpsContribution),
    employeeNpsContribution: money(facts.employeeNpsContribution),
    netPay,
    // YTD is deliberately never asked of the AI (types.ts header) — always
    // absent on an AI-fallback-produced extraction.
    ytdGross: undefined,
    ytdTax: undefined,
    ytdNet: undefined,
    ytdEmployerRetirement: undefined,
    ytdEmployeeRetirement: undefined,
    // No line-level components — the AI schema deliberately asks only for
    // header totals (types.ts's own scope note); downstream reconciliation
    // therefore always uses the 'header_totals' method, never 'components',
    // for an AI-fallback-produced extraction (reconcileGrossToNet's own
    // documented precedence).
    components: [],
    parserName: AIE_PAYSLIP_ADAPTER_PARSER_NAME,
    parserVersion: AIE_PAYSLIP_ADAPTER_PARSER_VERSION,
    extractionConfidence: 0, // P4/REC-04: no confidence channel is trusted anywhere in this pipeline; recorded as 0, never used to gate anything
    warnings: facts.documentMissingReasonCode ? [`document_missing_reason:${facts.documentMissingReasonCode}`] : [],
  };
}
