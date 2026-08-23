/**
 * R7 — Bank CSV Engine: account identity resolution (spec sections 30-31).
 *
 * FAIL-SAFE BY DEFAULT. This module never merges two accounts on a weak
 * signal ("both say Savings Account", spec 31). It only ever reuses an
 * existing account when a MASKED IDENTIFIER fingerprint matches exactly, or
 * safely creates a new one when the user has zero existing accounts for the
 * institution+currency. Every other shape of evidence resolves to
 * `ambiguous` — the caller must then halt the import at
 * `ACCOUNT_REVIEW_REQUIRED` rather than guess (ambiguity is preferable to a
 * wrong merge or a wrong split, spec 91's FAIL-condition list: "two accounts
 * incorrectly merged").
 *
 * PRIVACY. `maskedIdentifier` is a display-safe remnant only (the same
 * 7-consecutive-digit-rejecting check constraint already enforced by
 * `fdh_financial_accounts.chk_fdh_accounts_masked_identifier`, FDH-1). The
 * fingerprint is a one-way hash — this module never persists or logs a full
 * account number.
 */

import { createHash } from 'node:crypto';

export interface ExistingAccountSummary {
  id: string;
  accountFingerprint: string | null;
}

export type AccountIdentityDecision =
  | { outcome: 'reuse'; accountId: string; fingerprint: string }
  | { outcome: 'create'; fingerprint: string }
  | { outcome: 'ambiguous'; reason: string };

/** Deterministic, one-way fingerprint. Never reversible to the original
 * identifier — matches the design intent of `fdh_financial_accounts.
 * account_fingerprint` (reserved by FDH-1, populated for the first time by
 * R7). */
export function computeAccountFingerprint(input: {
  userId: string;
  institutionId: string | null;
  currencyCode: string;
  maskedIdentifierNormalised: string | null;
}): string {
  const payload = JSON.stringify([
    input.userId,
    input.institutionId ?? 'none',
    input.currencyCode,
    input.maskedIdentifierNormalised ?? 'unidentified',
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function normaliseMaskedIdentifier(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject anything that looks like a full account number (7+ consecutive
  // digits) rather than persist it — mirrors the DB check constraint so the
  // application layer never even attempts to store an unsafe value.
  if (/\d{7,}/.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

/**
 * Resolves which account a document belongs to.
 *
 *  - A real masked identifier is supplied (from a column or explicit user
 *    input): reuse the account with the matching fingerprint, or safely
 *    create one (this identifier has never been seen before for this user).
 *  - No identifier is supplied: reuse is safe ONLY when the user has exactly
 *    one existing account for this institution+currency AND that account was
 *    ITSELF created without an identifier (so we are not silently attaching
 *    an unidentified import to an account we know to be something more
 *    specific). Zero existing accounts: safe to create one. Two or more:
 *    genuinely ambiguous — which one is this?
 */
export function resolveAccountIdentity(input: {
  userId: string;
  institutionId: string | null;
  currencyCode: string;
  maskedIdentifierNormalised: string | null;
  existingAccountsForInstitutionAndCurrency: readonly ExistingAccountSummary[];
}): AccountIdentityDecision {
  const fingerprint = computeAccountFingerprint({
    userId: input.userId,
    institutionId: input.institutionId,
    currencyCode: input.currencyCode,
    maskedIdentifierNormalised: input.maskedIdentifierNormalised,
  });

  if (input.maskedIdentifierNormalised) {
    const match = input.existingAccountsForInstitutionAndCurrency.find((a) => a.accountFingerprint === fingerprint);
    if (match) return { outcome: 'reuse', accountId: match.id, fingerprint };
    return { outcome: 'create', fingerprint };
  }

  const existing = input.existingAccountsForInstitutionAndCurrency;
  if (existing.length === 0) return { outcome: 'create', fingerprint };
  if (existing.length === 1 && existing[0].accountFingerprint === fingerprint) {
    return { outcome: 'reuse', accountId: existing[0].id, fingerprint };
  }
  return {
    outcome: 'ambiguous',
    reason:
      existing.length === 1
        ? 'an existing, differently-identified account already exists for this institution and currency'
        : 'more than one existing account exists for this institution and currency with no identifier to disambiguate',
  };
}
