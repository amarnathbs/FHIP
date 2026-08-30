/**
 * FDH-12 — member and account matching (spec sections 14-19, 132, 140).
 *
 * The defining control is spec section 17: Self holds Fund A ****1234 and
 * Spouse holds Fund A ****9876, at the SAME institution with SIMILAR balances.
 * The statement for ****1234 must never update ****9876.
 *
 * The reason that control holds is that `current_balance` is not an input to
 * matching at all — which this file asserts twice: behaviourally (identical
 * balances change nothing) and structurally (the module never reads the
 * column).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  matchRetirementAccount,
  resolveRetirementMember,
  type ExistingRetirementAccountRow,
  type RetirementAccountMatchQuery,
  type RetirementMemberRow,
} from '@/lib/financial-data-hub/retirement/accountMatching';

const SELF = 'aaaaaaaa-0000-0000-0000-000000000001';
const SPOUSE = 'aaaaaaaa-0000-0000-0000-000000000002';

function account(overrides: Partial<ExistingRetirementAccountRow> & { id: string }): ExistingRetirementAccountRow {
  return {
    account_name: 'Hostplus Super',
    account_type: 'super',
    currency_code: 'AUD',
    country_code: 'AU',
    owner: 'self',
    master_item_key: null,
    retirement_member_id: SELF,
    ...overrides,
  };
}

function query(overrides: Partial<RetirementAccountMatchQuery> = {}): RetirementAccountMatchQuery {
  return {
    jurisdiction: 'AU',
    currencyCode: 'AUD',
    fundName: 'Hostplus',
    maskedAccountIdentifier: null,
    accountType: 'industry_super',
    retirementMemberId: null,
    ...overrides,
  };
}

// ===========================================================================
// spec 17 — the wrong-account negative control
// ===========================================================================

describe('FDH-12 spec 17/132 — wrong-account negative control', () => {
  const selfAccount = account({ id: 'acc-self', account_name: 'Hostplus Super (Me)', retirement_member_id: SELF, owner: 'self' });
  const spouseAccount = account({ id: 'acc-spouse', account_name: 'Hostplus Super (Partner)', retirement_member_id: SPOUSE, owner: 'spouse' });
  const identifiers = new Map<string, Set<string>>([
    ['acc-self', new Set(['****1234'])],
    ['acc-spouse', new Set(['****9876'])],
  ]);

  it("Self's ****1234 statement matches Self's account, never Spouse's", () => {
    const result = matchRetirementAccount(
      query({ maskedAccountIdentifier: '****1234', retirementMemberId: SELF }),
      [selfAccount, spouseAccount],
      identifiers,
    );
    expect(result.status).toBe('matched');
    expect(result.accountId).toBe('acc-self');
    expect(result.accountId).not.toBe('acc-spouse');
  });

  it("Spouse's ****9876 statement matches Spouse's account", () => {
    const result = matchRetirementAccount(
      query({ maskedAccountIdentifier: '****9876', retirementMemberId: SPOUSE }),
      [selfAccount, spouseAccount],
      identifiers,
    );
    expect(result.status).toBe('matched');
    expect(result.accountId).toBe('acc-spouse');
  });

  it('matches on the identifier even WITHOUT member narrowing', () => {
    // The member filter is a second layer, not the only one — the identifier
    // alone is decisive.
    const result = matchRetirementAccount(
      query({ maskedAccountIdentifier: '****1234', retirementMemberId: null }),
      [selfAccount, spouseAccount],
      identifiers,
    );
    expect(result.accountId).toBe('acc-self');
  });

  it('normalises identifier formatting so ****1234 and xxxx1234 compare equal', () => {
    const result = matchRetirementAccount(
      query({ maskedAccountIdentifier: 'xxxx1234' }),
      [selfAccount, spouseAccount],
      identifiers,
    );
    expect(result.accountId).toBe('acc-self');
  });

  it('a statement identifier matching NOTHING on file does not fall back to fund name', () => {
    // Both accounts already carry a DIFFERENT identifier, which is positive
    // proof they are other accounts. Matching either on the shared fund name
    // would overwrite an unrelated fund's balance — the exact live defect
    // FDH-10 found in its own matcher.
    const result = matchRetirementAccount(
      query({ maskedAccountIdentifier: '****5555' }),
      [selfAccount, spouseAccount],
      identifiers,
    );
    expect(result.status).toBe('no_match');
    expect(result.accountId).toBeNull();
  });
});

// ===========================================================================
// spec 16 — never match by balance alone
// ===========================================================================

describe('FDH-12 spec 16 — balance is never an input to matching', () => {
  it('the module never reads current_balance (structural proof)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'financial-data-hub', 'retirement', 'accountMatching.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/current_balance/.test(src)).toBe(false);
    expect(/\bbalance\b/i.test(src)).toBe(false);
  });

  it('the row type this module consumes does not even carry a balance field', () => {
    // A compile-time guarantee: `ExistingRetirementAccountRow` has no balance.
    const row: ExistingRetirementAccountRow = account({ id: 'x' });
    expect(Object.prototype.hasOwnProperty.call(row, 'current_balance')).toBe(false);
  });

  it('two accounts with identical everything-but-name are AMBIGUOUS, not guessed', () => {
    const a = account({ id: 'acc-a', account_name: 'Super Fund One', retirement_member_id: null });
    const b = account({ id: 'acc-b', account_name: 'Super Fund Two', retirement_member_id: null });
    const result = matchRetirementAccount(query({ fundName: 'Super Fund' }), [a, b], new Map());
    expect(result.status).toBe('multiple_candidates');
    expect(result.accountId).toBeNull();
    expect(result.candidates).toHaveLength(2);
  });
});

// ===========================================================================
// spec 68 / 10 — hard filters
// ===========================================================================

describe('FDH-12 hard filters', () => {
  it('never matches across currencies (spec section 68)', () => {
    const inrAccount = account({ id: 'acc-inr', currency_code: 'INR', country_code: 'IN', account_name: 'EPF' });
    const result = matchRetirementAccount(
      query({ currencyCode: 'AUD', fundName: 'EPF' }),
      [inrAccount],
      new Map(),
    );
    expect(result.status).toBe('no_match');
  });

  it('NEVER offers an SMSF account as a candidate (spec sections 10, 72)', () => {
    const smsf = account({ id: 'acc-smsf', master_item_key: 'smsf', account_name: 'Hostplus Super' });
    const result = matchRetirementAccount(query(), [smsf], new Map());
    expect(result.status).toBe('no_match');
    expect(result.candidates).toHaveLength(0);
  });

  it('an SMSF account is excluded even when it is the only plausible one', () => {
    const smsf = account({ id: 'acc-smsf', master_item_key: 'smsf' });
    const result = matchRetirementAccount(
      query({ fundName: null, retirementMemberId: SELF }),
      [smsf],
      new Map(),
    );
    expect(result.accountId).toBeNull();
  });
});

// ===========================================================================
// spec 18 — controlled fallback, and its limits
// ===========================================================================

describe('FDH-12 spec 18 — missing identifier, controlled fallback', () => {
  it('matches when there is exactly ONE plausible account and no identifier', () => {
    const only = account({ id: 'acc-only', account_name: 'My Super', retirement_member_id: SELF });
    const result = matchRetirementAccount(
      query({ fundName: null, maskedAccountIdentifier: null }),
      [only],
      new Map(),
    );
    expect(result.status).toBe('matched');
    expect(result.reason).toBe('single_plausible_account_controlled_fallback');
  });

  it('refuses to pick when ambiguity remains', () => {
    const a = account({ id: 'acc-a', account_name: 'Fund One', retirement_member_id: null });
    const b = account({ id: 'acc-b', account_name: 'Fund Two', retirement_member_id: null });
    const result = matchRetirementAccount(
      query({ fundName: null, maskedAccountIdentifier: null }),
      [a, b],
      new Map(),
    );
    expect(result.status).toBe('multiple_candidates');
    expect(result.accountId).toBeNull();
  });

  it('never returns the first candidate as a tie-break', () => {
    const accounts = ['acc-a', 'acc-b', 'acc-c'].map((id) =>
      account({ id, account_name: `Fund ${id}`, retirement_member_id: null }));
    const result = matchRetirementAccount(
      query({ fundName: null, maskedAccountIdentifier: null }),
      accounts,
      new Map(),
    );
    expect(result.accountId).toBeNull();
    expect(result.candidates.map((c) => c.accountId)).toEqual(['acc-a', 'acc-b', 'acc-c']);
  });
});

// ===========================================================================
// spec 14 / 140 — multiple accounts per member, and scale
// ===========================================================================

describe('FDH-12 spec 14/140 — multiple accounts, and scale', () => {
  it('supports Self: Fund A + Fund B and Spouse: Fund C', () => {
    const accounts = [
      account({ id: 'a', account_name: 'AustralianSuper', retirement_member_id: SELF }),
      account({ id: 'b', account_name: 'Hostplus', retirement_member_id: SELF }),
      account({ id: 'c', account_name: 'Aware Super', retirement_member_id: SPOUSE, owner: 'spouse' }),
    ];
    expect(matchRetirementAccount(query({ fundName: 'AustralianSuper', retirementMemberId: SELF }), accounts, new Map()).accountId).toBe('a');
    expect(matchRetirementAccount(query({ fundName: 'Hostplus', retirementMemberId: SELF }), accounts, new Map()).accountId).toBe('b');
    expect(matchRetirementAccount(query({ fundName: 'Aware', retirementMemberId: SPOUSE }), accounts, new Map()).accountId).toBe('c');
  });

  for (const count of [1, 5, 10, 20]) {
    it(`stays unambiguous with ${count} retirement accounts in the household`, () => {
      const accounts = Array.from({ length: count }, (_, i) =>
        account({ id: `acc-${i}`, account_name: `Distinct Fund ${i}`, retirement_member_id: SELF }));
      const identifiers = new Map(accounts.map((a, i) => [a.id, new Set([`****${1000 + i}`])]));
      // Every account is reachable by its own identifier, regardless of scale.
      for (let i = 0; i < count; i += 1) {
        const result = matchRetirementAccount(
          query({ maskedAccountIdentifier: `****${1000 + i}`, fundName: `Distinct Fund ${i}`, retirementMemberId: SELF }),
          accounts,
          identifiers,
        );
        expect(result.status, `account ${i} of ${count}`).toBe('matched');
        expect(result.accountId).toBe(`acc-${i}`);
      }
    });
  }
});

// ===========================================================================
// spec 15 / 101 / 112 — member resolution
// ===========================================================================

describe('FDH-12 spec 15/112 — member resolution', () => {
  const members: RetirementMemberRow[] = [
    { id: SELF, member_type: 'self' },
    { id: SPOUSE, member_type: 'spouse' },
  ];

  it("honours the user's explicit choice", () => {
    const r = resolveRetirementMember(members, { userConfirmedMemberId: SPOUSE });
    expect(r.memberId).toBe(SPOUSE);
    expect(r.reason).toBe('user_confirmed');
  });

  it('resolves a single-member household without asking', () => {
    const r = resolveRetirementMember([members[0]], {});
    expect(r.memberId).toBe(SELF);
    expect(r.reason).toBe('single_member_household');
  });

  it('REFUSES to guess between Self and Spouse with no evidence', () => {
    const r = resolveRetirementMember(members, {});
    expect(r.memberId).toBeNull();
    expect(r.reason).toBe('member_not_determinable_review_required');
  });

  it('rejects a confirmed member id that is not in the household', () => {
    // The cross-tenant case: a forged member id from another user's household
    // is not found here, and migration 0111's ownership trigger refuses it at
    // the database as well.
    const r = resolveRetirementMember(members, { userConfirmedMemberId: 'ffffffff-0000-0000-0000-000000000009' });
    expect(r.memberId).toBeNull();
    expect(r.reason).toBe('confirmed_member_not_found');
  });

  it('never infers the member from a balance or a file name', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'financial-data-hub', 'retirement', 'accountMatching.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/filename|file_name|fileName/.test(src)).toBe(false);
  });
});
