// Factsheet benchmark reader: the monthly runner, end to end against an in-memory store that enforces the database's
// rules and a scripted fetcher. Offline: no network, no database, no real document.
//
// Named negative controls proved here (each shows what is REFUSED):
//   kill switch OFF = no work . dry run writes nothing and fetches nothing . NO source is fetched unless terms are
//   APPROVED . nothing is fetched for a scheme nobody holds . history is append-only . a CHANGE never auto-publishes
//   a COMPOSITE never auto-publishes . idempotent within the month . one failing scheme does not stop the others
//   an oversized document is skipped (not truncated) . AI output failing the schema is rejected . no user / holding
//   data leaves the system . retries are capped per month
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runFactsheetReader, type RunnerDeps } from '@/lib/services/investment-intelligence/factsheetReader/runner';
import { FACTSHEET_SOURCE_SEED } from '@/lib/services/investment-intelligence/factsheetReader/sourceRegistry';
import type { FactsheetAiExtractor, FactsheetAiRequest } from '@/lib/services/investment-intelligence/factsheetReader/aiExtractor';
import { CONTROL_OFF, CONTROL_ON, FakeFetcher, FakeStore, HELD_BAF, HELD_CONTRA, HELD_MULTI, HELD_NIPPON, okDoc, readAsText, sourcesFor, type Script } from './support/factsheetFakes';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'factsheet-benchmark-reader');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const HDFC = read('hdfc_balanced_advantage_sid.txt');
const SBI_MA = read('sbi_multi_asset_allocation_factsheet.txt');
const SBI_CONTRA = read('sbi_contra_factsheet.txt');
const NIPPON = read('nippon_power_infra_presentation.txt');

const url = (key: string) => (FACTSHEET_SOURCE_SEED.find((s) => s.sourceKey === key) as { url: string }).url;
const OCT = '2026-10-03T02:00:00.000Z';
const NOV = '2026-11-03T02:00:00.000Z';
const DEC = '2026-12-03T02:00:00.000Z';
const NOAI = {} as Record<string, string | undefined>;

function setup(opts: { keys: string[]; held: Array<typeof HELD_BAF>; terms?: 'approved' | 'not_reviewed' | 'under_review' | 'declined'; scripts?: Record<string, Script>; control?: typeof CONTROL_ON | null }) {
  const store = new FakeStore();
  store.sources = sourcesFor(opts.keys, opts.terms ?? 'approved');
  store.held = opts.held;
  store.control = opts.control === undefined ? CONTROL_ON : opts.control;
  const fetcher = new FakeFetcher(opts.scripts ?? {});
  const deps = (nowIso: string, extra: Partial<RunnerDeps> = {}): RunnerDeps => ({ store, fetcher, nowIso, env: NOAI, readDocument: readAsText, runId: 'run-1', ...extra });
  return { store, fetcher, deps };
}

describe('kill switch', () => {
  it('NEGATIVE CONTROL: switch OFF = no work: no fetch, no write, and nothing is read but the switch row', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], control: CONTROL_OFF, scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC) } });
    const r = await runFactsheetReader(t.deps(OCT));
    expect(r.status).toBe('skipped_kill_switch');
    expect(r.killSwitch).toBe('off');
    expect(t.fetcher.requestCount).toBe(0);
    expect(t.store.writes).toBe(0);
    expect(t.store.calls).toEqual(['readControl']);
  });
  it('NEGATIVE CONTROL: a MISSING switch row fails closed exactly like an off switch', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], control: null, scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC) } });
    const r = await runFactsheetReader(t.deps(OCT));
    expect(r.status).toBe('skipped_kill_switch');
    expect(r.killSwitch).toBe('missing');
    expect(t.fetcher.requestCount).toBe(0);
    expect(t.store.writes).toBe(0);
  });
  it('an active backoff after failures also means no work', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], control: { ...CONTROL_ON, consecutiveFailures: 2, nextAttemptNotBefore: '2026-10-03T09:00:00.000Z' } });
    const r = await runFactsheetReader(t.deps(OCT));
    expect(r.status).toBe('skipped_backoff');
    expect(t.fetcher.requestCount).toBe(0);
    expect(t.store.writes).toBe(0);
  });
});

describe('dry run', () => {
  it('NEGATIVE CONTROL: a dry run reports what it WOULD fetch, fetches NOTHING and writes NOTHING, whatever the switch says', async () => {
    for (const control of [CONTROL_OFF, CONTROL_ON, null]) {
      const t = setup({ keys: ['hdfc_baf_sid_2024_06', 'sbi_contra_sid_2025_10'], held: [HELD_BAF, HELD_CONTRA], control, scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC) } });
      t.store.sources[1].termsReviewStatus = 'not_reviewed';
      const r = await runFactsheetReader(t.deps(OCT), { dryRun: true });
      expect(r.status).toBe('dry_run');
      expect(r.dryRun).toBe(true);
      expect(t.fetcher.requestCount).toBe(0);
      expect(t.store.writes).toBe(0);
      expect(r.sources.find((s) => s.sourceKey === 'hdfc_baf_sid_2024_06')).toMatchObject({ action: 'would_fetch', instruments: 1 });
      expect(r.sources.find((s) => s.sourceKey === 'sbi_contra_sid_2025_10')).toMatchObject({ action: 'refused_terms_not_approved' });
    }
  });
  it('a dry run never calls the AI or loads anything it does not need to plan', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF] });
    await runFactsheetReader(t.deps(OCT), { dryRun: true });
    expect(t.store.calls).not.toContain('loadCatalogue');
    expect(t.store.calls).not.toContain('recordAttempt');
  });
});

describe('terms gate', () => {
  it.each(['not_reviewed', 'under_review', 'declined'] as const)('NEGATIVE CONTROL: no source is fetched while terms are "%s" (zero requests; a refusal is recorded once)', async (terms) => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], terms, scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC) } });
    const r = await runFactsheetReader(t.deps(OCT));
    expect(t.fetcher.requestCount).toBe(0);
    expect(r.sources[0]).toMatchObject({ action: 'refused_terms_not_approved', instruments: 1 });
    expect(t.store.versions).toHaveLength(0);
    expect(t.store.attempts.map((a) => a.outcome)).toEqual(['refused_terms_not_approved']);
    // re-running the same month does not pile up refusal rows, and still fetches nothing
    await runFactsheetReader(t.deps('2026-10-20T02:00:00.000Z'));
    expect(t.store.attempts.filter((a) => a.outcome === 'refused_terms_not_approved')).toHaveLength(1);
    expect(t.fetcher.requestCount).toBe(0);
  });
  it('the SEEDED registry is entirely not_reviewed, so a run against the seeded sources fetches nothing at all', async () => {
    const t = setup({ keys: FACTSHEET_SOURCE_SEED.map((s) => s.sourceKey), held: [HELD_BAF, HELD_MULTI, HELD_CONTRA, HELD_NIPPON], terms: 'not_reviewed' });
    const r = await runFactsheetReader(t.deps(OCT));
    expect(FACTSHEET_SOURCE_SEED.every((s) => s.termsReviewStatus === 'not_reviewed')).toBe(true);
    expect(t.fetcher.requestCount).toBe(0);
    expect(r.sources.every((s) => s.action === 'refused_terms_not_approved' || s.action === 'no_held_scheme')).toBe(true);
  });
  it('a disabled source is refused as well, even when approved', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC) } });
    t.store.sources[0].enabled = false;
    const r = await runFactsheetReader(t.deps(OCT));
    expect(r.sources[0].action).toBe('refused_source_disabled');
    expect(t.fetcher.requestCount).toBe(0);
  });
  it('an approved source IS fetched (the gate is the only thing that was stopping it)', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC) } });
    await runFactsheetReader(t.deps(OCT));
    expect(t.fetcher.urls).toEqual([url('hdfc_baf_sid_2024_06')]);
  });
});

describe('bounded to schemes users actually hold', () => {
  it('NEGATIVE CONTROL: a source none of whose schemes is held is never fetched', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06', 'sbi_contra_sid_2025_10'], held: [HELD_BAF], scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC), [url('sbi_contra_sid_2025_10')]: okDoc(SBI_CONTRA) } });
    const r = await runFactsheetReader(t.deps(OCT));
    expect(t.fetcher.urls).toEqual([url('hdfc_baf_sid_2024_06')]);
    expect(r.sources.find((s) => s.sourceKey === 'sbi_contra_sid_2025_10')?.action).toBe('no_held_scheme');
  });
  it('a held scheme with no AMFI code is never matched by name', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [{ ...HELD_BAF, amfiSchemeCode: null }], scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC) } });
    await runFactsheetReader(t.deps(OCT));
    expect(t.fetcher.requestCount).toBe(0);
  });
});

describe('the monthly life of one scheme: record, confirm, publish; and what must not publish', () => {
  const KEY = 'hdfc_baf_sid_2024_06';
  const scripts = { [url(KEY)]: okDoc(HDFC) };

  it('month 1 records the benchmark as a dated version and a ledger row; nothing is published', async () => {
    const t = setup({ keys: [KEY], held: [HELD_BAF], scripts });
    const r = await runFactsheetReader(t.deps(OCT));
    expect(r.status).toBe('completed');
    expect(t.store.versions).toHaveLength(1);
    expect(t.store.versions[0]).toMatchObject({ versionNo: 1, reviewState: 'awaiting_confirmation', tier1Name: expect.stringMatching(/50:50/), documentDate: '2024-06-28', extractionMethod: 'text_pattern' });
    expect(t.store.versions[0].documentChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(t.store.attempts.map((a) => [a.outcome, a.runMonth])).toEqual([['recorded_first_observation', '2026-10-01']]);
    expect(t.store.proposals).toHaveLength(0);
    expect(t.store.autoPublishCalls).toBe(0);
    expect(t.store.mappings.size).toBe(0);
  });

  it('NEGATIVE CONTROL: idempotent within the month: a re-run (or ten) makes no request and writes no row', async () => {
    const t = setup({ keys: [KEY], held: [HELD_BAF], scripts });
    await runFactsheetReader(t.deps(OCT));
    const writes = t.store.writes;
    const requests = t.fetcher.requestCount;
    for (const day of ['2026-10-10', '2026-10-17', '2026-10-31']) {
      const again = await runFactsheetReader(t.deps(`${day}T02:00:00.000Z`));
      expect(again.sources[0].action).toBe('already_done_this_month');
    }
    expect(t.store.writes).toBe(writes);
    expect(t.fetcher.requestCount).toBe(requests);
    expect(t.store.versions).toHaveLength(1);
    expect(t.store.attempts).toHaveLength(1);
  });

  it('month 2 with the same benchmark: confirmed AND published automatically through the existing auto-publish function (deterministic, high, evidence complete)', async () => {
    const t = setup({ keys: [KEY], held: [HELD_BAF], scripts });
    await runFactsheetReader(t.deps(OCT));
    const r = await runFactsheetReader(t.deps(NOV));
    expect(r.status).toBe('completed');
    expect(t.store.versions).toHaveLength(1); // unchanged: no new version, just a confirmation
    expect(t.store.attempts.map((a) => a.outcome)).toEqual(['recorded_first_observation', 'auto_published']);
    expect(t.store.proposals).toHaveLength(1);
    expect(t.store.proposals[0].payload).toMatchObject({ resolution_method: 'deterministic_exact', confidence: 'high', effective_from: '2024-06-01', evidence_source: 'amc_sid' });
    expect(t.store.events.map((e) => e.eventType)).toEqual(['proposal_created', 'auto_published']);
    expect(t.store.mappings.get(HELD_BAF.instrumentId)).toHaveLength(1);
    // month 3: nothing more to publish
    await runFactsheetReader(t.deps(DEC));
    expect(t.store.proposals).toHaveLength(1);
    expect(t.store.attempts.at(-1)?.outcome).toBe('confirmed_unchanged');
  });

  it('NEGATIVE CONTROL + append-only: a CHANGED benchmark creates a NEW version, the previous version row is untouched, and it NEVER auto-publishes', async () => {
    const t = setup({ keys: [KEY], held: [HELD_BAF], scripts });
    await runFactsheetReader(t.deps(OCT));
    const v1 = JSON.stringify(t.store.versions[0]);
    const changed = HDFC.replace('50:50 Index (Total Returns Index)', '65:35 Index (Total Returns Index)').replace('June 28, 2024', 'July 31, 2024');
    const f2 = new FakeFetcher({ [url(KEY)]: okDoc(changed) });
    const r = await runFactsheetReader({ store: t.store, fetcher: f2, nowIso: NOV, env: NOAI, readDocument: readAsText, runId: 'run-2' });
    expect(r.status).toBe('completed');
    expect(t.store.versions).toHaveLength(2);
    expect(JSON.stringify(t.store.versions[0])).toBe(v1); // the earlier benchmark remains on record, byte for byte
    expect(t.store.versions[1]).toMatchObject({ versionNo: 2, supersedesVersionId: t.store.versions[0].id, reviewState: 'pending_review', tier1Name: expect.stringMatching(/65:35/) });
    expect(t.store.versions[1].reviewReason).toMatch(/changed from/);
    expect(t.store.autoPublishCalls).toBe(0);
    expect(t.store.mappings.size).toBe(0);
    expect(t.store.attempts.at(-1)).toMatchObject({ outcome: 'recorded_change', reviewRequired: true });
    // 65:35 is not in the catalogue: no proposal can even be created, a human enters it
    expect(t.store.proposals).toHaveLength(0);
  });

  it('a changed benchmark that DOES match a verified series creates an admin_judgement proposal for a reviewer, still never published', async () => {
    const t = setup({ keys: [KEY], held: [HELD_BAF], scripts: { [url(KEY)]: okDoc(HDFC.replace('50:50 Index (Total Returns Index)', '65:35 Index (Total Returns Index)').replace('June 28, 2024', 'April 30, 2021')) } });
    await runFactsheetReader(t.deps('2021-05-10T02:00:00.000Z'));
    const f2 = new FakeFetcher({ [url(KEY)]: okDoc(HDFC) });
    await runFactsheetReader({ store: t.store, fetcher: f2, nowIso: OCT, env: NOAI, readDocument: readAsText, runId: 'run-2' });
    expect(t.store.versions).toHaveLength(2);
    expect(t.store.proposals).toHaveLength(1);
    expect(t.store.proposals[0].payload).toMatchObject({ resolution_method: 'admin_judgement', benchmark_id: 'sample-IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI' });
    expect(t.store.proposals[0].payload.effective_from > t.store.versions[0].effectiveFrom).toBe(true);
    expect(t.store.autoPublishCalls).toBe(0);
    expect(t.store.events.map((e) => e.eventType)).toEqual(['proposal_created']);
  });

  it('NEGATIVE CONTROL: a composite benchmark is recorded as an unsupported composite and never auto-publishes, across three months', async () => {
    const key = 'sbi_multi_asset_factsheet_2026_04';
    const t = setup({ keys: [key], held: [HELD_MULTI], scripts: { [url(key)]: okDoc(SBI_MA) } });
    for (const now of [OCT, NOV, DEC]) await runFactsheetReader(t.deps(now));
    expect(t.store.versions).toHaveLength(1);
    expect(t.store.versions[0]).toMatchObject({ benchmarkKind: 'composite', catalogueState: 'unsupported_composite', reviewState: 'pending_review', effectiveFrom: '2023-10-31', effectiveFromBasis: 'document_stated' });
    expect(t.store.versions[0].composition).toHaveLength(4);
    expect(t.store.autoPublishCalls).toBe(0);
    expect(t.store.proposals).toHaveLength(0);
    expect(t.store.mappings.size).toBe(0);
    expect(t.store.attempts[0]).toMatchObject({ outcome: 'recorded_first_observation', reviewRequired: true });
  });

  it('a document type of "other" (the Nippon presentation) is confirmed but can never auto-publish; it is routed to review', async () => {
    const key = 'nippon_power_infra_presentation';
    const t = setup({ keys: [key], held: [HELD_NIPPON], scripts: { [url(key)]: okDoc(NIPPON) } });
    await runFactsheetReader(t.deps(OCT));
    await runFactsheetReader(t.deps(NOV));
    expect(t.store.autoPublishCalls).toBe(0);
    expect(t.store.mappings.size).toBe(0);
    expect(t.store.events.map((e) => e.eventType)).toEqual(['auto_publish_refused']);
  });

  it('when the database refuses automatic publication (an overlapping mapping appeared) the reading is routed to review, never forced', async () => {
    const t = setup({ keys: [KEY], held: [HELD_BAF], scripts });
    await runFactsheetReader(t.deps(OCT));
    // an admin maps a DIFFERENT benchmark in the meantime: the decision layer routes it to review before even proposing
    t.store.mappings.set(HELD_BAF.instrumentId, [{ benchmarkId: 'sample-IN_NIFTY_500_TRI', effectiveFrom: '2020-01-01', effectiveTo: null }]);
    await runFactsheetReader(t.deps(NOV));
    expect(t.store.autoPublishCalls).toBe(0);
    expect(t.store.events.map((e) => e.eventType)).toEqual(['auto_publish_refused']);
    expect(t.store.attempts.at(-1)?.reviewRequired).toBe(true);
  });

  it('an older document processed after a newer one never supersedes it (priority order reads the newer document first)', async () => {
    const t = setup({
      keys: ['hdfc_baf_fund_facts_2026_03', 'hdfc_baf_sid_2024_06'],
      held: [HELD_BAF],
      scripts: { [url('hdfc_baf_fund_facts_2026_03')]: okDoc(HDFC.replace('June 28, 2024', 'March 31, 2026')), [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC.replace('50:50', '65:35').replace('June 28, 2024', 'April 30, 2021')) },
    });
    await runFactsheetReader(t.deps(OCT));
    expect(t.fetcher.urls[0]).toBe(url('hdfc_baf_fund_facts_2026_03'));
    expect(t.store.versions).toHaveLength(1);
    expect(t.store.attempts.map((a) => a.outcome).sort()).toEqual(['older_document_ignored', 'recorded_first_observation']);
  });

  it('a 304 Not Modified is a confirmation of the reading on record; the validators are sent only when every scheme has a reading from this source', async () => {
    const t = setup({ keys: [KEY], held: [HELD_BAF], scripts: { [url(KEY)]: okDoc(HDFC, { etag: '"v1"', lastModified: 'Mon, 01 Jul 2024 00:00:00 GMT' }) } });
    await runFactsheetReader(t.deps(OCT));
    expect(t.store.sources[0].lastEtag).toBe('"v1"');
    expect(t.fetcher.options[0].etag ?? null).toBeNull(); // first read: nothing to validate against
    const f2 = new FakeFetcher({ [url(KEY)]: { kind: 'not_modified' } });
    await runFactsheetReader({ store: t.store, fetcher: f2, nowIso: NOV, env: NOAI, readDocument: readAsText, runId: 'run-2' });
    expect(f2.options[0]).toMatchObject({ etag: '"v1"', lastModified: 'Mon, 01 Jul 2024 00:00:00 GMT' });
    expect(t.store.versions).toHaveLength(1);
    expect(t.store.attempts.at(-1)?.outcome).toBe('auto_published'); // a second month, deterministic reading, unchanged document
  });
});

describe('failures are isolated and recorded', () => {
  it('NEGATIVE CONTROL: one failing scheme does not stop the others (database failure for one instrument, same document)', async () => {
    const KEY = 'sbi_contra_factsheet_2025_08';
    const REG = { ...HELD_CONTRA, instrumentId: '55555555-5555-4555-8555-555555555555', amfiSchemeCode: '102414' }; // two held plans of the same scheme
    const t = setup({ keys: [KEY], held: [HELD_CONTRA, REG], scripts: { [url(KEY)]: okDoc(SBI_CONTRA) } });
    t.store.failVersionFor.add(HELD_CONTRA.instrumentId);
    const r = await runFactsheetReader(t.deps(OCT));
    expect(r.status).toBe('completed_with_problems');
    const byInstrument = Object.fromEntries(t.store.attempts.map((a) => [a.instrumentId, a.outcome]));
    expect(byInstrument[HELD_CONTRA.instrumentId]).toBe('error');
    expect(byInstrument[REG.instrumentId]).toBe('recorded_first_observation');
    expect(t.store.versions.map((v) => v.instrumentId)).toEqual([REG.instrumentId]);
    expect(t.store.jobOutcomes).toEqual([false]);
  });
  it('NEGATIVE CONTROL: one failing SOURCE does not stop the others (the fetch itself throws for the first)', async () => {
    const t = setup({
      keys: ['hdfc_baf_sid_2024_06', 'sbi_contra_factsheet_2025_08'],
      held: [HELD_BAF, HELD_CONTRA],
      scripts: { [url('hdfc_baf_sid_2024_06')]: { throws: 'socket hang up' }, [url('sbi_contra_factsheet_2025_08')]: okDoc(SBI_CONTRA) },
    });
    const r = await runFactsheetReader(t.deps(OCT));
    expect(r.status).toBe('completed_with_problems');
    expect(t.store.attempts.find((a) => a.instrumentId === HELD_BAF.instrumentId)?.outcome).toBe('error');
    expect(t.store.attempts.find((a) => a.instrumentId === HELD_CONTRA.instrumentId)?.outcome).toBe('recorded_first_observation');
  });
  it('a failed proposal never loses the recorded version', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC) } });
    await runFactsheetReader(t.deps(OCT));
    t.store.failProposals = true;
    const f2 = new FakeFetcher({ [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC.replace('50:50', '65:35')) });
    await runFactsheetReader({ store: t.store, fetcher: f2, nowIso: NOV, env: NOAI, readDocument: readAsText, runId: 'r2' });
    expect(t.store.versions).toHaveLength(2);
  });
  it('NEGATIVE CONTROL: an oversized document is skipped with a clear status (not truncated, not read) and is terminal for the month', async () => {
    const key = 'icici_dividend_yield_complete_factsheet';
    const HELD_ICICI = { instrumentId: '66666666-6666-4666-8666-666666666666', instrumentName: 'P2373-ICICI Prudential Dividend Yield Fund Growth', amcName: 'ICICI Prudential Mutual Fund', amfiSchemeCode: '129310' };
    const t = setup({ keys: [key], held: [HELD_ICICI], scripts: { [url(key)]: { kind: 'too_large', contentLength: 48_000_000 } } });
    await runFactsheetReader(t.deps(OCT));
    expect(t.store.attempts).toHaveLength(1);
    expect(t.store.attempts[0]).toMatchObject({ outcome: 'document_too_large', bytes: 48_000_000 });
    expect(t.store.attempts[0].detail).toMatch(/too large .*skipped, not truncated/i);
    expect(t.store.versions).toHaveLength(0);
    await runFactsheetReader(t.deps('2026-10-20T00:00:00.000Z'));
    expect(t.fetcher.requestCount).toBe(1);
  });
  it('a block is recorded as source_blocked and is terminal for the month (no retry storm); robots refusal likewise', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], scripts: { [url('hdfc_baf_sid_2024_06')]: { kind: 'blocked', status: 403, detail: 'files.hdfcfund.com: HTTP 403.' } } });
    await runFactsheetReader(t.deps(OCT));
    await runFactsheetReader(t.deps('2026-10-05T00:00:00.000Z'));
    expect(t.fetcher.requestCount).toBe(1);
    expect(t.store.attempts.map((a) => a.outcome)).toEqual(['source_blocked']);
    const t2 = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], scripts: { [url('hdfc_baf_sid_2024_06')]: { kind: 'robots_disallowed', detail: 'robots.txt disallows this path.' } } });
    await runFactsheetReader(t2.deps(OCT));
    expect(t2.store.attempts.map((a) => a.outcome)).toEqual(['refused_robots']);
  });
  it('NEGATIVE CONTROL: transient failures are retried by LATER runs only, at most 3 times a month, then the source waits for next month', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], scripts: { [url('hdfc_baf_sid_2024_06')]: { kind: 'failed', status: 503, detail: 'files.hdfcfund.com: HTTP 503.' } } });
    for (const d of ['03', '04', '05']) await runFactsheetReader(t.deps(`2026-10-${d}T00:00:00.000Z`));
    expect(t.fetcher.requestCount).toBe(3);
    const fourth = await runFactsheetReader(t.deps('2026-10-06T00:00:00.000Z'));
    expect(fourth.sources[0].action).toBe('attempt_cap_reached');
    expect(t.fetcher.requestCount).toBe(3);
    // next month it is tried again
    await runFactsheetReader(t.deps(NOV));
    expect(t.fetcher.requestCount).toBe(4);
  });
  it('unreadable text, a document that does not name the scheme, and a document with no benchmark are each recorded with their own outcome', async () => {
    const cases: Array<[string, string, string]> = [
      ['scheme_not_in_document', 'Some Other Fund\nFirst Tier Benchmark: BSE 500 TRI\n', 'sbi_contra_factsheet_2025_08'],
      ['benchmark_not_found', 'SBI Contra Fund\nReport As On: 31/08/2025\nnothing relevant here at all\n', 'sbi_contra_factsheet_2025_08'],
      ['extraction_ambiguous', 'SBI Contra Fund\nFirst Tier Benchmark: BSE 500 TRI\nTier I Benchmark: Nifty 100 TRI\n', 'sbi_contra_factsheet_2025_08'],
    ];
    for (const [outcome, text, key] of cases) {
      const t = setup({ keys: [key], held: [HELD_CONTRA], scripts: { [url(key)]: okDoc(text) } });
      await runFactsheetReader(t.deps(OCT));
      expect(t.store.attempts.map((a) => a.outcome), outcome).toEqual([outcome]);
      expect(t.store.versions).toHaveLength(0);
    }
    const t = setup({ keys: ['sbi_contra_factsheet_2025_08'], held: [HELD_CONTRA], scripts: { [url('sbi_contra_factsheet_2025_08')]: okDoc('x') } });
    await runFactsheetReader({ ...t.deps(OCT), readDocument: async () => ({ ok: false as const, kind: 'corrupt' as const, message: 'Could not read this PDF.' }) });
    expect(t.store.attempts.map((a) => a.outcome)).toEqual(['text_extraction_failed']);
  });
});

describe('fair rotation and caps', () => {
  it('picks the sources untouched longest first up to the cap, defers the rest, and READS the chosen ones in priority order', async () => {
    const keys = ['hdfc_baf_sid_2024_06', 'hdfc_baf_fund_facts_2026_03', 'sbi_contra_factsheet_2025_08'];
    const t = setup({ keys, held: [HELD_BAF, HELD_CONTRA], scripts: Object.fromEntries(keys.map((k) => [url(k), okDoc(k.startsWith('sbi') ? SBI_CONTRA : HDFC)])) });
    // history: last month the SBI source and the FACTSHEET were tried; the SID was never tried -> it is picked first
    t.store.attempts.push(
      { runId: 'old', runMonth: '2026-09-01', sourceId: 'src-sbi_contra_factsheet_2025_08', instrumentId: HELD_CONTRA.instrumentId, attemptedAt: '2026-09-03T00:00:00.000Z', outcome: 'confirmed_unchanged', detail: null, httpStatus: null, bytes: null, documentChecksum: null, documentDate: null, versionId: null, reviewRequired: false },
      { runId: 'old', runMonth: '2026-09-01', sourceId: 'src-hdfc_baf_fund_facts_2026_03', instrumentId: HELD_BAF.instrumentId, attemptedAt: '2026-09-10T00:00:00.000Z', outcome: 'confirmed_unchanged', detail: null, httpStatus: null, bytes: null, documentChecksum: null, documentDate: null, versionId: null, reviewRequired: false }
    );
    const r = await runFactsheetReader(t.deps(OCT), { maxSources: 2 });
    // chosen: the never-tried SID and the SBI source (tried 3 Sep, older than 10 Sep); deferred: the factsheet
    expect(r.sources.find((s) => s.sourceKey === 'hdfc_baf_fund_facts_2026_03')?.action).toBe('deferred_run_cap');
    expect(t.fetcher.urls).toEqual([url('sbi_contra_factsheet_2025_08'), url('hdfc_baf_sid_2024_06')]); // executed in priority order: the SBI factsheet (10) before the HDFC SID (50)
  });
  it('maxSources 0 fetches nothing', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC) } });
    const r = await runFactsheetReader(t.deps(OCT), { maxSources: 0 });
    expect(t.fetcher.requestCount).toBe(0);
    expect(r.sources[0].action).toBe('deferred_run_cap');
  });
});

describe('the AI pass (optional, only when the pattern pass fails, never trusted)', () => {
  const NO_BENCHMARK_TEXT = 'SBI Contra Fund\nReport As On: 31/08/2025\nThe benchmark for this fund is the BSE 500 TRI index, as the document puts it elsewhere.\n';
  const KEY = 'sbi_contra_factsheet_2025_08';
  const aiJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ schemeNameInDocument: 'SBI Contra Fund', tier1BenchmarkName: 'BSE 500 TRI', tier1VariantStated: 'total_return', additionalBenchmarkNames: [], effectiveFromIso: null, documentDateIso: '2025-08-31', verbatimQuote: 'The benchmark for this fund is the BSE 500 TRI index', notFoundReason: null, ...over });
  const extractor = (raw: string, seen: FactsheetAiRequest[] = []): FactsheetAiExtractor => ({ id: 't', extract: async (req) => { seen.push(req); return { ok: true, rawText: raw, model: 'gpt-4o-mini' }; } });

  it('the AI is NOT used when its switch is off, even though the pattern pass failed', async () => {
    const seen: FactsheetAiRequest[] = [];
    const t = setup({ keys: [KEY], held: [HELD_CONTRA], scripts: { [url(KEY)]: okDoc(NO_BENCHMARK_TEXT) } });
    await runFactsheetReader(t.deps(OCT, { ai: extractor(aiJson(), seen), env: {} }));
    expect(seen).toHaveLength(0);
    expect(t.store.attempts.map((a) => a.outcome)).toEqual(['benchmark_not_found']);
  });
  it('the AI is NOT used when the pattern pass succeeds', async () => {
    const seen: FactsheetAiRequest[] = [];
    const t = setup({ keys: [KEY], held: [HELD_CONTRA], scripts: { [url(KEY)]: okDoc(SBI_CONTRA) } });
    await runFactsheetReader(t.deps(OCT, { ai: extractor(aiJson(), seen), env: { FACTSHEET_READER_AI_ENABLED: 'true' } }));
    expect(seen).toHaveLength(0);
    expect(t.store.versions[0].extractionMethod).toBe('text_pattern');
  });
  it('when the pattern pass fails and the switch is on, a validated AI reading is recorded, flagged AI-only, low confidence, and sent to review', async () => {
    const t = setup({ keys: [KEY], held: [HELD_CONTRA], scripts: { [url(KEY)]: okDoc(NO_BENCHMARK_TEXT) } });
    await runFactsheetReader(t.deps(OCT, { ai: extractor(aiJson()), env: { FACTSHEET_READER_AI_ENABLED: 'true' } }));
    expect(t.store.versions).toHaveLength(1);
    expect(t.store.versions[0]).toMatchObject({ extractionMethod: 'ai', aiModel: 'gpt-4o-mini', extractionConfidence: 'low', reviewState: 'pending_review' });
    expect(t.store.autoPublishCalls).toBe(0);
  });
  it('NEGATIVE CONTROL: AI output failing the schema (or not found in the document) is REJECTED and nothing is recorded', async () => {
    for (const raw of ['not json', JSON.stringify({ tier1BenchmarkName: 'BSE 500 TRI' }), aiJson({ rogue: 1 }), aiJson({ tier1BenchmarkName: 'Nifty 100 TRI', verbatimQuote: 'The benchmark is Nifty 100 TRI' })]) {
      const t = setup({ keys: [KEY], held: [HELD_CONTRA], scripts: { [url(KEY)]: okDoc(NO_BENCHMARK_TEXT) } });
      await runFactsheetReader(t.deps(OCT, { ai: extractor(raw), env: { FACTSHEET_READER_AI_ENABLED: 'true' } }));
      expect(t.store.attempts.map((a) => a.outcome), raw.slice(0, 30)).toEqual(['ai_rejected']);
      expect(t.store.versions).toHaveLength(0);
    }
  });
  it('NEGATIVE CONTROL: no user / holding data leaves the system: the AI request is exactly {schemeName, excerpt} and no document request names an instrument', async () => {
    const seen: FactsheetAiRequest[] = [];
    const t = setup({ keys: [KEY], held: [HELD_CONTRA], scripts: { [url(KEY)]: okDoc(NO_BENCHMARK_TEXT) } });
    await runFactsheetReader(t.deps(OCT, { ai: extractor(aiJson(), seen), env: { FACTSHEET_READER_AI_ENABLED: 'true' } }));
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]).sort()).toEqual(['excerpt', 'schemeName']);
    const wire = JSON.stringify(seen);
    expect(wire).not.toContain(HELD_CONTRA.instrumentId);
    expect(wire).not.toContain(HELD_CONTRA.instrumentName);
    expect(wire).not.toMatch(/user|folio|units|amount|account/i);
    expect(seen[0].schemeName).toBe('SBI Contra Fund'); // the registry's name, not the held instrument's statement name
    // and the only addresses requested are the registered public documents
    expect(t.fetcher.urls).toEqual([url(KEY)]);
  });
  it('the number of AI calls per run is capped', async () => {
    const keys = ['sbi_contra_factsheet_2025_08', 'sbi_contra_sid_2025_10', 'hdfc_baf_sid_2024_06'];
    const seen: FactsheetAiRequest[] = [];
    const t = setup({ keys, held: [HELD_CONTRA, HELD_BAF], scripts: { [url(keys[0])]: okDoc(NO_BENCHMARK_TEXT), [url(keys[1])]: okDoc(NO_BENCHMARK_TEXT), [url(keys[2])]: okDoc('HDFC Balanced Advantage Fund\nThe benchmark is the Nifty 50.\nBenchmark and benchmark.\n') } });
    await runFactsheetReader(t.deps(OCT, { ai: extractor('not json', seen), env: { FACTSHEET_READER_AI_ENABLED: 'true' }, config: { maxAiCallsPerRun: 1 } }));
    expect(seen).toHaveLength(1); // three documents needed the AI; only one call was allowed
  });
});

describe('no user data is read or sent by the job', () => {
  it('the job only ever asks the store for instrument identity (id, name, AMC, AMFI code): the held-instrument shape has no user, count, unit or amount field', async () => {
    const t = setup({ keys: ['hdfc_baf_sid_2024_06'], held: [HELD_BAF], scripts: { [url('hdfc_baf_sid_2024_06')]: okDoc(HDFC) } });
    const held = await t.store.listHeldInstruments();
    expect(Object.keys(held[0]).sort()).toEqual(['amcName', 'amfiSchemeCode', 'instrumentId', 'instrumentName']);
  });
});
