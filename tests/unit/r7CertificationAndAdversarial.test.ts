/**
 * R7 — Bank CSV Engine independent certification: malformed/adversarial
 * inputs (spec section 64, cases R7-TC138-R7-TC145) and
 * security/provenance/idempotency scenarios (R7-TC146-R7-TC160), pure-logic
 * portion (DB-touching security/idempotency is additionally proven live in
 * the live-DEV certification — see R7_LIVE_DEV_VERIFICATION.md).
 */
import { describe, expect, it } from 'vitest';
import { decideCertification, runBankCsvPipeline } from '@/lib/financial-data-hub/bank-csv/orchestrator';
import { adapterToRowFormat } from '@/lib/financial-data-hub/bank-csv/normalize';
import { AU_CBA_DEBIT_CREDIT_V1 } from '@/lib/financial-data-hub/bank-csv/adapters/registry';
import { addToDedupIndex } from '@/lib/financial-data-hub/bank-csv/dedup';
import type { DedupIndex } from '@/lib/financial-data-hub/bank-csv/dedup';
import {
  bankTransactionCorrectionSchema,
  bankCsvMappingConfirmSchema,
} from '@/lib/financial-data-hub/validation/bankCsv';
import { FDH_TRANSACTION_CORRECTION_FIELDS } from '@/lib/financial-data-hub/constants/enums';

const rowFormat = adapterToRowFormat(AU_CBA_DEBIT_CREDIT_V1);
const HEADER = 'Date,Description,Debit Amount,Credit Amount,Balance\n';

function run(csv: string, statementUploadId = 'doc-1', dedupIndex: DedupIndex = new Map()) {
  return runBankCsvPipeline({
    bytes: new TextEncoder().encode(csv),
    statementUploadId,
    financialAccountId: 'acct-1',
    currencyCode: 'AUD',
    rowFormatOverride: rowFormat,
    dedupIndex,
  });
}

describe('R7-TC138-141 — malformed/adversarial rows within an otherwise valid file', () => {
  it('R7-TC138 a row with a missing transaction date is rejected, not silently skipped or defaulted', () => {
    const csv = HEADER + ',Coffee,4.50,,100.00\n01/01/2026,Salary,,3500.00,3600.00\n';
    const r = run(csv);
    expect(r.rejected.some((x) => x.reason === 'missing_transaction_date')).toBe(true);
    expect(r.parsedRowCount).toBe(1); // the second, valid row still processed
  });
  it('R7-TC139 an unparseable amount ("N/A") is rejected, never coerced to zero', () => {
    const csv = HEADER + '01/01/2026,Weird,N/A,,100.00\n';
    const r = run(csv);
    expect(r.rejected[0]?.reason).toBe('invalid_amount');
  });
  it('R7-TC140 a row with a zero amount is rejected (not a real economic movement)', () => {
    const csv = HEADER + '01/01/2026,Zero,0.00,,100.00\n';
    const r = run(csv);
    expect(r.rejected[0]?.reason).toBe('zero_amount');
  });
  it('R7-TC141 mixed valid and invalid rows: valid rows still process correctly around the invalid one', () => {
    const csv = HEADER + '01/01/2026,Good,10.00,,90.00\nBADDATE,Bad,5.00,,85.00\n02/01/2026,Good2,,20.00,105.00\n';
    const r = run(csv);
    expect(r.parsedRowCount).toBe(2);
    expect(r.rejected.length).toBe(1);
    expect(r.rejected[0].sourceRowNumber).toBe(2);
  });
});

describe('R7-TC142-145 — partial-import safety: certification decision never silently certifies a half-import (spec 46, 91)', () => {
  it('R7-TC142 any rejected row forces certification_status = partial, never certified', () => {
    const decision = decideCertification({
      detectionStatus: 'detected',
      declaredRowCount: 10,
      parsedRowCount: 9,
      rejectedRowCount: 1,
      duplicateCandidateCount: 0,
      accountAmbiguous: false,
      reconciliationStatus: 'reconciled',
    });
    expect(decision.certificationStatus).toBe('partial');
  });
  it('R7-TC143 a declared/parsed row-count mismatch alone (rejected=0, but counts differ) also forces partial', () => {
    const decision = decideCertification({
      detectionStatus: 'detected',
      declaredRowCount: 10,
      parsedRowCount: 8,
      rejectedRowCount: 0,
      duplicateCandidateCount: 0,
      accountAmbiguous: false,
      reconciliationStatus: null,
    });
    expect(decision.certificationStatus).toBe('partial');
  });
  it('R7-TC144 zero rejected rows AND matching declared/parsed counts, clean reconciliation, no ambiguity -> certified', () => {
    const decision = decideCertification({
      detectionStatus: 'detected',
      declaredRowCount: 10,
      parsedRowCount: 10,
      rejectedRowCount: 0,
      duplicateCandidateCount: 0,
      accountAmbiguous: false,
      reconciliationStatus: 'reconciled',
    });
    expect(decision.certificationStatus).toBe('certified');
  });
  it('R7-TC145 an ambiguous or unsupported detection status is never certified, regardless of row counts', () => {
    const ambiguous = decideCertification({
      detectionStatus: 'ambiguous',
      declaredRowCount: 10,
      parsedRowCount: 10,
      rejectedRowCount: 0,
      duplicateCandidateCount: 0,
      accountAmbiguous: false,
      reconciliationStatus: null,
    });
    const unsupported = decideCertification({
      detectionStatus: 'unsupported',
      declaredRowCount: 10,
      parsedRowCount: 10,
      rejectedRowCount: 0,
      duplicateCandidateCount: 0,
      accountAmbiguous: false,
      reconciliationStatus: null,
    });
    expect(ambiguous.certificationStatus).toBe('review_required');
    expect(unsupported.certificationStatus).toBe('rejected');
  });
});

describe('R7-TC146-150 — determinism and idempotency of the pure pipeline (spec 37, 56)', () => {
  it('R7-TC146 running the SAME bytes through the pipeline twice yields byte-identical normalised output', () => {
    const csv = HEADER + '01/01/2026,Woolworths,45.20,,1954.80\n02/01/2026,Salary,,3500.00,5454.80\n';
    const a = run(csv, 'doc-a');
    const b = run(csv, 'doc-b');
    expect(a.accepted.map((t) => ({ ...t, sourceRowHash: undefined }))).toEqual(
      b.accepted.map((t) => ({ ...t, sourceRowHash: undefined })),
    );
  });
  it('R7-TC147 source_row_hash differs across different statement_upload_ids for identical row content (layer-2 scoping)', () => {
    const csv = HEADER + '01/01/2026,Woolworths,45.20,,1954.80\n';
    const a = run(csv, 'doc-a');
    const b = run(csv, 'doc-b');
    expect(a.accepted[0].sourceRowHash).not.toBe(b.accepted[0].sourceRowHash);
  });
  it('R7-TC148 economic_fingerprint is IDENTICAL across different statement_upload_ids for the same economic transaction (cross-import dedup precondition)', () => {
    const csv = HEADER + '01/01/2026,Woolworths,45.20,,1954.80\n';
    const a = run(csv, 'doc-a');
    const b = run(csv, 'doc-b');
    expect(a.accepted[0].economicFingerprint).toBe(b.accepted[0].economicFingerprint);
  });
  it('R7-TC149 a retry (same bytes, dedup index now containing the first attempt) produces zero NEW transactions — idempotent retry', () => {
    const csv = HEADER + '01/01/2026,Woolworths,45.20,,1954.80\n';
    const first = run(csv, 'doc-a');
    const index: DedupIndex = new Map();
    for (const t of first.accepted) addToDedupIndex(index, t.economicFingerprint, { transactionId: 'real-1', hasStrongEvidence: true });
    const retry = run(csv, 'doc-a', index); // SAME statement id — a genuine retry
    expect(retry.newTransactionRowCount).toBe(0);
  });
  it('R7-TC150 parser/economic-fingerprint algorithm versions are recorded on every pipeline run (provenance, spec 16/35)', () => {
    const r = run(HEADER + '01/01/2026,X,1.00,,99.00\n');
    expect(r.parserVersion).toMatch(/^r7-bank-csv-/);
    expect(r.economicFingerprintVersion).toMatch(/^r7-fp-v/);
  });
});

describe('R7-TC151-155 — narrow, closed-scope user-writable surfaces (spec 47, 51-52, 82)', () => {
  it('R7-TC151 a transaction correction may only target the closed field list — a request naming an unlisted field is rejected before it reaches the database', () => {
    const invalid = bankTransactionCorrectionSchema.safeParse({ field_name: 'extraction_confidence', corrected_value: 1 });
    expect(invalid.success).toBe(false);
  });
  it('R7-TC152 every one of the closed correction fields IS individually accepted by the schema', () => {
    for (const field of FDH_TRANSACTION_CORRECTION_FIELDS) {
      const parsed = bankTransactionCorrectionSchema.safeParse({ field_name: field, corrected_value: 'x' });
      expect(parsed.success).toBe(true);
    }
  });
  it('R7-TC153 description_raw is NOT a correctable field — raw source evidence is immutable (spec 16/47)', () => {
    expect((FDH_TRANSACTION_CORRECTION_FIELDS as readonly string[]).includes('description_raw')).toBe(false);
    expect((FDH_TRANSACTION_CORRECTION_FIELDS as readonly string[]).includes('merchant_raw')).toBe(false);
  });
  it('R7-TC154 the correction request schema never accepts a certification/provenance field name (parser_id, certification_status, reconciliation_status)', () => {
    for (const forbidden of ['parser_id', 'certification_status', 'reconciliation_status', 'dedup_status', 'extraction_confidence']) {
      const parsed = bankTransactionCorrectionSchema.safeParse({ field_name: forbidden, corrected_value: 'x' });
      expect(parsed.success).toBe(false);
    }
  });
  it('R7-TC155 a generic mapping request requires the columns its own amount_convention needs, rejecting an incomplete mapping', () => {
    const incomplete = bankCsvMappingConfirmSchema.safeParse({
      amount_convention: 'debit_credit_columns',
      date_format: 'DD/MM/YYYY',
      delimiter: ',',
      column_mapping: { transaction_date: 'Date', description: 'Description' }, // no debit/credit column named
    });
    expect(incomplete.success).toBe(false);
  });
});

describe('R7-TC156-160 — investment-transfer boundary is a bounded hint only (spec 40-41, 86)', () => {
  it('R7-TC156 an obvious investment-transfer narrative is hinted, never turned into an investment record by this module', () => {
    const csv = HEADER + '01/01/2026,SIP Mutual Fund ABC,5000.00,,45000.00\n';
    const r = run(csv);
    expect(r.accepted[0].transactionTypeHint).toBe('investment_transfer_candidate');
  });
  it('R7-TC157 the pipeline result never contains any unit/NAV/folio/holding field for an investment-transfer-hinted row', () => {
    const csv = HEADER + '01/01/2026,SIP Mutual Fund ABC,5000.00,,45000.00\n';
    const r = run(csv);
    const keys = Object.keys(r.accepted[0]);
    for (const forbidden of ['units', 'nav', 'folio', 'holding', 'instrument']) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden))).toBe(false);
    }
  });
  it('R7-TC158 a salary-shaped credit is hinted salary_candidate, never a final "income" classification', () => {
    const csv = HEADER + '01/01/2026,Payroll ACME Salary,,3500.00,3600.00\n';
    const r = run(csv);
    expect(r.accepted[0].transactionTypeHint).toBe('salary_candidate');
  });
  it('R7-TC159 an interest-narrative credit is hinted interest_candidate', () => {
    const csv = HEADER + '01/01/2026,Interest Credit,,1.20,101.20\n';
    const r = run(csv);
    expect(r.accepted[0].transactionTypeHint).toBe('interest_candidate');
  });
  it('R7-TC160 a fee-narrative debit is hinted fee_candidate', () => {
    const csv = HEADER + '01/01/2026,Monthly Account Fee,5.00,,95.00\n';
    const r = run(csv);
    expect(r.accepted[0].transactionTypeHint).toBe('fee_candidate');
  });
});
