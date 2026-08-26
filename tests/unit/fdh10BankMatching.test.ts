/**
 * FDH-10 — bank payment matching certification (spec sections 39-43).
 * Mandatory negative control: same amount / wrong lender must NOT auto-match.
 */
import { describe, expect, it } from 'vitest';
import { matchBankPayment, type BankTransactionCandidate } from '@/lib/financial-data-hub/liability/bankMatching';
import { matchLiabilityFacility, type ExistingLiabilityCandidate } from '@/lib/financial-data-hub/liability/facilityMatching';

describe('FDH-10 — bank payment matching: never amount alone (spec section 39, mandatory negative control)', () => {
  it('GREEN: single candidate with amount + date + institution match is MATCHED', () => {
    const candidates: BankTransactionCandidate[] = [
      { transactionId: 'txn-1', amount: 350, transactionDate: '2026-08-10', institutionOrNarrativeMatches: true, positivelyWrongFacility: false },
    ];
    const result = matchBankPayment({ paymentAmount: 350, paymentDate: '2026-08-10', currencyCode: 'AUD' }, candidates);
    expect(result.outcome).toBe('matched');
    expect(result.matchedTransactionId).toBe('txn-1');
  });

  it('RED prevented: same amount, WRONG lender must NOT auto-match', () => {
    const candidates: BankTransactionCandidate[] = [
      { transactionId: 'txn-wrong', amount: 350, transactionDate: '2026-08-10', institutionOrNarrativeMatches: false, positivelyWrongFacility: true },
    ];
    const result = matchBankPayment({ paymentAmount: 350, paymentDate: '2026-08-10', currencyCode: 'AUD' }, candidates);
    expect(result.outcome).toBe('no_match');
    expect(result.matchedTransactionId).toBeNull();
  });

  it('amount + date alone (no institution/narrative/recurring signal at all) never matches', () => {
    const candidates: BankTransactionCandidate[] = [
      { transactionId: 'txn-1', amount: 350, transactionDate: '2026-08-10', institutionOrNarrativeMatches: false, positivelyWrongFacility: false },
    ];
    const result = matchBankPayment({ paymentAmount: 350, paymentDate: '2026-08-10', currencyCode: 'AUD' }, candidates);
    expect(result.outcome).toBe('no_match');
  });

  it('MULTIPLE PLAUSIBLE CANDIDATES -> REVIEW_REQUIRED, never auto-picks the first (spec section 41)', () => {
    const candidates: BankTransactionCandidate[] = [
      { transactionId: 'txn-1', amount: 350, transactionDate: '2026-08-10', institutionOrNarrativeMatches: true, positivelyWrongFacility: false },
      { transactionId: 'txn-2', amount: 350, transactionDate: '2026-08-11', institutionOrNarrativeMatches: true, positivelyWrongFacility: false },
    ];
    const result = matchBankPayment({ paymentAmount: 350, paymentDate: '2026-08-10', currencyCode: 'AUD' }, candidates);
    expect(result.outcome).toBe('multiple_candidates');
    expect(result.matchedTransactionId).toBeNull();
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('a candidate outside date tolerance is excluded even with a perfect amount+institution match', () => {
    const candidates: BankTransactionCandidate[] = [
      { transactionId: 'txn-1', amount: 350, transactionDate: '2026-09-30', institutionOrNarrativeMatches: true, positivelyWrongFacility: false },
    ];
    const result = matchBankPayment({ paymentAmount: 350, paymentDate: '2026-08-10', currencyCode: 'AUD', dateToleranceDays: 5 }, candidates);
    expect(result.outcome).toBe('no_match');
  });

  it('a recurring pattern match can substitute for an institution/narrative signal', () => {
    const candidates: BankTransactionCandidate[] = [
      { transactionId: 'txn-1', amount: 350, transactionDate: '2026-08-10', institutionOrNarrativeMatches: false, positivelyWrongFacility: false, recurringPatternMatch: true },
    ];
    const result = matchBankPayment({ paymentAmount: 350, paymentDate: '2026-08-10', currencyCode: 'AUD' }, candidates);
    expect(result.outcome).toBe('matched');
  });

  it('one repayment event only: a matched result never implies a second cash outflow (structural check)', () => {
    // matchBankPayment's own result type carries no "create a new
    // transaction" instruction anywhere — only a reference to an EXISTING
    // transaction id, structurally preventing a second write from this
    // module (spec section 43).
    const candidates: BankTransactionCandidate[] = [
      { transactionId: 'txn-1', amount: 2000, transactionDate: '2026-08-10', institutionOrNarrativeMatches: true, positivelyWrongFacility: false },
    ];
    const result = matchBankPayment({ paymentAmount: 2000, paymentDate: '2026-08-10', currencyCode: 'AUD' }, candidates);
    expect(Object.keys(result)).not.toContain('newTransactionId');
    expect(result.matchedTransactionId).toBe('txn-1');
  });
});

describe('FDH-10 — liability facility matching: never balance alone (spec sections 50-52)', () => {
  const existing: ExistingLiabilityCandidate[] = [
    { liabilityId: 'liab-1', debtType: 'credit_card', currencyCode: 'AUD', maskedIdentifier: '****1234', lender: 'Big Bank', liabilityName: 'Big Bank Card' },
    { liabilityId: 'liab-2', debtType: 'credit_card', currencyCode: 'AUD', maskedIdentifier: '****5678', lender: 'Big Bank', liabilityName: 'Big Bank Card 2' },
  ];

  it('a masked-identifier match resolves to a single liability', () => {
    const result = matchLiabilityFacility({ facilityDebtType: 'credit_card', currencyCode: 'AUD', institutionName: 'Big Bank', maskedIdentifier: '****1234' }, existing);
    expect(result.outcome).toBe('single_match');
    expect(result.matchedLiabilityId).toBe('liab-1');
  });

  it('multiple cards with the SAME bank (spec section 72) is AMBIGUOUS when no masked identifier disambiguates', () => {
    const result = matchLiabilityFacility({ facilityDebtType: 'credit_card', currencyCode: 'AUD', institutionName: 'Big Bank', maskedIdentifier: null }, existing);
    expect(result.outcome).toBe('ambiguous');
    expect(result.candidateIds).toHaveLength(2);
  });

  it('no institution and no masked identifier at all is NO_MATCH, never guessed from balance', () => {
    const result = matchLiabilityFacility({ facilityDebtType: 'credit_card', currencyCode: 'AUD', institutionName: null, maskedIdentifier: null }, existing);
    expect(result.outcome).toBe('no_match');
  });

  it('a different debt type or currency is never matched even with the same masked identifier', () => {
    const result = matchLiabilityFacility({ facilityDebtType: 'personal_loan', currencyCode: 'AUD', institutionName: 'Big Bank', maskedIdentifier: '****1234' }, existing);
    expect(result.outcome).toBe('no_match');
  });
});
