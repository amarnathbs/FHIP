/**
 * SYNTHETIC documents for the PRODUCTION proof of AI document reading for every eligible Premium user
 * (docs/ai/po_apply_premium_ai_production_proof/).
 *
 * WHAT THESE ARE. Eight deterministic files: the same bytes on every run (no timestamp, no random tag), so the
 * Product Owner can check the SHA-256 in MANIFEST.sha256 before uploading and a test can regenerate them and
 * compare. Every person, institution, employer, number and address is INVENTED. Planted "personal" details exist
 * only to prove the masking step on the real request path; `planted` lists them per document so a check can prove
 * none of them reached the model.
 *
 * WHY THE DETERMINISTIC READERS CANNOT READ THEM (a legitimate shortfall, nothing is disabled or broken):
 *   - Bank statements: the layout parsers are certified for four named Australian banks (signature text such as
 *     "Commonwealth Bank"). A statement from any other institution is `unsupported_layout`, which is exactly the
 *     case real users hit (see AI_FALLBACK_ELIGIBLE_PIPELINE_STATUSES in bankPdfProcessingService.ts). The bank
 *     files here are real tables (Date, Description, Amount, Balance) from invented institutions, not prose.
 *   - Payslip / liability / retirement / AU investment / Investment Intelligence: written as letters in sentences
 *     with no column table, so no layout adapter can segment them (the same fixtures the 2026-09 DEV journeys used).
 *     tests/unit/aiProductionProofDocuments.test.ts runs the REAL deterministic reader over every file and
 *     asserts the failure kind that makes the AI step eligible, plus a control document the parser DOES read.
 *
 * EXPECTED VALUES are hand-computed in the comments next to each document (arithmetic shown), never read back
 * from a parser or a model. docs/ai/po_apply_premium_ai_production_proof/synthetic/EXPECTED_VALUES.md repeats them
 * in plain words for the Product Owner; the unit test asserts the two agree.
 *
 * Needs NO environment variable, NO network and NO credential. It only builds bytes (and, from the CLI, writes files):
 *   npx tsx scripts/ai_production_proof_documents.ts <output-folder>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';
import { PLANTED_PII, liabilityLetterCsv, retirementLetterCsv, investmentLetterCsv, LIABILITY_EXPECTED, RETIREMENT_EXPECTED, INVESTMENT_EXPECTED } from './aie1_other_pdf_fixtures';
import { aiNeededPayslipPdf, AI_PAYSLIP_EXPECTED } from './aie1_final_fixtures';

export type ProofDocumentClass = 'bank_statement' | 'payslip' | 'liability_statement' | 'retirement_statement' | 'au_investment_statement' | 'investment_intelligence_statement';

export interface ProofDocument {
  /** Short stable id used in the protocol ("DOC-B1"). */
  id: string;
  filename: string;
  documentClass: ProofDocumentClass;
  /** Exercises the document-scanning path (PDF) or the structured-file path (CSV). Never interchangeable. */
  format: 'pdf' | 'csv';
  /** Which synthetic account uploads it (see README: P1 Premium former-pilot-independent, P2 second Premium, ...). */
  uploader: string;
  build: () => Buffer;
  /** Synthetic personal details planted in the text; none may survive masking. */
  planted: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------
// BANK STATEMENTS (PDF, tabular, invented institutions)
// ---------------------------------------------------------------------------------------------------------

export interface ExpectedBankRow {
  date: string; // ISO in the data; the protocol prints it day-first
  description: string;
  direction: 'credit' | 'debit';
  amount: number;
  balanceAfter: number;
}
export interface ExpectedBankStatement {
  institution: string;
  periodStart: string;
  periodEnd: string;
  opening: number;
  rows: readonly ExpectedBankRow[];
  closing: number;
  debits: number;
  credits: number;
  /** The closing balance the page prints. Equal to `closing` unless the statement is deliberately wrong. */
  printedClosing: number;
  /**
   * 1-based row at which the PRINTED running balance stops following the arithmetic (deliberately wrong statements only).
   * The deterministic reconciliation must report its first break at exactly this row.
   */
  breakAtRow?: number;
}

/**
 * DOC-B1 (uploader P1). EXPECTED, by hand:
 *   opening                                  3,215.40
 *   03 Aug  salary            credit 2,450.00  -> 3,215.40 + 2,450.00 = 5,665.40
 *   05 Aug  rent              debit  1,380.00  -> 5,665.40 - 1,380.00 = 4,285.40
 *   09 Aug  grocer            debit    164.85  -> 4,285.40 -   164.85 = 4,120.55
 *   14 Aug  electricity       debit    212.30  -> 4,120.55 -   212.30 = 3,908.25
 *   19 Aug  appliance refund  credit   500.00  -> 3,908.25 +   500.00 = 4,408.25
 *   26 Aug  pharmacy          debit     38.60  -> 4,408.25 -    38.60 = 4,369.65
 *   closing 4,369.65;  debits 1,380.00 + 164.85 + 212.30 + 38.60 = 1,795.75;  credits 2,450.00 + 500.00 = 2,950.00
 *   check: 3,215.40 + 2,950.00 - 1,795.75 = 4,369.65
 */
export const BANK_B1_EXPECTED: ExpectedBankStatement = {
  institution: 'Kestrel Coast Community Bank',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  opening: 3215.4,
  rows: [
    { date: '2026-08-03', description: 'SALARY SYNTHETIC WORKS PTY LTD', direction: 'credit', amount: 2450, balanceAfter: 5665.4 },
    { date: '2026-08-05', description: 'RENT IMAGINARY REALTY', direction: 'debit', amount: 1380, balanceAfter: 4285.4 },
    { date: '2026-08-09', description: 'FICTIONAL GROCER', direction: 'debit', amount: 164.85, balanceAfter: 4120.55 },
    { date: '2026-08-14', description: 'ELECTRICITY SAMPLE ENERGY', direction: 'debit', amount: 212.3, balanceAfter: 3908.25 },
    { date: '2026-08-19', description: 'REFUND FICTIONAL APPLIANCES', direction: 'credit', amount: 500, balanceAfter: 4408.25 },
    { date: '2026-08-26', description: 'PHARMACY IMAGINARY', direction: 'debit', amount: 38.6, balanceAfter: 4369.65 },
  ],
  closing: 4369.65,
  debits: 1795.75,
  credits: 2950,
  printedClosing: 4369.65,
};

/**
 * DOC-B2 (uploader P2). EXPECTED, by hand:
 *   opening                                       8,120.55
 *   04 Aug  salary             credit 3,100.00  -> 8,120.55 + 3,100.00 = 11,220.55
 *   06 Aug  home loan          debit  2,250.00  -> 11,220.55 - 2,250.00 = 8,970.55
 *   11 Aug  supermarket        debit    212.75  ->  8,970.55 -   212.75 = 8,757.80
 *   17 Aug  insurance          debit     96.40  ->  8,757.80 -    96.40 = 8,661.40
 *   21 Aug  interest           credit     4.15  ->  8,661.40 +     4.15 = 8,665.55
 *   28 Aug  fuel               debit     71.30  ->  8,665.55 -    71.30 = 8,594.25
 *   closing 8,594.25;  debits 2,250.00 + 212.75 + 96.40 + 71.30 = 2,630.45;  credits 3,100.00 + 4.15 = 3,104.15
 *   check: 8,120.55 + 3,104.15 - 2,630.45 = 8,594.25
 */
export const BANK_B2_EXPECTED: ExpectedBankStatement = {
  institution: 'Marlowe Valley Credit Union',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  opening: 8120.55,
  rows: [
    { date: '2026-08-04', description: 'SALARY QUILLFEATHER STUDIO PTY LTD', direction: 'credit', amount: 3100, balanceAfter: 11220.55 },
    { date: '2026-08-06', description: 'HOME LOAN REPAYMENT IMAGINARY HOME LOANS', direction: 'debit', amount: 2250, balanceAfter: 8970.55 },
    { date: '2026-08-11', description: 'FICTIONAL SUPERMARKET', direction: 'debit', amount: 212.75, balanceAfter: 8757.8 },
    { date: '2026-08-17', description: 'INSURANCE PREMIUM SAMPLE MUTUAL', direction: 'debit', amount: 96.4, balanceAfter: 8661.4 },
    { date: '2026-08-21', description: 'INTEREST PAID', direction: 'credit', amount: 4.15, balanceAfter: 8665.55 },
    { date: '2026-08-28', description: 'FUEL FICTIONAL PETROLEUM', direction: 'debit', amount: 71.3, balanceAfter: 8594.25 },
  ],
  closing: 8594.25,
  debits: 2630.45,
  credits: 3104.15,
  printedClosing: 8594.25,
};

/**
 * DOC-B3 (uploader P2, optional journey 1b): a September statement of the SAME invented credit union with an ARITHMETIC ERROR on
 * the page: the last line's printed running balance (and so the printed closing balance) is wrong on purpose.
 *   opening                                       8,594.25   (= DOC-B2 closing)
 *   02 Sep  salary             credit 3,100.00  ->  8,594.25 + 3,100.00 = 11,694.25   (printed 11,694.25, correct)
 *   04 Sep  home loan          debit  2,250.00  -> 11,694.25 - 2,250.00 =  9,444.25   (printed  9,444.25, correct)
 *   10 Sep  supermarket        debit    188.20  ->  9,444.25 -   188.20 =  9,256.05   (PRINTED 9,300.00, wrong by 43.95)
 *   closing BY THE LINES 9,256.05;  the page PRINTS 9,300.00 (last running balance and closing balance);  variance 43.95
 * The model must report the figures AS PRINTED (9,300.00). The deterministic reconciliation must then break at row 3 and NOT
 * balance: the statement must need the person's attention (never be silently certified), and nothing may be invented to balance it.
 */
export const BANK_B3_EXPECTED: ExpectedBankStatement = {
  institution: 'Marlowe Valley Credit Union',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  opening: 8594.25,
  rows: [
    { date: '2026-09-02', description: 'SALARY QUILLFEATHER STUDIO PTY LTD', direction: 'credit', amount: 3100, balanceAfter: 11694.25 },
    { date: '2026-09-04', description: 'HOME LOAN REPAYMENT IMAGINARY HOME LOANS', direction: 'debit', amount: 2250, balanceAfter: 9444.25 },
    { date: '2026-09-10', description: 'FICTIONAL SUPERMARKET', direction: 'debit', amount: 188.2, balanceAfter: 9300 },
  ],
  closing: 9256.05,
  debits: 2438.2,
  credits: 3100,
  printedClosing: 9300,
  breakAtRow: 3,
};
export const BANK_B3_VARIANCE = 43.95;

function dmy(iso: string): string {
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[Number(m) - 1]} ${y}`;
}
function money(n: number): string {
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const BANK_PII = {
  B1: { name: 'Zelda Quarrington', address: '12 Imaginary Lane, Nowhere NSW 2999', bsbAcct: '999-999 54321098', email: 'zelda.q@example.invalid', mobile: '0412 555 019' },
  B2: { name: 'Barnaby Oakhollow', address: '7 Fictional Crescent, Elsewhere VIC 3999', bsbAcct: '999-998 11223344', email: 'barnaby.o@example.invalid', mobile: '0413 555 077' },
} as const;

function bankStatementPdf(e: ExpectedBankStatement, pii: (typeof BANK_PII)[keyof typeof BANK_PII], statementNo: string): Buffer {
  const lines = [
    `${e.institution} (synthetic test institution)`,
    'Statement of Account',
    `Account holder: ${pii.name}`,
    `Address: ${pii.address}`,
    `Email: ${pii.email}`,
    `Mobile: ${pii.mobile}`,
    `BSB/Account: ${pii.bsbAcct}`,
    `Statement period: ${dmy(e.periodStart)} to ${dmy(e.periodEnd)}`,
    `Statement number: ${statementNo}`,
    '',
    `Opening balance ${money(e.opening)}`,
    'Date           Description                                   Amount        Balance',
    ...e.rows.map((r) => `${dmy(r.date)}   ${r.description}   ${r.direction === 'credit' ? '+' : '-'}${money(r.amount)}   ${money(r.balanceAfter)}`),
    '',
    `Closing balance ${money(e.printedClosing)}`,
    `Total money out ${money(e.debits)}   Total money in ${money(e.credits)}`,
    'Page 1 of 1',
  ];
  return buildMinimalTextPdf([lines]);
}

export function bankB1Pdf(): Buffer { return bankStatementPdf(BANK_B1_EXPECTED, BANK_PII.B1, 'PROOF-B1'); }
export function bankB2Pdf(): Buffer { return bankStatementPdf(BANK_B2_EXPECTED, BANK_PII.B2, 'PROOF-B2'); }
export function bankB3Pdf(): Buffer { return bankStatementPdf(BANK_B3_EXPECTED, BANK_PII.B2, 'PROOF-B3'); }

/**
 * CONTROL (not uploaded to production): a statement in a layout the deterministic parser DOES read natively. Built
 * in memory by the unit test only. It proves the parser is intact (a parser we broke would also "need" the fallback).
 */
export function bankSupportedLayoutControlLines(): string[] {
  return [
    'Commonwealth Bank of Australia',
    'Statement of Account',
    'Account Number: ****1234',
    'Opening Balance: $1,000.00',
    'Date Transaction Details Debit Credit Balance',
    '10 Aug 2026  CARD PURCHASE FICTIONAL GROCER 1234   45.20 DR   954.80',
    '12 Aug 2026  SALARY SYNTHETIC WORKS   2,000.00 CR   2,954.80',
    'Closing Balance: $2,954.80',
  ];
}

// ---------------------------------------------------------------------------------------------------------
// PAYSLIP (PDF), LIABILITY / RETIREMENT / AU INVESTMENT (CSV), INVESTMENT INTELLIGENCE (PDF)
// ---------------------------------------------------------------------------------------------------------

export const PAYSLIP_P1_EXPECTED = AI_PAYSLIP_EXPECTED; // gross 3,200.00 = 2,900.00 + 300.00; tax 512.00; net 3,200.00 - 512.00 - 200.00 = 2,488.00
export { LIABILITY_EXPECTED, RETIREMENT_EXPECTED, INVESTMENT_EXPECTED };

/**
 * DOC-I1 (Investment Intelligence statement, PDF, uploader P1). EXPECTED, by hand: one holding,
 * SYNTHETIC BLUECHIP FUND - DIRECT PLAN - GROWTH, ISIN INF000S00001; 1 purchase on 05/08/2026 of 100.000 units at NAV 50.0000
 * = 100.000 x 50.0000 = 5,000.00; closing 100.000 units; NAV 52.5000 on 31/08/2026; market value 100.000 x 52.5000 = 5,250.00;
 * cost value (from the purchase) 5,000.00.
 */
export const II_EXPECTED = { units: 100, marketValue: 5250, costValue: 5000, purchaseAmount: 5000, purchaseUnits: 100, purchaseNav: 50, closingNav: 52.5, asOf: '2026-08-31', purchaseDate: '2026-08-05' } as const;
export const II_PLANTED = ['Zelda Quarrington', 'ABCDE1234F', 'zelda.q@example.invalid', '0412 555 019'] as const;
export function iiLetterLines(): string[] {
  return [
    'Imaginary Registrar - quarterly holdings letter (synthetic test document)',
    `Investor: ${II_PLANTED[0]}`,
    `PAN: ${II_PLANTED[1]}`,
    `Email: ${II_PLANTED[2]}`,
    `Mobile: ${II_PLANTED[3]}`,
    'Folio SYN-2026-0001 with Imaginary Asset Management.',
    'In your SYNTHETIC BLUECHIP FUND - DIRECT PLAN - GROWTH holding (ISIN INF000S00001) you had no units before this period.',
    'On 5 August 2026 you purchased 100.000 units at a NAV of 50.0000 for 5000.00.',
    'On 31 August 2026 you held 100.000 units; the NAV that day was 52.5000, so the market value was 5250.00.',
    'Reference: PROOF-I1',
  ];
}
export function iiI1Pdf(): Buffer { return buildMinimalTextPdf([iiLetterLines()]); }

export const PROOF_DOCUMENTS: readonly ProofDocument[] = [
  { id: 'DOC-B1', filename: 'DOC-B1_bank_statement_kestrel_coast_aug2026.pdf', documentClass: 'bank_statement', format: 'pdf', uploader: 'P1', build: bankB1Pdf, planted: [BANK_PII.B1.name, BANK_PII.B1.email, BANK_PII.B1.mobile, BANK_PII.B1.bsbAcct] },
  { id: 'DOC-B2', filename: 'DOC-B2_bank_statement_marlowe_valley_aug2026.pdf', documentClass: 'bank_statement', format: 'pdf', uploader: 'P2', build: bankB2Pdf, planted: [BANK_PII.B2.name, BANK_PII.B2.email, BANK_PII.B2.mobile, BANK_PII.B2.bsbAcct] },
  { id: 'DOC-B3', filename: 'DOC-B3_bank_statement_marlowe_valley_sep2026_wrong_closing.pdf', documentClass: 'bank_statement', format: 'pdf', uploader: 'P2', build: bankB3Pdf, planted: [BANK_PII.B2.name, BANK_PII.B2.email, BANK_PII.B2.mobile, BANK_PII.B2.bsbAcct] },
  { id: 'DOC-P1', filename: 'DOC-P1_payslip_remittance_advice_aug2026.pdf', documentClass: 'payslip', format: 'pdf', uploader: 'P1', build: () => aiNeededPayslipPdf('PROOF-P1'), planted: [PLANTED_PII.name, PLANTED_PII.email, PLANTED_PII.tfn, PLANTED_PII.bsbAccount] },
  { id: 'DOC-L1', filename: 'DOC-L1_credit_card_letter_jul2026.csv', documentClass: 'liability_statement', format: 'csv', uploader: 'P1', build: () => liabilityLetterCsv('PROOF-L1'), planted: [PLANTED_PII.name, PLANTED_PII.email, PLANTED_PII.mobile] },
  { id: 'DOC-R1', filename: 'DOC-R1_super_member_letter_jul2026.csv', documentClass: 'retirement_statement', format: 'csv', uploader: 'P1', build: () => retirementLetterCsv('PROOF-R1'), planted: [PLANTED_PII.name, PLANTED_PII.email, PLANTED_PII.tfn, PLANTED_PII.memberNumber] },
  { id: 'DOC-A1', filename: 'DOC-A1_broker_activity_letter_jul2026.csv', documentClass: 'au_investment_statement', format: 'csv', uploader: 'P1', build: () => investmentLetterCsv('PROOF-A1'), planted: [PLANTED_PII.name, PLANTED_PII.email, PLANTED_PII.hin] },
  { id: 'DOC-I1', filename: 'DOC-I1_investment_holdings_letter_aug2026.pdf', documentClass: 'investment_intelligence_statement', format: 'pdf', uploader: 'P1', build: iiI1Pdf, planted: II_PLANTED },
];

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The manifest text (sha256sum format, so `sha256sum -c` or Get-FileHash comparison works). */
export function manifestText(): string {
  return PROOF_DOCUMENTS.map((d) => `${sha256(d.build())}  ${d.filename}`).join('\n') + '\n';
}

if (process.argv[1] && /ai_production_proof_documents\.ts$/.test(process.argv[1])) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: npx tsx scripts/ai_production_proof_documents.ts <output-folder>');
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  for (const d of PROOF_DOCUMENTS) {
    const bytes = d.build();
    fs.writeFileSync(path.join(out, d.filename), bytes);
    console.log(`wrote ${d.filename} (${bytes.byteLength} bytes, ${d.format}, ${d.documentClass})`);
  }
  fs.writeFileSync(path.join(out, 'MANIFEST.sha256'), manifestText());
  console.log('wrote MANIFEST.sha256. All content is synthetic.');
}
