/**
 * AIE other-PDF AI proof (2026-09-25) -- LOCAL masking pre-check of the exact
 * text each fixture yields (PDF text extraction for the bank letter; the CSV
 * decoder for the other three), through the same `maskText` the adapters'
 * shared gate uses and the gateway's own pre-egress re-scan. Prints, per
 * planted synthetic value, whether it would survive to the request payload.
 * Never prints document text.
 *
 * Run: npx tsx scripts/aie1_other_pdf_masking_precheck.ts
 */
import { randomBytes } from 'node:crypto';

process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');

export async function maskedSurvivors(text: string): Promise<{ survivors: string[]; rescanFlagged: boolean }> {
  const { maskText, containsUnmaskedPii } = await import('../lib/aie/masking/piiMasking');
  const { PLANTED_PII } = await import('./aie1_other_pdf_fixtures');
  const masked = maskText(text, { tenantKey: 'aie1-other-pdf-precheck' }).maskedText;
  const survivors = Object.entries(PLANTED_PII).filter(([, v]) => text.includes(v) && masked.includes(v)).map(([k]) => k);
  return { survivors, rescanFlagged: containsUnmaskedPii(masked) };
}

async function main() {
  const fx = await import('./aie1_other_pdf_fixtures');
  const { extractPdfPages } = await import('../lib/financial-data-hub/bank-pdf/textExtraction');
  const { decodeCsvBytes } = await import('../lib/financial-data-hub/bank-csv/csv');
  const cases: Array<[string, () => Promise<string>]> = [
    ['bank letter PDF', async () => {
      const r = await extractPdfPages(new Uint8Array(fx.bankLetterPdf('precheck')));
      if (!('pages' in r) || !r.pages) throw new Error(`pdf extraction: ${JSON.stringify(r).slice(0, 120)}`);
      return (r.pages as string[]).join('\n');
    }],
    ['liability letter CSV', async () => decodeCsvBytes(new Uint8Array(fx.liabilityLetterCsv('precheck'))).text],
    ['retirement letter CSV', async () => decodeCsvBytes(new Uint8Array(fx.retirementLetterCsv('precheck'))).text],
    ['investment letter CSV', async () => decodeCsvBytes(new Uint8Array(fx.investmentLetterCsv('precheck'))).text],
  ];
  let bad = 0;
  for (const [label, get] of cases) {
    const text = await get();
    const planted = Object.entries(fx.PLANTED_PII).filter(([, v]) => text.includes(v)).map(([k]) => k);
    const { survivors, rescanFlagged } = await maskedSurvivors(text);
    if (survivors.length) bad++;
    console.log(`${label}: ${text.length} chars; planted present ${planted.length} [${planted.join(', ')}]; SURVIVE MASKING: ${survivors.length ? survivors.join(', ') : 'none'}; gateway re-scan flags masked text: ${rescanFlagged}`);
  }
  process.exit(bad ? 1 : 0);
}

if (process.argv[1]?.endsWith('aie1_other_pdf_masking_precheck.ts')) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
