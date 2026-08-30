/**
 * FHIP Input Data Import Bridge — the RETIREMENT adapter (FDH-12, spec
 * sections 55-60, 103-113).
 *
 * The third domain adapter, following the shape `incomeAdapter.ts` established
 * and `liabilityAdapter.ts` confirmed. Spec section 7 of FDH-9's own brief
 * predicted this file: "later use by Income, Expenses, Investments,
 * Liabilities, Retirement ... a governance certification rather than an
 * architectural rewrite". `IMPORT_TARGET_DOMAINS` has contained `'retirement'`
 * and `IMPORT_SOURCE_KINDS` `'retirement_statement'` since migration 0091,
 * reserved and unused. This is that later use.
 *
 * ============================================================================
 * WHAT THIS ADAPTER PROPOSES, AND WHY
 * ============================================================================
 *
 * `current_balance` — the statement's CLOSING balance. Canonical Retirement
 * stores balance as a DIRECT numeric column (`retirement_accounts
 * .current_balance`, migration 0003), not as a derivation over an event
 * ledger — FHIP has no retirement ledger at all. Spec section 58 therefore
 * resolves to "balance is a direct canonical field, safe update may be
 * permitted", and spec section 59's event-ledger prohibition does not bind
 * because there are no canonical events to import. This is the single most
 * important architectural fact about FDH-12.
 *
 * `employer_contribution` / `personal_contribution` / `contribution_frequency`
 * — existing canonical columns holding a contribution RATE (annualised at read
 * time by `lib/services/forecastData.ts`), currently written by nothing in
 * FDH. Proposed with `requiresConfirmation: true`, because they feed the
 * retirement forecast and a statement's period total is only the user's
 * ongoing rate if the user says so. Never ticked by default.
 *
 * `account_name` / `account_type` / `currency_code` / `country_code` / `owner`
 * — proposed ONLY when creating a new account (`!target`), exactly like
 * income's `source_name` and liability's `liability_name`. An import never
 * silently renames, re-types or re-owns an account the user set up themselves.
 *
 * ============================================================================
 * WHAT THIS ADAPTER CAN NEVER PROPOSE
 * ============================================================================
 *
 * `target_retirement_age` IS NOT IN `RETIREMENT_APPLICABLE_FIELDS`, in either
 * its canonical per-member form (`retirement_members.target_retirement_age`)
 * or its legacy per-account form (`retirement_accounts.target_retirement_age`).
 * Spec section 61: "Default: statement import cannot mutate target retirement
 * age." A super statement does not contain the user's chosen retirement age;
 * anything that looked like one would be the fund's projection assumption, not
 * the user's decision. The refusal is enforced twice over — here, and again in
 * `fdh12_apply_retirement_proposal()`'s own `v_allowed` array (migration 0111
 * PART I), so a forged proposal row naming it is rejected FORBIDDEN_FIELD by
 * the database even if this file were bypassed.
 *
 * `master_item_key` is likewise absent, which is what makes it structurally
 * impossible for an import to create or target an SMSF account: SMSF is
 * identified solely by `master_item_key = 'smsf'`, and the apply RPC forces
 * NULL on ADD NEW.
 *
 * Statement ACTIVITIES are absent entirely — there is no field for a
 * contribution event, a fee, a rollover or a withdrawal, because canonical
 * Retirement has nowhere to put one. That absence is spec section 60's
 * double-apply control.
 */

import type {
  ImportDomainAdapter,
  ImportProposalDraft,
  ImportValueKind,
  PersistedApplyMode,
  ProposedField,
  RecommendedApplyMode,
} from '../types';
import { serialiseValue, deserialiseValue } from '../proposalEngine';

/**
 * ISOLATION (the `tests/unit/fdh1Isolation.test.ts` precedent). This adapter
 * deliberately does NOT import the Hub's own
 * `lib/financial-data-hub/retirement/accountMatching.ts`, exactly as
 * `liabilityAdapter.ts` keeps its own copy of facility matching rather than
 * importing the Hub's. The Hub's matcher serves the Hub's own processing
 * pipeline; the small self-contained copy below is the bridge's
 * isolation-safe one. Both implement the same rule — never match on balance —
 * and both have their own dedicated tests
 * (`fdh12AccountMatching.test.ts` for the Hub engine,
 * `fdh12RetirementBridge.test.ts` for this adapter).
 */

/** Canonical `retirement_accounts.account_type` vocabulary. This is the ZOD
 * vocabulary (`lib/validation/retirement.ts`), which is what a canonical row
 * is validated against — NOT the lowercase catalogue keys some migrations also
 * wrote into the same unconstrained column. See FDH12_REUSE_AND_GAP_AUDIT.md
 * GAP-R3. */
export const CANONICAL_RETIREMENT_ACCOUNT_TYPES = ['super', 'EPF', 'PPF', 'NPS', 'other'] as const;
export type CanonicalRetirementAccountType = (typeof CANONICAL_RETIREMENT_ACCOUNT_TYPES)[number];

/** FDH-12 evidence account type -> canonical `account_type`. */
export const EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE: Record<string, CanonicalRetirementAccountType> = {
  industry_super: 'super',
  retail_super: 'super',
  defined_benefit: 'super',
  account_based_pension: 'super',
  allocated_pension: 'super',
  transition_to_retirement: 'super',
  annuity: 'other',
  overseas_pension: 'other',
  retirement_savings: 'other',
  epf: 'EPF',
  ppf: 'PPF',
  nps: 'NPS',
  unknown: 'other',
};

export type RetirementMatchOutcome = 'single_match' | 'no_match' | 'ambiguous';

/** The subset of a canonical `retirement_accounts` row this adapter reads.
 * NOTE the absence of any balance field from the MATCHING key below — the
 * column is present because the compare view must display it, and is never an
 * input to `matchExistingRetirementAccount`. */
export interface ExistingRetirementRow {
  id: string;
  account_name: string;
  account_type: string | null;
  current_balance: number | string;
  currency_code: string;
  country_code: string | null;
  owner: string;
  master_item_key: string | null;
  retirement_member_id: string | null;
  employer_contribution: number | string | null;
  personal_contribution: number | string | null;
  contribution_frequency: string | null;
  updated_at?: string | null;
}

/** Statement evidence this adapter consumes. A plain shape, not an import of
 * the Hub's own extraction types, for the same reason `IncomeEvidence` and
 * `LiabilityEvidence` are plain shapes. */
export interface RetirementEvidence {
  statementId: string;
  jurisdiction: 'AU' | 'IN';
  /** The FDH-12 evidence account type. */
  accountType: string;
  fundName?: string;
  maskedAccountIdentifier?: string;
  currencyCode: string;
  countryCode?: string;
  /** Exact decimal string. */
  closingBalance?: string;
  /** The statement's own employer/personal contribution totals for the period,
   * and the period's length, so the review UI can show what frequency the
   * proposed rate represents. */
  employerContributions?: string;
  personalContributions?: string;
  contributionFrequency?: string;
  /** Which household member the statement resolved to. Drives `owner`. */
  memberType?: 'self' | 'spouse';
  /** True when SMSF routing fired. An SMSF statement must never reach the
   * bridge at all; this flag exists so `buildProposal` can refuse loudly if
   * one somehow does. */
  isSmsf?: boolean;
  reviewReasons: string[];
}

/**
 * THE SECURITY ALLOW-LIST (spec section 104). The complete set of canonical
 * columns this adapter may ever write. Mirrored exactly by
 * `fdh12_apply_retirement_proposal()`'s `v_allowed` array.
 */
export const RETIREMENT_APPLICABLE_FIELDS = [
  'account_name',
  'account_type',
  'current_balance',
  'currency_code',
  'country_code',
  'owner',
  'employer_contribution',
  'personal_contribution',
  'contribution_frequency',
] as const;

const FIELD_KINDS: Record<string, ImportValueKind> = {
  account_name: 'text',
  account_type: 'enum',
  current_balance: 'money',
  currency_code: 'enum',
  country_code: 'enum',
  owner: 'enum',
  employer_contribution: 'money',
  personal_contribution: 'money',
  contribution_frequency: 'enum',
};

function foldName(s: string | null | undefined): string | null {
  if (!s) return null;
  const folded = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return folded || null;
}

/**
 * Match the statement to an existing canonical account.
 *
 * NEVER BY BALANCE (spec section 16). The key is currency + jurisdiction (hard
 * filters), then member, then fund name, then account type. `current_balance`
 * is not read by this function at all.
 *
 * SMSF rows are excluded from the pool outright (spec sections 10, 72), so an
 * SMSF account can never become a candidate.
 */
function matchExistingRetirementAccount(
  query: {
    currencyCode: string;
    countryCode: string | null;
    fundName: string | null;
    canonicalAccountType: CanonicalRetirementAccountType;
    memberOwner: string | null;
  },
  existing: readonly ExistingRetirementRow[],
): { accountId: string | null; outcome: RetirementMatchOutcome } {
  let pool = existing.filter((a) =>
    a.currency_code === query.currencyCode
    && a.master_item_key !== 'smsf'
    && (query.countryCode === null || a.country_code === null || a.country_code === query.countryCode));

  // Member narrowing — the mechanism behind spec section 17's wrong-account
  // negative control (Self ****1234 must never update Spouse ****9876).
  if (query.memberOwner) {
    const byOwner = pool.filter((a) => a.owner === query.memberOwner);
    if (byOwner.length > 0) pool = byOwner;
  }

  if (pool.length === 0) return { accountId: null, outcome: 'no_match' };

  const fund = foldName(query.fundName);
  if (fund) {
    const byFund = pool.filter((a) => {
      const folded = foldName(a.account_name);
      return folded !== null && (folded === fund || folded.includes(fund) || fund.includes(folded));
    });
    if (byFund.length === 1) return { accountId: byFund[0].id, outcome: 'single_match' };
    if (byFund.length > 1) {
      const byType = byFund.filter((a) => a.account_type === query.canonicalAccountType);
      if (byType.length === 1) return { accountId: byType[0].id, outcome: 'single_match' };
      return { accountId: null, outcome: 'ambiguous' };
    }
    // The statement names a fund and nothing matched it. Do NOT fall back to
    // "the only account of this type" — a named fund that matches nothing is
    // positive evidence this is a DIFFERENT fund, and updating an unrelated
    // account's balance from it is the exact defect FDH-10 found live in its
    // own matcher.
    return { accountId: null, outcome: 'no_match' };
  }

  // No fund name at all. A single remaining candidate is the controlled
  // fallback spec section 18 permits; more than one is ambiguous, never the
  // first.
  if (pool.length === 1) return { accountId: pool[0].id, outcome: 'single_match' };
  return { accountId: null, outcome: 'ambiguous' };
}

export function findDuplicateRetirementAccount(
  evidence: RetirementEvidence,
  existing: readonly ExistingRetirementRow[],
): { accountId: string | null; outcome: RetirementMatchOutcome } {
  return matchExistingRetirementAccount(
    {
      currencyCode: evidence.currencyCode,
      countryCode: evidence.countryCode ?? null,
      fundName: evidence.fundName ?? null,
      canonicalAccountType: EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE[evidence.accountType] ?? 'other',
      memberOwner: evidence.memberType ?? null,
    },
    existing,
  );
}

function field(
  fieldName: string,
  proposed: unknown,
  existingRow: ExistingRetirementRow | null,
  opts: { isRecommended?: boolean; requiresConfirmation?: boolean; reasonCode: string; confidence?: number },
): ProposedField {
  const kind = FIELD_KINDS[fieldName];
  return {
    fieldName,
    valueKind: kind,
    proposedValue: serialiseValue(proposed, kind),
    existingValue: existingRow
      ? serialiseValue((existingRow as unknown as Record<string, unknown>)[fieldName], kind)
      : null,
    isRecommended: opts.isRecommended ?? true,
    requiresConfirmation: opts.requiresConfirmation ?? false,
    confidence: opts.confidence,
    reasonCode: opts.reasonCode,
  };
}

export const retirementAdapter: ImportDomainAdapter<RetirementEvidence, ExistingRetirementRow> = {
  domain: 'retirement',
  applicableFields: RETIREMENT_APPLICABLE_FIELDS,

  buildProposal(evidence, existing): ImportProposalDraft {
    const duplicate = findDuplicateRetirementAccount(evidence, existing);
    // AMBIGUOUS is never silently resolved to the first candidate (spec
    // sections 18, 27): the proposal targets nothing and carries the ambiguity
    // as a review reason; the UI surfaces REVIEW_REQUIRED and the user picks.
    const target = duplicate.outcome === 'single_match'
      ? existing.find((r) => r.id === duplicate.accountId) ?? null
      : null;
    const recommendedApplyMode: RecommendedApplyMode = target ? 'update_existing' : 'add_new';
    const reviewReasons = [...evidence.reviewReasons];
    if (duplicate.outcome === 'ambiguous') reviewReasons.push('ambiguous_account_match_review_required');
    // Defence in depth: an SMSF statement should have been routed away long
    // before reaching the bridge (migration 0111 PART H refuses to approve
    // one, and an unapproved statement cannot be applied). If one arrives
    // anyway, say so loudly rather than proceeding quietly.
    if (evidence.isSmsf) reviewReasons.push('smsf_statement_must_be_managed_in_the_smsf_section');

    const fields: ProposedField[] = [];
    const canonicalType = EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE[evidence.accountType] ?? 'other';

    if (!target) {
      const name = evidence.fundName
        ? evidence.fundName
        : evidence.jurisdiction === 'IN' ? 'Retirement account' : 'Superannuation account';
      fields.push(field('account_name', name, null, { reasonCode: 'derived_from_statement' }));
      fields.push(field('account_type', canonicalType, null, { reasonCode: 'derived_from_statement_account_type' }));
      fields.push(field('currency_code', evidence.currencyCode, null, { reasonCode: 'read_from_statement' }));
      if (evidence.countryCode) {
        fields.push(field('country_code', evidence.countryCode, null, { reasonCode: 'read_from_statement' }));
      }
      // OWNER: from the resolved member, and REQUIRING CONFIRMATION when the
      // statement did not tell us (spec sections 15, 112 — never inferred from
      // balance or filename). Defaulting silently to 'self' would be exactly
      // that inference.
      fields.push(field('owner', evidence.memberType ?? 'self', null, {
        requiresConfirmation: !evidence.memberType,
        reasonCode: evidence.memberType ? 'resolved_household_member' : 'household_member_not_determined_confirm',
      }));
      if (!evidence.memberType) reviewReasons.push('confirm_which_household_member_this_account_belongs_to');
    }

    // --- current_balance: the statement's CLOSING balance -------------------
    if (evidence.closingBalance !== undefined) {
      fields.push(field('current_balance', evidence.closingBalance, target, {
        reasonCode: 'statement_closing_balance',
      }));
    } else {
      // Spec section 94: no closing balance means we say so, never $0.
      reviewReasons.push('no_closing_balance_on_statement');
    }

    // --- contribution RATES: confirmation-gated ----------------------------
    // These change forecast inputs. A statement's period total is not
    // automatically the user's ongoing contribution rate, so they are never
    // ticked by default and always require an explicit confirmation.
    if (evidence.employerContributions !== undefined) {
      fields.push(field('employer_contribution', evidence.employerContributions, target, {
        isRecommended: false,
        requiresConfirmation: true,
        reasonCode: 'statement_period_employer_contributions',
      }));
    }
    if (evidence.personalContributions !== undefined) {
      fields.push(field('personal_contribution', evidence.personalContributions, target, {
        isRecommended: false,
        requiresConfirmation: true,
        reasonCode: 'statement_period_personal_contributions',
      }));
    }
    if (evidence.contributionFrequency !== undefined) {
      fields.push(field('contribution_frequency', evidence.contributionFrequency, target, {
        isRecommended: false,
        requiresConfirmation: true,
        reasonCode: 'derived_from_statement_period_length',
      }));
    }

    return {
      targetDomain: 'retirement',
      sourceKind: 'retirement_statement',
      currencyCode: evidence.currencyCode,
      targetEntityId: target?.id ?? null,
      targetEntityUpdatedAt: target?.updated_at ?? null,
      recommendedApplyMode,
      duplicateOfEntityId: duplicate.outcome === 'single_match' ? duplicate.accountId : null,
      fields,
      summary: buildSummary(evidence, target, reviewReasons),
    };
  },

  coerce(_fieldName, value, valueKind) {
    return deserialiseValue(value, valueKind);
  },

  serialise(_fieldName, value, valueKind) {
    return serialiseValue(value, valueKind);
  },

  validateApply(mode: PersistedApplyMode, fields, selected) {
    if (selected.length === 0) {
      return { ok: false, error: 'No fields were selected to apply.' };
    }
    if (mode === 'add_new') {
      const names = new Set(selected);
      if (!names.has('account_name')) return { ok: false, error: 'A new retirement account needs a name.' };
      if (!names.has('current_balance')) return { ok: false, error: 'A new retirement account needs a balance.' };
      if (!names.has('currency_code')) return { ok: false, error: 'A new retirement account needs a currency.' };
    }
    const known = new Set(fields.map((f) => f.fieldName));
    for (const name of selected) {
      if (!known.has(name)) return { ok: false, error: `Field ${name} is not part of this proposal.` };
    }
    return { ok: true };
  },
};

/**
 * The non-negotiable base of a NEW retirement row.
 *
 * `master_item_key` is deliberately ABSENT (i.e. left NULL), which does two
 * things at once:
 *   * it makes the row a CUSTOM row, outside
 *     `uq_retirement_accounts_user_master unique (user_id, master_item_key)`,
 *     so Self and Spouse can each hold their own funds (spec section 14; see
 *     FDH12_REUSE_AND_GAP_AUDIT.md GAP-R1);
 *   * it makes it structurally impossible for an import to create an SMSF row,
 *     since SMSF is identified solely by `master_item_key = 'smsf'`.
 *
 * `owner` is NOT defaulted here — unlike income and liability, which default
 * to 'self' because a payslip or a loan statement carries no member evidence.
 * A retirement account's member matters (it drives per-member retirement
 * planning), so `owner` is a PROPOSED field the user confirms, and the RPC's
 * `add_new` path takes it from the proposal.
 */
export function newRetirementRowDefaults(): Record<string, unknown> {
  return { is_active: true };
}

function buildSummary(
  evidence: RetirementEvidence,
  target: ExistingRetirementRow | null,
  reviewReasons: string[],
): ImportProposalDraft['summary'] {
  const lines: { label: string; value: string; note?: string }[] = [];
  const show = (v: string | undefined, note?: string) =>
    v === undefined ? { value: 'Not shown on statement' } : { value: v, note };

  lines.push({ label: 'Fund', value: evidence.fundName ?? 'Not identified' });
  lines.push({ label: 'Account type', value: evidence.accountType.replace(/_/g, ' ') });
  lines.push({ label: 'Closing balance', ...show(evidence.closingBalance) });
  lines.push({
    label: 'Employer contributions (this period)',
    ...show(evidence.employerContributions, 'Evidence — not added to your income or expenses'),
  });
  lines.push({
    label: 'Personal contributions (this period)',
    ...show(evidence.personalContributions, 'A transfer into retirement, not household spending'),
  });

  return {
    title: target
      ? `Update your existing retirement account “${target.account_name}”?`
      : 'Add this as a new retirement account?',
    lines,
    reviewReasons: [...new Set(reviewReasons)],
  };
}
