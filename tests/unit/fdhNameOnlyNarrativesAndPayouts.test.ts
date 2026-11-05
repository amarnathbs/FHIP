/**
 * NAB narratives that are only a name, and payouts from platforms (PO 05-11-2026, from the PO's own AI-categorised reference of two NAB statements).
 *
 * Pinned here: a line that is only the holder's name (plus codes) is a move between own accounts; a joint-account title (holder's name or first
 * initial, a connector, the surname) is a joint-account move; a debit that is only a different first name plus the holder's surname is a payment to
 * family ("Payments to People", which counts as spending); a credit from Stripe / Uber BV / Google Ireland is income, not a Transport refund.
 * Every look-alike that must NOT match is here too. Synthetic names only (the holder is "Pat Sample").
 */
import { describe, it, expect } from 'vitest';
import { buildOwnIdentity, nameOnlyNarrativeKind } from '@/lib/financial-data-hub/classification/ownIdentity';
import { matchBuiltinRule } from '@/lib/financial-data-hub/classification/builtinRules';
import { classifyTransaction } from '@/lib/financial-data-hub/classification/economicTypeEngine';
import { buildReferenceFromSeeds, txnOf } from '../support/classificationReferenceFromSeeds';

const identity = buildOwnIdentity({ selfName: 'Pat Sample', householdNames: [], accountIdentifiers: [], narratives: [] });
const ref = buildReferenceFromSeeds({ ownIdentity: identity });
const keyOf = (id: string | null | undefined) => ref.categories.find((c: { id: string }) => c.id === id)?.category_key ?? null;
const subKeyOf = (id: string | null | undefined) => ref.subcategories.find((s: { id: string }) => s.id === id)?.subcategory_key ?? null;

const kind = (text: string) => nameOnlyNarrativeKind(text.toUpperCase(), identity);
const builtin = (text: string, creditDebit: 'credit' | 'debit') =>
  matchBuiltinRule({ haystackUpper: text.toUpperCase(), creditDebit, currency: 'AUD' }, ref.categories, ref.subcategories, identity);
const full = (text: string, creditDebit: 'credit' | 'debit') =>
  classifyTransaction(txnOf(text, { credit_debit: creditDebit, currency_original: 'AUD', amount_original: 100, transaction_type_hint: creditDebit }) as never, null, ref as never);

describe('name-only narratives: what kind of line is it', () => {
  it('only the holder name plus codes is the holder (own accounts)', () => {
    expect(kind('Pat Sample 8876')).toBe('self');
    expect(kind('Pat S Sample')).toBe('self'); // a middle initial is ignored
    expect(kind('Pat Sample 5521 Dd-Ue')).toBe('self'); // short reference codes are ignored
    expect(kind('Pat Sample 5521 Other')).toBe('self');
  });

  it('the surname with a connector and the holder name or first initial is a joint account', () => {
    expect(kind('Pat Sample and')).toBe('joint');
    expect(kind('P and S Sample 123')).toBe('joint');
    expect(kind('P S & S P Sample')).toBe('joint');
    expect(kind('Pat Sample and Sam Sample')).toBe('joint');
  });

  it('a different first name with the holder surname and no connector is family', () => {
    expect(kind('Riley Sample 123 456')).toBe('family');
    expect(kind('Sample Riley J')).toBe('family');
  });

  it('LOOK-ALIKES THAT MUST NOT MATCH: another surname, a lone initial, a business word, extra words, a truncated name, no name', () => {
    expect(kind('Riley Jones 123')).toBeNull(); // not the holder surname
    expect(kind('P Sample')).toBeNull(); // a lone initial plus surname proves nothing
    expect(kind('Sample Consulting Pty Ltd')).toBeNull(); // a business word
    expect(kind('Pat Sample Acme Plumbing')).toBeNull(); // the holder name plus a second word that is not a name or a connector... family guard
    expect(kind('Pat Sam 123')).toBeNull(); // a truncated surname
    expect(kind('Woolworths Metro Melbourne')).toBeNull();
    expect(kind('Riley Sample and Alex Sample and Jo Sample')).toBeNull(); // too many other names
    expect(kind('')).toBeNull();
  });

  it('with no signed-in holder name known, nothing matches', () => {
    const none = buildOwnIdentity({ selfName: '', householdNames: [], accountIdentifiers: [], narratives: [] });
    expect(nameOnlyNarrativeKind('PAT SAMPLE 123', none)).toBeNull();
  });
});

describe('the rules that use it', () => {
  it('only the holder name, money in or out, is proposed as an own-account transfer (no transfer word needed)', () => {
    for (const cd of ['credit', 'debit'] as const) {
      const m = builtin('Pat S Sample', cd)!;
      expect(m, cd).not.toBeNull();
      expect(keyOf(m.categoryId)).toBe('transfer_own_account');
      expect(m.isOwnTransfer).toBe(true);
    }
  });

  it('a joint-account title is proposed as an own-account transfer too', () => {
    const m = builtin('P and S Sample 123', 'debit')!;
    expect(keyOf(m.categoryId)).toBe('transfer_own_account');
  });

  it('a debit that is only a family name is Payments to People (spending), and money IN from the same name is left as a question', () => {
    const out = builtin('Riley Sample 123 456', 'debit')!;
    expect(keyOf(out.categoryId)).toBe('payments_to_people');
    expect(out.economicType).toBe('expense');
    expect(out.isOwnTransfer).toBe(false);
    expect(builtin('Sample Riley J', 'credit')).toBeNull();
  });

  it('the holder name inside a longer, different narrative is not decided here', () => {
    expect(builtin('SALARY Pat Sample Acme Pty Ltd', 'credit')).toBeNull();
    expect(builtin('Riley Jones 123', 'debit')).toBeNull();
  });

  it('end to end: the classifier files a name-only credit as a transfer, and a family-name debit as expense', () => {
    expect(full('Pat S Sample', 'credit').economicTransactionType).toBe('transfer');
    const fam = full('Riley Sample 123 456', 'debit');
    expect(fam.economicTransactionType).toBe('expense');
    expect(keyOf(fam.categoryId)).toBe('payments_to_people');
  });
});

describe('payouts from platforms are income, not a Transport refund', () => {
  it('a credit from Stripe, Uber BV, Uber Payments or Google Ireland is gig or business income', () => {
    for (const text of ['STRIPE-abc123 Stripe 998877', 'Store Id: , Txn I Uber Bv 480255', 'UBER PAYMENTS 5512', 'G99887 Google Ireland L 266600']) {
      const m = builtin(text, 'credit')!;
      expect(m, text).not.toBeNull();
      expect(keyOf(m.categoryId), text).toBe('income');
      expect(subKeyOf(m.subcategoryId), text).toBe('self_employment_income');
    }
  });

  it('end to end: an Uber BV credit is income even though Uber is a Transport merchant (the old result was a refund)', () => {
    const r = full('Store Id: , Txn I Uber Bv 480255', 'credit');
    expect(r.economicTransactionType).toBe('income');
    expect(keyOf(r.categoryId)).toBe('income');
  });

  it('LOOK-ALIKES: a debit to the same names, a refund wording, and other platforms are not income', () => {
    expect(keyOf(builtin('STRIPE-abc123 Stripe 998877', 'debit')?.categoryId)).not.toBe('income');
    expect(builtin('STRIPE REFUND 998877', 'credit')).toBeNull();
    expect(builtin('UBER BV REVERSAL 480255', 'credit')).toBeNull();
    expect(keyOf(builtin('Squarespace subscription', 'credit')?.categoryId)).not.toBe('income');
  });
});

describe('NEGATIVE CONTROL: the tests really depend on the new behaviour', () => {
  it('with no holder name known the same name-only line is NOT proposed as a transfer, so the assertions above bite', () => {
    const none = buildOwnIdentity({ selfName: '', householdNames: [], accountIdentifiers: [], narratives: [] });
    const m = matchBuiltinRule({ haystackUpper: 'PAT S SAMPLE', creditDebit: 'credit', currency: 'AUD' }, ref.categories, ref.subcategories, none);
    expect(m).toBeNull();
  });
});
