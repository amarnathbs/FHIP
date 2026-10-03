// A scheme RENAME must not break the reader. ICICI Prudential Dividend Yield Equity Fund became ICICI Prudential
// Dividend Yield Fund w.e.f. 26-08-2026 (AMFI code 129310). A document may use either name; a held scheme whose
// statement still prints the OLD name is matched to its source by AMFI code only, never by name.
// Benchmark facts from the supplied documents: Nifty 500 TRI, additional Nifty 50 TRI, revised from Nifty Dividend
// Opportunities 50 TRI w.e.f. 01-01-2022. Fixtures are SYNTHETIC (hand-written); no fund-house document is committed.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractWithPatterns } from '@/lib/services/investment-intelligence/factsheetReader/patternExtractor';
import { dryRunOnSample } from '@/lib/services/investment-intelligence/factsheetReader/sampleDryRun';
import { runFactsheetReader } from '@/lib/services/investment-intelligence/factsheetReader/runner';
import { FACTSHEET_SOURCE_SEED } from '@/lib/services/investment-intelligence/factsheetReader/sourceRegistry';
import { FakeFetcher, FakeStore, CONTROL_ON, okDoc, readAsText, sourcesFor } from './support/factsheetFakes';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'factsheet-benchmark-reader');
const ICICI = fs.readFileSync(path.join(FIX, 'icici_dividend_yield_complete_factsheet.txt'), 'utf8');
const KEY = 'icici_dividend_yield_complete_factsheet';
const seed = FACTSHEET_SOURCE_SEED.find((s) => s.sourceKey === KEY)!;
const URL_ = seed.url;

describe('ICICI rename: the seeded source knows both names', () => {
  it('the registry records the current name, the former name as an alias and the AMFI code', () => {
    expect(seed.documentSchemeName).toBe('ICICI Prudential Dividend Yield Fund');
    expect(seed.documentSchemeAliases).toEqual(['ICICI Prudential Dividend Yield Equity Fund']);
    expect(seed.amfiSchemeCodes).toEqual(['129310']);
    expect(seed.documentScope).toBe('multi_scheme');
  });
  it('after the rename: Nifty 500 TRI, additional Nifty 50 TRI, effective 01-01-2022 as the document states, report date 30-09-2026', () => {
    const r = extractWithPatterns({ text: ICICI, schemeName: seed.documentSchemeName, schemeAliases: seed.documentSchemeAliases, scope: 'multi_scheme' });
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.extraction.tier1?.raw).toBe('Nifty 500 TRI');
    expect(r.extraction.additional.map((a) => a.raw)).toEqual(['Nifty 50 TRI']);
    expect(r.extraction.effectiveFromStated).toEqual({ iso: '2022-01-01', precision: 'day' });
    expect(r.extraction.documentDate).toEqual({ iso: '2026-09-30', precision: 'day' });
    // the superseded benchmark is NOT read as the current one, and the neighbouring scheme's benchmark is not either
    expect(JSON.stringify(r.extraction)).not.toMatch(/Dividend Opportunities|Nifty 100/);
  });
  it('a document written BEFORE the rename (the former name only) is still found', () => {
    const old = ICICI.replace(/ICICI Prudential Dividend Yield Fund\n\(renamed[^\n]*\n/, 'ICICI Prudential Dividend Yield Equity Fund\n');
    expect(old).not.toMatch(/Dividend Yield Fund/);
    const r = extractWithPatterns({ text: old, schemeName: seed.documentSchemeName, schemeAliases: seed.documentSchemeAliases, scope: 'multi_scheme' });
    expect(r.status).toBe('found');
  });
  it('NEGATIVE CONTROL: without the alias the former-name document does NOT name the scheme (so the alias is what makes it work); a document naming neither is not found', () => {
    const old = ICICI.replace(/ICICI Prudential Dividend Yield Fund\n\(renamed[^\n]*\n/, 'ICICI Prudential Dividend Yield Equity Fund\n');
    expect(extractWithPatterns({ text: old, schemeName: seed.documentSchemeName, scope: 'multi_scheme' })).toMatchObject({ status: 'not_found', schemeNamePresent: false });
    expect(extractWithPatterns({ text: old.replace(/Dividend Yield (Equity )?Fund/g, 'Something Else Fund'), schemeName: seed.documentSchemeName, schemeAliases: seed.documentSchemeAliases, scope: 'multi_scheme' })).toMatchObject({ status: 'not_found', schemeNamePresent: false });
  });
  it('the sample tool records it as a clean single index with the DOCUMENT-STATED effective date (not backdated, not estimated)', () => {
    const r = dryRunOnSample({ text: ICICI, sourceKey: KEY });
    if (r.decision.action !== 'new_version') throw new Error('expected a new version');
    expect(r.decision.version).toMatchObject({ tier1Name: 'Nifty 500 TRI', catalogueState: 'matched_verified', effectiveFrom: '2022-01-01', effectiveFromBasis: 'document_stated', reviewState: 'awaiting_confirmation' });
    expect(r.decision.version.additionalNames).toEqual(['Nifty 50 TRI']);
  });
});

describe('a held scheme is matched to its source by AMFI code ONLY', () => {
  const OLD_NAME_HOLDING = { instrumentId: '66666666-6666-4666-8666-666666666666', instrumentName: 'P2373-ICICI Prudential Dividend Yield Equity Fund - Growth (Non-Demat)', amcName: 'ICICI Prudential Mutual Fund', amfiSchemeCode: '129310' };
  const NEW_NAME_HOLDING = { ...OLD_NAME_HOLDING, instrumentId: '77777777-7777-4777-8777-777777777777', instrumentName: 'ICICI Prudential Dividend Yield Fund - Growth' };
  const SAME_NAME_OTHER_CODE = { ...OLD_NAME_HOLDING, instrumentId: '88888888-8888-4888-8888-888888888888', amfiSchemeCode: '999999' };

  function run(held: Array<typeof OLD_NAME_HOLDING>) {
    const store = new FakeStore();
    store.control = CONTROL_ON;
    store.sources = sourcesFor([KEY]);
    store.held = held;
    const fetcher = new FakeFetcher({ [URL_]: okDoc(ICICI) });
    return runFactsheetReader({ store, fetcher, nowIso: '2026-10-03T02:00:00.000Z', env: {}, readDocument: readAsText, runId: 'r' }).then((r) => ({ r, store, fetcher }));
  }

  it('a holding whose statement still prints the OLD name (129310) is read and recorded, the same as one printing the new name', async () => {
    const { store, fetcher } = await run([OLD_NAME_HOLDING, NEW_NAME_HOLDING]);
    expect(fetcher.urls).toEqual([URL_]); // one fetch for the document, however many plans / names
    expect(store.attempts.map((a) => [a.instrumentId, a.outcome]).sort()).toEqual([[OLD_NAME_HOLDING.instrumentId, 'recorded_first_observation'], [NEW_NAME_HOLDING.instrumentId, 'recorded_first_observation']].sort());
    expect(store.versions.every((v) => v.tier1Name === 'Nifty 500 TRI' && v.effectiveFrom === '2022-01-01' && v.effectiveFromBasis === 'document_stated')).toBe(true);
  });
  it('NEGATIVE CONTROL: a holding with the SAME NAME but a different AMFI code is NOT matched (no fetch, no record)', async () => {
    const { r, store, fetcher } = await run([SAME_NAME_OTHER_CODE]);
    expect(fetcher.requestCount).toBe(0);
    expect(store.versions).toHaveLength(0);
    expect(r.sources[0].action).toBe('no_held_scheme');
  });
});
