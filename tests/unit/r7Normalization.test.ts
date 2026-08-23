/**
 * R7 — Bank CSV Engine independent certification: transaction normalisation
 * (spec section 64, cases R7-TC041-R7-TC065) — amount canonicalisation,
 * date determinism, description normalisation, structural type hints.
 */
import { describe, expect, it } from 'vitest';
import { normalizeRow, normalizeDescription, adapterToRowFormat } from '@/lib/financial-data-hub/bank-csv/normalize';
import { parseDateWithFormat, inferDateFormat } from '@/lib/financial-data-hub/bank-csv/dateFormats';
import { parseAmountField } from '@/lib/financial-data-hub/bank-csv/amount';
import { AU_CBA_DEBIT_CREDIT_V1, AU_WESTPAC_SINGLE_SIGNED_V1, IN_SBI_DR_CR_V1 } from '@/lib/financial-data-hub/bank-csv/adapters/registry';

const header = ['Date', 'Description', 'Debit Amount', 'Credit Amount', 'Balance'];
const debitCreditFormat = adapterToRowFormat(AU_CBA_DEBIT_CREDIT_V1);
const singleSignedFormat = adapterToRowFormat(AU_WESTPAC_SINGLE_SIGNED_V1);
const drCrFormat = adapterToRowFormat(IN_SBI_DR_CR_V1);

describe('R7-TC041-046 — amount canonicalisation (spec 25-26)', () => {
  it('R7-TC041 debit_credit_columns: a debit-only row is amount>0, direction debit', () => {
    const r = normalizeRow(header, ['01/01/2026', 'Woolworths', '45.20', '', '1954.80'], 1, debitCreditFormat);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.transaction.amountOriginal).toBe(45.2);
      expect(r.transaction.creditDebit).toBe('debit');
    }
  });
  it('R7-TC042 debit_credit_columns: a credit-only row is amount>0, direction credit', () => {
    const r = normalizeRow(header, ['02/01/2026', 'Salary', '', '3500.00', '5454.80'], 2, debitCreditFormat);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.transaction.amountOriginal).toBe(3500);
      expect(r.transaction.creditDebit).toBe('credit');
    }
  });
  it('R7-TC043 debit_credit_columns: both debit and credit populated is ambiguous_direction, never guessed', () => {
    const r = normalizeRow(header, ['01/01/2026', 'Weird', '10.00', '5.00', '100.00'], 3, debitCreditFormat);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous_direction');
  });
  it('R7-TC044 single_signed: a negative amount is a debit', () => {
    const r = normalizeRow(
      ['Date', 'Narrative', 'Amount', 'Balance', 'Categories', 'Serial'],
      ['01/01/2026', 'Woolworths', '-45.20', '1954.80', 'Groceries', '000123'],
      1,
      singleSignedFormat,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.transaction.amountOriginal).toBe(45.2);
      expect(r.transaction.creditDebit).toBe('debit');
    }
  });
  it('R7-TC045 single_signed: a positive amount is a credit', () => {
    const r = normalizeRow(
      ['Date', 'Narrative', 'Amount', 'Balance', 'Categories', 'Serial'],
      ['02/01/2026', 'Salary', '3500.00', '5454.80', 'Income', '000124'],
      2,
      singleSignedFormat,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.transaction.creditDebit).toBe('credit');
  });
  it('R7-TC046 dr_cr_indicator: DR maps to debit, CR maps to credit', () => {
    const h = ['Txn Date', 'Description', 'Amount', 'Dr/Cr', 'Balance', 'Ref No'];
    const dr = normalizeRow(h, ['01/01/2026', 'ATM', '2000.00', 'DR', '48000.00', 'R1'], 1, drCrFormat);
    const cr = normalizeRow(h, ['01/01/2026', 'Salary', '50000.00', 'CR', '98000.00', 'R2'], 2, drCrFormat);
    expect(dr.ok && dr.transaction.creditDebit).toBe('debit');
    expect(cr.ok && cr.transaction.creditDebit).toBe('credit');
  });
});

describe('R7-TC047-051 — exact money precision (spec 26-27, money tolerance spec 67)', () => {
  it.each([
    ['10.01', 10.01],
    ['10.00', 10.0],
    ['1,234.56', 1234.56],
    ['0.01', 0.01],
    ['999999.99', 999999.99],
  ])('R7-TC047 parseAmountField(%j) is EXACTLY %j, never rounded to a neighbouring cent', (raw, expected) => {
    const r = parseAmountField(raw);
    expect(r.ok).toBe(true);
    expect(r.magnitude).toBe(expected);
  });
  it('R7-TC048 A$10.01 must never normalise to A$10.00 (spec 67 — the literal example)', () => {
    const r = parseAmountField('10.01');
    expect(r.magnitude).not.toBe(10.0);
    expect(r.magnitude).toBe(10.01);
  });
  it('R7-TC049 parenthesised amount is negative', () => {
    const r = parseAmountField('(45.20)');
    expect(r.isNegative).toBe(true);
    expect(r.magnitude).toBe(45.2);
  });
  it('R7-TC050 a currency symbol is stripped without affecting the magnitude', () => {
    expect(parseAmountField('$45.20').magnitude).toBe(45.2);
    expect(parseAmountField('₹1,000.50').magnitude).toBe(1000.5);
  });
  it('R7-TC051 a non-numeric amount fails cleanly, never silently coerced to 0', () => {
    const r = parseAmountField('N/A');
    expect(r.ok).toBe(false);
    expect(r.magnitude).toBeNull();
  });
});

describe('R7-TC052-057 — deterministic date parsing (spec 27-28), never locale-guessed', () => {
  it('R7-TC052 DD/MM/YYYY: 01/02/2026 is 1 February', () => {
    expect(parseDateWithFormat('01/02/2026', 'DD/MM/YYYY')).toEqual({ ok: true, iso: '2026-02-01' });
  });
  it('R7-TC053 MM/DD/YYYY: 01/02/2026 is 2 January — the SAME raw string, opposite date', () => {
    expect(parseDateWithFormat('01/02/2026', 'MM/DD/YYYY')).toEqual({ ok: true, iso: '2026-01-02' });
  });
  it('R7-TC054 YYYY-MM-DD parses unambiguously', () => {
    expect(parseDateWithFormat('2026-02-01', 'YYYY-MM-DD')).toEqual({ ok: true, iso: '2026-02-01' });
  });
  it('R7-TC055 an impossible calendar date (32/01/2026) is rejected, not silently rolled forward', () => {
    expect(parseDateWithFormat('32/01/2026', 'DD/MM/YYYY').ok).toBe(false);
  });
  it('R7-TC056 30 February is rejected under any format (not a real date)', () => {
    expect(parseDateWithFormat('30/02/2026', 'DD/MM/YYYY').ok).toBe(false);
    expect(parseDateWithFormat('2026-02-30', 'YYYY-MM-DD').ok).toBe(false);
  });
  it('R7-TC057 29 Feb is valid in a leap year (2028) and invalid in a non-leap year (2026)', () => {
    expect(parseDateWithFormat('29/02/2028', 'DD/MM/YYYY').ok).toBe(true);
    expect(parseDateWithFormat('29/02/2026', 'DD/MM/YYYY').ok).toBe(false);
  });
});

describe('R7-TC058-060 — date-format inference for DETECTION EVIDENCE ONLY (spec 27 — never used to parse the canonical date)', () => {
  it('R7-TC058 a sample containing day>12 proves DD/MM/YYYY unambiguously', () => {
    const inferred = inferDateFormat(['13/01/2026', '01/02/2026']);
    expect(inferred?.format).toBe('DD/MM/YYYY');
  });
  it('R7-TC059 a sample where every value is <=12/<=12 is genuinely ambiguous and returns null', () => {
    expect(inferDateFormat(['01/02/2026', '03/04/2026'])).toBeNull();
  });
  it('R7-TC060 an ISO-shaped sample infers YYYY-MM-DD', () => {
    expect(inferDateFormat(['2026-01-13', '2026-02-01'])?.format).toBe('YYYY-MM-DD');
  });
});

describe('R7-TC061-063 — description normalisation preserves reference numbers (spec 29)', () => {
  it('R7-TC061 collapses repeated whitespace without destroying content', () => {
    expect(normalizeDescription('  Woolworths   Supermarket  ')).toBe('Woolworths Supermarket');
  });
  it('R7-TC062 a reference number embedded in the description survives normalisation intact', () => {
    expect(normalizeDescription('NEFT REF1234567890 TRANSFER')).toContain('REF1234567890');
  });
  it('R7-TC063 Unicode is normalised (NFKC) without corrupting the text', () => {
    expect(normalizeDescription('Café Roma')).toBe('Café Roma');
  });
});

describe('R7-TC064-065 — structural type hints are deterministic, never AI-derived (spec 40-41)', () => {
  it('R7-TC064 an ATM withdrawal narrative hints atm_candidate', () => {
    const h = ['Txn Date', 'Description', 'Amount', 'Dr/Cr', 'Balance', 'Ref No'];
    const r = normalizeRow(h, ['01/01/2026', 'ATM WDL CASH', '2000.00', 'DR', '48000.00', ''], 1, drCrFormat);
    expect(r.ok && r.transaction.transactionTypeHint).toBe('atm_candidate');
  });
  it('R7-TC065 an unrecognised narrative falls back to the plain debit/credit hint, never a fabricated category', () => {
    const r = normalizeRow(header, ['01/01/2026', 'XYZ123', '10.00', '', '100.00'], 1, debitCreditFormat);
    expect(r.ok && r.transaction.transactionTypeHint).toBe('debit');
  });
});
