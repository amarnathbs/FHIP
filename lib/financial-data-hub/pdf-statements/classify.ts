/**
 * PDF statement routes: "is this document a statement of the class the person chose?".
 *
 * A deterministic signal count over the extracted text, run BEFORE any reader and BEFORE any model. A document that is clearly not
 * this class (a bank account statement sent to the credit card screen, a card statement sent to the super screen, a letter) is
 * refused with `not_this_class`: nothing is saved, no model is called, nothing is charged. This is the "wrong document type" case
 * the AI-fallback design rules out (a model asked to read a statement out of something that is not one will invent one).
 *
 * It is a HEURISTIC with a published threshold, tuned against the synthetic corpus and NOT against real lender documents (none
 * were available). A real statement of this class that uses unusual wording and scores below the threshold is refused rather than
 * guessed; the person can upload the CSV or add the item manually. The signal lists are exported so the tests (and a reviewer) can see exactly what counts.
 */

export type SignalClass = 'card' | 'loan' | 'retirement' | 'investment' | 'bank_account';

const SIGNALS: Record<SignalClass, readonly RegExp[]> = {
  card: [
    /credit card/i,
    /card (?:number|ending|no\b)/i,
    /credit limit/i,
    /minimum (?:payment|repayment)/i,
    /payment due/i,
    /cash advance/i,
    /interest charges?/i,
    /available credit/i,
    /\b(?:visa|mastercard|amex)\b/i,
    /purchases? (?:and|&) charges|purchases this period/i,
  ],
  loan: [
    /\bloan\b/i,
    /\bprincipal\b/i,
    /\brepayments?\b/i,
    /interest rate|p\.a\./i,
    /loan account/i,
    /\bredraw\b|\boffset\b/i,
    /\bEMI\b|instal?lments?/i,
    /interest charged/i,
    /maturity|term remaining/i,
  ],
  retirement: [
    /\bsuper(?:annuation)?\b/i,
    /\bmember (?:number|name|id|no\b)/i,
    /\bfund\b/i,
    /\bpension\b/i,
    /employer contributions?/i,
    /(?:contributions?|income) tax|tax on contributions?/i,
    /investment options?/i,
    /rollovers?/i,
    /provident fund|\bEPF\b|\bUAN\b|passbook|\bNPS\b|\bPRAN\b/i,
    /salary sacrifice/i,
    /insurance premiums?/i,
    /accumulation|preservation/i,
  ],
  investment: [
    /\bHIN\b|\bSRN\b|\bCHESS\b/i,
    /holdings? (?:statement|valuation)|portfolio (?:valuation|summary|statement)/i,
    /\bASX\b/i,
    /securit(?:y|ies)|\bshares?\b|\bETF\b|units held/i,
    /market value/i,
    /brokerage|broking|broker/i,
    /contract note|trade confirmation/i,
    /transaction statement|activity statement/i,
    /\bdividends?\b|\bdistributions?\b/i,
    /\bcode\b.*\bquantity\b.*\bprice\b/i,
  ],
  bank_account: [
    /\bBSB\b/i,
    /transaction account|savings account|everyday account|cheque account/i,
    /\bdebit\b.*\bcredit\b.*\bbalance\b/i,
    /account number/i,
  ],
};

export function scoreSignals(text: string): Record<SignalClass, number> {
  const out = {} as Record<SignalClass, number>;
  for (const k of Object.keys(SIGNALS) as SignalClass[]) out[k] = SIGNALS[k].filter((re) => re.test(text)).length;
  return out;
}

/** Fewest distinct signals for a document to count as this class. */
export const MIN_CLASS_SIGNALS = 2;

export interface ClassCheck {
  ok: boolean;
  scores: Record<SignalClass, number>;
}

/**
 * Credit card or loan, as the person declared. A card needs at least 2 card signals and not fewer than the loan signals; a loan
 * needs at least 2 loan signals and not fewer than the card signals. A document that is mostly bank-account wording scores low on
 * both and is refused.
 */
export function checkLiabilityClass(text: string, declared: 'credit_card' | 'loan'): ClassCheck {
  const s = scoreSignals(text);
  const ok = declared === 'credit_card'
    ? s.card >= MIN_CLASS_SIGNALS && s.card >= s.loan
    : s.loan >= MIN_CLASS_SIGNALS && s.loan >= s.card;
  return { ok, scores: s };
}

/** A retirement statement needs at least 3 retirement signals (the wording is broad: "fund" and "member" alone appear in many documents) and must out-score a card or investment reading. */
export function checkRetirementClass(text: string): ClassCheck {
  const s = scoreSignals(text);
  return { ok: s.retirement >= 3 && s.retirement > s.card && s.retirement >= s.investment, scores: s };
}

/** A broker statement needs at least 3 investment signals and must out-score a retirement reading. */
export function checkInvestmentClass(text: string): ClassCheck {
  const s = scoreSignals(text);
  return { ok: s.investment >= 3 && s.investment > s.retirement && s.investment > s.card, scores: s };
}

/** Exposed for tests and the specification check. */
export const CLASS_SIGNAL_COUNTS: Record<SignalClass, number> = {
  card: SIGNALS.card.length,
  loan: SIGNALS.loan.length,
  retirement: SIGNALS.retirement.length,
  investment: SIGNALS.investment.length,
  bank_account: SIGNALS.bank_account.length,
};
