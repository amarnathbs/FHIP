/**
 * Canonical-cert UI journey (live on DEV, 2026-09-27): Retirement -> Import statement, fund "FHIP Test
 * Super Fund B". In "Which account is this?" the user chose their existing account "Industry Super" and
 * pressed "Use this account" (account_match_status 'matched', canonical_account_id = Industry Super).
 * The comparison then showed every "Current" value as "Not set" and recommended "Add as a new
 * retirement account" (proposal target_entity_id null). Applying the recommendation would have left
 * Industry Super ($9,600) AND created a second account ($131,643.75): the same money twice in Net Worth.
 *
 * Cause: the proposal route scoped the existing accounts to the confirmed one (its comment says the
 * account-match decision is AUTHORITATIVE), but the adapter then re-ran fund-NAME matching on that
 * scope; "FHIP Test Super Fund B" does not fold-match "Industry Super", a named fund that matches
 * nothing means "different fund", so the user's explicit choice was discarded.
 *
 * [NC] tests fail on the code before the fix (recommendedApplyMode 'add_new', targetEntityId null).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { retirementAdapter, type ExistingRetirementRow, type RetirementEvidence } from '@/lib/import-bridge/adapters/retirementAdapter';

const industry = (over: Partial<ExistingRetirementRow> = {}): ExistingRetirementRow => ({
  id: 'acc-industry', account_name: 'Industry Super', account_type: 'super', current_balance: '9600.00', currency_code: 'AUD', country_code: 'AU',
  owner: 'self', master_item_key: null, retirement_member_id: null, employer_contribution: null, personal_contribution: null,
  contribution_frequency: null, updated_at: '2026-07-01T00:00:00Z', ...over,
});
const evidence = (over: Partial<RetirementEvidence> = {}): RetirementEvidence => ({
  statementId: 'stmt-b', jurisdiction: 'AU', accountType: 'unknown', fundName: 'FHIP Test Super Fund B', currencyCode: 'AUD', countryCode: 'AU',
  closingBalance: '131643.75', employerContributions: '575.00', memberType: 'self', reviewReasons: [],
  statementStartDate: '2026-08-01', statementEndDate: '2026-08-31', ...over,
});

describe('a confirmed account match is authoritative in the retirement proposal', () => {
  it('[NC] the user-confirmed account is the target even when the fund name differs: update it, never add a second account', () => {
    const d = retirementAdapter.buildProposal(evidence({ confirmedAccountId: 'acc-industry' }), [industry()]);
    expect(d.recommendedApplyMode).toBe('update_existing');
    expect(d.targetEntityId).toBe('acc-industry');
    const balance = d.fields.find((f) => f.fieldName === 'current_balance')!;
    expect(balance.existingValue).not.toBeNull(); // the comparison shows the account's CURRENT balance, not "Not set"
    expect(Number(balance.proposedValue)).toBe(131643.75);
  });

  it('control: WITHOUT a confirmed account, a differently named fund is still treated as a different fund (add new)', () => {
    const d = retirementAdapter.buildProposal(evidence(), [industry()]);
    expect(d.recommendedApplyMode).toBe('add_new');
    expect(d.targetEntityId).toBeNull();
  });

  it('a confirmed id that is not among the active accounts (or is an SMSF) is never targeted', () => {
    expect(retirementAdapter.buildProposal(evidence({ confirmedAccountId: 'acc-gone' }), [industry()]).targetEntityId).toBeNull();
    expect(retirementAdapter.buildProposal(evidence({ confirmedAccountId: 'acc-industry' }), [industry({ master_item_key: 'smsf' })]).targetEntityId).toBeNull();
  });

  it('[NC] the proposal route passes the account-match decision to the adapter', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/financial-data-hub/retirement-statement/[documentId]/proposal/route.ts'), 'utf8');
    expect(src).toMatch(/confirmedAccountId:\s*statement\.account_match_status === 'matched'/);
  });
});
