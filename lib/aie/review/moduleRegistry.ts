/**
 * AIE-1.5 — module renderer registry (AIE15-MOD-01/12).
 *
 * ONE registry, one shape, for every adapter — a module descriptor
 * customises meaning (labels, reason codes, correctable fields) only. It
 * cannot change lifecycle, authorization or audit: nothing exported from
 * here is capable of writing to the database — every descriptor is pure
 * data plus pure functions, and the actual status mutation always goes
 * through `lib/aie/db/repository.ts`'s server-validated functions
 * regardless of which module is involved.
 */

import { INSURANCE_REQUIRED_FIELDS } from '../adapters/insurance';
import { II_ADAPTER_ID } from '../adapters/investment-intelligence';
import { FDH_BANK_CLASSIFICATION_ADAPTER_ID, FDH_BANK_STATEMENT_ADAPTER_ID } from '../adapters/fdhBankStatement';
import type { AieCorrectableFieldSpec, AieReasonCodeMeta, AieReviewModuleDescriptor } from './types';
import { FDH_BANK_REASON_CODES, GENERIC_FALLBACK_REASON_META, INSURANCE_REASON_CODES, INVESTMENT_INTELLIGENCE_REASON_CODES, stripCoreReconciliationPrefix } from './reasonCodes';

const INSURANCE_DESCRIPTOR: AieReviewModuleDescriptor = {
  moduleKey: 'insurance',
  label: 'Insurance',
  integrationTested: true,
  matchesAdapterId: (adapterId) => adapterId === 'insurance_generic_schedule_v1',
  summaryFieldOrder: ['policyName', 'provider', 'coverType', 'coverAmount', 'premium', 'premiumFrequency', 'currencyCode', 'renewalDate'],
  reasonCodes: INSURANCE_REASON_CODES,
};

/** AIE-1.2 is now merged in (`integration/aie-1-release-candidate`). The
 * `matchesAdapterId` predicate below was originally a GUESS at 1.2's
 * eventual adapter-id naming, written before that branch existed — it did
 * not match the real, committed `II_ADAPTER_ID` and silently resolved every
 * Investment Intelligence run to the generic fallback (found by the AIE-1
 * merge plan's own post-merge verification, section 3 finding #2). Fixed to
 * match the real exported constant directly, so it can never drift from it
 * again. `integrationTested` stays `false` — this fix corrects the id
 * predicate itself; no end-to-end run through the actual review UI has yet
 * exercised this descriptor. */
const INVESTMENT_INTELLIGENCE_DESCRIPTOR: AieReviewModuleDescriptor = {
  moduleKey: 'investment_intelligence',
  label: 'Investment Intelligence',
  integrationTested: false,
  matchesAdapterId: (adapterId) => adapterId === II_ADAPTER_ID,
  summaryFieldOrder: ['accountId', 'ownerMemberId', 'statementPeriodStart', 'statementPeriodEnd', 'asOfDate', 'holdingCount', 'closingCashBalance'],
  reasonCodes: INVESTMENT_INTELLIGENCE_REASON_CODES,
  reasonCodePrefixes: [
    { prefix: 'ii_adapter_roll_forward:', meta: {
      humanQuestion: 'A holding on this statement does not roll forward from your last statement as expected.',
      explanation: 'The quantity or cost base we would expect for this holding, given your prior statement plus any trades since, does not match what this statement shows.',
      severity: 'blocking',
      allowedActions: ['reject_document', 'request_reprocessing'],
    } },
    { prefix: 'ii_adapter_canonical_conflict:', meta: {
      humanQuestion: 'This statement conflicts with holdings already recorded for this account.',
      explanation: 'Accepting this statement as-is would conflict with a holding or cash balance already recorded for this account from a different source.',
      severity: 'blocking',
      allowedActions: ['reject_document', 'request_reprocessing'],
    } },
    { prefix: 'ii_adapter_duplicate_overlap', meta: {
      humanQuestion: 'This statement appears to overlap one already imported.',
      explanation: 'The period or holdings on this statement overlap a statement you have already accepted, which could double-count activity.',
      severity: 'blocking',
      // PC5 (M4) — K.10. Before this phase the ONLY permitted action was
      // `reject_document`, which is wrong in one of the three real cases:
      // when the overlap is genuinely two separate events that happen to
      // look alike, rejecting the statement discards real data. The
      // deterministic evidence cannot tell the three cases apart — that is
      // precisely why the item exists — so the user is asked, and the
      // canonical dedup/reconciliation is re-run against their answer.
      allowedActions: ['choose_value', 'reject_document', 'defer'],
      choosableFields: [
        { fieldName: 'duplicateResolution', label: 'Is this the same activity you have already imported?', optionSource: 'duplicate_resolution' },
      ],
    } },
    // PC5 (M4) — NEW ENTRY for a shape that previously fell through to
    // GENERIC_FALLBACK_REASON_META. `unresolvedItemsForDisagreements`
    // (`disagreement.ts:206`) emits
    // `ii_adapter:source_disagreement:<fieldName>` with BOTH candidate
    // values recorded in `evidence_ref`, and the generic fallback offered
    // no way to act on them — a reviewer could see that two readings
    // disagreed and could only defer, reject or reprocess.
    //
    // HONESTY NOTE, carried forward from M3 and RE-VERIFIED against the
    // current tree rather than trusted: this shape is REAL and REACHABLE in
    // code, but no fixture in this repository currently produces one. It
    // requires an AI-fallback candidate to disagree with a deterministic
    // one, and the AI fallback is unreachable today behind two independent
    // blockers (`AIE_MASK_TOKEN_ENCRYPTION_KEY` unset; every II parser
    // declares `aiEligibleGaps: []`). So this entry is written from the
    // emitter's own source, and PC5's own live matrix cannot exercise it.
    // It is registered anyway because the alternative — leaving a real
    // blocking shape rendering as "no specific guidance is registered" —
    // is strictly worse.
    { prefix: 'ii_adapter:source_disagreement:', meta: {
      humanQuestion: 'Two readings of this statement disagree about one value.',
      explanation:
        'Our document reader and its checking pass read different values for the same field. We will not pick one for you on a financial figure, so this needs your decision before the statement can be accepted.',
      severity: 'blocking',
      allowedActions: ['reject_document', 'request_reprocessing', 'defer'],
    } },
  ],
};

/** AIE-1.3 is now merged in (`integration/aie-1-release-candidate`). The
 * `matchesAdapterId` predicate below was originally a GUESS at 1.3's
 * eventual adapter-id naming, written before that branch existed — neither
 * real id (`FDH_BANK_CLASSIFICATION_ADAPTER_ID`, the globally-registered
 * institution/layout sniffer, nor `FDH_BANK_STATEMENT_ADAPTER_ID`, the
 * request-scoped `parserOverride` bridge that actually claims a real run —
 * see `fdhBankStatement/parser.ts`'s own header) starts with `'fdh_bank'`,
 * so this silently resolved every FDH-bank run to the generic fallback
 * (found by the AIE-1 merge plan's own post-merge verification, section 3
 * finding #2). Fixed to match both real exported constants directly.
 * `integrationTested` stays `false` — this fix corrects the id predicate
 * itself; no end-to-end run through the actual review UI has yet exercised
 * this descriptor. */
const FDH_BANK_DESCRIPTOR: AieReviewModuleDescriptor = {
  moduleKey: 'fdh_bank',
  label: 'Bank statement',
  integrationTested: false,
  matchesAdapterId: (adapterId) => adapterId === FDH_BANK_STATEMENT_ADAPTER_ID || adapterId === FDH_BANK_CLASSIFICATION_ADAPTER_ID,
  summaryFieldOrder: ['accountId', 'statementPeriodStart', 'statementPeriodEnd', 'openingBalance', 'closingBalance', 'transactionCount'],
  reasonCodes: FDH_BANK_REASON_CODES,
};

const MODULE_DESCRIPTORS: readonly AieReviewModuleDescriptor[] = [INSURANCE_DESCRIPTOR, INVESTMENT_INTELLIGENCE_DESCRIPTOR, FDH_BANK_DESCRIPTOR];

/** Resolves which module owns a run by its recorded `adapter_id`
 * (`aie_parser_attempt.adapter_id`) — the real, already-persisted fact of
 * which registered parser claimed the document (never re-derived from
 * `source_module_hint`, which AIE-1.1's own docs are explicit is caller
 * metadata, not an authority AIE-1.1 acts on). Returns `null` for a run
 * with no adapter registered against it (AIE-1.1's own
 * `noDomainAdapterReconciliationRule` path) — the generic fallback handles
 * that case at the reason-code layer, not here. */
export function resolveModuleDescriptorByAdapterId(adapterId: string | null): AieReviewModuleDescriptor | null {
  if (!adapterId) return null;
  return MODULE_DESCRIPTORS.find((d) => d.matchesAdapterId(adapterId)) ?? null;
}

export function resolveReasonCodeMeta(descriptor: AieReviewModuleDescriptor | null, reasonCode: string): AieReasonCodeMeta {
  if (!descriptor) return GENERIC_FALLBACK_REASON_META;
  const stripped = stripCoreReconciliationPrefix(reasonCode);
  const exact = descriptor.reasonCodes[stripped];
  if (exact) return exact;
  const prefixMatch = descriptor.reasonCodePrefixes?.find((p) => stripped.startsWith(p.prefix));
  if (prefixMatch) return prefixMatch.meta;
  return GENERIC_FALLBACK_REASON_META;
}

/**
 * Insurance-specific refinement: `insurance_required_fields_present`'s
 * static registry entry lists all five potentially-required fields, but
 * ACT-09 / ITEM-05 mean a reviewer should only be offered the field(s)
 * ACTUALLY missing on THIS document — never invited to "correct" a field
 * that already extracted successfully. Uses `INSURANCE_REQUIRED_FIELDS`
 * (the adapter's own single source of truth, exported from
 * `lib/aie/adapters/insurance/reconciliation.ts` for exactly this purpose)
 * cross-referenced against which fields are present in the merged
 * candidate set.
 */
export function narrowInsuranceRequiredFieldsCorrection(meta: AieReasonCodeMeta, presentFieldNames: ReadonlySet<string>): AieReasonCodeMeta {
  if (!meta.correctableFields) return meta;
  const missingOnly = meta.correctableFields.filter((f) => (INSURANCE_REQUIRED_FIELDS as readonly string[]).includes(f.fieldName) && !presentFieldNames.has(f.fieldName));
  if (missingOnly.length === 0) return meta;
  return { ...meta, correctableFields: missingOnly as AieCorrectableFieldSpec[] };
}

export function listModuleDescriptors(): readonly AieReviewModuleDescriptor[] {
  return MODULE_DESCRIPTORS;
}
