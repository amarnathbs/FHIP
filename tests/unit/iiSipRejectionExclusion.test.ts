import { describe, it, expect } from 'vitest';
import {
  isSourceConfirmedSip,
  detectSipSeries,
  type SipCandidateTransaction,
} from '@/lib/engines/investment-intelligence/sip/sipDetection';

// Real production incident, 2026-09-07: a real fund's SIP had 71 monthly
// instalments of Rs 1,000, of which only 1 actually went through -- the
// other 70 were "Systematic Investment Rejection" bounces (insufficient
// funds). The UI showed "Total Contributed: Rs 71,000" instead of the real
// Rs 1,000, because TWO independent bugs both counted the rejections as
// contributions:
//
// 1. transactionTypeMapping.ts's 'reversal' rule didn't match the word-form
//    "Rejection" (only "rejected", and only paired with "units") --
//    covered separately in iiR2TransactionTypeMapping.test.ts.
// 2. sipDetection.ts's isSourceConfirmedSip() independently treats ANY
//    description containing "systematic investment" as confirmed-SIP
//    evidence, regardless of transactionType -- so even after fixing bug
//    #1 (transactionType correctly becomes 'reversal'), this SEPARATE
//    check would still pull the rejected instalment back into the series
//    via detectSipSeries()'s `SERIES_MEMBER_TYPES.has(t.transactionType)
//    || isSourceConfirmedSip(t)` OR-clause. Both must be fixed together;
//    this file proves bug #2's fix and the end-to-end effect of both.
//
// Every value below is invented (amounts, dates, ids) -- reproduces only
// the structural shape of the real incident.

function txn(overrides: Partial<SipCandidateTransaction>): SipCandidateTransaction {
  return {
    id: 'txn-default',
    accountId: 'acct-1',
    instrumentId: 'instr-nippon',
    transactionType: 'sip',
    transactionDate: '2025-01-10',
    grossAmount: 1000,
    units: 10,
    currencyCode: 'INR',
    sourceDescription: 'Systematic Investment - Purchase',
    ...overrides,
  };
}

describe('isSourceConfirmedSip: a rejected/reversed instalment is never confirmed contribution evidence', () => {
  it('returns false for a real-world "Systematic Investment Rejection" description, even though it contains "systematic investment"', () => {
    const t = txn({ transactionType: 'reversal', sourceDescription: 'Systematic Investment Rejection' });
    expect(isSourceConfirmedSip(t)).toBe(false);
  });

  it('still returns true for a genuine, non-rejected SIP description', () => {
    const t = txn({ transactionType: 'sip', sourceDescription: 'Systematic Investment - Purchase' });
    expect(isSourceConfirmedSip(t)).toBe(true);
  });

  it('returns false for a description mentioning plain "SIP" alongside "Reversed"', () => {
    const t = txn({ transactionType: 'reversal', sourceDescription: 'SIP Instalment Reversed' });
    expect(isSourceConfirmedSip(t)).toBe(false);
  });
});

describe('detectSipSeries: rejected instalments are excluded end-to-end (real production incident, 2026-09-07)', () => {
  it('a fund with 1 real contribution and 70 rejected instalments totals only the real amount', () => {
    const real = txn({ id: 'real-1', transactionDate: '2025-01-10', grossAmount: 1000, transactionType: 'sip', sourceDescription: 'Systematic Investment - Purchase' });
    const rejections: SipCandidateTransaction[] = Array.from({ length: 70 }, (_, i) =>
      txn({
        id: `rejected-${i}`,
        transactionDate: `2025-${String(2 + (i % 11)).padStart(2, '0')}-10`,
        grossAmount: 1000,
        // Post-fix: transactionTypeMapping.ts now classifies this description
        // as 'reversal', not 'sip' -- reflected here as the stored R2 type.
        transactionType: 'reversal',
        sourceDescription: 'Systematic Investment Rejection',
      }),
    );
    const series = detectSipSeries([real, ...rejections]);
    // Only the one genuine contribution should ever reach a series.
    const allContributions = series.flatMap((s) => s.contributions);
    expect(allContributions.length).toBe(1);
    expect(allContributions[0].id).toBe('real-1');
    const totalContributed = allContributions.reduce((sum, c) => sum + c.grossAmount, 0);
    expect(totalContributed).toBe(1000); // NOT 71,000
  });
});
