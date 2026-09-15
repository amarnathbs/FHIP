/**
 * AIE-1.5 — reason-code -> human-language/action registry (Appendix A).
 *
 * ONE INSURANCE ENTRY PER RULE THIS PASS ACTUALLY RUNS (`buildInsuranceReconciliationRule`,
 * `lib/aie/adapters/insurance/reconciliation.ts`, merged into this branch
 * from `feature/aie-1-4-other-modules` for real integration testing — see
 * AIE_1_5_IMPLEMENTATION.md section 1). Investment Intelligence and FDH
 * entries below are transcribed from those adapters' own reconciliation/
 * unresolved-item source on their OWN unmerged branches
 * (`feature/aie-1-2-investment-adapter`, `feature/aie-1-3-fdh-bank-adapter`)
 * — believed accurate to that source, but this pass never executed either
 * adapter's code, so `integrationTested: false` on their module descriptors
 * (moduleRegistry.ts) is the honest, load-bearing flag: DO NOT read their
 * presence here as "AIE-1.5 tested Investment/FDH review" — it did not.
 *
 * Every reason code AIE-1.1 core itself can produce (`reconciliation_fail:
 * <ruleId>` / `reconciliation_indeterminate:<ruleId>`, from
 * `blockingItemsForReconciliation`, lib/aie/reconciliation/types.ts) is
 * handled by stripping that fixed prefix before matching against a
 * module's own rule-id keyed registry below — the prefix itself carries no
 * adapter-specific meaning, it is AIE-1.1's own generic wrapper.
 */

import type { AieReasonCodeMeta } from './types';

/** Any reason code with no specific registry entry (a not-yet-catalogued
 * rule id, or a genuinely unrecognised one) still renders something
 * truthful and safe rather than a raw internal code (ITEM-01) or a crash:
 * blocking, no correction offered (ACT-09's conservative default — never
 * offer to edit a field the registry does not explicitly describe),
 * reject/reprocess only. */
export const GENERIC_FALLBACK_REASON_META: AieReasonCodeMeta = {
  humanQuestion: 'This document needs a decision before it can be accepted.',
  explanation: 'Our automatic checks could not confirm this document is safe to accept as-is, and no specific guidance is registered for this exact condition yet.',
  severity: 'blocking',
  allowedActions: ['reject_document', 'request_reprocessing', 'defer'],
};

const AIE_CORE_RECONCILIATION_PREFIXES = ['reconciliation_fail:', 'reconciliation_indeterminate:'] as const;

/** Strips AIE-1.1 core's generic `reconciliation_<outcome>:` wrapper (if
 * present) to recover the adapter's own rule id — the string every module
 * registry below is actually keyed on. Reason codes an adapter creates
 * directly via `createUnresolvedItems` (e.g. AIE-1.2's `ii_adapter:*`
 * family) never carry this prefix and pass through unchanged. */
export function stripCoreReconciliationPrefix(reasonCode: string): string {
  for (const prefix of AIE_CORE_RECONCILIATION_PREFIXES) {
    if (reasonCode.startsWith(prefix)) return reasonCode.slice(prefix.length);
  }
  return reasonCode;
}

// ---------------------------------------------------------------------------
// Insurance (AIE-1.4) — INTEGRATION TESTED this pass.
// ---------------------------------------------------------------------------
export const INSURANCE_REASON_CODES: Record<string, AieReasonCodeMeta> = {
  insurance_document_class_supported: {
    humanQuestion: 'This document type is not one we can process automatically yet.',
    explanation:
      'Our insurance document reader currently handles policy schedules, renewal notices and premium notices only. This looks like a different kind of document (for example a Product Disclosure Statement or claim form), which needs a different, not-yet-built handling path.',
    severity: 'blocking',
    allowedActions: ['reject_document', 'request_reprocessing'],
  },
  insurance_required_fields_present: {
    humanQuestion: 'Some required policy details were not found on this document.',
    explanation: 'Policy name, cover amount, premium, premium frequency and currency are all required before this policy can be saved. One or more of these could not be read from the document.',
    severity: 'blocking',
    allowedActions: ['correct', 'reject_document'],
    // Populated precisely per-run by moduleRegistry.ts (only the fields
    // actually missing for THIS document, using
    // INSURANCE_REQUIRED_FIELDS as the single source of truth) — the
    // static list here is the full permitted universe.
    correctableFields: [
      { fieldName: 'policyName', label: 'Policy name', type: 'string' },
      { fieldName: 'coverAmount', label: 'Cover amount', type: 'number', min: 0 },
      { fieldName: 'premium', label: 'Premium', type: 'number', min: 0 },
      { fieldName: 'premiumFrequency', label: 'Premium frequency', type: 'enum', enumValues: ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off'] },
      { fieldName: 'currencyCode', label: 'Currency', type: 'enum', enumValues: ['AUD', 'INR'] },
    ],
  },
  insurance_currency_supported: {
    humanQuestion: 'The currency on this document is not one we currently support.',
    explanation: 'Only AUD and INR policies can be saved today. Confirm the correct currency for this policy, or reject the document if the currency was misread.',
    severity: 'blocking',
    allowedActions: ['correct', 'reject_document'],
    correctableFields: [{ fieldName: 'currencyCode', label: 'Currency', type: 'enum', enumValues: ['AUD', 'INR'] }],
  },
  insurance_multi_component_not_supported: {
    humanQuestion: 'This policy has more than one cover component, which we cannot reconcile automatically.',
    explanation:
      'This document appears to bundle more than one cover amount or premium under a single policy. Our current model can only hold one flat cover/premium per policy, so we cannot safely determine which component to save.',
    severity: 'blocking',
    allowedActions: ['reject_document', 'request_reprocessing'],
  },
  insurance_premium_totals_reconciled: {
    humanQuestion: 'The premium amount does not match the annual total printed on this document.',
    explanation: 'We calculated an annual premium from the amount and frequency shown, and it does not match the annual total the document itself prints, by more than a rounding tolerance.',
    severity: 'blocking',
    allowedActions: ['correct', 'reject_document'],
    correctableFields: [
      { fieldName: 'premium', label: 'Premium', type: 'number', min: 0 },
      { fieldName: 'premiumFrequency', label: 'Premium frequency', type: 'enum', enumValues: ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off'] },
    ],
  },
  // M12B-F4 / M12B-F5. Registered with real copy rather than left to
  // GENERIC_FALLBACK_REASON_META, for the same reason M12A registered its
  // FDH-bank counterpart: the generic text ("our automatic checks could not
  // confirm this document is safe to accept as-is") gives a reviewer nothing
  // to act on, and this condition has a precise, actionable meaning — we read
  // the policy, and something it printed we could not read.
  //
  // The wording deliberately does NOT say the unread facts are wrong; we do
  // not know that. The evidence attached to the item names WHICH label and
  // WHY, never a guess at what it meant.
  //
  // `correct` is offered on renewalDate specifically: the commonest instance
  // of this item is a renewal date printed in a format this reader has not
  // been certified against, which a human can read off the document at a
  // glance and type in unambiguously — whereas the reader must not guess
  // between DD/MM and MM/DD on the reviewer's behalf. Where the unread fact is
  // an unrecognised money label instead, the reviewer still has
  // reject/reprocess, and the evidence names the label.
  insurance_printed_fact_completeness: {
    humanQuestion: 'Something printed on this policy could not be read.',
    explanation:
      'This document prints a detail we were unable to read reliably — for example a renewal date in a format we have not been certified against, or a money amount under a heading we do not recognise. The rest of the policy may still reconcile perfectly, so this is not the same as the figures being wrong: it means the saved policy would be INCOMPLETE. We will not guess at what it said.',
    severity: 'blocking',
    allowedActions: ['correct', 'reject_document', 'request_reprocessing'],
    correctableFields: [{ fieldName: 'renewalDate', label: 'Renewal date', type: 'date' }],
  },
};

// ---------------------------------------------------------------------------
// Investment Intelligence (AIE-1.2) — DESIGN-ONLY. Transcribed from
// `feature/aie-1-2-investment-adapter`'s `unresolvedItems.ts` /
// `reconciliationRule.ts`. NEVER RUN by this pass — see moduleRegistry.ts's
// `integrationTested: false`.
// ---------------------------------------------------------------------------
export const INVESTMENT_INTELLIGENCE_REASON_CODES: Record<string, AieReasonCodeMeta> = {
  'ii_adapter:ambiguous_account': {
    humanQuestion: 'We could not tell which of your investment accounts this statement belongs to.',
    explanation: 'More than one of your accounts could plausibly match this statement, and the document does not identify one uniquely enough for us to choose automatically.',
    severity: 'blocking',
    // PC5 (M4): the ambiguity is between a KNOWN, FINITE set of the user's
    // own account ids — `matchAccountsReadOnly` already recorded them in
    // this item's own `evidence_ref.candidateAccountIds`. A user can
    // legitimately say which one it is; a machine may not guess, which is
    // why the item exists. `choose_value` resolves exactly that, from that
    // recorded candidate list and no wider.
    allowedActions: ['choose_value', 'reject_document', 'request_reprocessing', 'defer'],
    choosableFields: [
      { fieldName: 'accountId', label: 'Which account is this statement for?', optionSource: 'account_match_candidates' },
    ],
  },
  'ii_adapter:owner_unresolved': {
    humanQuestion: 'We could not confirm who owns this investment account.',
    explanation: 'Ownership must be confirmed before holdings from this statement can be recorded against the right person or entity.',
    severity: 'blocking',
    // PC5 (M4): `choose_value` added. Before this phase the ONLY ways out of
    // an owner-unresolved item were to reject the document or to request a
    // reprocessing action that has no implementation — i.e. a user who
    // simply forgot to say whose statement it was had no way to say so
    // afterwards, and their only real option was to throw the document
    // away and upload it again. That is the "passive observation" state
    // K.2 exists to end.
    allowedActions: ['choose_value', 'reject_document', 'request_reprocessing', 'defer'],
    choosableFields: [
      { fieldName: 'ownerMemberId', label: 'Who does this statement belong to?', optionSource: 'household_owner', allocationMayBeRequired: true },
    ],
  },
  // PC5 (M4) — NEW. The mismatch half of PC4-INV-12, which did not exist in
  // any form before this phase: `holderName` was parsed by three certified
  // parsers and discarded, so a statement belonging to a DIFFERENT PERSON,
  // uploaded with any owner set, was ingested with no signal at all. See
  // `lib/pc5/ownerMatching.ts` for the comparison itself and for why it is
  // exact-after-normalisation rather than fuzzy.
  'ii_adapter:owner_mismatch': {
    humanQuestion: 'The name on this statement does not match the person you selected.',
    explanation:
      'The account holder printed on this statement does not match the household member this upload was filed against. We will not record someone else’s holdings against your household, so this needs your decision before the statement can be accepted.',
    severity: 'blocking',
    allowedActions: ['choose_value', 'reject_document', 'defer'],
    choosableFields: [
      { fieldName: 'ownerMemberId', label: 'Who does this statement actually belong to?', optionSource: 'household_owner', allocationMayBeRequired: true },
    ],
  },
  // PC5 (M4) — NEW. A jointly-held folio has no single owner, so it cannot
  // be published under one household member without an explicit split.
  'ii_adapter:owner_joint_allocation_required': {
    humanQuestion: 'This account is held jointly. How should it be split?',
    explanation:
      'The statement shows more than one account holder. The holdings are still counted once in your net worth — this only records who owns which share of them, so reports and goals attribute the position correctly.',
    severity: 'blocking',
    allowedActions: ['choose_value', 'reject_document', 'defer'],
    choosableFields: [
      { fieldName: 'ownerAllocation', label: 'Who are the owners, and in what shares?', optionSource: 'household_owner', allocationMayBeRequired: true },
    ],
  },
  'ii_adapter:ambiguous_instrument': {
    humanQuestion: 'One of the holdings on this statement could not be matched to a known instrument.',
    explanation: 'The instrument identifier or name on the statement does not match an instrument we already have on file closely enough to be certain.',
    severity: 'blocking',
    allowedActions: ['reject_document', 'request_reprocessing'],
  },
  'ii_adapter:statement_period_missing': {
    humanQuestion: 'This statement does not state the period it covers.',
    explanation: 'A statement period is required to check holdings and cash movements roll forward correctly from your last statement.',
    severity: 'blocking',
    allowedActions: ['correct', 'reject_document'],
    correctableFields: [
      { fieldName: 'statementPeriodStart', label: 'Statement period start', type: 'date' },
      { fieldName: 'statementPeriodEnd', label: 'Statement period end', type: 'date' },
    ],
  },
  'ii_adapter:statement_period_invalid_order': {
    humanQuestion: 'The statement period end date is before its start date.',
    explanation: 'The two dates printed for this statement’s period are in the wrong order, which usually means one of them was misread.',
    severity: 'blocking',
    allowedActions: ['correct', 'reject_document'],
    correctableFields: [
      { fieldName: 'statementPeriodStart', label: 'Statement period start', type: 'date' },
      { fieldName: 'statementPeriodEnd', label: 'Statement period end', type: 'date' },
    ],
  },
  'ii_adapter:statement_as_of_date_missing': {
    humanQuestion: 'This statement does not state the date its holding values are as of.',
    explanation: 'An as-of date is required to compare this statement’s valuations against your existing holding history.',
    severity: 'blocking',
    allowedActions: ['correct', 'reject_document'],
    correctableFields: [{ fieldName: 'asOfDate', label: 'Valuation as-of date', type: 'date' }],
  },
};

// ---------------------------------------------------------------------------
// FDH bank statement (AIE-1.3) — DESIGN-ONLY. Transcribed from
// `feature/aie-1-3-fdh-bank-adapter`'s `reconciliation.ts`. NEVER RUN by
// this pass — see moduleRegistry.ts's `integrationTested: false`.
// ---------------------------------------------------------------------------
export const FDH_BANK_REASON_CODES: Record<string, AieReasonCodeMeta> = {
  fdh_bank_statement_balance_reconciliation: {
    humanQuestion: 'The transactions on this statement do not add up to its printed closing balance.',
    explanation: 'We added up every transaction row against the statement’s own opening balance and it does not reach the closing balance the document prints, by more than a rounding tolerance.',
    severity: 'blocking',
    allowedActions: ['reject_document', 'request_reprocessing'],
  },
  fdh_bank_statement_layout_certified: {
    humanQuestion: 'This bank statement layout is not one we recognise.',
    explanation: 'The row/column structure of this statement does not match a layout our reader has been certified against, so we cannot safely extract transactions from it.',
    severity: 'blocking',
    allowedActions: ['reject_document', 'request_reprocessing'],
  },
  fdh_bank_statement_layout_certification: {
    humanQuestion: 'This bank statement layout is not one we recognise.',
    explanation: 'The row/column structure of this statement does not match a layout our reader has been certified against, so we cannot safely extract transactions from it.',
    severity: 'blocking',
    allowedActions: ['reject_document', 'request_reprocessing'],
  },
  fdh_bank_statement_date_range_overlap: {
    humanQuestion: 'This statement’s date range overlaps one you have already imported.',
    explanation: 'Importing this statement as well as the overlapping one could double-count transactions in the overlapping period.',
    severity: 'blocking',
    allowedActions: ['reject_document', 'request_reprocessing'],
  },
  // M12A-F1. Registered with real copy rather than left to
  // GENERIC_FALLBACK_REASON_META, because the generic text ("our automatic
  // checks could not confirm this document is safe to accept as-is") gives a
  // reviewer nothing to act on, and this condition has a precise, actionable
  // meaning: we read the statement, and some of what it printed we could not
  // read. The wording deliberately does NOT say the missing rows are wrong —
  // we do not know that, and the evidence attached to the item names which
  // rows and why, never a guess at what they contained.
  fdh_bank_statement_row_extraction_completeness: {
    humanQuestion: 'Some transactions printed on this statement could not be read.',
    explanation:
      'This statement prints transaction lines we were unable to read reliably — for example a date that is not a real calendar date, or an amount we could not interpret. The rest of the statement may still add up perfectly, so this is not the same as the figures being wrong: it means the import would be INCOMPLETE. We will not guess at what those lines said.',
    severity: 'blocking',
    allowedActions: ['reject_document', 'request_reprocessing'],
  },
};
