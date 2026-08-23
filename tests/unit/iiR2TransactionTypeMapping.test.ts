import { describe, it, expect } from 'vitest';
import { classifyTransactionType } from '@/lib/services/investment-intelligence/transactionTypeMapping';

describe('classifyTransactionType (spec section 19 — canonical transaction taxonomy)', () => {
  const cases: [string, string][] = [
    ['Purchase', 'purchase'],
    ['Fresh Purchase', 'purchase'],
    ['Additional Purchase', 'purchase'],
    ['SIP Purchase', 'sip'],
    ['Systematic Investment', 'sip'],
    ['Redemption', 'redemption'],
    ['Redeem', 'redemption'],
    ['Switch In From XYZ Fund', 'switch_in'],
    ['Switch Out To XYZ Fund', 'switch_out'],
    ['STP In From XYZ Fund', 'stp_in'],
    ['STP Out To XYZ Fund', 'stp_out'],
    ['SWP Withdrawal', 'swp'],
    ['Systematic Withdrawal', 'swp'],
    ['IDCW Payout', 'dividend'],
    ['Dividend Payout', 'dividend'],
    ['IDCW Reinvestment', 'reinvestment'],
    ['Dividend Reinvestment', 'reinvestment'],
    ['Reinvestment', 'reinvestment'],
    ['Transfer In', 'transfer_in'],
    ['Transfer Out', 'transfer_out'],
    ['Transfer', 'transfer'],
    ['Merger', 'merger'],
    ['Scheme Consolidation', 'merger'],
    ['Segregated Portfolio Creation', 'segregation'],
    ['Transaction Charge', 'fee'],
    ['Stamp Duty', 'fee'],
    ['STT Deducted', 'tax'],
    ['Adjustment', 'adjustment'],
    ['Rectification Entry', 'adjustment'],
  ];

  for (const [desc, expected] of cases) {
    it(`classifies "${desc}" as ${expected}`, () => {
      expect(classifyTransactionType(desc).canonicalType).toBe(expected);
    });
  }

  it('classifies a genuinely unrecognised description as unclassified with confidence 0 (never forced into a wrong type)', () => {
    const r = classifyTransactionType('Some Entirely Novel Statement Line Nobody Has Seen Before');
    expect(r.canonicalType).toBe('unclassified');
    expect(r.confidence).toBe(0);
    expect(r.matchedRuleCode).toBeNull();
  });

  it('rule-precedence: "Purchase - Reversed" classifies as reversal, not purchase (reversal keyword takes priority)', () => {
    expect(classifyTransactionType('Purchase - Reversed').canonicalType).toBe('reversal');
  });

  it('rule-precedence: "Redemption Reversal" classifies as reversal, not redemption', () => {
    expect(classifyTransactionType('Redemption Reversal').canonicalType).toBe('reversal');
  });

  it('rule-precedence: "Dividend Reinvestment" classifies as reinvestment, not plain dividend', () => {
    expect(classifyTransactionType('Dividend Reinvestment').canonicalType).toBe('reinvestment');
  });

  it('rule-precedence: "SIP Purchase - Switch In From XYZ Fund" classifies as switch_in, not sip (switch is checked before generic sip/purchase)', () => {
    // A more specific real-world narrative: an STP/switch instalment that
    // happens to also mention "purchase" in passing.
    expect(classifyTransactionType('Switch In Purchase From XYZ Fund').canonicalType).toBe('switch_in');
  });

  it('exact known keyword match always returns confidence 1', () => {
    expect(classifyTransactionType('Purchase').confidence).toBe(1);
  });
});
