/**
 * Bank categorisation coverage (PO evidence 29-10-2026: "271 of 341 need you to choose a category").
 *
 * Every rule family has POSITIVE cases (the generic statement shape is recognised) and NEGATIVE cases (look-alikes that must NOT match: a wrong
 * automatic category is worse than a question). All fixtures are synthetic: made-up people, made-up account numbers, no customer content.
 * The engine runs against the REAL governed seed data (tests/support/classificationReferenceFromSeeds.ts).
 */
import { describe, it, expect } from 'vitest';
import { classifyTransaction } from '@/lib/financial-data-hub/classification/economicTypeEngine';
import { matchBuiltinRule, BUILTIN_RULES } from '@/lib/financial-data-hub/classification/builtinRules';
import { buildOwnIdentity, learnOwnMaskPrefixes, matchOwnPerson, EMPTY_OWN_IDENTITY } from '@/lib/financial-data-hub/classification/ownIdentity';
import { isCardPurchaseShape, isPersonToPersonRail } from '@/lib/financial-data-hub/classification/paymentShape';
import { containsPhrase } from '@/lib/financial-data-hub/classification/textMatch';
import { inferTypeHint } from '@/lib/financial-data-hub/bank-csv/normalize';
import { buildReferenceFromSeeds, txnOf } from '../support/classificationReferenceFromSeeds';

const SELF = 'Alex Rowan';
const SPOUSE = 'Casey Jane Rowan';

function identity(extraNarratives: string[] = []) {
  return buildOwnIdentity({ selfName: SELF, householdNames: [SPOUSE, 'Pat'], accountIdentifiers: ['****4821'], narratives: extraNarratives });
}

function classify(description: string, over: { cd?: 'credit' | 'debit'; currency?: string; ownIdentity?: ReturnType<typeof identity> | null; country?: 'AU' | 'IN' } = {}) {
  const cd = over.cd ?? 'debit';
  const ref = buildReferenceFromSeeds({ ownIdentity: over.ownIdentity === null ? undefined : over.ownIdentity ?? identity(), country: over.country });
  const result = classifyTransaction(
    txnOf(description, { credit_debit: cd, currency_original: over.currency ?? 'AUD', transaction_type_hint: inferTypeHint(description, cd) }),
    null,
    ref,
  );
  const cat = ref.categories.find((c) => c.id === result.categoryId)?.category_key ?? null;
  return { result, cat };
}

describe('containsPhrase (word boundary)', () => {
  it('matches whole words and a store number glued on, never a bare substring', () => {
    expect(containsPhrase('VISA-BP DEER PARK', 'BP')).toBe(true);
    expect(containsPhrase('WOOLWORTHS1234 MELBOURNE', 'WOOLWORTHS')).toBe(true);
    expect(containsPhrase('INTERNET BPAY TO X', 'BP')).toBe(false); // BPAY is not BP
    expect(containsPhrase('COLESWORTH PTY LTD', 'COLES')).toBe(false);
    expect(containsPhrase('TOMATO REFUND', 'ATO')).toBe(false);
    expect(containsPhrase('ATO PAYMENT', 'ATO')).toBe(true);
    expect(containsPhrase('', 'ATO')).toBe(false);
  });
});

describe('payment shape helpers', () => {
  it('knows a person-to-person rail from a card purchase', () => {
    expect(isPersonToPersonRail('OSKO PAYMENT TO SOMEONE')).toBe(true);
    expect(isPersonToPersonRail('TRANSFER TO SAV 12345678')).toBe(true);
    expect(isPersonToPersonRail('VISA-COLES CARLTON')).toBe(false);
    expect(isCardPurchaseShape('VISA-COLES CARLTON AU#123(REF.9) APPLE PAY')).toBe(true);
    expect(isCardPurchaseShape('POS #123-ALDI STORES')).toBe(true);
    expect(isCardPurchaseShape('BPAY TO ORIGIN ENERGY')).toBe(false);
  });
});

describe('own identity: no fuzzy name matching', () => {
  it('needs at least two name tokens and EVERY token present as a whole word; initials and partial names never match', () => {
    const id = buildOwnIdentity({ selfName: 'Alex Rowan', householdNames: ['Pat', 'Dr Casey Jane Rowan', null] });
    expect(id.people.map((p) => p.kind)).toEqual(['self', 'household']); // "Pat" (one token) can never match, so it is dropped
    expect(matchOwnPerson('OSKO PAYMENT TO ALEX ROWAN ACCOUNT 1234', id)).toBe('self');
    expect(matchOwnPerson('OSKO FROM CASEY JANE ROWAN', id)).toBe('household');
    expect(matchOwnPerson('OSKO FROM CASEY ROWAN', id)).toBeNull(); // the stored name also has JANE
    expect(matchOwnPerson('OSKO FROM A ROWAN', id)).toBeNull();
    expect(matchOwnPerson('OSKO FROM ALEXANDER ROWAN', id)).toBeNull(); // no prefix matching
    expect(matchOwnPerson('OSKO FROM ALEX', id)).toBeNull();
  });
});

describe('own-account transfers', () => {
  it('Osko payment to yourself is a PROPOSED own-account transfer (MEDIUM, builtin rule, no pending link)', () => {
    const { result, cat } = classify('Osko Payment To Alex Rowan Account 123456789 NAB - Parramatta Ref#8821');
    expect(cat).toBe('transfer_own_account');
    expect(result.confidence).toBe('MEDIUM');
    expect(result.source.kind).toBe('builtin_rule');
    expect(result.classificationMethod).toBe('global_rule');
    expect(result.flaggedCandidate).toBeNull();
    expect(result.explanation).not.toMatch(/Alex|Rowan/); // the name never reaches the explanation
  });
  it('a household member in either direction, with a middle name or an honorific', () => {
    expect(classify('Osko Payment From DR CASEY JANE ROWAN', { cd: 'credit' }).cat).toBe('transfer_own_account');
    expect(classify('OSKO to Casey Jane Rowan 123456 987654321 transfer').cat).toBe('transfer_own_account');
  });
  it('NEGATIVE: a first name alone, a surname alone, a different person with the same surname, initials, or no identity at all', () => {
    expect(classify('Osko Payment To Alex Smith Account 123456789 NAB').cat).toBeNull();
    expect(classify('Osko Payment To Jordan Rowan Account 123456789 NAB').cat).toBeNull();
    expect(classify('Osko Payment To A Rowan Account 123456789 NAB').cat).toBeNull();
    expect(classify('Osko Payment To Alex Rowan Account 123456789 NAB', { ownIdentity: null }).cat).toBeNull();
    expect(classify('Osko Payment To Alex Rowan Account 123456789 NAB', { ownIdentity: EMPTY_OWN_IDENTITY }).cat).toBeNull();
  });
  it('NEGATIVE: the name on a card PURCHASE is not an own-account transfer (a rail word is required)', () => {
    expect(classify('VISA-ALEX ROWAN PLUMBING MELBOURNE').cat).not.toBe('transfer_own_account');
  });
  it('"Transfer to SAV <digits>" is a savings transfer when its title is only household names or initials', () => {
    expect(classify('Transfer to SAV 12345678 to A R Rowan S').cat).toBe('transfer_own_account');
    expect(classify('Received from SAV 12345678 Transfer from A R Rowan S', { cd: 'credit' }).cat).toBe('transfer_own_account');
    expect(classify('Transfer to SAV 12345678').cat).toBe('transfer_own_account');
  });
  it('NEGATIVE: a savings transfer whose title names someone else is a question', () => {
    expect(classify('Transfer to SAV 12345678 to Quillfeather Superannuation Pty Ltd').cat).toBeNull();
    expect(classify('Transfer to SAV 12345678 to Jordan Smith').cat).toBeNull();
  });
  it('linked-account wording and a known account number', () => {
    expect(classify('Linked Acc Trns To Savings').cat).toBe('transfer_own_account');
    expect(classify('Transfer to 990000114821 Savings').cat).toBe('transfer_own_account'); // ends in the last four digits of an imported account
    expect(classify('Transfer to 990000119999 Savings').cat).toBeNull();
  });
  it('credit-union masked member numbers: learned from the user\'s own lines, only when one prefix clearly dominates', () => {
    const own = Array.from({ length: 8 }, (_, i) => `TFR to ***41S3${i % 3}.1 MOB`);
    expect(learnOwnMaskPrefixes(own)).toEqual(['41']);
    expect(learnOwnMaskPrefixes(own.slice(0, 4))).toEqual([]); // fewer than five lines: not enough evidence
    expect(learnOwnMaskPrefixes([...own, ...Array.from({ length: 6 }, () => 'TFR to ***77S31 MOB')])).toEqual([]); // no clear winner
    const id = identity(own);
    expect(classify('TFR to ***41S31.3 MOB', { ownIdentity: id }).cat).toBe('transfer_own_account');
    expect(classify('TFR from ***41S32 MOB', { cd: 'credit', ownIdentity: id }).cat).toBe('transfer_own_account');
    // a loan account under the user's own member number is a loan repayment, never a transfer that counts nowhere
    expect(classify('TFR TO ***41L31 PP', { ownIdentity: id }).cat).toBe('loan_principal');
    // NEGATIVE: somebody else's member number
    expect(classify('TFR to ***77S31 MOB', { ownIdentity: id }).cat).toBeNull();
  });
});

describe('card, store-card and buy-now-pay-later repayments', () => {
  it('BPAY / direct debit to a card provider is a credit-card payment, never an expense', () => {
    for (const d of [
      'Internet BPay to MYCARD CREDIT CARDS - Biller Code 1234 - Receipt No 99',
      'BPAY: CITIBANK READYCREDIT MOB Ref-9 #8',
      'Direct Debit GEM VISA 5521 - SCN',
      'DIRECT DEBIT From: humm Cards Ref: 551_OTDD rem:1',
      'GE SALES FINANCE SCHEM From: GEM VISA 5521 Ref: SCN',
      'CREDIT CARD PAYMENT THANK YOU',
    ]) {
      const { cat, result } = classify(d);
      expect(cat, d).toBe('credit_card_payment');
      expect(result.confidence).toBe('MEDIUM');
    }
  });
  it('NEGATIVE: a card PURCHASE is not a repayment (and no longer opens a pending settlement link)', () => {
    const { result, cat } = classify('VISA-SOME BAKERY CARLTON AU#123(Ref.55) Apple Pay');
    expect(cat).not.toBe('credit_card_payment');
    expect(result.flaggedCandidate).toBeNull();
    expect(classify('VISA-COLES CARLTON AU#123(Ref.55)').result.flaggedCandidate).toBeNull();
    expect(classify('Direct Debit Gym Memberships Pty Ltd').cat).not.toBe('credit_card_payment');
  });
});

describe('merchant matching no longer fires on look-alikes (real defects found 29-10-2026)', () => {
  it('"BPAY" is not the fuel brand "BP"', () => {
    const { cat, result } = classify('Internet BPay to Some Super Fund - Biller Code 1234 - Receipt No 5');
    expect(cat).not.toBe('transport');
    expect(result.source.kind).not.toBe('verified_merchant_alias');
  });
  it('a merchant word in the payer-typed reference of an Osko line decides nothing', () => {
    const { result } = classify('OSKO From Pat Smith Ref-KFC', { cd: 'credit' });
    expect(result.source.kind).not.toBe('verified_merchant_alias');
    expect(result.categoryId).toBeNull();
  });
  it('a real merchant purchase is still HIGH confidence', () => {
    const { cat, result } = classify('VISA-WOOLWORTHS/84-88 MAIN RD CARLTON AU#12(Ref.9) Apple Pay');
    expect(cat).toBe('food');
    expect(result.confidence).toBe('HIGH');
  });
  it('fuel at a wholesale club is fuel, not groceries (the more specific phrase outranks the merchant alias)', () => {
    expect(classify('VISA-COSTCO GAS ARDEER AU#12(Ref.9)').cat).toBe('transport');
    expect(classify('VISA-COSTCO WHOLESALE ARDEER AU#12(Ref.9)').cat).toBe('food');
  });
});

describe('utilities, insurance, housing', () => {
  it.each([
    ['VISA-ALINTA ENERGY SYDNEY AU#12(Ref.9)', 'utilities'],
    ['BPAY SOUTH EAST WATER Biller Code 9999 Receipt 1', 'utilities'],
    ['VISA-Lycamobile Pty Ltd Northmead AU#12', 'utilities'],
    ['DIRECT DEBIT YOUI Car Insurance policy', 'insurance'],
    ['BPAY HCF Biller Code 5555', 'insurance'],
    ['Direct Debit Brimbank Council Rates', 'housing'],
    ['BPAY STRATA Management Biller Code 777', 'housing'],
    ['VISA-Max on Hardware Melbourne AU#12', 'housing'],
  ])('%s -> %s', (d, expected) => {
    expect(classify(d).cat).toBe(expected);
  });
  it('rent: the word on an Osko reference or a rent payment, not a car rental', () => {
    expect(classify('Osko Payment To Jordan Lee Ref#Rent Nov').cat).toBe('housing');
    expect(classify('VISA-CAR RENTAL HERTZ AIRPORT').cat).not.toBe('housing');
    expect(classify('Osko Payment To Jordan Lee Ref#Equipment rental').cat).not.toBe('housing');
  });
  it('NEGATIVE: an unrelated name that merely contains a keyword', () => {
    expect(classify('VISA-WATERFORD PLUMBING CARLTON').cat).not.toBe('utilities');
    expect(classify('VISA-SUPERIOR CLEANING PTY LTD').cat).not.toBe('retirement_contribution');
  });
});

describe('retirement, tax and government', () => {
  it('BPAY to a super fund is a retirement contribution (not fuel, not spending)', () => {
    const { cat } = classify('Internet BPay to AwareSuper Aware Super - Biller Code 1234 - Receipt No 5');
    expect(cat).toBe('retirement_contribution');
    expect(classify('Internet BPay to MLC Super - Biller Code 1234 - Receipt No 5').cat).toBe('retirement_contribution');
  });
  it('NEGATIVE: supermarket / super-cheap-style names are not super funds', () => {
    expect(classify('VISA-SUPER CHEAP AUTO BPAY Receipt 1').cat).not.toBe('retirement_contribution');
    expect(classify('VISA-FRESH SUPERMARKET CARLTON').cat).not.toBe('retirement_contribution');
  });
  it('tax office payments, refunds and benefits go the right way; a look-alike word does not match', () => {
    expect(classify('BPAY TAX OFFICE PAYMENTS ATO Biller Code 75556').cat).toBe('government_tax');
    expect(classify('ATO REFUND', { cd: 'credit' }).cat).toBe('refund_reversal');
    expect(classify('CENTRELINK PARENTING PAYMENT', { cd: 'credit' }).cat).toBe('income');
    expect(classify('CENTRELINK DEBT RECOVERY').cat).not.toBe('income');
    expect(classify('VISA-TOMATO KING GROCER CARLTON').cat).not.toBe('government_tax');
    expect(classify('CENTRELINK PARENTING PAYMENT').cat).not.toBe('income'); // a DEBIT is never a benefit
  });
});

describe('fees, cash, transport, health, education, food', () => {
  it.each([
    ['Visa - 1234-Int Tran Fee - SOME SERVICE US', 'financial_fees'],
    ['NABATM CSH 20th17:50BOX HILL', 'cash_withdrawal'],
    ['POS #1234-MYKI ST ALBANS RS SAB ST ALBANS VICAU', 'transport'],
    ['VISA-LINKT MELBOURNE AU#1', 'transport'],
    ['VISA-AMPOL FOODARY DEER PARK AU#1', 'transport'],
    ['POS #2323-TERRY WHITE BRIMBAN DEER PARK AU', 'health'],
    ['VISA-Sunshine Dental Group SUNSHINE', 'health'],
    ['BPAY OSHC Biller Code 3030 Receipt 9', 'education'],
    ['VISA-SQ *COLOR ERA BAKERY Deer Park', 'food'],
    ['POS #4411-HARRY FRESH MARKET KEILOR DOWNS AU', 'food'],
    ['VISA-Royal Spices Deer Park', 'food'],
    ['VISA-PACIFIC SEAFOOD MARKET FOOTSCRAY', 'food'],
  ])('%s -> %s', (d, expected) => {
    expect(classify(d).cat).toBe(expected);
  });
  it('NEGATIVE look-alikes', () => {
    expect(classify('NABATM FEE SURCHARGE').cat).not.toBe('cash_withdrawal');
    expect(classify('ATM DEPOSIT', { cd: 'credit' }).cat).not.toBe('cash_withdrawal');
    // the fuel brand "Shell" inside another name: the built-in fuel rule declines (the governed MERCHANT seed alias "SHELL" is data and is listed as an open risk)
    expect(matchBuiltinRule({ haystackUpper: 'VISA-SHELL COVE MEDICAL CENTRE', creditDebit: 'debit', currency: 'AUD' }, buildReferenceFromSeeds().categories, buildReferenceFromSeeds().subcategories, EMPTY_OWN_IDENTITY)?.ruleKey).not.toBe('au_fuel_brands');
    expect(classify('VISA-CAFE SUPPLIES WHOLESALE').cat).not.toBe('food');
    expect(classify('VISA-PARKING FINE INFRINGEMENT').cat).not.toBe('transport');
  });
  it('spending rules apply to money OUT only: the same words as a credit stay a question', () => {
    expect(classify('VISA-SQ *COLOR ERA BAKERY Deer Park', { cd: 'credit' }).cat).toBeNull();
    expect(classify('Direct Credit Sunshine Dental Group', { cd: 'credit' }).cat).toBeNull();
  });
  it('a payment to another person is never given a spending category', () => {
    for (const d of ['Osko Payment To Jordan Smith Account 123456789 WBC Ref#Dinner', 'OSKO to Taylor Green Ref-Thai food', 'Osko Payment To Sam Lee Ref#Pizza night']) {
      expect(classify(d).cat, d).toBeNull();
    }
  });
});

describe('brokers and loans', () => {
  it('funding an investment platform is an investment purchase; money back from it is a sale', () => {
    expect(classify('OSKO to Superhero MOB t12@superhero.com.au Ref-Fund t').cat).toBe('investment_purchase');
    expect(classify('Osko From Superhero Securities', { cd: 'credit' }).cat).toBe('investment_sale');
  });
  it('a repayment named on a transfer line is a loan repayment', () => {
    expect(classify('Transfer to HL 123456 to A R Rowan - Repayment June 26').cat).toBe('loan_principal');
    expect(classify('MORTGAGE REPAYMENT').cat).toBe('loan_principal');
    expect(classify('MORTGAGE INTEREST CHARGED').cat).not.toBe('loan_principal');
  });
});

describe('India shares the engine: INR rules are separate from AU rules', () => {
  it('INR narratives use the India set; AU brand words do not fire on INR and vice versa', () => {
    expect(classify('BESCOM ELECTRICITY BILL PAYMENT', { currency: 'INR', country: 'IN' }).cat).toBe('utilities');
    expect(classify('LIC PREMIUM 12345', { currency: 'INR', country: 'IN' }).cat).toBe('insurance');
    expect(classify('VISA-ALINTA ENERGY SYDNEY', { currency: 'INR', country: 'IN' }).cat).toBeNull();
    expect(classify('BESCOM ELECTRICITY BILL PAYMENT', { currency: 'AUD' }).cat).toBe('utilities'); // "ELECTRICITY" is also an AU wording
    expect(classify('LIC PREMIUM 12345', { currency: 'AUD' }).cat).toBeNull();
  });
});

describe('structure of the rule table and the engine contract', () => {
  it('every built-in rule names a real category and subcategory, and only the rent/loan/broker rules may match a person-to-person line', () => {
    const ref = buildReferenceFromSeeds();
    for (const r of BUILTIN_RULES) {
      const cat = ref.categories.find((c) => c.category_key === r.category);
      expect(cat, r.key).toBeTruthy();
      if (r.subcategory) expect(ref.subcategories.some((s) => s.category_id === cat!.id && s.subcategory_key === r.subcategory), `${r.key} subcategory`).toBe(true);
      for (const phrase of [...r.anyOf, ...(r.andAnyOf ?? []), ...(r.noneOf ?? [])]) expect(phrase, `${r.key}: phrases are upper case`).toBe(phrase.toUpperCase());
    }
    expect(BUILTIN_RULES.filter((r) => r.allowOnPersonToPerson).map((r) => r.key).sort()).toEqual(
      ['au_broker_funding', 'au_broker_withdrawal', 'au_loan_repayment_on_transfer_line', 'au_rent_reference'],
    );
  });
  it('a built-in rule is never HIGH, never a database rule id, never a user decision', () => {
    for (const d of ['Osko Payment To Alex Rowan Account 123456789 NAB', 'Direct Debit GEM VISA 5521 - SCN', 'VISA-ALINTA ENERGY SYDNEY']) {
      const { result } = classify(d);
      expect(result.confidence).toBe('MEDIUM');
      expect(result.source.kind).toBe('builtin_rule');
      expect(result.source.ruleId).toBeUndefined();
      expect(result.source.builtinRuleKey).toBeTruthy();
      expect(result.classificationMethod).toBe('global_rule');
    }
  });
  it('two built-in rules of the same priority that disagree propose nothing', () => {
    const ref = buildReferenceFromSeeds();
    // "SALON" (personal care, 335) and "HARDWARE" (housing, 330) differ in priority, so craft a genuine tie: gym (335) and personal care (335)
    const tie = matchBuiltinRule({ haystackUpper: 'VISA-FITNESS HAIR SALON CARLTON', creditDebit: 'debit', currency: 'AUD' }, ref.categories, ref.subcategories, EMPTY_OWN_IDENTITY);
    expect(tie).toBeNull();
  });
  it('a higher tier always wins: a verified merchant, an approved global rule, and the user\'s own rule', () => {
    expect(classify('VISA-WOOLWORTHS CARLTON AU#1').result.source.kind).toBe('verified_merchant_alias');
    expect(classify('MONTHLY ACCOUNT FEE').result.source.kind).toBe('narrative_pattern'); // the governed fee rule
  });
  it('a line the engine could not classify keeps its transfer hint candidate; a classified one does not', () => {
    const unresolvedOsko = classify('Osko Payment To Jordan Smith Account 123456789 WBC Ref#Gift');
    expect(unresolvedOsko.result.source.kind).toBe('unresolved');
    expect(unresolvedOsko.result.flaggedCandidate).toBe('transfer_candidate');
    expect(classify('UPI/12345/SWIGGY FOOD ORDER', { currency: 'INR', country: 'IN' }).result.flaggedCandidate).toBeNull();
  });
});
