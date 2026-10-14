/**
 * Writes the SYNTHETIC "AI-needed" documents for the Product Owner's production proof of wide Premium
 * AI document reading (docs/ai/po_apply_premium_wide_access/05_PRODUCTION_PROOF_PROCEDURE_AND_EVIDENCE.md).
 *
 * Every person, institution, number and address in these files is invented (see scripts/aie1_other_pdf_fixtures.ts).
 * They are written as letters in sentences with no column table, so no deterministic layout parser can read them:
 * they genuinely route to the AI fallback. Each run uses a fresh tag, so every run produces distinct documents
 * (a repeat upload of the same bytes would be answered by the duplicate rule, not by a new AI reading).
 *
 * Needs NO environment variable, NO network and NO credential. It only writes files.
 *
 *   npx tsx scripts/ai_premium_proof_make_fixtures.ts <output-folder>
 */
import fs from 'node:fs';
import path from 'node:path';
import { bankLetterPdf, liabilityLetterCsv, retirementLetterCsv, investmentLetterCsv } from './aie1_other_pdf_fixtures';

const out = process.argv[2];
if (!out) {
  console.error('usage: npx tsx scripts/ai_premium_proof_make_fixtures.ts <output-folder>');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const tag = `proof${Date.now().toString(36)}`;

const files: Array<[string, Buffer]> = [
  [`synthetic_bank_letter_${tag}.pdf`, bankLetterPdf(tag)],
  [`synthetic_liability_letter_${tag}.csv`, liabilityLetterCsv(tag)],
  [`synthetic_retirement_letter_${tag}.csv`, retirementLetterCsv(tag)],
  [`synthetic_au_investment_letter_${tag}.csv`, investmentLetterCsv(tag)],
];
for (const [name, bytes] of files) {
  fs.writeFileSync(path.join(out, name), bytes);
  console.log(`wrote ${name} (${bytes.byteLength} bytes)`);
}
console.log(`Tag ${tag}. All content is synthetic.`);
