// Investment Intelligence R2 — canonical transaction-type classification
// (spec section 19). Shared by every provider adapter so CAMS and
// KFintech's differently-worded narratives ("SIP Purchase" vs "Systematic
// Investment - Purchase") converge on the SAME canonical taxonomy, rather
// than each parser inventing its own mapping.
//
// Deliberately ORDERED, most-specific-first: a description like "Switch In
// SIP Purchase" must classify as SWITCH_IN, not SIP, so the switch-related
// rules are checked before the generic purchase/SIP rules. Unknown
// descriptions are NEVER forced into an incorrect type — they classify as
// 'unclassified' with confidence 0, and the caller (documentProcessing.ts)
// is responsible for opening a TRANSACTION_UNCLASSIFIED reconciliation case
// when material (spec section 19).

import type { IiTransactionType } from './types';

export interface TransactionTypeClassification {
  canonicalType: IiTransactionType;
  confidence: number; // 1.0 = exact known keyword rule matched; 0 = fell through to unclassified
  matchedRuleCode: string | null;
}

interface Rule {
  code: string;
  test: RegExp;
  type: IiTransactionType;
}

// Order matters — first match wins.
const RULES: Rule[] = [
  { code: 'stp_in', test: /\bstp\b.*\b(in|purchase)\b|systematic transfer.*\bin\b/i, type: 'stp_in' },
  { code: 'stp_out', test: /\bstp\b.*\bout\b|systematic transfer.*\bout\b/i, type: 'stp_out' },
  { code: 'swp', test: /\bswp\b|systematic withdrawal/i, type: 'swp' },
  // 'reversal' is checked BEFORE the generic purchase/redemption rules
  // deliberately: a real RTA narrative like "Purchase - Reversed" or
  // "Redemption Reversal" contains a purchase/redemption keyword too, and
  // the reversal fact is the more important classification signal
  // (spec section 39/40's CAMS/KFIN adversarial rule-precedence test case
  // exercises exactly this ordering).
  { code: 'reversal', test: /\breversal\b|\breversed\b|\brejected\b.*\bunits?\b/i, type: 'reversal' },
  { code: 'switch_in', test: /switch.*\bin\b/i, type: 'switch_in' },
  { code: 'switch_out', test: /switch.*\bout\b/i, type: 'switch_out' },
  { code: 'dividend_reinvestment', test: /(idcw|dividend).*(reinvest)/i, type: 'reinvestment' },
  { code: 'reinvestment_generic', test: /\breinvest(ment)?\b/i, type: 'reinvestment' },
  { code: 'dividend', test: /\bidcw\b|\bdividend\b/i, type: 'dividend' },
  { code: 'sip_purchase', test: /\bsip\b|systematic investment/i, type: 'sip' },
  { code: 'purchase', test: /\bpurchase\b|\bfresh purchase\b|\badditional purchase\b|\bsubscription\b/i, type: 'purchase' },
  { code: 'redemption', test: /\bredemption\b|\bredeem\b/i, type: 'redemption' },
  { code: 'transfer_in', test: /transfer.*\bin\b/i, type: 'transfer_in' },
  { code: 'transfer_out', test: /transfer.*\bout\b/i, type: 'transfer_out' },
  { code: 'transfer_generic', test: /\btransfer\b/i, type: 'transfer' },
  { code: 'merger', test: /\bmerger\b|\bmerged\b|\bscheme consolidation\b/i, type: 'merger' },
  { code: 'segregation', test: /\bsegregat/i, type: 'segregation' },
  { code: 'fee', test: /\btransaction charge\b|\bstamp duty\b|\bfee\b/i, type: 'fee' },
  { code: 'tax', test: /\bstt\b|\btax deduct/i, type: 'tax' },
  { code: 'adjustment', test: /\badjustment\b|\brectification\b/i, type: 'adjustment' },
];

export function classifyTransactionType(rawDescription: string): TransactionTypeClassification {
  const desc = rawDescription.trim();
  for (const rule of RULES) {
    if (rule.test.test(desc)) {
      return { canonicalType: rule.type, confidence: 1, matchedRuleCode: rule.code };
    }
  }
  return { canonicalType: 'unclassified', confidence: 0, matchedRuleCode: null };
}
