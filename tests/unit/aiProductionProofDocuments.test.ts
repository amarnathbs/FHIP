// The synthetic documents for the PRODUCTION proof of AI document reading (docs/ai/po_apply_premium_ai_production_proof/).
//
// UNIT-TESTED. Nothing here calls a provider, a database or a network. What it proves:
//   1. The files committed in the pack are byte-identical to what the generator builds (deterministic, no timestamp), and the SHA-256
//      manifest the Product Owner checks before uploading matches.
//   2. The expected values are internally consistent: recomputed here in integer cents, independently of the generator's arithmetic comments,
//      of any parser and of any model.
//   3. The deterministic readers GENUINELY cannot read each document (the legitimate shortfall that routes to the AI step), with the failure kind
//      that makes the AI step eligible -- and a CONTROL document in a supported layout IS read natively, so the parser is demonstrably intact.
//   4. If a model reads each bank statement exactly as the expected sheet says, the existing deterministic mapping / printed-figure check /
//      reconciliation accept B1 and B2 as balanced and refuse to balance B3 (printed closing wrong on purpose). That is the deterministic half
//      of "strict schema validation and deterministic reconciliation"; the model half is the PO's production run.
//   5. Masking removes every planted personal detail and keeps the figures the model must read.
//   6. The Product Owner's expected-value sheet states every key figure.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROOF_DOCUMENTS,
  BANK_B1_EXPECTED,
  BANK_B2_EXPECTED,
  BANK_B3_EXPECTED,
  BANK_B3_VARIANCE,
  II_EXPECTED,
  LIABILITY_EXPECTED,
  RETIREMENT_EXPECTED,
  INVESTMENT_EXPECTED,
  PAYSLIP_P1_EXPECTED,
  bankSupportedLayoutControlLines,
  manifestText,
  sha256,
  type ExpectedBankStatement,
} from '../../scripts/ai_production_proof_documents';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { runBankPdfPipeline, runBankPdfPipelineFromReadRows, decidePdfCertification } from '@/lib/financial-data-hub/bank-pdf/orchestrator';
import { extractPdfPages } from '@/lib/financial-data-hub/bank-pdf/textExtraction';
import { mapBankStatementFactsToDraft, keepOnlyPrintedBankFigures } from '@/lib/aie/adapters/bankStatement/mapping';
import { bankStatementDocumentFactsSchema, AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/bankStatement/schema';
import { parsePayslipText } from '@/lib/financial-data-hub/payslip/parser';
import { detectLiabilityCsvAdapter } from '@/lib/financial-data-hub/liability/statementIntake';
import { extractLiabilityStatement } from '@/lib/financial-data-hub/liability/statementIntake';
import { detectRetirementCsvFormat } from '@/lib/financial-data-hub/retirement/detection';
import { extractRetirementStatement } from '@/lib/financial-data-hub/retirement/extraction';
import { detectAuInvestmentCsvFormat } from '@/lib/financial-data-hub/investment/detection';
import { extractAuTransactionsFromCsv, extractAuPositionsFromCsv } from '@/lib/financial-data-hub/investment/csvExtraction';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { maskText } from '@/lib/aie/masking/piiMasking';

const ROOT = path.resolve(__dirname, '..', '..');
const PACK = path.join(ROOT, 'docs', 'ai', 'po_apply_premium_ai_production_proof', 'synthetic');

const cents = (n: number) => Math.round(n * 100);

describe('1. the committed files are exactly what the generator builds', () => {
  it('every document is deterministic: two builds are byte-identical', () => {
    for (const d of PROOF_DOCUMENTS) expect(d.build().equals(d.build()), d.id).toBe(true);
  });

  it('every document in the pack folder exists, equals the built bytes, and MANIFEST.sha256 lists exactly these hashes', () => {
    const manifest = fs.readFileSync(path.join(PACK, 'MANIFEST.sha256'), 'utf8');
    expect(manifest).toBe(manifestText());
    for (const d of PROOF_DOCUMENTS) {
      const onDisk = fs.readFileSync(path.join(PACK, d.filename));
      expect(onDisk.equals(d.build()), `${d.filename} differs from the generator output`).toBe(true);
      expect(manifest).toContain(`${sha256(onDisk)}  ${d.filename}`);
    }
  });

  it('eight documents: 4 PDF (bank x3, payslip, II = 5 pdf) and 3 CSV; document-scanning evidence needs a PDF', () => {
    expect(PROOF_DOCUMENTS).toHaveLength(8);
    expect(PROOF_DOCUMENTS.filter((d) => d.format === 'pdf').map((d) => d.id).sort()).toEqual(['DOC-B1', 'DOC-B2', 'DOC-B3', 'DOC-I1', 'DOC-P1']);
    expect(PROOF_DOCUMENTS.filter((d) => d.format === 'csv').map((d) => d.id).sort()).toEqual(['DOC-A1', 'DOC-L1', 'DOC-R1']);
    for (const d of PROOF_DOCUMENTS.filter((x) => x.format === 'pdf')) expect(d.build().subarray(0, 5).toString('latin1'), d.id).toBe('%PDF-');
  });

  it('no two documents share bytes (a repeat upload would hit the duplicate rule, not a new reading)', () => {
    const hashes = PROOF_DOCUMENTS.map((d) => sha256(d.build()));
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('2. the expected values add up (integer cents, independent of the generator)', () => {
  const sheets: Array<[string, ExpectedBankStatement]> = [['B1', BANK_B1_EXPECTED], ['B2', BANK_B2_EXPECTED], ['B3', BANK_B3_EXPECTED]];
  for (const [name, e] of sheets) {
    it(`${name}: opening + credits - debits = closing, every running balance follows, totals match`, () => {
      let run = cents(e.opening);
      let debits = 0;
      let credits = 0;
      e.rows.forEach((r, i) => {
        run += r.direction === 'credit' ? cents(r.amount) : -cents(r.amount);
        if (r.direction === 'credit') credits += cents(r.amount);
        else debits += cents(r.amount);
        // a deliberately wrong statement prints a running balance that does NOT follow the arithmetic at its break row
        if (e.breakAtRow === i + 1) expect(cents(r.balanceAfter), `${name} row ${i + 1} must be the printed error`).not.toBe(run);
        else expect(cents(r.balanceAfter), `${name} ${r.date} running balance`).toBe(run);
      });
      expect(run).toBe(cents(e.closing));
      expect(debits).toBe(cents(e.debits));
      expect(credits).toBe(cents(e.credits));
      expect(cents(e.opening) + credits - debits).toBe(cents(e.closing));
    });
  }
  it('B1 and B2 print the true closing balance; B3 prints 9,300.00 against 9,256.05 by the lines (variance 43.95), breaking at row 3', () => {
    expect(BANK_B3_EXPECTED.breakAtRow).toBe(3);
    expect(BANK_B1_EXPECTED.printedClosing).toBe(BANK_B1_EXPECTED.closing);
    expect(BANK_B2_EXPECTED.printedClosing).toBe(BANK_B2_EXPECTED.closing);
    expect(cents(BANK_B3_EXPECTED.printedClosing) - cents(BANK_B3_EXPECTED.closing)).toBe(cents(BANK_B3_VARIANCE));
  });
  it('B3 opens where B2 closes', () => {
    expect(BANK_B3_EXPECTED.opening).toBe(BANK_B2_EXPECTED.closing);
  });
  it('payslip: gross 3,200.00 = 2,900.00 + 300.00; net 3,200.00 - 512.00 - 200.00 = 2,488.00', () => {
    expect(2900 + 300).toBe(PAYSLIP_P1_EXPECTED.grossPay);
    expect(PAYSLIP_P1_EXPECTED.grossPay - PAYSLIP_P1_EXPECTED.taxWithheld - 200).toBe(PAYSLIP_P1_EXPECTED.netPay);
  });
  it('liability: 500.00 + 85.40 + 42.10 - 200.00 = 427.50', () => {
    expect(cents(500) + cents(85.4) + cents(42.1) - cents(200)).toBe(cents(LIABILITY_EXPECTED.closingBalance));
  });
  it('retirement: 10,000.00 + 500.00 + 200.00 - 12.50 = 10,687.50', () => {
    expect(cents(10000) + cents(500) + cents(200) - cents(12.5)).toBe(cents(Number(RETIREMENT_EXPECTED.closingBalance)));
  });
  it('AU investment: 50 x 40.00 = 2,000.00 (brokerage 9.95 separate); dividend 120.00', () => {
    expect(50 * 40).toBe(Number(INVESTMENT_EXPECTED.buy.amount));
    expect(INVESTMENT_EXPECTED.dividend.amount).toBe('120.00');
  });
  it('Investment Intelligence: 100.000 x 50.0000 = 5,000.00 cost; 100.000 x 52.5000 = 5,250.00 market value', () => {
    expect(cents(II_EXPECTED.units * II_EXPECTED.purchaseNav)).toBe(cents(II_EXPECTED.costValue));
    expect(cents(II_EXPECTED.units * II_EXPECTED.closingNav)).toBe(cents(II_EXPECTED.marketValue));
  });
});

describe('3. the deterministic readers genuinely cannot read the documents (the legitimate shortfall), and CAN read a supported one', () => {
  it('CONTROL: a statement in a supported bank layout is read natively (status ok), so the parser is intact', async () => {
    const bytes = buildMinimalTextPdf([bankSupportedLayoutControlLines()]);
    const r = await runBankPdfPipeline({ bytes, statementUploadId: 'control', financialAccountId: 'acct', currencyCode: 'AUD', dedupIndex: new Map() as never });
    expect(r.status).toBe('ok');
    expect(r.accepted.length).toBe(2);
  }, 120_000);

  for (const d of PROOF_DOCUMENTS.filter((x) => x.documentClass === 'bank_statement')) {
    it(`${d.id}: the bank PDF pipeline answers unsupported_layout (an AI-eligible status) and hands over readable text`, async () => {
      const r = await runBankPdfPipeline({ bytes: d.build(), statementUploadId: d.id, financialAccountId: 'acct', currencyCode: 'AUD', dedupIndex: new Map() as never });
      expect(r.status).toBe('unsupported_layout');
      expect(['unsupported_layout', 'ambiguous_layout', 'extraction_low_confidence']).toContain(r.status);
      expect(r.extractedText).toBeTruthy();
      expect(r.extractedText).toContain('Statement of Account');
    }, 120_000);
  }

  it('the bank service still lists exactly those statuses as AI-eligible (guard against drift)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/financial-data-hub/services/bankPdfProcessingService.ts'), 'utf8');
    expect(src).toContain("['unsupported_layout', 'ambiguous_layout', 'extraction_low_confidence']");
  });

  it('DOC-P1 payslip: the PDF has a text layer, and the parser finds neither gross nor net pay (service treats that as layout_unsupported)', async () => {
    const doc = PROOF_DOCUMENTS.find((d) => d.id === 'DOC-P1')!;
    const ex = await extractPdfPages(doc.build());
    expect(ex.ok).toBe(true);
    if (!ex.ok) return;
    const parsed = parsePayslipText(ex.pages.join('\n'), { declaredCountry: 'AU' });
    const unreadable = 'error' in parsed || (parsed.grossPay === undefined && parsed.netPay === undefined);
    expect(unreadable).toBe(true);
  }, 120_000);

  it('DOC-L1 liability CSV: no known layout (manual_mapping_required / ambiguous / layout_unsupported)', () => {
    const doc = PROOF_DOCUMENTS.find((d) => d.id === 'DOC-L1')!;
    const bytes = new Uint8Array(doc.build());
    const r = extractLiabilityStatement({ bytes, statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['manual_mapping_required', 'ambiguous_format', 'layout_unsupported']).toContain(r.kind);
    expect(detectLiabilityCsvAdapter(bytes, 'credit_card', 'AU').status).not.toBe('detected');
  });

  it('DOC-R1 retirement CSV: layout not recognised (eligible kind)', () => {
    const doc = PROOF_DOCUMENTS.find((d) => d.id === 'DOC-R1')!;
    const detection = detectRetirementCsvFormat(new Uint8Array(doc.build()));
    const r = extractRetirementStatement(detection, { currencyCode: 'AUD', jurisdiction: 'AU' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['manual_mapping_required', 'ambiguous_format', 'layout_unsupported']).toContain(r.kind);
  });

  it('DOC-A1 AU investment CSV: layout_unsupported (the one eligible kind) under either CSV shape', () => {
    const doc = PROOF_DOCUMENTS.find((d) => d.id === 'DOC-A1')!;
    const bytes = new Uint8Array(doc.build());
    const detection = detectAuInvestmentCsvFormat(bytes);
    expect(detection.status === 'detected' && detection.adapter).toBeFalsy();
    const base = { bytes, currencyCode: 'AUD', institutionName: undefined, maskedAccountIdentifier: undefined, statementDate: undefined };
    const tx = extractAuTransactionsFromCsv({ ...base, columnMap: undefined as never, statementPeriodStart: undefined, statementPeriodEnd: undefined } as never);
    const pos = extractAuPositionsFromCsv({ ...base, columnMap: undefined as never, defaultValuationDate: '2026-07-31' } as never);
    expect(tx.ok).toBe(false);
    expect(pos.ok).toBe(false);
  });

  it('DOC-I1 Investment Intelligence: the deterministic registry cannot identify the statement (format_unrecognized trigger)', async () => {
    const doc = PROOF_DOCUMENTS.find((d) => d.id === 'DOC-I1')!;
    const ex = await extractPdfPages(doc.build());
    expect(ex.ok).toBe(true);
    if (!ex.ok) return;
    const det = parseExtractedDocument(ex.pages.join('\n'));
    expect(!det.detection.parser || !det.parsed).toBe(true);
  }, 120_000);
});

describe('4. if a model reads each bank statement as the sheet says, the deterministic half accepts B1/B2 and refuses to balance B3', () => {
  const fld = (v: string | null) => ({ value: v, missingReasonCode: v === null ? ('not_present_on_document' as const) : null });
  const f2 = (n: number) => n.toFixed(2);

  function factsFor(e: ExpectedBankStatement) {
    return bankStatementDocumentFactsSchema.parse({
      schemaVersion: AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
      documentMissingReasonCode: null,
      institutionName: fld(e.institution),
      maskedAccountIdentifier: fld(null),
      statementPeriodStart: fld(e.periodStart),
      statementPeriodEnd: fld(e.periodEnd),
      declaredOpeningBalance: fld(f2(e.opening)),
      declaredClosingBalance: fld(f2(e.printedClosing)),
      allTransactionsListed: true,
      transactions: e.rows.map((r) => ({ transactionDate: r.date, descriptionRaw: r.description, amount: f2(r.amount), creditDebit: r.direction, balanceAfter: f2(r.balanceAfter) })),
    });
  }

  for (const [id, e] of [['DOC-B1', BANK_B1_EXPECTED], ['DOC-B2', BANK_B2_EXPECTED], ['DOC-B3', BANK_B3_EXPECTED]] as Array<[string, ExpectedBankStatement]>) {
    it(`${id}: schema-valid facts -> mapped rows -> every printed figure is found in the extracted text -> reconciliation ${id === 'DOC-B3' ? 'FAILS at row 3 with variance 43.95' : 'reconciles'}`, async () => {
      const doc = PROOF_DOCUMENTS.find((d) => d.id === id)!;
      const ex = await extractPdfPages(doc.build());
      expect(ex.ok).toBe(true);
      if (!ex.ok) return;
      const text = ex.pages.join('\n');
      const mapped = mapBankStatementFactsToDraft(factsFor(e));
      expect(mapped).not.toBeNull();
      const checked = keepOnlyPrintedBankFigures(mapped!, text);
      // no figure was dropped or flagged: every amount, running balance, opening and closing is printed on the page
      expect(checked.warnings.filter((w) => /not_found|not_printed|dropped/.test(w))).toEqual([]);
      expect(checked.rows).toHaveLength(e.rows.length);
      const res = runBankPdfPipelineFromReadRows({
        statementUploadId: id,
        financialAccountId: 'acct',
        currencyCode: 'AUD',
        dedupIndex: new Map() as never,
        rows: checked.rows,
        statementMetadata: checked.statementMetadata,
        pageCount: 1,
        parserVersion: 'proof-test',
      });
      expect(res.accepted).toHaveLength(e.rows.length);
      expect(res.reconciliation).not.toBeNull();
      if (id === 'DOC-B3') {
        expect(res.reconciliation!.status).toBe('failed');
        expect(res.reconciliation!.firstBreakRowNumber).toBe(BANK_B3_EXPECTED.breakAtRow);
        expect(Math.abs(Number(res.reconciliation!.variance))).toBeCloseTo(BANK_B3_VARIANCE, 2);
      } else {
        expect(res.reconciliation!.status).toBe('reconciled');
        expect(Number(res.reconciliation!.variance)).toBe(0);
      }
      // the SAME certification decision the persistence step takes (the declared closing balance is also cross-checked there)
      const declaredClosing = checked.statementMetadata.declaredClosingBalance;
      const declaredMismatch = declaredClosing !== null && declaredClosing !== undefined && res.reconciliation!.reportedClosingBalance !== null && cents(declaredClosing) !== cents(res.reconciliation!.reportedClosingBalance as number);
      const decided = decidePdfCertification({
        pipelineStatus: res.status,
        declaredRowCount: res.accepted.length + res.rejected.length + res.unparseableBlockCount,
        parsedRowCount: res.accepted.length,
        rejectedRowCount: res.rejected.length + res.unparseableBlockCount,
        duplicateCandidateCount: 0,
        accountAmbiguous: false,
        reconciliationStatus: declaredMismatch ? 'failed' : res.reconciliation!.status,
      });
      if (id === 'DOC-B3') expect(decided).toEqual({ certificationStatus: 'review_required', reasonCodes: ['reconciliation_failed'] });
      else expect(decided).toEqual({ certificationStatus: 'certified', reasonCodes: [] });
      // sums of what would be written
      const credits = res.accepted.filter((a) => a.creditDebit === 'credit').reduce((s, a) => s + cents(a.amountOriginal), 0);
      const debits = res.accepted.filter((a) => a.creditDebit === 'debit').reduce((s, a) => s + cents(a.amountOriginal), 0);
      expect(credits).toBe(cents(e.credits));
      expect(debits).toBe(cents(e.debits));
    }, 120_000);
  }

  it('NEGATIVE CONTROL: a model that invents a line (adds 100.00 with its own running balance) is caught by the printed-figure check and cannot reconcile', async () => {
    const doc = PROOF_DOCUMENTS.find((d) => d.id === 'DOC-B1')!;
    const ex = await extractPdfPages(doc.build());
    expect(ex.ok).toBe(true);
    if (!ex.ok) return;
    const text = ex.pages.join('\n');
    const wrong = { ...BANK_B1_EXPECTED, rows: [...BANK_B1_EXPECTED.rows, { date: '2026-08-30', description: 'INVENTED', direction: 'debit' as const, amount: 100, balanceAfter: 4269.65 }] };
    const mapped = keepOnlyPrintedBankFigures(mapBankStatementFactsToDraft(factsFor(wrong))!, text);
    // the invented amount and the invented running balance are not on the page: flagged and dropped
    expect(mapped.warnings).toContain('ai_row_7_amount_not_found_in_document');
    expect(mapped.warnings).toContain('ai_row_7_balance_not_printed_dropped');
    const res = runBankPdfPipelineFromReadRows({ statementUploadId: 'neg', financialAccountId: 'acct', currencyCode: 'AUD', dedupIndex: new Map() as never, rows: mapped.rows, statementMetadata: mapped.statementMetadata, pageCount: 1, parserVersion: 'proof-test' });
    expect(res.reconciliation!.status).not.toBe('reconciled');
  }, 120_000);

  it('NEGATIVE CONTROL: a model that DROPS a line cannot reconcile either (the running-balance chain breaks)', async () => {
    const dropped = { ...BANK_B1_EXPECTED, rows: BANK_B1_EXPECTED.rows.filter((_, i) => i !== 2) };
    const mapped = mapBankStatementFactsToDraft(factsFor(dropped))!;
    const res = runBankPdfPipelineFromReadRows({ statementUploadId: 'neg2', financialAccountId: 'acct', currencyCode: 'AUD', dedupIndex: new Map() as never, rows: mapped.rows, statementMetadata: mapped.statementMetadata, pageCount: 1, parserVersion: 'proof-test' });
    expect(res.reconciliation!.status).toBe('failed');
  });
});

describe('5. masking keeps the figures the model must read and removes every planted personal detail', () => {
  let savedKey: string | undefined;
  beforeAll(() => { savedKey = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY; process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32); });
  afterAll(() => { if (savedKey === undefined) delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY; else process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = savedKey; });

  async function textOf(id: string): Promise<string> {
    const doc = PROOF_DOCUMENTS.find((d) => d.id === id)!;
    if (doc.format === 'csv') return doc.build().toString('utf8');
    const ex = await extractPdfPages(doc.build());
    if (!ex.ok) throw new Error(`cannot extract ${id}`);
    return ex.pages.join('\n');
  }

  const keyFigures: Record<string, string[]> = {
    'DOC-B1': ['3,215.40', '2,450.00', '1,380.00', '164.85', '212.30', '500.00', '38.60', '4,369.65'],
    'DOC-B2': ['8,120.55', '3,100.00', '2,250.00', '212.75', '96.40', '4.15', '71.30', '8,594.25'],
    'DOC-B3': ['8,594.25', '188.20', '9,300.00', '9,444.25'],
    'DOC-P1': ['2900.00', '300.00', '3200.00', '512.00', '200.00', '2488.00'],
    'DOC-L1': ['500.00', '85.40', '42.10', '200.00', '427.50'],
    'DOC-R1': ['10000.00', '500.00', '200.00', '12.50', '10687.50'],
    'DOC-A1': ['40.00', '2000.00', '9.95', '120.00'],
    'DOC-I1': ['100.000', '50.0000', '5000.00', '52.5000', '5250.00'],
  };

  for (const d of PROOF_DOCUMENTS) {
    it(`${d.id}: no planted detail survives masking; every key figure survives`, async () => {
      const raw = await textOf(d.id);
      // sanity: the planted details really are in the document (otherwise the test proves nothing)
      for (const p of d.planted) expect(raw, `${d.id} should contain planted detail`).toContain(p);
      const masked = maskText(raw, { tenantKey: 'proof-tenant' }).maskedText;
      const survivors = d.planted.filter((p) => masked.includes(p));
      expect(survivors, `${d.id} survivors`).toEqual([]);
      for (const fig of keyFigures[d.id]) expect(masked, `${d.id} figure ${fig}`).toContain(fig);
    }, 120_000);
  }
});

describe('6. the Product Owner sheet states every key figure and every file', () => {
  const sheet = fs.existsSync(path.join(PACK, 'EXPECTED_VALUES.md')) ? fs.readFileSync(path.join(PACK, 'EXPECTED_VALUES.md'), 'utf8') : '';
  it('EXPECTED_VALUES.md exists and names every document and its SHA-256', () => {
    expect(sheet.length).toBeGreaterThan(1000);
    for (const d of PROOF_DOCUMENTS) {
      expect(sheet, d.id).toContain(d.id);
      expect(sheet, `${d.id} hash`).toContain(sha256(d.build()));
    }
  });
  it('states the bank figures day-first and in money form', () => {
    for (const e of [BANK_B1_EXPECTED, BANK_B2_EXPECTED, BANK_B3_EXPECTED]) {
      for (const r of e.rows) {
        const [y, m, dd] = r.date.split('-');
        expect(sheet, `${r.description} date`).toContain(`${dd}/${m}/${y}`);
        expect(sheet, `${r.description} amount`).toContain(r.amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
      }
      expect(sheet).toContain(e.closing.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
    }
    expect(sheet).toContain('43.95');
  });
  it('states the non-bank figures', () => {
    for (const s of ['3,200.00', '512.00', '2,488.00', '427.50', '10,687.50', '2,000.00', '9.95', '120.00', '5,250.00', '5,000.00']) expect(sheet, s).toContain(s);
  });
  it('does not print any date in ISO or US order', () => {
    expect(/\b20\d{2}-\d{2}-\d{2}\b/.test(sheet)).toBe(false);
  });
});
