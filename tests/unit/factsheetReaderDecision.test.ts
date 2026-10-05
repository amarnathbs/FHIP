// Factsheet benchmark reader: change detection, append-only versioning and the auto-publish rule, offline.
// Named negative controls (each proves a guard by showing what is refused):
//   CHANGED benchmark never auto-publishes . COMPOSITE never auto-publishes . COMMODITY price never auto-publishes
//   AI-only never auto-publishes . extractor DISAGREEMENT never auto-publishes . a FIRST reading never auto-publishes
//   a second reading in the SAME month never auto-publishes . incomplete evidence never auto-publishes
//   a REJECTED earlier reading is never revived . an OLDER document never supersedes a newer one
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decideObservation, benchmarkInForceOn, buildTimeline, portionsForHolding, type ObservationDecision, type StoredVersion } from '@/lib/services/investment-intelligence/factsheetReader/decision';
import { SAMPLE_CATALOGUE, dryRunOnSample } from '@/lib/services/investment-intelligence/factsheetReader/sampleDryRun';
import { extractWithPatterns } from '@/lib/services/investment-intelligence/factsheetReader/patternExtractor';
import { FACTSHEET_SOURCE_SEED, sourceFromSeed } from '@/lib/services/investment-intelligence/factsheetReader/sourceRegistry';
import type { AiOutcome } from '@/lib/services/investment-intelligence/factsheetReader/aiExtractor';
import type { DeclaredExtraction } from '@/lib/services/investment-intelligence/factsheetReader/types';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'factsheet-benchmark-reader');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const HDFC = read('hdfc_balanced_advantage_sid.txt');
const SBI_MA = read('sbi_multi_asset_allocation_factsheet.txt');
const NIPPON = read('nippon_power_infra_presentation.txt');
const INSTR = '00000000-0000-4000-8000-000000000001';

const OCT = '2026-10-03T00:00:00.000Z';
const NOV = '2026-11-03T00:00:00.000Z';

function newVersion(d: ObservationDecision) {
  if (d.action !== 'new_version') throw new Error(`expected new_version, got ${d.action}/${d.outcome}`);
  return d;
}
function stored(d: ObservationDecision, id = 'v1', events: StoredVersion['events'] = []): StoredVersion {
  return { ...newVersion(d).version, id, events };
}
const first = (text: string, sourceKey: string, retrievedAt = OCT) => dryRunOnSample({ text, sourceKey, retrievedAt }).decision;

describe('first reading, then the same reading a month later: auto-publish needs BOTH', () => {
  it('month 1: recorded as "awaiting confirmation", no proposal; month 2 with the same benchmark: proposed for automatic publication with deterministic_exact / high / complete evidence', () => {
    const v1 = stored(first(HDFC, 'hdfc_baf_sid_2024_06'));
    expect(v1.reviewState).toBe('awaiting_confirmation');
    const d2 = dryRunOnSample({ text: HDFC, sourceKey: 'hdfc_baf_sid_2024_06', previous: v1, retrievedAt: NOV }).decision;
    expect(d2.action).toBe('confirm');
    if (d2.action !== 'confirm') return;
    expect(d2.autoPublish).not.toBeNull();
    expect(d2.autoPublish?.autoPublish).toBe(true);
    const p = d2.autoPublish?.payload;
    expect(p).toMatchObject({
      instrument_id: INSTR,
      benchmark_id: 'sample-IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI',
      relationship_type: 'primary',
      effective_from: '2024-06-01', // the FIRST sighting's effective date, not this month's
      evidence_source: 'amc_sid',
      resolution_method: 'deterministic_exact',
      confidence: 'high',
      ambiguity_reason: null,
      evidence_document_date: '2024-06-28',
      evidence_retrieved_at: '2026-11-03',
    });
    expect(p?.evidence_url).toMatch(/^https:\/\/files\.hdfcfund\.com\//);
    expect(p?.evidence_excerpt?.length).toBeGreaterThan(3);
  });

  it('NEGATIVE CONTROL: a FIRST reading never auto-publishes (there is no "previous month" to equal)', () => {
    const d = newVersion(first(HDFC, 'hdfc_baf_sid_2024_06'));
    expect(d.proposal).toBeNull();
    expect(d.version.reviewState).toBe('awaiting_confirmation');
  });

  it('NEGATIVE CONTROL: a second document read in the SAME month (a SID after a factsheet) confirms but does not auto-publish', () => {
    const v1 = stored(first(HDFC, 'hdfc_baf_sid_2024_06'));
    const d2 = dryRunOnSample({ text: HDFC, sourceKey: 'hdfc_baf_fund_facts_2026_03', previous: v1, retrievedAt: '2026-10-20T00:00:00.000Z' }).decision;
    expect(d2).toMatchObject({ action: 'confirm', autoPublish: null });
  });

  it('a third month: nothing more to publish (the reading is no longer waiting once an event exists); it is just confirmed', () => {
    const v1 = stored(first(HDFC, 'hdfc_baf_sid_2024_06'), 'v1', ['proposal_created', 'auto_published']);
    const d3 = dryRunOnSample({ text: HDFC, sourceKey: 'hdfc_baf_sid_2024_06', previous: v1, retrievedAt: '2026-12-03T00:00:00.000Z' }).decision;
    expect(d3).toMatchObject({ action: 'confirm', outcome: 'confirmed_unchanged', autoPublish: null });
  });
});

describe('a CHANGED benchmark is a NEW effective-dated version and always goes to review', () => {
  const OLD_65_35 = HDFC.replace('50:50 Index (Total Returns Index)', '65:35 Index (Total Returns Index)').replace('June 28, 2024', 'April 30, 2021');

  it('NEGATIVE CONTROL: changed benchmark never auto-publishes; previous stays on record (supersedes link); proposal is admin_judgement', () => {
    const v1 = stored(first(OLD_65_35, 'hdfc_baf_sid_2024_06', '2021-05-10T00:00:00.000Z'));
    expect(v1.tier1Name).toMatch(/65:35/);
    const d = newVersion(dryRunOnSample({ text: HDFC, sourceKey: 'hdfc_baf_sid_2024_06', previous: v1, retrievedAt: OCT }).decision);
    expect(d.outcome).toBe('recorded_change');
    expect(d.reviewRequired).toBe(true);
    expect(d.version.reviewState).toBe('pending_review');
    expect(d.version.reviewReason).toMatch(/changed from .*65:35.* to .*50:50/);
    expect(d.version.versionNo).toBe(2);
    expect(d.version.supersedesVersionId).toBe('v1');
    expect(d.version.effectiveFrom > v1.effectiveFrom).toBe(true);
    expect(d.version.effectiveFromBasis).toBe('estimated_document_month');
    expect(d.proposal?.autoPublish).toBe(false);
    expect(d.proposal?.payload.resolution_method).toBe('admin_judgement');
    expect(d.proposal?.payload.ambiguity_reason).toMatch(/changed/i);
    // history is data: the decision never edits the previous version
    expect(v1.tier1Name).toMatch(/65:35/);
  });

  it('the new version\'s effective date is always AFTER the previous version\'s', () => {
    const v1 = stored(first(HDFC, 'hdfc_baf_sid_2024_06', OCT));
    // a "changed" reading dated in the same month as the first: the candidate start would not be after v1, so it is moved to the next day
    const changed = HDFC.replace('50:50 Index (Total Returns Index)', '65:35 Index (Total Returns Index)');
    const d = newVersion(dryRunOnSample({ text: changed, sourceKey: 'hdfc_baf_sid_2024_06', previous: v1, retrievedAt: '2026-10-25T00:00:00.000Z' }).decision);
    expect(d.version.effectiveFrom).toBe('2024-06-02');
    expect(d.version.effectiveFromBasis).toBe('estimated_document_month');
  });

  it('a stated effective date is used and not flagged estimated', () => {
    const d = newVersion(first(SBI_MA, 'sbi_multi_asset_factsheet_2026_04'));
    expect(d.version).toMatchObject({ effectiveFrom: '2023-10-31', effectiveFromBasis: 'document_stated' });
  });

  it('an OLDER document never supersedes a newer one (no version, no change)', () => {
    const v1 = stored(first(HDFC, 'hdfc_baf_sid_2024_06'));
    const older = HDFC.replace('June 28, 2024', 'April 30, 2021').replace('50:50', '65:35');
    const d = dryRunOnSample({ text: older, sourceKey: 'hdfc_baf_sid_2024_06', previous: v1, retrievedAt: NOV }).decision;
    expect(d).toMatchObject({ action: 'no_record', outcome: 'older_document_ignored' });
  });

  it('only the ADDITIONAL benchmark changed: a new version is kept (history), no review, Tier-1 start date carried forward', () => {
    const v1 = stored(first(HDFC, 'hdfc_baf_sid_2024_06'));
    const text = HDFC.replace('NIFTY 50 Total Returns Index (TRI)', 'Nifty 500 TRI');
    const d = newVersion(dryRunOnSample({ text, sourceKey: 'hdfc_baf_sid_2024_06', previous: v1, retrievedAt: NOV }).decision);
    expect(d.outcome).toBe('recorded_additional_change');
    expect(d.reviewRequired).toBe(false);
    expect(d.version.reviewState).toBe('recorded_only');
    expect(d.version.effectiveFrom).toBe(v1.effectiveFrom);
    expect(d.proposal).toBeNull();
  });

  it('an additional benchmark that merely was not found this month does NOT create a version', () => {
    const v1 = stored(first(HDFC, 'hdfc_baf_sid_2024_06'));
    const text = HDFC.replace(/Additional Benchmark:.*\n/, '');
    const d = dryRunOnSample({ text, sourceKey: 'hdfc_baf_sid_2024_06', previous: v1, retrievedAt: NOV }).decision;
    expect(d.action).toBe('confirm');
  });

  it('NEGATIVE CONTROL: an admin-REJECTED earlier reading is not revived: the same benchmark next month is only confirmed', () => {
    const v1 = stored(first(HDFC, 'hdfc_baf_sid_2024_06'), 'v1', ['rejected']);
    const d = dryRunOnSample({ text: HDFC, sourceKey: 'hdfc_baf_sid_2024_06', previous: v1, retrievedAt: NOV }).decision;
    expect(d).toMatchObject({ action: 'confirm', autoPublish: null });
  });
});

describe('what can NEVER auto-publish', () => {
  it('NEGATIVE CONTROL: a composite never auto-publishes, even if its first reading had somehow been left "awaiting confirmation"', () => {
    const v1 = stored(first(SBI_MA, 'sbi_multi_asset_factsheet_2026_04'));
    expect(v1.catalogueState).toBe('unsupported_composite');
    const forced: StoredVersion = { ...v1, reviewState: 'awaiting_confirmation' };
    const d2 = dryRunOnSample({ text: SBI_MA, sourceKey: 'sbi_multi_asset_factsheet_2026_04', previous: forced, retrievedAt: NOV }).decision;
    expect(d2).toMatchObject({ action: 'confirm', autoPublish: null });
  });

  it('NEGATIVE CONTROL: a commodity-price benchmark (gold) is recorded as unsupported, goes to review, and never auto-publishes', () => {
    const gold = 'HDFC Gold ETF Fund of Fund\nThis Scheme Information Document is dated November 21, 2025\nBenchmark (Total Return Index): Domestic price of physical gold\n';
    const d = newVersion(dryRunOnSample({ text: gold, sourceKey: 'hdfc_gold_fof_sid_2025_11' }).decision);
    expect(d.version).toMatchObject({ benchmarkKind: 'commodity_price', catalogueState: 'unsupported_commodity', reviewState: 'pending_review', matchedBenchmarkId: null });
    expect(d.proposal).toBeNull();
    const v1 = stored(d);
    const d2 = dryRunOnSample({ text: gold, sourceKey: 'hdfc_gold_fof_sid_2025_11', previous: { ...v1, reviewState: 'awaiting_confirmation' }, retrievedAt: NOV }).decision;
    expect(d2).toMatchObject({ action: 'confirm', autoPublish: null });
  });

  it('NEGATIVE CONTROL: a single index missing from the catalogue (HDFC 65:35) is "no catalogue match": review, no proposal, never published', () => {
    const text = HDFC.replace('50:50', '65:35');
    const d = newVersion(first(text, 'hdfc_baf_sid_2024_06'));
    expect(d.version).toMatchObject({ catalogueState: 'no_catalogue_match', reviewState: 'pending_review', matchedBenchmarkId: null });
    expect(d.proposal).toBeNull();
  });

  it('NEGATIVE CONTROL: low confidence / unverified catalogue entry goes to review (matched_other), with a proposal a human must approve', () => {
    const unverified = SAMPLE_CATALOGUE.map((e) => ({ ...e, verified: false }));
    const d = newVersion(dryRunOnSample({ text: HDFC, sourceKey: 'hdfc_baf_sid_2024_06', catalogue: unverified }).decision);
    expect(d.version).toMatchObject({ catalogueState: 'matched_other', reviewState: 'pending_review' });
    expect(d.proposal?.autoPublish).toBe(false);
    expect(d.proposal?.payload.resolution_method).toBe('admin_judgement');
  });

  it('NEGATIVE CONTROL: incomplete evidence never auto-publishes (document type "other"; or no document date)', () => {
    // 'other' document type (the Nippon presentation): the second month is confirmed, not published, and routed to review
    const v1 = stored(first(NIPPON, 'nippon_power_infra_presentation'));
    expect(v1.reviewState).toBe('awaiting_confirmation');
    const d2 = dryRunOnSample({ text: NIPPON, sourceKey: 'nippon_power_infra_presentation', previous: v1, retrievedAt: NOV }).decision;
    expect(d2).toMatchObject({ action: 'confirm', autoPublish: null });
    if (d2.action === 'confirm') expect(d2.routeToReview).toMatch(/evidence is incomplete/);
    // no document date at all: the first reading goes straight to review
    const undated = 'HDFC Balanced Advantage Fund\nBenchmark: NIFTY 50 Hybrid Composite Debt 50:50 Index (Total Returns Index)\n';
    const d = newVersion(first(undated, 'hdfc_baf_sid_2024_06'));
    expect(d.version).toMatchObject({ reviewState: 'pending_review', documentDate: null });
    expect(d.version.reviewReason).toMatch(/date could not be found/);
  });

  it('NEGATIVE CONTROL: a reading made by the AI ALONE never auto-publishes (first reading -> review; a later identical reading is only confirmed)', () => {
    const source = sourceFromSeed(FACTSHEET_SOURCE_SEED.find((s) => s.sourceKey === 'hdfc_baf_sid_2024_06')!, 'src');
    const extraction: DeclaredExtraction = {
      schemeNamePresent: true,
      tier1: { raw: 'NIFTY 50 Hybrid Composite Debt 50:50 Index (Total Returns Index)', variantHint: 'total_return' },
      additional: [],
      effectiveFromStated: null,
      documentDate: { iso: '2024-06-28', precision: 'day' },
      excerpt: 'Benchmark: NIFTY 50 Hybrid Composite Debt 50:50 Index (Total Returns Index)',
    };
    const ai: AiOutcome = { status: 'found', extraction, model: 'gpt-4o-mini' };
    const notFound = extractWithPatterns({ text: 'HDFC Balanced Advantage Fund\nnothing useful here', schemeName: 'HDFC Balanced Advantage Fund', scope: 'single_scheme' });
    expect(notFound.status).toBe('not_found');
    const mk = (retrievedAt: string, previous: StoredVersion | null) =>
      decideObservation({ instrumentId: INSTR, source, sourceTitle: null, retrievedAt, documentChecksum: 'c', pattern: notFound, ai, aiModel: 'gpt-4o-mini', catalogue: SAMPLE_CATALOGUE, previous, existingMappings: [] });
    const d1 = newVersion(mk(OCT, null));
    expect(d1.version).toMatchObject({ extractionMethod: 'ai', aiModel: 'gpt-4o-mini', reviewState: 'pending_review', extractionConfidence: 'low' });
    expect(d1.version.reviewReason).toMatch(/AI pass only/);
    const d2 = mk(NOV, { ...d1.version, id: 'v1', events: [], reviewState: 'awaiting_confirmation' });
    expect(d2).toMatchObject({ action: 'confirm', autoPublish: null });
  });

  it('NEGATIVE CONTROL: when the pattern pass and the AI pass DISAGREE the reading goes to review with both answers named', () => {
    const source = sourceFromSeed(FACTSHEET_SOURCE_SEED.find((s) => s.sourceKey === 'hdfc_baf_sid_2024_06')!, 'src');
    const pattern = extractWithPatterns({ text: HDFC, schemeName: 'HDFC Balanced Advantage Fund', scope: 'single_scheme' });
    if (pattern.status !== 'found') throw new Error('fixture');
    const ai: AiOutcome = { status: 'found', model: 'gpt-4o-mini', extraction: { ...pattern.extraction, tier1: { raw: 'Nifty 500 TRI', variantHint: null } } };
    const d = newVersion(decideObservation({ instrumentId: INSTR, source, sourceTitle: null, retrievedAt: OCT, documentChecksum: 'c', pattern, ai, aiModel: 'gpt-4o-mini', catalogue: SAMPLE_CATALOGUE, previous: null, existingMappings: [] }));
    expect(d.version).toMatchObject({ reviewState: 'pending_review', extractorsAgree: false, extractionMethod: 'text_pattern_and_ai', extractionConfidence: 'low' });
    expect(d.version.reviewReason).toMatch(/text-pattern pass read .*50:50.* AI pass read .*Nifty 500/);
    // and when they AGREE the method records both and the reading stays clean
    const agree: AiOutcome = { status: 'found', model: 'gpt-4o-mini', extraction: pattern.extraction };
    const ok = newVersion(decideObservation({ instrumentId: INSTR, source, sourceTitle: null, retrievedAt: OCT, documentChecksum: 'c', pattern, ai: agree, aiModel: 'gpt-4o-mini', catalogue: SAMPLE_CATALOGUE, previous: null, existingMappings: [] }));
    expect(ok.version).toMatchObject({ extractorsAgree: true, extractionMethod: 'text_pattern_and_ai', reviewState: 'awaiting_confirmation' });
  });
});

describe('an admin-entered mapping already exists', () => {
  it('the same benchmark: recorded as consistent with the mapping (no queue, nothing to publish)', () => {
    const d = newVersion(dryRunOnSample({ text: HDFC, sourceKey: 'hdfc_baf_sid_2024_06', existingMappings: [{ benchmarkId: 'sample-IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI', effectiveFrom: '2020-01-01', effectiveTo: null }] }).decision);
    expect(d.version.reviewState).toBe('consistent_with_mapping');
    expect(d.reviewRequired).toBe(false);
  });
  it('a different benchmark: review, never silently overridden', () => {
    const d = newVersion(dryRunOnSample({ text: HDFC, sourceKey: 'hdfc_baf_sid_2024_06', existingMappings: [{ benchmarkId: 'sample-IN_NIFTY_500_TRI', effectiveFrom: '2020-01-01', effectiveTo: null }] }).decision);
    expect(d.version.reviewState).toBe('pending_review');
    expect(d.version.reviewReason).toMatch(/disagree/);
  });
  it('month 2 with a conflicting mapping: confirmed but NOT published; routed to review', () => {
    const v1 = stored(first(HDFC, 'hdfc_baf_sid_2024_06'));
    const d2 = dryRunOnSample({ text: HDFC, sourceKey: 'hdfc_baf_sid_2024_06', previous: v1, retrievedAt: NOV, existingMappings: [{ benchmarkId: 'sample-IN_NIFTY_500_TRI', effectiveFrom: '2020-01-01', effectiveTo: null }] }).decision;
    expect(d2).toMatchObject({ action: 'confirm', autoPublish: null });
    if (d2.action === 'confirm') expect(d2.routeToReview).toMatch(/conflict|disagree/i);
  });
});

describe('the timeline: the benchmark in force for each portion of a holding period', () => {
  const v1 = { versionNo: 1, tier1Name: 'NIFTY 50 Hybrid Composite Debt 65:35 Index (TRI)', benchmarkKind: 'single_index' as const, catalogueState: 'no_catalogue_match' as const, effectiveFrom: '2021-06-01', effectiveFromBasis: 'estimated_document_month' as const };
  const v2 = { versionNo: 2, tier1Name: 'NIFTY 50 Hybrid Composite Debt 50:50 Index (TRI)', benchmarkKind: 'single_index' as const, catalogueState: 'matched_verified' as const, effectiveFrom: '2024-06-01', effectiveFromBasis: 'estimated_document_month' as const };
  const v3AdditionalOnly = { ...v2, versionNo: 3, effectiveFrom: '2025-01-01' };

  it('each version closes the day before the next starts, derived (never stored), and an additional-only version starts no new period', () => {
    const t = buildTimeline([v2, v1, v3AdditionalOnly]);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ versionNo: 1, from: '2021-06-01', to: '2024-05-31' });
    expect(t[1]).toMatchObject({ versionNo: 2, from: '2024-06-01', to: null });
  });
  it('a holding period straddling the change has two portions, each with its own benchmark; a date before any record has none', () => {
    const t = buildTimeline([v1, v2]);
    expect(benchmarkInForceOn(t, '2023-01-01')?.tier1Name).toMatch(/65:35/);
    expect(benchmarkInForceOn(t, '2024-06-01')?.tier1Name).toMatch(/50:50/);
    expect(benchmarkInForceOn(t, '2020-01-01')).toBeNull();
    const portions = portionsForHolding(t, '2022-01-01', '2026-01-01');
    expect(portions.map((p) => [p.from, p.to, p.period?.versionNo])).toEqual([
      ['2022-01-01', '2024-05-31', 1],
      ['2024-06-01', '2026-01-01', 2],
    ]);
    expect(portionsForHolding(t, '2019-01-01', '2020-01-01')[0].period).toBeNull();
  });
});
