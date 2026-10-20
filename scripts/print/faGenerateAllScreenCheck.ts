// Real-browser check of the Fund analytics SCREEN's "Generate all my funds" (Chromium via Playwright; no dev server, login, database or secret).
//
//   npx tsx scripts/print/faGenerateAllScreenCheck.ts [--shots <dir>]
//
// The REAL FundAnalyticsReportClient is bundled and loaded in Chromium; window.fetch is replaced by a scripted server that holds 17 funds, answers a request
// without a choice with the 409 "choose funds" answer, issues ONE report per Idempotency-Key (a repeated key replays it with 200), takes 250 ms per request, and
// records every call. Scenarios: (A) one click makes 2 reports one after the other, (B) pressing it again makes no copy, (C) batch 2 fails once: batch 1 is kept,
// the 7 funds are named, "Try the remaining funds again" asks only for batch 2. It proves the screen's sequencing and states; it does NOT prove the real server's
// 22 s budget per batch (see the report).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import { buildPrintFixture } from '../nav2_print_fixtures';
import { buildAssets, launch, OUT } from './printLayoutLib.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : undefined;
const failures: string[] = [];
const log: string[] = [];
const check = (ok: boolean, what: string) => {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

const HELD = 17;
const candidates = Array.from({ length: HELD }, (_, i) => ({ instrumentId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, schemeName: `Fund number ${i + 1}`, currentValue: 2_000_000 - i * 50_000 }));

// the scripted server, run inside the page (plain JavaScript as a string)
const SERVER = `
window.__CALLS__ = []; window.__ISSUED__ = {}; window.__ACTIVE__ = 0; window.__MAX_ACTIVE__ = 0; window.__FAILED_ONCE__ = false; window.__VERSIONS__ = [];
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
window.fetch = async (url, init) => {
  const u = String(url); const method = (init && init.method) || 'GET';
  if (method === 'GET' && u === '/api/reports/fund-analytics') return json(200, { data: window.__VERSIONS__ });
  if (method === 'GET' && u.startsWith('/api/reports/fund-analytics/')) return json(200, { data: { report: window.__REPORT__ } });
  if (method === 'POST' && u === '/api/reports/fund-analytics') {
    const body = JSON.parse(init.body); const key = init.headers['Idempotency-Key'];
    window.__CALLS__.push({ funds: body.funds || null, key: key, period: body.period, t0: Date.now() });
    window.__ACTIVE__ += 1; window.__MAX_ACTIVE__ = Math.max(window.__MAX_ACTIVE__, window.__ACTIVE__);
    try {
      await sleep(250);
      const cands = window.__CANDS__;
      if (!body.funds) return json(409, { error: 'You hold 17 funds', data: { status: 'select_funds', message: 'You hold 17 funds', max: 10, heldFundCount: 17, candidates: cands, suggestedIds: cands.slice(0, 10).map((c) => c.instrumentId) } });
      if (body.funds.length > 10) return json(422, { error: 'too many' });
      if (window.__SCENARIO__.failSecondOnce && body.funds.length === 7 && !window.__FAILED_ONCE__) { window.__FAILED_ONCE__ = true; return json(500, { error: 'The report could not be generated. Please try again.', data: { status: 'failed', retryable: true } }); }
      if (window.__ISSUED__[key]) return json(200, { data: { status: 'ready', replayed: true, report: window.__ISSUED__[key] } });
      const n = Object.keys(window.__ISSUED__).length + 1;
      const rep = { id: '10000000-0000-4000-8000-' + String(n).padStart(12, '0'), versionNumber: n, asOfDate: '2026-10-20', schemeCount: body.funds.length, createdAt: '2026-10-20T01:0' + n + ':00.000Z', periodChoice: body.period || 'since_first_held' };
      window.__ISSUED__[key] = rep; window.__VERSIONS__.unshift(rep);
      return json(201, { data: { status: 'ready', report: rep } });
    } finally { window.__ACTIVE__ -= 1; }
  }
  return json(404, { error: 'unexpected ' + method + ' ' + u });
};
`;

const html = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>screen</title><link rel="stylesheet" href="out.css"></head><body><div id="root"></div><script src="screen_data.js"></script><script>${SERVER}</script><script src="printHarnessEntry.generateAll.bundle.js"></script></body></html>`;

async function main() {
  await buildAssets('printHarnessEntry.generateAll.jsx');
  const browser = await launch();
  const base = buildPrintFixture({ funds: 2 }).report;
  // the loaded report says it covers 10 of 17 funds, so the screen offers the "rest of funds" row
  const report = { ...base, selection: { max: 10, heldFundCount: HELD, chosenCount: 10, chosenInstrumentIds: candidates.slice(0, 10).map((c) => c.instrumentId) } };
  if (shots) mkdirSync(shots, { recursive: true });
  writeFileSync(path.join(OUT, 'screen.html'), html());

  const open = async (scenario: Record<string, unknown>) => {
    writeFileSync(path.join(OUT, 'screen_data.js'), `window.__REPORT__=${JSON.stringify(report).split('<').join('\\u003c')};window.__CANDS__=${JSON.stringify(candidates)};window.__SCENARIO__=${JSON.stringify(scenario)};`);
    const context = await browser.newContext({ viewport: { width: 1000, height: 1300 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(pathToFileURL(path.join(OUT, 'screen.html')).href);
    await page.waitForFunction(() => (window as unknown as { __READY__?: boolean }).__READY__ === true);
    return { page, errors, context };
  };
  const state = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __CALLS__: Array<{ funds: string[] | null; key: string; t0: number }>; __ISSUED__: Record<string, unknown>; __MAX_ACTIVE__: number };
      return { calls: w.__CALLS__.map((c) => ({ n: c.funds ? c.funds.length : 0, key: c.key, t0: c.t0 })), issued: Object.keys(w.__ISSUED__).length, maxActive: w.__MAX_ACTIVE__ };
    });
  const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);
  const waitText = (page: Page, text: string, timeout = 20000) => page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });

  // ---- A + B: one click, two reports one after the other; pressing again makes no copy -------------------------------------------------------------
  {
    const { page, errors, context } = await open({});
    await page.getByRole('button', { name: 'Generate report' }).click();
    await page.getByTestId('fund-pick').waitFor();
    check((await bodyText(page)).includes('Generate all my funds (2 reports)'), 'A: the choose-funds panel offers "Generate all my funds (2 reports)" for 17 funds');
    await page.getByRole('button', { name: 'Generate all my funds (2 reports)' }).click();
    await page.getByTestId('generate-all-progress').waitFor();
    await waitText(page, 'Report 1 of 2: 10 funds - being made');
    check((await bodyText(page)).includes('Report 2 of 2: 7 funds - waiting'), 'A: while report 1 is being made, report 2 says "waiting" (not started)');
    if (shots) await page.screenshot({ path: path.join(shots, 'screen_A_running.png') });
    await waitText(page, 'All your funds are covered.');
    const done = await bodyText(page);
    check(done.includes('Report 1 of 2: 10 funds - ready') && done.includes('Report 2 of 2: 7 funds - ready'), 'A: the final lines read "Report 1 of 2: 10 funds - ready" and "Report 2 of 2: 7 funds - ready"');
    const s = await state(page);
    check(JSON.stringify(s.calls.map((c) => c.n)) === '[0,10,7]', `A: calls are the probe (no funds), then 10 funds, then 7 funds (got ${JSON.stringify(s.calls.map((c) => c.n))})`);
    check(s.maxActive === 1, `A: never two requests at once (max in flight ${s.maxActive})`);
    check(s.calls[1].key !== s.calls[2].key && s.calls.every((c) => /^[A-Za-z0-9_-]{16,64}$/.test(c.key)), 'A: each batch has its own valid Idempotency-Key');
    check(s.calls[2].t0 - s.calls[1].t0 >= 240, `A: batch 2 started only after batch 1 finished (${s.calls[2].t0 - s.calls[1].t0} ms apart, each request takes 250 ms)`);
    check(s.issued === 2, `A: exactly 2 reports were issued (${s.issued})`);
    const href = await page.getByRole('link', { name: 'Save all as one PDF' }).getAttribute('href');
    check(!!href && /^\/reports\/fund-analytics\/print\?ids=10000000-0000-4000-8000-000000000001,10000000-0000-4000-8000-000000000002&print=1/.test(href), `A: "Save all as one PDF" opens the combined print address (${href})`);
    await page.getByRole('link', { name: 'Print / Save as PDF' }).waitFor({ timeout: 10000 }); // the first report is loaded into the screen once the run ends
    const single = await page.getByRole('link', { name: 'Print / Save as PDF' }).getAttribute('href');
    check(/^\/reports\/fund-analytics\/print\?id=10000000-0000-4000-8000-000000000001&print=1/.test(single ?? ''), `A: the per-report "Print / Save as PDF" is still there and opens the single-report address (${single})`);
    if (shots) await page.screenshot({ path: path.join(shots, 'screen_A_done.png') });

    // B: press "Generate all" again (the loaded report says it covers 10 of 17): the same two keys, so the server replays them, no third report
    await page.getByRole('button', { name: /Generate all my funds \(2 reports\)/ }).click();
    await page.waitForFunction(() => (window as unknown as { __CALLS__: unknown[] }).__CALLS__.length >= 6, null, { timeout: 20000 });
    await waitText(page, 'All your funds are covered.');
    const s2 = await state(page);
    check(s2.issued === 2, `B: pressing again made NO copy: still 2 reports issued (${s2.issued})`);
    check(s2.calls[4].key === s.calls[1].key && s2.calls[5].key === s.calls[2].key, 'B: the second press reused the keys of the first press, batch by batch');
    check(s2.maxActive === 1, 'B: still never two requests at once');
    check(errors.length === 0, `A/B: no script error (${errors.join(' | ')})`);
    await context.close();
  }

  // ---- C: batch 2 fails once -------------------------------------------------------------------------------------------------------------------
  {
    const { page, errors, context } = await open({ failSecondOnce: true });
    await page.getByRole('button', { name: 'Generate report' }).click();
    await page.getByTestId('fund-pick').waitFor();
    await page.getByRole('button', { name: 'Generate all my funds (2 reports)' }).click();
    await waitText(page, 'Some funds are not covered yet.');
    const t = await bodyText(page);
    check(t.includes('Report 1 of 2: 10 funds - ready'), 'C: batch 1 is kept and shown ready');
    check(t.includes('Report 2 of 2: 7 funds - not ready'), 'C: batch 2 is shown "not ready"');
    check(t.includes('Report 1 of 2 is saved and kept.'), 'C: the message says report 1 is saved');
    const uncovered = t.split('not covered yet:')[1] ?? '';
    check(t.includes('7 funds not covered yet:') && candidates.slice(10).every((c) => uncovered.includes(c.schemeName)), 'C: the 7 funds not covered are named');
    check(!candidates.slice(0, 10).some((c) => uncovered.includes(`${c.schemeName};`) || uncovered.includes(`${c.schemeName}.`)), 'C: none of the 10 covered funds is named as not covered');
    check((await page.getByRole('link', { name: 'Save all as one PDF' }).count()) === 0, 'C: no "Save all as one PDF" while a fund is not covered');
    if (shots) await page.screenshot({ path: path.join(shots, 'screen_C_partial.png') });
    const before = await state(page);
    await page.getByRole('button', { name: 'Try the remaining funds again' }).click();
    await waitText(page, 'All your funds are covered.');
    const after = await state(page);
    const added = after.calls.slice(before.calls.length);
    check(added.length === 1 && added[0].n === 7, `C: "Try the remaining funds again" asked ONLY for the 7 remaining funds (asked: ${added.map((c) => c.n).join(',')})`);
    check(after.issued === 2, `C: 2 reports in the end, no copy of batch 1 (${after.issued})`);
    check((await page.getByRole('link', { name: 'Save all as one PDF' }).count()) === 1, 'C: after the retry "Save all as one PDF" appears');
    check(errors.length === 0, `C: no script error (${errors.join(' | ')})`);
    await context.close();
  }

  await browser.close();
  console.log(log.join('\n'));
  console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
