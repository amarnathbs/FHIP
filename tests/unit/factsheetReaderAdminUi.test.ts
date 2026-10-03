// Factsheet changes queue (admin UI): the pure helpers and the source contract of the new panel.
// EVIDENCE LABEL: pure-function and source-contract tests (there is no DOM environment in this repository). They do NOT
// prove how the panel renders in a browser, which was not checked here (the admin pages need a signed-in admin).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { factsheetChangeHeading, formatDate, mappingFormFromFactsheetChange, validateMappingForm, apiPaths, FACTSHEET_TERMS_WORDS } from '@/components/admin/benchmarkData/benchmarkDataUiLogic';
import { OUTCOME_WORDS, buildFactsheetChangeViews, checkViewFromAttempt, latestCheckByInstrument, type VersionRow } from '@/lib/services/investment-intelligence/factsheetReader/adminView';
import type { AttemptOutcome } from '@/lib/services/investment-intelligence/factsheetReader/types';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const panel = read('components/admin/benchmarkData/FactsheetChangesPanel.tsx');
const tab = read('components/admin/benchmarkData/MappingsTab.tsx');
const table = read('components/admin/benchmarkData/HeldSchemesTable.tsx');

const V = (over: Partial<VersionRow> = {}): VersionRow => ({
  id: 'v2', instrument_id: '33333333-3333-4333-8333-333333333333', version_no: 2, supersedes_version_id: 'v1', tier1_name: 'Nifty 500 TRI', additional_names: [], benchmark_kind: 'single_index', composition: [],
  catalogue_state: 'matched_verified', match_confidence: 'high', effective_from: '2026-02-01', effective_from_basis: 'estimated_document_month', source_url: 'https://www.sbimf.com/x.pdf', source_title: null,
  source_document_type: 'amc_sid', document_date: '2026-02-14', document_month: '2026-02-01', retrieved_at: '2026-10-03T02:00:00.000Z', extraction_method: 'text_pattern', extraction_confidence: 'high',
  evidence_excerpt: 'Benchmark: Nifty 500 TRI', review_state: 'pending_review', review_reason: 'changed', ii_instruments: { instrument_name: 'SBI Contra Fund' }, ii_benchmarks: { benchmark_key: 'IN_NIFTY_500_TRI' }, ...over,
});

describe('the queue builder (pure)', () => {
  it('lists pending items with the previous benchmark; a decided item (approved, rejected, manual, acknowledged, auto-published) is gone', () => {
    const prev = new Map([['v1', 'BSE 500 TRI']]);
    const items = buildFactsheetChangeViews([V()], [{ version_id: 'v2', event_type: 'proposal_created', proposal_id: 'p1' }], prev);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'changed', previousBenchmark: 'BSE 500 TRI', newBenchmark: 'Nifty 500 TRI', proposalId: 'p1', canApprove: true, canAcknowledge: true });
    for (const decided of ['approved', 'rejected', 'manual_entry', 'acknowledged', 'auto_published'] as const) {
      expect(buildFactsheetChangeViews([V()], [{ version_id: 'v2', event_type: 'proposal_created', proposal_id: 'p1' }, { version_id: 'v2', event_type: decided, proposal_id: null }], prev), decided).toHaveLength(0);
    }
  });
  it('a version whose automatic publication was refused re-enters the queue even though it was "awaiting confirmation"', () => {
    const waiting = V({ review_state: 'awaiting_confirmation', supersedes_version_id: null });
    expect(buildFactsheetChangeViews([waiting], [], new Map())).toHaveLength(0);
    const items = buildFactsheetChangeViews([waiting], [{ version_id: 'v2', event_type: 'auto_publish_refused', proposal_id: 'p9' }], new Map());
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('first_reading');
  });
  it('NEGATIVE CONTROL: Approve is never offered for an unsupported composite, a commodity price or an index not in the catalogue (even if a proposal id existed)', () => {
    for (const catalogue_state of ['unsupported_composite', 'unsupported_commodity', 'no_catalogue_match'] as const) {
      const [i] = buildFactsheetChangeViews([V({ catalogue_state, supersedes_version_id: null })], [{ version_id: 'v2', event_type: 'proposal_created', proposal_id: 'p1' }], new Map());
      expect(i.canApprove, catalogue_state).toBe(false);
    }
    const [none] = buildFactsheetChangeViews([V()], [], new Map());
    expect(none.canApprove).toBe(false); // no proposal: nothing to approve
  });
  it('the item carries no personal data: no user, account, holding, amount or holder count', () => {
    const wire = JSON.stringify(buildFactsheetChangeViews([V()], [], new Map([['v1', 'x']])));
    expect(wire).not.toMatch(/user_id|userId|holder|folio|units|amount|email/i);
  });
});

describe('last factsheet check per scheme', () => {
  it('the latest attempt wins, whatever the row order; every outcome has plain words; an unknown outcome is dropped', () => {
    const rows = [
      { instrument_id: 'a', attempted_at: '2026-09-03T02:00:00.000Z', outcome: 'document_too_large', document_date: null },
      { instrument_id: 'a', attempted_at: '2026-10-03T02:00:00.000Z', outcome: 'confirmed_unchanged', document_date: '2026-04-30' },
      { instrument_id: 'b', attempted_at: '2026-10-03T02:00:00.000Z', outcome: 'not_an_outcome', document_date: null },
    ];
    const m = latestCheckByInstrument(rows);
    expect(m.get('a')).toMatchObject({ outcome: 'confirmed_unchanged', result: 'Confirmed unchanged', documentDate: '2026-04-30' });
    expect(m.has('b')).toBe(false);
    expect(checkViewFromAttempt({ attempted_at: 'x', outcome: 'nope', document_date: null })).toBeNull();
    for (const o of Object.keys(OUTCOME_WORDS) as AttemptOutcome[]) expect(OUTCOME_WORDS[o].length, o).toBeGreaterThan(8);
  });
});

describe('Enter manually prefill (day-first, nothing guessed)', () => {
  const form = mappingFormFromFactsheetChange({ instrumentId: '33333333-3333-4333-8333-333333333333', newBenchmark: 'Nifty 500 TRI', effectiveFrom: '2026-02-01', documentType: 'amc_sid', documentUrl: 'https://www.sbimf.com/x.pdf', documentTitle: 'SBI Contra Fund SID', documentDate: '2026-02-14', documentMonth: '2026-02-01', retrievedAt: '2026-10-03T02:00:00.000Z', evidenceExcerpt: 'Benchmark: Nifty 500 TRI', reviewReason: 'changed' });
  it('dates are typed day-first (DD-MM-YYYY), the document type is kept, and the catalogue benchmark, method and confidence are left for the reviewer', () => {
    expect(form).toMatchObject({ proposedBenchmarkName: 'Nifty 500 TRI', effectiveFrom: '01-02-2026', evidenceDocumentDate: '14-02-2026', evidenceRetrievedAt: '03-10-2026', evidenceSource: 'amc_sid', evidenceUrl: 'https://www.sbimf.com/x.pdf', benchmarkKey: '', resolutionMethod: '', confidence: '' });
  });
  it('the prefilled form still has to be completed (method and confidence) before it validates', () => {
    const e = validateMappingForm(form);
    expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['confidence', 'resolutionMethod']));
    expect(e.effectiveFrom).toBeUndefined();
  });
  it('a document type outside the proposal list falls back to factsheet rather than an invalid value', () => {
    expect(mappingFormFromFactsheetChange({ ...{ instrumentId: 'x', newBenchmark: 'N', effectiveFrom: '2026-01-01', documentUrl: 'https://a.test/b', documentTitle: null, documentDate: null, documentMonth: '2026-01-01', retrievedAt: '2026-10-03T00:00:00Z', evidenceExcerpt: null, reviewReason: null }, documentType: 'weird' }).evidenceSource).toBe('amc_factsheet');
  });
});

describe('wording and paths', () => {
  it('the queue headings say what the item is, in plain words', () => {
    expect(factsheetChangeHeading({ kind: 'changed', benchmarkKind: 'single_index', catalogueState: 'matched_verified' })).toBe('The fund house now declares a different benchmark');
    expect(factsheetChangeHeading({ kind: 'first_reading', benchmarkKind: 'composite', catalogueState: 'unsupported_composite' })).toMatch(/composite the catalogue cannot represent/);
    expect(factsheetChangeHeading({ kind: 'first_reading', benchmarkKind: 'commodity_price', catalogueState: 'unsupported_commodity' })).toMatch(/commodity price/);
    expect(FACTSHEET_TERMS_WORDS.not_reviewed).toMatch(/not read/);
    expect(FACTSHEET_TERMS_WORDS.approved).toBe('Terms approved');
  });
  it('the API paths are built only by the logic module', () => {
    expect(apiPaths.factsheetChanges()).toBe('/api/admin/investment-intelligence/benchmark-data/factsheet/changes');
    expect(apiPaths.factsheetChangeReview('a b')).toBe('/api/admin/investment-intelligence/benchmark-data/factsheet/changes/a%20b/review');
    expect(panel).not.toMatch(/\/api\//);
  });
  it('dates are shown day-first through the shared formatter (INR, dd-mm-yyyy), never as an ISO literal', () => {
    expect(formatDate('2026-10-03T02:00:00.000Z')).toBe('03-10-2026');
    expect(panel).toMatch(/formatDate\(c\.effectiveFrom\)/);
    expect(panel).toMatch(/formatDate\(c\.retrievedAt\)/);
    expect(table).toMatch(/formatDate\(h\.factsheetCheck\.checkedAt\)/);
    expect(panel + table).not.toMatch(/toISOString|toLocaleDateString|\.slice\(0, 10\)/);
  });
  it('the panel shows the queue controls named in the brief: Approve, Reject, Enter manually (and Acknowledge for items the catalogue cannot represent)', () => {
    for (const label of ['Approve ${tag}', 'Reject ${tag}', 'Enter manually ${tag}', 'Acknowledge ${tag}']) expect(panel).toContain(label);
    expect(panel).toMatch(/Previous benchmark/);
    expect(panel).toMatch(/New benchmark/);
    expect(panel).toMatch(/Confidence/);
    expect(panel).toMatch(/rel="noopener noreferrer"/);
  });
  it('the Mappings tab mounts the queue and closes a manually-entered item once its proposal is saved', () => {
    expect(tab).toMatch(/<FactsheetChangesPanel /);
    expect(tab).toMatch(/decision: 'manual'/);
    expect(tab).toMatch(/mappingFormFromFactsheetChange\(c\)/);
  });
  it('the held-schemes table has the last-check column and the declared-but-not-comparable state, with no category label for it', () => {
    expect(table).toMatch(/Last factsheet check/);
    expect(table).toMatch(/Never checked/);
    expect(table).toMatch(/h\.benchmark\.kind === 'declared_unsupported'/);
    expect(table).toMatch(/Declared, cannot be compared/);
    expect(table).toMatch(/No category benchmark and no comparison number/);
  });
});
