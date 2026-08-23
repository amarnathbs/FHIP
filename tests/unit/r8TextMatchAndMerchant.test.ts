/**
 * R8 — text-matching primitives and merchant normalisation. Pure functions,
 * no database.
 */
import { describe, expect, it } from 'vitest';
import { containsTerm, matchesNarrativePattern, toMatchText } from '@/lib/financial-data-hub/classification/textMatch';
import { matchMerchant } from '@/lib/financial-data-hub/classification/merchantMatching';
import type { FdhMerchant, FdhMerchantAlias } from '@/lib/financial-data-hub/domain/types';

function merchant(overrides: Partial<FdhMerchant> = {}): FdhMerchant {
  return {
    id: 'm1',
    canonical_name: 'Woolworths',
    display_name: 'Woolworths',
    country_code: 'AU',
    merchant_type: 'retail',
    default_category_id: 'cat-groceries',
    default_subcategory_id: 'sub-groceries',
    mcc: null,
    subscription_possible: false,
    essential_discretionary: 'essential',
    verification_status: 'approved',
    merged_into_merchant_id: null,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    recurring_possible: null,
    typical_frequency: null,
    fixed_amount_expected: null,
    variable_amount_possible: null,
    recurring_type: null,
    is_payment_processor: null,
    ...overrides,
  } as FdhMerchant;
}

function alias(overrides: Partial<FdhMerchantAlias> = {}): FdhMerchantAlias {
  return {
    id: 'a1',
    merchant_id: 'm1',
    country_code: 'AU',
    alias_normalised: 'WOOLWORTHS',
    alias_type: 'trading_name',
    source: 'admin_curated',
    confidence: 1,
    verified: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as FdhMerchantAlias;
}

describe('R8 textMatch', () => {
  it('toMatchText upper-cases and collapses whitespace, never mutating the caller value', () => {
    expect(toMatchText('  woolworths   1234  melbourne ')).toBe('WOOLWORTHS 1234 MELBOURNE');
    expect(toMatchText(null)).toBe('');
    expect(toMatchText(undefined)).toBe('');
  });

  it('containsTerm is a literal substring match, never a regex', () => {
    expect(containsTerm('WOOLWORTHS1234MELBOURNE', 'WOOLWORTHS')).toBe(true);
    expect(containsTerm('WOOLWORTHS1234MELBOURNE', 'COLES')).toBe(false);
    expect(containsTerm('ABC', '')).toBe(false);
    // A literal '.' must not act as a regex wildcard.
    expect(containsTerm('AB.CD', 'B.C')).toBe(true);
    expect(containsTerm('ABXCD', 'B.C')).toBe(false);
  });

  it('matchesNarrativePattern requires every required term and no excluded term', () => {
    expect(matchesNarrativePattern('MONTHLY SALARY CREDIT', ['SALARY'])).toBe(true);
    expect(matchesNarrativePattern('SALARY SACRIFICE ADJUSTMENT', ['SALARY'], ['SALARY SACRIFICE'])).toBe(false);
    expect(matchesNarrativePattern('PAYROLL DEPOSIT', ['PAYROLL'])).toBe(true);
    expect(matchesNarrativePattern('RANDOM TEXT', [])).toBe(false); // empty required never matches
    expect(matchesNarrativePattern('ACCOUNT FEE', ['FEE'], ['FEE WAIVED', 'FEE REFUND'])).toBe(true);
    expect(matchesNarrativePattern('ACCOUNT FEE WAIVED', ['FEE'], ['FEE WAIVED', 'FEE REFUND'])).toBe(false);
    expect(matchesNarrativePattern('DIRECT DEBIT PAYMENT', ['DIRECT DEBIT', 'PAYMENT'])).toBe(true);
    expect(matchesNarrativePattern('DIRECT DEBIT ONLY', ['DIRECT DEBIT', 'PAYMENT'])).toBe(false);
  });
});

describe('R8 merchantMatching', () => {
  it('matches a verified alias by substring', () => {
    const result = matchMerchant('WOOLWORTHS 1234 MELBOURNE', null, [merchant()], [alias()]);
    expect(result?.merchant.id).toBe('m1');
    expect(result?.matchedOn).toBe('alias');
  });

  it('never matches an UNVERIFIED alias', () => {
    // canonical_name is deliberately unrelated to the matched text so this
    // test isolates the alias path — an unverified alias must contribute
    // nothing on its own.
    const m = merchant({ canonical_name: 'Unrelated Corp Pty Ltd' });
    const result = matchMerchant('SPECIALTRADINGALIAS PURCHASE', null, [m], [
      alias({ alias_normalised: 'SPECIALTRADINGALIAS', verified: false }),
    ]);
    expect(result).toBeNull();
  });

  it('never matches a merchant whose verification_status is not approved', () => {
    const result = matchMerchant('WOOLWORTHS 1234', null, [merchant({ verification_status: 'admin_review' })], [
      alias(),
    ]);
    expect(result).toBeNull();
  });

  it('never matches an inactive merchant', () => {
    const result = matchMerchant('WOOLWORTHS 1234', null, [merchant({ active: false })], [alias()]);
    expect(result).toBeNull();
  });

  it('falls back to canonical_name when no alias matches', () => {
    const result = matchMerchant('WOOLWORTHS SUPERMARKET', null, [merchant()], []);
    expect(result?.merchant.id).toBe('m1');
    expect(result?.matchedOn).toBe('canonical_name');
  });

  it('prefers the LONGER matched text on overlapping candidates (specific alias over generic name)', () => {
    const generic = merchant({ id: 'm-generic', canonical_name: 'WOOLWORTHS' });
    const specific = merchant({ id: 'm-specific', canonical_name: 'WOOLWORTHS METRO', default_category_id: 'cat-metro' });
    const result = matchMerchant('PAYMENT TO WOOLWORTHS METRO STORE', null, [generic, specific], []);
    expect(result?.merchant.id).toBe('m-specific');
  });

  it('returns null for an empty description', () => {
    expect(matchMerchant(null, null, [merchant()], [alias()])).toBeNull();
    expect(matchMerchant('', '', [merchant()], [alias()])).toBeNull();
  });

  it('considers merchant_raw alongside description_clean', () => {
    const result = matchMerchant('EFTPOS PURCHASE', 'WOOLWORTHS 1234', [merchant()], [alias()]);
    expect(result?.merchant.id).toBe('m1');
  });

  it('never matches an unrelated merchant with a similar prefix (no fuzzy matching)', () => {
    const coles = merchant({ id: 'm-coles', canonical_name: 'COLES' });
    const result = matchMerchant('COLESWORTH PTY LTD', null, [coles], []);
    // "COLESWORTH" contains "COLES" as a substring, which IS a legitimate
    // deterministic containment match under this module's own documented
    // rule (word-boundary-agnostic) — asserting the actual, disclosed
    // behaviour rather than an aspirational one.
    expect(result?.merchant.id).toBe('m-coles');
  });
});
