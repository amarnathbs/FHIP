/**
 * FDH-2 — domain-logic unit tests: personal-payee/PII screening,
 * global-learning governance state transitions, classification precedence
 * resolution semantics, and the normalisation library. All pure functions,
 * no database.
 */
import { describe, expect, it } from 'vitest';
import { screenForPersonalPayee } from '@/lib/financial-data-hub/domain/personalPayeeGuard';
import * as GlobalLearningGovernance from '@/lib/financial-data-hub/domain/globalLearningGovernance';
import {
  buildCandidateEvidence,
  decideGovernanceTransition,
  GLOBAL_MERCHANT_VS_PRIVATE_COUNTERPARTY_BOUNDARY,
} from '@/lib/financial-data-hub/domain/globalLearningGovernance';
import {
  applyUserOverrideExample,
  PRECEDENCE_ORDER,
  resolvePrecedence,
  type PrecedenceCandidate,
} from '@/lib/financial-data-hub/domain/classificationPrecedence';
import {
  GOVERNED_LEGAL_SUFFIXES,
  normaliseAndStripSuffix,
  normaliseNarrative,
  stripGovernedSuffix,
} from '@/lib/financial-data-hub/domain/normalization';

describe('FDH-2 personal-payee / PII guard', () => {
  it('flags a bare two-word personal name', () => {
    expect(screenForPersonalPayee('JOHN SMITH').flagged).toBe(true);
    expect(screenForPersonalPayee('ravi kumar').flagged).toBe(true);
  });

  it('flags "TRANSFER TO <name>" phrasing', () => {
    const r = screenForPersonalPayee('TRANSFER TO AMAR');
    expect(r.flagged).toBe(true);
    expect(r.reasons.some((x) => x.includes('named individual'))).toBe(true);
  });

  it('flags an email-like pattern', () => {
    expect(screenForPersonalPayee('payment from jane.doe@example.com').flagged).toBe(true);
  });

  it('flags a UPI-handle-like pattern', () => {
    expect(screenForPersonalPayee('ravikumar@okhdfcbank').flagged).toBe(true);
    expect(screenForPersonalPayee('name@paytm').flagged).toBe(true);
  });

  it('flags a run of 7+ digits (account/phone number)', () => {
    expect(screenForPersonalPayee('PAYMENT TO 9876543210').flagged).toBe(true);
  });

  it('does NOT flag genuine, well-known business/institution names', () => {
    // These are real names from FDH-2's own seed data — none should trip
    // the heuristic, because each carries a recognised business/institution
    // indicator word.
    for (const legit of [
      'WOOLWORTHS SUPERMARKET',
      'STAR HEALTH INSURANCE',
      'COMMONWEALTH BANK',
      'BUNNINGS WAREHOUSE',
      'RELIANCE FRESH RETAIL',
    ]) {
      expect(screenForPersonalPayee(legit).flagged, legit).toBe(false);
    }
  });

  it('the false-positive tradeoff is deliberately conservative: an unrecognised two-word brand IS flagged for review', () => {
    // Documents the known limitation honestly rather than hiding it: a
    // genuine two-word brand with no listed business keyword (e.g. a small
    // local business "ACME WIDGETS") will also be flagged. This is the
    // specification's explicit intent ("conservatively flagged ... rather
    // than persisted into global master data") — a false positive here only
    // means "held for admin review", never data loss.
    expect(screenForPersonalPayee('ACME WIDGETS').flagged).toBe(true);
  });
});

describe('FDH-2 global-learning governance transitions', () => {
  it('open may only move to admin_review', () => {
    expect(decideGovernanceTransition('open', 'admin_review', { piiScreeningStatus: 'not_screened' }).allowed).toBe(true);
    expect(decideGovernanceTransition('open', 'approved', { piiScreeningStatus: 'passed' }).allowed).toBe(false);
    expect(decideGovernanceTransition('open', 'rejected', { piiScreeningStatus: 'not_screened' }).allowed).toBe(false);
    expect(decideGovernanceTransition('open', 'merged', { piiScreeningStatus: 'passed' }).allowed).toBe(false);
  });

  it('admin_review -> approved requires PII screening to have passed', () => {
    expect(decideGovernanceTransition('admin_review', 'approved', { piiScreeningStatus: 'passed' }).allowed).toBe(true);
    expect(decideGovernanceTransition('admin_review', 'approved', { piiScreeningStatus: 'flagged' }).allowed).toBe(false);
    expect(decideGovernanceTransition('admin_review', 'approved', { piiScreeningStatus: 'not_screened' }).allowed).toBe(false);
    expect(decideGovernanceTransition('admin_review', 'approved', { piiScreeningStatus: 'rejected' }).allowed).toBe(false);
  });

  it('admin_review -> merged requires PII screening to have passed (same gate as approved)', () => {
    expect(decideGovernanceTransition('admin_review', 'merged', { piiScreeningStatus: 'passed' }).allowed).toBe(true);
    expect(decideGovernanceTransition('admin_review', 'merged', { piiScreeningStatus: 'flagged' }).allowed).toBe(false);
  });

  it('admin_review -> rejected is always allowed regardless of PII screening', () => {
    expect(decideGovernanceTransition('admin_review', 'rejected', { piiScreeningStatus: 'not_screened' }).allowed).toBe(true);
  });

  it('terminal statuses (approved/rejected/merged) permit no further transition', () => {
    for (const terminal of ['approved', 'rejected', 'merged'] as const) {
      for (const target of ['open', 'admin_review', 'approved', 'rejected', 'merged'] as const) {
        if (target === terminal) continue;
        expect(decideGovernanceTransition(terminal, target, { piiScreeningStatus: 'passed' }).allowed, `${terminal} -> ${target}`).toBe(false);
      }
    }
  });

  it('a no-op transition (same status) is never allowed', () => {
    expect(decideGovernanceTransition('admin_review', 'admin_review', { piiScreeningStatus: 'passed' }).allowed).toBe(false);
  });

  it('builds aggregate-only evidence with non-negative counts', () => {
    const evidence = buildCandidateEvidence({
      candidateType: 'merchant_alias',
      numberOfIndependentUsers: 5,
      numberOfCorrections: 8,
      numberOfMatchingAliases: 3,
    });
    expect(evidence.numberOfIndependentUsers).toBe(5);
    expect(Object.keys(evidence)).not.toContain('rawNarrative');
    expect(Object.keys(evidence)).not.toContain('userId');
  });

  it('rejects negative evidence counts', () => {
    expect(() => buildCandidateEvidence({
      candidateType: 'merchant_alias',
      numberOfIndependentUsers: -1,
      numberOfCorrections: 0,
      numberOfMatchingAliases: 0,
    })).toThrow();
  });

  it('exports no function whose name implies automatic promotion', () => {
    const suspiciousNames = Object.keys(GlobalLearningGovernance)
      .filter((k) => /autoPromote|autoApprove|promoteToGlobal|autoMerge/i.test(k));
    expect(suspiciousNames).toEqual([]);
  });

  it('documents the global-merchant vs private-counterparty boundary as a real, importable fact', () => {
    expect(GLOBAL_MERCHANT_VS_PRIVATE_COUNTERPARTY_BOUNDARY.globalMerchant).toContain('fdh_merchants');
    expect(GLOBAL_MERCHANT_VS_PRIVATE_COUNTERPARTY_BOUNDARY.privateCounterparty).toContain('NOT IMPLEMENTED');
  });
});

describe('FDH-2 classification-precedence resolution semantics', () => {
  it('a user rule always outranks every other source', () => {
    const candidates: PrecedenceCandidate[] = [
      { source: 'ai', categoryKey: 'unknown' },
      { source: 'verified_global_rule', categoryKey: 'food' },
      { source: 'user_rule', categoryKey: 'lifestyle' },
      { source: 'mcc', categoryKey: 'shopping' },
    ];
    expect(resolvePrecedence(candidates)?.categoryKey).toBe('lifestyle');
  });

  it('a verified merchant alias outranks MCC', () => {
    const candidates: PrecedenceCandidate[] = [
      { source: 'mcc', categoryKey: 'shopping' },
      { source: 'verified_merchant_alias', categoryKey: 'food' },
    ];
    expect(resolvePrecedence(candidates)?.categoryKey).toBe('food');
  });

  it('MCC outranks a verified global rule', () => {
    const candidates: PrecedenceCandidate[] = [
      { source: 'verified_global_rule', categoryKey: 'lifestyle' },
      { source: 'mcc', categoryKey: 'food' },
    ];
    expect(resolvePrecedence(candidates)?.categoryKey).toBe('food');
  });

  it('a narrative pattern outranks a fuzzy merchant match and AI', () => {
    const candidates: PrecedenceCandidate[] = [
      { source: 'ai', categoryKey: 'unknown' },
      { source: 'fuzzy_merchant_match', categoryKey: 'shopping' },
      { source: 'narrative_pattern', categoryKey: 'financial_fees' },
    ];
    expect(resolvePrecedence(candidates)?.categoryKey).toBe('financial_fees');
  });

  it('an empty candidate list resolves to null (user_review territory)', () => {
    expect(resolvePrecedence([])).toBeNull();
  });

  it('throws on an unrecognised precedence source rather than silently ranking it last', () => {
    expect(() => resolvePrecedence([{ source: 'made_up_source' as never, categoryKey: 'x' }])).toThrow();
  });

  it('the documented order has 9 distinct, non-duplicated members', () => {
    expect(PRECEDENCE_ORDER.length).toBe(9);
    expect(new Set(PRECEDENCE_ORDER).size).toBe(9);
  });

  it('worked example: a user COSTCO override wins for that user, and the global default is echoed back unchanged', () => {
    const result = applyUserOverrideExample({ categoryKey: 'food.groceries' }, { categoryKey: 'housing.household' });
    expect(result.winningCategoryKey).toBe('housing.household');
    expect(result.globalDefaultCategoryKeyUnchanged).toBe('food.groceries');
  });

  it('worked example: with no user override, the global default wins', () => {
    const result = applyUserOverrideExample({ categoryKey: 'food.groceries' }, null);
    expect(result.winningCategoryKey).toBe('food.groceries');
  });
});

describe('FDH-2 normalisation library', () => {
  it('collapses whitespace and upper-cases', () => {
    expect(normaliseNarrative('  woolworths   metro  ')).toBe('WOOLWORTHS METRO');
  });

  it('applies Unicode NFKC normalisation', () => {
    // U+FF37 (fullwidth W) should normalise to the same form as ASCII 'W'.
    expect(normaliseNarrative('Ｗoolworths')).toBe('WOOLWORTHS');
  });

  it('collapses processor marker characters (*, #) without deleting the surrounding words', () => {
    expect(normaliseNarrative('PAYPAL *MERCHANT')).toBe('PAYPAL MERCHANT');
  });

  it('CRITICAL: never over-normalises — "UBER EATS" must never collapse into "UBER"', () => {
    expect(normaliseNarrative('Uber Eats')).toBe('UBER EATS');
    expect(stripGovernedSuffix('UBER EATS')).toBe('UBER EATS');
    expect(normaliseAndStripSuffix('Uber Eats')).toBe('UBER EATS');
  });

  it('strips only a closed list of legal-entity suffixes, never a brand word', () => {
    expect(stripGovernedSuffix('ACME PTY LTD')).toBe('ACME');
    expect(stripGovernedSuffix('WIDGETS LIMITED')).toBe('WIDGETS');
    expect(stripGovernedSuffix('SEVEN ELEVEN')).toBe('SEVEN ELEVEN'); // 'ELEVEN' is not a legal suffix
  });

  it('the governed suffix list contains only legal/corporate designators', () => {
    for (const suffix of GOVERNED_LEGAL_SUFFIXES) {
      expect(/^[A-Z .]+$/.test(suffix)).toBe(true);
    }
  });
});
