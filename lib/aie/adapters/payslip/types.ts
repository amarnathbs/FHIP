/**
 * AIE payslip AI-fallback adapter — field vocabulary.
 *
 * The AI is asked to complete exactly the CURRENT-PERIOD scalar fields of
 * `PayrollExtraction` (`lib/financial-data-hub/payslip/types.ts`) needed to
 * produce the same payroll-evidence row the native parser would have
 * produced. `country` and `currencyCode` are deliberately NOT in this list —
 * jurisdiction is never AI-derived anywhere in this codebase (see
 * `lib/aie/adapters/insurance/write.ts`'s header on `owner`, and the
 * Investment Intelligence route's identical rule for country) — the caller
 * always supplies them from the document's own already-declared
 * `country_code`, exactly as the native path does.
 *
 * YEAR-TO-DATE FIELDS ARE DELIBERATELY OUT OF SCOPE FOR THIS FIRST PASS.
 * `ytdGross`/`ytdTax`/`ytdNet`/`ytdEmployerRetirement`/`ytdEmployeeRetirement`
 * have no independent document-internal check the way current-period
 * gross-to-net does (`reconcileGrossToNet`) — there is nothing this adapter
 * can cross-check an AI-guessed YTD figure against, so asking for them here
 * would be exactly the "confidence without a check" shape AIE-1's own design
 * principles warn against. A future pass can add them once a real
 * corroboration source exists (e.g. the previous payslip's own YTD).
 */

export const PAYSLIP_AI_COMPLETABLE_FIELDS = [
  'employerName',
  'payPeriodStart',
  'payPeriodEnd',
  'paymentDate',
  'payFrequency',
  'grossPay',
  'basePay',
  'overtimePay',
  'bonusPay',
  'commissionPay',
  'allowancesTotal',
  'reimbursementsTotal',
  'otherEarnings',
  'taxWithheld',
  'employeeDeductionsTotal',
  'salarySacrifice',
  'professionalTax',
  'employerRetirementContribution',
  'employeeRetirementContribution',
  'employerNpsContribution',
  'employeeNpsContribution',
  'netPay',
] as const;

export type PayslipAiCompletableField = (typeof PAYSLIP_AI_COMPLETABLE_FIELDS)[number];

/** Fields the adapter treats as money (validated/rendered as numeric
 * amounts) — every field above except the three date fields and the
 * frequency enum. */
export const PAYSLIP_AI_MONEY_FIELDS: readonly PayslipAiCompletableField[] = [
  'grossPay',
  'basePay',
  'overtimePay',
  'bonusPay',
  'commissionPay',
  'allowancesTotal',
  'reimbursementsTotal',
  'otherEarnings',
  'taxWithheld',
  'employeeDeductionsTotal',
  'salarySacrifice',
  'professionalTax',
  'employerRetirementContribution',
  'employeeRetirementContribution',
  'employerNpsContribution',
  'employeeNpsContribution',
  'netPay',
];

/** Minimum this adapter requires before it will even offer a draft for
 * review (mirrors `lib/aie/adapters/insurance/reconciliation.ts`'s
 * `INSURANCE_REQUIRED_FIELDS` pattern) — a document reporting neither a
 * gross nor a net figure is not usable payroll evidence no matter how many
 * other fields were read. */
export const PAYSLIP_AI_REQUIRED_FIELDS_ANY_OF: readonly PayslipAiCompletableField[] = ['grossPay', 'netPay'];
