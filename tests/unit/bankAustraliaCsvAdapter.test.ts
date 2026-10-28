/**
 * Bank Australia transaction export (28-10-2026) -- the recognised (EXPERIMENTAL) layout. Synthetic data only
 * (tests/support/buildPoShapedBankCsv.ts has the same shape as the Product Owner's file, with invented values).
 *
 * Evidence label: UNIT-TESTED.
 */
import { describe, expect, it } from 'vitest';
import { detectBankCsvFormat } from '@/lib/financial-data-hub/bank-csv/detection';
import { runBankCsvPipeline, decideCertification } from '@/lib/financial-data-hub/bank-csv/orchestrator';
import { BANK_CSV_ADAPTER_REGISTRY, AU_BANK_AUSTRALIA_DEBIT_CREDIT_V1 } from '@/lib/financial-data-hub/bank-csv/adapters/registry';
import { scoreHeaderAgainstSignature } from '@/lib/financial-data-hub/bank-csv/adapters/types';
import { readAdapterAccountLastDigits } from '@/lib/financial-data-hub/bank-csv/accountColumn';
import { buildPoShapedCsv, PO_SHAPED_HEADER, UNRECOGNISED_VARIANT } from '../support/buildPoShapedBankCsv';

const bankAustralia = AU_BANK_AUSTRALIA_DEBIT_CREDIT_V1;
const others = BANK_CSV_ADAPTER_REGISTRY.filter((a) => a.id !== bankAustralia.id);

describe('the layout is recognised', () => {
  it('the sample shape detects as Bank Australia, experimental, with nothing else in contention', () => {
    const { bytes } = buildPoShapedCsv(342);
    const det = detectBankCsvFormat(bytes);
    expect(det.status).toBe('detected');
    expect(det.adapter?.id).toBe('au_bank_australia_debit_credit_v1');
    expect(det.adapter?.institutionCode).toBe('bank_australia');
    expect(det.adapter?.certificationState).toBe('experimental');
    expect(det.header).toEqual([...PO_SHAPED_HEADER]);
    const ev = det.evidence as { candidates: Array<{ adapterId: string; score: number }> };
    const runnerUp = ev.candidates[1];
    expect(runnerUp.score).toBe(0); // no certified or generic adapter scores at all: nothing ambiguous
  });

  it('reads every row exactly: dates, money in and out, balances, descriptions with the long description', () => {
    const built = buildPoShapedCsv(342);
    const result = runBankCsvPipeline({
      bytes: built.bytes,
      statementUploadId: 'doc',
      financialAccountId: 'acc',
      currencyCode: 'AUD',
      dedupIndex: new Map() as never,
    });
    expect(result.detection.adapter?.id).toBe(bankAustralia.id);
    expect(result.accepted).toHaveLength(342);
    expect(result.rejected).toHaveLength(0);
    const first = result.accepted[0];
    expect(first.transactionDate).toBe('2025-07-01');
    expect(first.postedDate).toBe('2025-07-02');
    expect(first.referenceRaw).toBe(built.rows[0].reference);
    expect(first.descriptionRaw).toContain(built.rows[0].description);
    expect(first.descriptionRaw).toContain('Synthetic Merchant');
    const credits = result.accepted.filter((t) => t.creditDebit === 'credit');
    expect(credits).toHaveLength(built.rows.filter((r) => r.credit > 0).length);
    expect(result.accepted.filter((t) => t.creditDebit === 'debit').reduce((s, t) => s + t.amountOriginal, 0)).toBeCloseTo(built.rows.reduce((s, r) => s + r.debit, 0), 2);
    expect(result.reconciliation?.status).toBe('reconciled');
  });

  it('even a perfect read lands in review, never certified, because the layout is experimental', () => {
    const base = { detectionStatus: 'detected' as const, declaredRowCount: 10, parsedRowCount: 10, rejectedRowCount: 0, duplicateCandidateCount: 0, accountAmbiguous: false, reconciliationStatus: 'reconciled' as const };
    expect(decideCertification(base).certificationStatus).toBe('certified');
    expect(decideCertification({ ...base, experimentalInstitutionAdapter: true })).toEqual({ certificationStatus: 'review_required', reasonCodes: ['adapter_experimental'] });
  });
});

describe('variants fall to the column mapping screen, they are not guessed', () => {
  const status = (opts: Parameters<typeof buildPoShapedCsv>[2]) => detectBankCsvFormat(buildPoShapedCsv(20, 1, opts).bytes);

  it('optional columns may be absent and the layout is still recognised', () => {
    for (const omit of [['Create date'], ['Long description'], ['Cheque number'], ['Reference no'], ['Balance after transfer'], ['Create date', 'Long description', 'Cheque number', 'Reference no', 'Balance after transfer']]) {
      const det = status({ omit });
      expect(det.status, omit.join(',')).toBe('detected');
      expect(det.adapter?.id).toBe(bankAustralia.id);
    }
  });
  it('a missing required column, or a renamed one, is not recognised', () => {
    for (const omit of [['Account number'], ['Transaction type'], ['Effective date'], ['Debit amount'], ['Credit amount'], ['Description']]) {
      expect(status({ omit }).status, omit.join(',')).toBe('manual_mapping_required');
    }
    expect(status({ renames: { 'Debit amount': 'Debits' } }).status).toBe('manual_mapping_required');
    expect(status(UNRECOGNISED_VARIANT).adapter).toBeNull();
  });
  it('heading case and spacing are ignored', () => {
    const det = status({ renames: { 'Effective date': '  EFFECTIVE   DATE ', 'Debit amount': 'debit amount' } });
    expect(det.adapter?.id).toBe(bankAustralia.id);
  });
});

describe('negative control: it cannot outscore or make ambiguous any other adapter', () => {
  it('scores zero on every other adapter\'s own header (required + optional), so their detection is unchanged', () => {
    for (const other of others) {
      const header = [...other.signature.requiredHeaders, ...(other.signature.optionalHeaders ?? [])];
      expect(bankAustralia.scoreHeader(header), other.id).toBe(0);
      const text = `${header.join(',')}\n${header.map(() => 'x').join(',')}\n`;
      const det = detectBankCsvFormat(new Uint8Array(Buffer.from(text)));
      expect(det.adapter?.id ?? null, other.id).not.toBe(bankAustralia.id);
      if (other.certificationState === 'certified') expect(det.adapter?.id, other.id).toBe(other.id);
    }
  });
  it('and no other adapter scores on the Bank Australia header', () => {
    for (const other of others) expect(other.scoreHeader([...PO_SHAPED_HEADER]), other.id).toBe(0);
  });
  it('the control is real: another bank sharing four of the headings scores 0 here, but a widened signature (without the two distinctive ones) would score and turn it red', () => {
    const otherBank = ['Effective date', 'Debit amount', 'Credit amount', 'Description', 'Balance'];
    expect(bankAustralia.scoreHeader(otherBank)).toBe(0);
    const widened = { requiredHeaders: ['Effective date', 'Debit amount', 'Credit amount', 'Description'], optionalHeaders: [] as string[] };
    expect(scoreHeaderAgainstSignature(otherBank, widened)).toBeGreaterThanOrEqual(0.8);
  });
});

describe('the account is named from the Account number column, last digits only', () => {
  it('takes the last four digits when the column holds one number', () => {
    const { header, rows } = detectBankCsvFormat(buildPoShapedCsv(10).bytes).parsed!;
    expect(readAdapterAccountLastDigits(header, rows, bankAustralia.columnRoles.accountIdentifier)).toBe('1234');
  });
  it('returns nothing, so the person is asked, when the file holds several accounts, no column, or too few digits', () => {
    const header = ['Account number', 'x'];
    expect(readAdapterAccountLastDigits(header, [['000000001234', 'a'], ['000000009999', 'b']], 'Account number')).toBeNull();
    expect(readAdapterAccountLastDigits(header, [['', 'a']], 'Account number')).toBeNull();
    expect(readAdapterAccountLastDigits(header, [['123', 'a']], 'Account number')).toBeNull();
    expect(readAdapterAccountLastDigits(header, [['000000001234', 'a']], undefined)).toBeNull();
    expect(readAdapterAccountLastDigits(['other'], [['000000001234']], 'Account number')).toBeNull();
  });
  it('never returns more than four digits (the whole number is never surfaced)', () => {
    const out = readAdapterAccountLastDigits(['Account number'], [['000000001234']], 'Account number');
    expect(out).toHaveLength(4);
    expect(out).not.toMatch(/\d{5,}/);
  });
});
