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
  //
  // Real production incident, 2026-09-07: a real CAMS statement's actual
  // wording for a failed SIP instalment is "Systematic Investment
  // Rejection" -- word-form "Rejection", not "rejected", and with no
  // co-occurring "units" mention anywhere (the old `\brejected\b.*\bunits?\b`
  // clause required both and matched neither). Because this rule failed,
  // classification fell through to 'sip_purchase' below, which matches
  // ANY description containing the substring "systematic investment" --
  // so every rejected/bounced SIP instalment for the affected fund was
  // counted as a genuine contribution, inflating "Total Contributed" from
  // a real 1,000 to a wrong 71,000 (71 rejected instalments, only 1 ever
  // actually went through). `\brejected\b`/`\brejection\b` are now matched
  // standalone, with no required co-occurring word, since real RTA wording
  // for a bounced/failed instalment never needs one to be unambiguous.
  { code: 'reversal', test: /\breversal\b|\breversed\b|\brejected\b|\brejection\b/i, type: 'reversal' },
  { code: 'switch_in', test: /switch.*\bin\b/i, type: 'switch_in' },
  { code: 'switch_out', test: /switch.*\bout\b/i, type: 'switch_out' },
  // Real production incident, 2026-09-07: a real CAMS statement's actual
  // wording for an inter-scheme unit movement is "Lateral Shift In/Out"
  // (a CAMS/RTA-specific synonym for a switch, e.g. "Lateral Shift In
  // (From LF (DP) F.No:...)(From NIPPON INDIA LIQUID FUND - RETAIL OPTION -
  // WEEKLY IDCW OPTION F.No:...)"). Before this rule existed, this fell
  // through to the 'dividend' rule below because the description happens
  // to name the SOURCE scheme's plan variant, which contains the substring
  // "IDCW" -- a false match on an unrelated fund name, not an actual
  // dividend on this transaction. Because reconciliation.ts's
  // DIRECTION_TABLE correctly excludes true 'dividend' rows from the
  // units-replay sum (cash_only), this silently dropped these transactions'
  // real unit impact from reconciliation, producing an impossible negative
  // reconstructed closing balance for the receiving scheme.
  //
  // Classified here as 'transfer' (passthrough — sign taken as parsed),
  // NOT 'switch_in'/'switch_out': a lateral shift is economically a switch
  // and may carry real capital-gains consequences, but 'switch_in'/
  // 'switch_out' feed R6's tax-lot/FIFO engine (taxRepository.ts's
  // ACQUISITION_TYPE_MAP/DISPOSAL_TYPES) which expects same-transaction
  // scheme-level cost-basis data this parser does not currently attach.
  // 'transfer' is in neither map, so this fix is reconciliation-only and
  // does not change R6's tax treatment (these rows were already excluded
  // from both maps under the old 'dividend' type) -- whether lateral
  // shifts should ALSO be tax-lot-tracked is a separate, disclosed gap for
  // a future PC5/PC6/PC7-scoped decision, not silently folded into this fix.
  { code: 'lateral_shift', test: /lateral shift/i, type: 'transfer' },
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
