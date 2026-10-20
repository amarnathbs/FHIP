// Fund analytics "Generate all my funds" (PO decision 20-10-2026, option B): the batches, the sequencing, one key per batch, retry handling and partial failure.
//
// UNIT-TESTED here (pure functions with an injected request and an injected wait, so no browser and no clock): lib/reports/fundAnalyticsGenerateAll.ts and the
// screen's wiring (source scan). NOT proven here: the real server's 22 s budget per batch and the real browser; see the report for what was rendered.
//
// NAMED NEGATIVE CONTROLS (each guard is removed in a copy and the very same check is shown to FAIL on it):
//   NC-GA1  a planner that does not clamp the batch size (trusts any `max`) puts more than 10 funds in a batch;
//   NC-GA2  a runner that asks for all batches at once (Promise.all) is caught by the concurrency check;
//   NC-GA3  a runner that makes a new key for every request (instead of one key per batch) is caught by the idempotency check: a replay would make copies;
//   NC-GA4  a runner that does not skip saved batches on "Try again" asks for a saved batch a second time;
//   NC-GA5  a planner that does not de-duplicate lets one fund appear in two batches.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FUND_ANALYTICS_MAX_FUNDS } from '@/lib/config/nav2/reportLimits';
import {
  batchProgressLine,
  batchSize,
  classifyBatchResponse,
  fitsCombinedPdf,
  GENERATE_ALL_MAX_POLLS,
  GENERATE_ALL_POLL_MS,
  initialBatches,
  planBatches,
  reportCountFor,
  runBatches,
  summarizeRun,
  type BatchCandidate,
  type BatchState,
  type RunDeps,
} from '@/lib/reports/fundAnalyticsGenerateAll';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const funds = (n: number, valueOf: (i: number) => number | null = (i) => 1_000_000 - i * 1000): BatchCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ instrumentId: `fund-${String(i + 1).padStart(2, '0')}`, schemeName: `Fund ${i + 1}`, currentValue: valueOf(i) }));
const nameOf = (id: string) => `Name of ${id}`;

// ---- a fake server: ONE report per Idempotency-Key (a replay of the same key returns the same report), a scripted answer per call -----------------------------------
type Answer = { status: number; body: unknown };
const ready = (id: string, replayed = false): Answer => ({ status: replayed ? 200 : 201, body: { data: { status: 'ready', report: { id }, ...(replayed ? { replayed: true } : {}) } } });
const inSteps: Answer = { status: 202, body: { data: { status: 'in_steps', headline: 'Preparing', loaded: 3, total: 7, waitingFunds: ['A'], unavailableFunds: [] } } };
const timedOut: Answer = { status: 503, body: { error: 'The report is taking longer than expected.', data: { status: 'timed_out', retryable: true } } };
const serverError: Answer = { status: 500, body: { error: 'The report could not be generated. Please try again.', data: { status: 'failed', retryable: true } } };

interface Call {
  fundIds: string[];
  key: string;
}
function harness(script: (call: Call, n: number, issued: Map<string, string>) => Answer | Promise<Answer> | 'throw') {
  const calls: Call[] = [];
  const issued = new Map<string, string>(); // key -> report id
  let active = 0;
  let maxActive = 0;
  const sleeps: number[] = [];
  const keys = new Map<string, string>();
  let keySeq = 0;
  const dropped: string[] = [];
  const changes: BatchState[][] = [];
  const deps: RunDeps = {
    async post(fundIds, key) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push({ fundIds, key });
      try {
        await Promise.resolve();
        const a = script({ fundIds, key }, calls.length, issued);
        if (a === 'throw') throw new Error('network');
        return await a;
      } finally {
        active -= 1;
      }
    },
    sleep: async (ms) => void sleeps.push(ms),
    keyFor: (b) => {
      const id = b.fundIds.join(',');
      if (!keys.has(id)) keys.set(id, `key-${String(++keySeq).padStart(4, '0')}-0123456789abcdef`);
      return keys.get(id) as string;
    },
    dropKey: (b) => void (dropped.push(b.fundIds.join(',')), keys.delete(b.fundIds.join(','))),
    cancelled: () => false,
    onChange: (bs) => void changes.push(bs),
  };
  return { deps, calls, issued, sleeps, keys, dropped, changes, maxActive: () => maxActive };
}
/** A server that issues one report per distinct key, and replays it for a repeated key. */
const issuingScript = () => (c: Call, _n: number, issued: Map<string, string>): Answer => {
  const had = issued.get(c.key);
  if (had) return ready(had, true);
  const id = `report-${issued.size + 1}`;
  issued.set(c.key, id);
  return ready(id);
};

describe('the batches', () => {
  it('17 funds are 10 + 7: the 10 largest by current value first, then the rest; every fund in exactly one batch', () => {
    const shuffled = funds(17).reverse();
    const plan = planBatches(shuffled, 10);
    expect(plan.map((b) => b.length)).toEqual([10, 7]);
    expect(plan[0]).toEqual(funds(10).map((f) => f.instrumentId));
    expect(plan[1]).toEqual(funds(17).slice(10).map((f) => f.instrumentId));
    expect(plan.flat().sort()).toEqual(funds(17).map((f) => f.instrumentId).sort());
    expect(new Set(plan.flat()).size).toBe(17);
  });
  it('10 funds are ONE batch, 11 are 10 + 1, 21 are 10 + 10 + 1, 1 fund is one batch of 1, none is no batch', () => {
    expect(planBatches(funds(10), 10).map((b) => b.length)).toEqual([10]);
    expect(planBatches(funds(11), 10).map((b) => b.length)).toEqual([10, 1]);
    expect(planBatches(funds(21), 10).map((b) => b.length)).toEqual([10, 10, 1]);
    expect(planBatches(funds(1), 10).map((b) => b.length)).toEqual([1]);
    expect(planBatches([], 10)).toEqual([]);
  });
  it('a fund with no value sorts last (ties keep list order) and is still covered', () => {
    const list = funds(12, (i) => (i === 0 ? null : 5000 - i));
    const plan = planBatches(list, 10);
    expect(plan[1]).toEqual(['fund-12', 'fund-01']); // fund-12 is the smallest with a value; fund-01 has none and is last of all
    expect(plan.flat()).toContain('fund-01');
    expect(plan.flat().indexOf('fund-01')).toBe(11); // last of all
  });
  it('a repeated fund in the answer is counted once (a fund is never in two batches)', () => {
    const plan = planBatches([...funds(12), ...funds(3)], 10);
    expect(plan.flat().length).toBe(12);
    expect(new Set(plan.flat()).size).toBe(12);
  });
  it('NEVER more than 10 per batch: even when the server answer says a larger maximum, and a missing or silly maximum falls back to 10', () => {
    expect(FUND_ANALYTICS_MAX_FUNDS).toBe(10);
    for (const max of [10, 11, 25, 1000, undefined, null, NaN, Infinity]) {
      expect(Math.max(...planBatches(funds(47), max as number).map((b) => b.length)), String(max)).toBeLessThanOrEqual(10);
      expect(batchSize(max as number)).toBeLessThanOrEqual(10);
    }
    expect(batchSize(4)).toBe(4); // a smaller server maximum is honoured
    expect(planBatches(funds(9), 4).map((b) => b.length)).toEqual([4, 4, 1]);
    expect(batchSize(0)).toBe(1);
  });
  it('how many reports, and whether one PDF can hold them (at most 4)', () => {
    expect(reportCountFor(17, 10)).toBe(2);
    expect(reportCountFor(10, 10)).toBe(1);
    expect(reportCountFor(41, 10)).toBe(5);
    expect([1, 2, 4, 5].map(fitsCombinedPdf)).toEqual([false, true, true, false]);
  });
  it('NC-GA1: a planner that trusts the server maximum without clamping is caught by the same 10-per-batch check', () => {
    const unclamped = (cands: readonly BatchCandidate[], max: number) => {
      const ids = cands.map((c) => c.instrumentId);
      const out: string[][] = [];
      for (let i = 0; i < ids.length; i += max) out.push(ids.slice(i, i + max));
      return out;
    };
    const over = (plan: string[][]) => plan.some((b) => b.length > FUND_ANALYTICS_MAX_FUNDS);
    expect(over(planBatches(funds(47), 25))).toBe(false);
    expect(over(unclamped(funds(47), 25))).toBe(true);
  });
  it('NC-GA5: a planner without de-duplication puts a fund in two batches, which the single-batch check catches', () => {
    const noDedupe = (cands: readonly BatchCandidate[]) => {
      const ids = cands.map((c) => c.instrumentId);
      const out: string[][] = [];
      for (let i = 0; i < ids.length; i += 10) out.push(ids.slice(i, i + 10));
      return out;
    };
    const twice = (plan: string[][]) => plan.flat().length !== new Set(plan.flat()).size;
    const dup = [...funds(10), ...funds(2)];
    expect(twice(planBatches(dup, 10))).toBe(false);
    expect(twice(noDedupe(dup))).toBe(true);
  });
});

describe('reading the answer to one batch (the same codes as the single-report screen)', () => {
  it('201 and 200 (replay) with a report are ready; the id is the report id', () => {
    expect(classifyBatchResponse(201, ready('r1').body)).toEqual({ kind: 'ready', reportId: 'r1', replayed: false });
    expect(classifyBatchResponse(200, ready('r1', true).body)).toEqual({ kind: 'ready', reportId: 'r1', replayed: true });
  });
  it('202 (prepared in steps) and 503 timed_out both mean "ask again with the same key"', () => {
    expect(classifyBatchResponse(202, inSteps.body)).toMatchObject({ kind: 'retry', waiting: { loaded: 3, total: 7, waitingFunds: ['A'] } });
    expect(classifyBatchResponse(503, timedOut.body)).toMatchObject({ kind: 'retry' });
    expect(classifyBatchResponse(503, { error: 'down' })).toMatchObject({ kind: 'failed', dropKey: true });
  });
  it('a refusal (403 Premium, 422, 404 off), a 500, an odd body and a select_funds are failures with a plain message, never a report', () => {
    expect(classifyBatchResponse(403, { error: 'Premium only' })).toEqual({ kind: 'failed', message: 'Premium only', dropKey: true });
    expect(classifyBatchResponse(422, { error: 'bad choice' })).toMatchObject({ kind: 'failed', message: 'bad choice' });
    expect(classifyBatchResponse(500, serverError.body)).toMatchObject({ kind: 'failed' });
    expect(classifyBatchResponse(500, null)).toMatchObject({ kind: 'failed', message: 'The report could not be generated (500).' });
    expect(classifyBatchResponse(200, { data: {} })).toMatchObject({ kind: 'failed' });
    expect(classifyBatchResponse(409, { error: 'choose', data: { status: 'select_funds', message: 'Choose some funds' } })).toMatchObject({ kind: 'failed', message: 'Choose some funds' });
  });
  it('no_funds is kept apart (the single screen shows its message as a notice)', () => {
    expect(classifyBatchResponse(200, { data: { status: 'no_funds', message: 'No funds' } })).toEqual({ kind: 'no_funds', message: 'No funds' });
  });
});

describe('the run: one batch after the other', () => {
  it('17 funds: batch 1 (10 funds) is asked for and finished BEFORE batch 2 (7 funds) is asked for; each batch has its own key; never two requests at once', async () => {
    const h = harness(issuingScript());
    const batches = initialBatches(planBatches(funds(17), 10));
    const out = await runBatches(batches, h.deps);
    expect(h.calls.map((c) => c.fundIds.length)).toEqual([10, 7]);
    expect(h.calls[0].fundIds).toEqual(funds(10).map((f) => f.instrumentId));
    expect(new Set(h.calls.map((c) => c.key)).size).toBe(2);
    expect(h.maxActive()).toBe(1);
    expect(out.map((b) => b.status)).toEqual(['ready', 'ready']);
    expect(out.map((b) => b.reportId)).toEqual(['report-1', 'report-2']);
    // every batch is shown as running before its request, and batch 2 is still "waiting" while batch 1 runs
    const firstRunning = h.changes.find((c) => c[0].status === 'running');
    expect(firstRunning?.[1].status).toBe('waiting');
    expect(summarizeRun(out, nameOf)).toMatchObject({ phase: 'done', readyReportIds: ['report-1', 'report-2'], uncoveredFundIds: [], message: null });
  });
  it('the batch keys are made by the same helper as the single report key (a UUID: valid for the server 16 to 64 character rule)', () => {
    const src = read('components/reports/FundAnalyticsReportClient.tsx');
    expect(src).toContain('k = newAttemptKey();');
  });
  it('pressing again after success REUSES the keys: the server replays the saved reports, no copy is made', async () => {
    const h = harness(issuingScript());
    const first = await runBatches(initialBatches(planBatches(funds(17), 10)), h.deps);
    const again = await runBatches(initialBatches(planBatches(funds(17), 10)), h.deps);
    expect(h.issued.size).toBe(2); // two keys, two reports, in total
    expect(again.map((b) => b.reportId)).toEqual(first.map((b) => b.reportId));
    expect(h.calls.length).toBe(4);
    expect(h.calls[2].key).toBe(h.calls[0].key);
    expect(h.calls[3].key).toBe(h.calls[1].key);
  });
  it('NC-GA3: a runner that makes a NEW key for every request would make copies on a second press (the issued-reports check catches it)', async () => {
    const h = harness(issuingScript());
    let n = 0;
    const brokenKeys: RunDeps = { ...h.deps, keyFor: () => `fresh-key-${String(++n).padStart(8, '0')}-abcdefgh` };
    await runBatches(initialBatches(planBatches(funds(17), 10)), brokenKeys);
    await runBatches(initialBatches(planBatches(funds(17), 10)), brokenKeys);
    expect(h.issued.size).toBe(4); // duplicates: the check "two reports in total" fails
    expect(h.issued.size).not.toBe(2);
  });
  it('NC-GA2: a runner that asks for every batch at once is caught by the concurrency check', async () => {
    const h = harness(issuingScript());
    const parallel = async (batches: BatchState[]) => {
      await Promise.all(batches.map((b) => h.deps.post(b.fundIds, h.deps.keyFor(b))));
    };
    await parallel(initialBatches(planBatches(funds(17), 10)));
    expect(h.maxActive()).toBe(2);
    expect(h.maxActive()).not.toBe(1);
  });
  it('a batch prepared in steps (202) or timed out (503) is asked again with the SAME key after 15 s, then continues to the next batch', async () => {
    let n = 0;
    const h = harness((c, i, issued) => {
      n += 1;
      if (n === 1) return inSteps;
      if (n === 2) return timedOut;
      return issuingScript()(c, i, issued);
    });
    const out = await runBatches(initialBatches(planBatches(funds(12), 10)), h.deps);
    expect(out.map((b) => b.status)).toEqual(['ready', 'ready']);
    expect(h.calls.length).toBe(4);
    expect(h.calls[0].key).toBe(h.calls[1].key);
    expect(h.calls[1].key).toBe(h.calls[2].key);
    expect(h.calls[3].key).not.toBe(h.calls[0].key);
    expect(h.sleeps).toEqual([GENERATE_ALL_POLL_MS, GENERATE_ALL_POLL_MS]);
    expect(GENERATE_ALL_POLL_MS).toBe(15_000);
    expect(GENERATE_ALL_MAX_POLLS * GENERATE_ALL_POLL_MS).toBe(10 * 60_000);
    // while waiting, the batch carries what the server said
    expect(h.changes.some((c) => c[0].waiting?.total === 7 || c[0].waiting?.loaded === 3)).toBe(true);
  });
  it('a batch that is still not ready after 40 checks (10 minutes) stops the run, keeps its key and names the funds as not covered', async () => {
    const h = harness(() => inSteps);
    const out = await runBatches(initialBatches(planBatches(funds(12), 10)), h.deps);
    expect(h.calls.length).toBe(GENERATE_ALL_MAX_POLLS + 1);
    expect(new Set(h.calls.map((c) => c.key)).size).toBe(1);
    expect(h.dropped).toEqual([]); // the key is kept: the server carries on where it stopped
    expect(out.map((b) => b.status)).toEqual(['failed', 'waiting']);
    expect(out[0].message).toMatch(/still being prepared/);
  });
});

describe('partial failure', () => {
  const failSecond = (answer: Answer | 'throw') => (c: Call, i: number, issued: Map<string, string>) => (c.fundIds.length === 7 ? answer : issuingScript()(c, i, issued));

  it('batch 2 fails (500): batch 1 is KEPT and ready, the 7 funds are named as not covered, the run stops, the error key is dropped', async () => {
    const h = harness(failSecond(serverError));
    const out = await runBatches(initialBatches(planBatches(funds(17), 10)), h.deps);
    expect(out.map((b) => b.status)).toEqual(['ready', 'failed']);
    expect(out[0].reportId).toBe('report-1');
    const s = summarizeRun(out, nameOf);
    expect(s.phase).toBe('partial');
    expect(s.readyReportIds).toEqual(['report-1']);
    expect(s.uncoveredFundIds).toEqual(funds(17).slice(10).map((f) => f.instrumentId));
    expect(s.message).toContain('Report 1 of 2 is saved and kept.');
    expect(s.message).toContain('Report 2 of 2 is not ready. 7 funds not covered yet:'); // the reason is on the report's own line, not repeated
    for (const f of funds(17).slice(10)) expect(s.message).toContain(nameOf(f.instrumentId));
    for (const f of funds(10)) expect(s.message).not.toContain(nameOf(f.instrumentId));
    expect(h.dropped).toEqual([funds(17).slice(10).map((f) => f.instrumentId).join(',')]);
  });
  it('"Try the remaining funds again": only the failed batch is asked for; the saved batch is NOT asked for again (no copy); the failed batch gets a fresh key (the server answered)', async () => {
    let failing = true;
    const h = harness((c, i, issued) => (c.fundIds.length === 7 && failing ? serverError : issuingScript()(c, i, issued)));
    const first = await runBatches(initialBatches(planBatches(funds(17), 10)), h.deps);
    const callsBefore = h.calls.length;
    failing = false;
    const retried = await runBatches(first, h.deps);
    const newCalls = h.calls.slice(callsBefore);
    expect(newCalls.length).toBe(1);
    expect(newCalls[0].fundIds.length).toBe(7);
    expect(newCalls[0].key).not.toBe(h.calls[1].key);
    expect(retried.map((b) => b.status)).toEqual(['ready', 'ready']);
    expect(h.issued.size).toBe(2);
    expect(summarizeRun(retried, nameOf).phase).toBe('done');
  });
  it('NC-GA4: a runner that does not skip saved batches asks for batch 1 again on retry (the calls check catches it)', async () => {
    const h = harness(issuingScript());
    const done = await runBatches(initialBatches(planBatches(funds(17), 10)), h.deps);
    const callsBefore = h.calls.length;
    await runBatches(done, h.deps);
    expect(h.calls.length).toBe(callsBefore); // the real runner: nothing asked, everything already saved
    const naive = done.map((b) => ({ ...b, status: 'waiting' as const }));
    await runBatches(naive, h.deps);
    expect(h.calls.length).toBeGreaterThan(callsBefore); // the broken one asks again
  });
  it('a network error (no answer at all) keeps the key: the request may have been accepted, so the retry replays instead of copying', async () => {
    let drop = true;
    const h = harness((c, i, issued) => (c.fundIds.length === 7 && drop ? 'throw' : issuingScript()(c, i, issued)));
    const first = await runBatches(initialBatches(planBatches(funds(17), 10)), h.deps);
    expect(first.map((b) => b.status)).toEqual(['ready', 'failed']);
    expect(h.dropped).toEqual([]);
    drop = false;
    await runBatches(first, h.deps);
    const sevens = h.calls.filter((c) => c.fundIds.length === 7);
    expect(sevens.length).toBe(2);
    expect(sevens[1].key).toBe(sevens[0].key);
  });
  it('a batch the server says has nothing to report on (no_funds) is skipped, the run goes on, and its funds are named', async () => {
    const h = harness((c, i, issued) => (c.fundIds.length === 10 ? { status: 200, body: { data: { status: 'no_funds', message: 'No funds to report on' } } } : issuingScript()(c, i, issued)));
    const out = await runBatches(initialBatches(planBatches(funds(17), 10)), h.deps);
    expect(out.map((b) => b.status)).toEqual(['skipped', 'ready']);
    const s = summarizeRun(out, nameOf);
    expect(s.phase).toBe('partial');
    expect(s.uncoveredFundIds.length).toBe(10);
  });
  it('a run that is cancelled (the screen went away) asks for nothing more', async () => {
    const h = harness(issuingScript());
    let stop = false;
    const out = await runBatches(initialBatches(planBatches(funds(17), 10)), { ...h.deps, cancelled: () => stop, post: async (f, k) => ((stop = true), h.deps.post(f, k)) });
    expect(h.calls.length).toBe(1);
    expect(out[1].status).toBe('waiting');
  });
});

describe('what the screen says', () => {
  it('the progress lines are plain: "Report 1 of 2: 10 funds - ready", "- waiting", "- being made", "- not ready: ..."', () => {
    const b = initialBatches(planBatches(funds(17), 10));
    expect(batchProgressLine(b[0], 2)).toBe('Report 1 of 2: 10 funds - waiting');
    expect(batchProgressLine({ ...b[0], status: 'running' }, 2)).toBe('Report 1 of 2: 10 funds - being made');
    expect(batchProgressLine({ ...b[0], status: 'ready' }, 2)).toBe('Report 1 of 2: 10 funds - ready');
    expect(batchProgressLine({ ...b[1], status: 'running', waiting: { headline: null, loaded: 3, total: 7, waitingFunds: [], unavailableFunds: [] } }, 2)).toContain('Report 2 of 2: 7 funds - price history is being prepared (3 of 7 loaded)');
    expect(batchProgressLine({ ...b[1], status: 'failed', message: 'try later' }, 2)).toBe('Report 2 of 2: 7 funds - not ready: try later');
    expect(batchProgressLine(initialBatches([['x']])[0], 1)).toBe('Report 1 of 1: 1 fund - waiting');
  });
  it('a run in progress is "running"; before the first request every batch is waiting and the run still counts as running', () => {
    expect(summarizeRun(initialBatches(planBatches(funds(17), 10)), nameOf).phase).toBe('running');
  });
});

describe('the screen wiring (source scan of components/reports/FundAnalyticsReportClient.tsx)', () => {
  const src = read('components/reports/FundAnalyticsReportClient.tsx');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('requests go through the one sequential runner, never Promise.all, and every request carries an Idempotency-Key and the period', () => {
    expect(code).toContain('runBatches(');
    expect(code).not.toMatch(/Promise\.all/);
    const post = code.slice(code.indexOf('post: async (funds, key)'), code.indexOf('sleep:'));
    expect(post).toContain("'Idempotency-Key': key");
    expect(post).toContain('JSON.stringify({ period: rp.period, funds })');
  });
  it('it shares inFlight with the single-report path (never two requests at once) and keeps one key per batch for the life of the screen', () => {
    const fn = code.slice(code.indexOf('const generateAll = useCallback'), code.indexOf('const generate = useCallback'));
    expect(fn.length).toBeGreaterThan(500);
    expect(fn).toContain('if (inFlight.current) return;');
    expect(fn).toContain('batchKeys.current');
    expect(fn).toContain('keyFor:');
    // the keys of saved batches are never dropped by the screen: only the runner drops a key after a server answer that is an error
    expect(fn).not.toMatch(/batchKeys\.current\.clear\(\)/);
  });
  it('"Save all as one PDF" is only offered when the run is done and the set fits one PDF, and opens the combined print address', () => {
    expect(code).toContain("runSummary.phase === 'done' && fitsCombinedPdf(run.length)");
    expect(code).toContain('combinedPrintHref(runSummary.readyReportIds, viewerTz)');
    expect(code).toContain('Save all as one PDF');
    expect(code).toContain('Try the remaining funds again');
  });
  it('the per-report "Print / Save as PDF" is still there, with the single-report address', () => {
    expect(code).toContain('/reports/fund-analytics/print?id=${encodeURIComponent(selectedId)}&print=1');
  });
  it('"Generate all" is offered where the funds are known: after the choose-funds answer, and next to "Choose the other funds"', () => {
    expect(code).toContain('onGenerateAll={() => void generateAll({ candidates: pick.candidates, max: pick.max })}');
    expect(code).toContain('askForAll.current = true;');
    expect(code).toMatch(/Generate all my funds \(\{reportCountFor\(report\.selection\.heldFundCount, report\.selection\.max\)\} reports\)/);
  });
});
