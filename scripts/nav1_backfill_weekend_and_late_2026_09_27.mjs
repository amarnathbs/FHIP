#!/usr/bin/env node
// NAV 1 -- PO decision #1 (27 Sep 2026), one-off backfill for the weekend
// and late-publication gaps found by the 27 Sep certification (F-17/F-18):
//
//   - 2026-09-25: ~67 schemes published their NAV after the old 04:30 UTC
//     collection cutoff and were never collected that morning;
//   - 2026-09-26 (Saturday) and 2026-09-27 (Sunday): AMFI publishes ~600-700
//     liquid/overnight schemes on weekends, and the daily window did not run
//     those two days at all (fixed going forward by migration 0220).
//
// THIS IS NOT A BESPOKE SCRIPT. It is a thin CLI wrapper around the exact
// production reconciliation route (app/api/investment-intelligence/cron/
// pc6-nav-reconciliation/route.ts -> runNavReconciliationSweep()) that
// migrations 0220-0222 add and schedule for ongoing daily use. It calls that
// SAME route with sourceConfigId 'amfi_nav_history' (the AMFI date-ranged
// history report, which genuinely serves any past date -- unlike
// NAVAll.txt, which only ever carries each scheme's LATEST nav) and a fixed
// past publicationDate, instead of "today". Every write it causes goes
// through the same bounded/resumable, exact-pair-lookup, idempotent,
// correction-safe machinery as the daily reconciliation sweep -- see
// lib/services/investment-intelligence/pc6/navReconciliationSweep.ts.
//
// IDEMPOTENT. Re-running this script (for the same or a later day) is safe:
// a date already fully covered costs one cheap "nothing missing" check per
// invocation and writes nothing. It is safe to run repeatedly, safe to
// re-run after a partial run, and safe to run again on a day it already
// completed.
//
// PREREQUISITE. This session's dispatch is production-READ-ONLY; this script
// makes real production writes and is meant to be run by the PO (or an
// operator with the real CRON_SECRET), not by this session. Run it only
// AFTER:
//   1. this branch is merged to main and the Amplify deploy has SUCCEEDed
//      (the /cron/pc6-nav-reconciliation route must exist), and
//   2. migrations 0220, 0221 and 0222 have been applied to production
//      (see docs/nav1/po_run_2026-09-27b/PROD_APPLY_0220_0221_0222.sql).
//
// USAGE:
//   CRON_SECRET=<the real production cron secret> \
//   node scripts/nav1_backfill_weekend_and_late_2026_09_27.mjs --confirm
//
//   Optional:
//     --dates=2026-09-25,2026-09-26,2026-09-27   (default: exactly these three)
//     --url=https://app.financialhealthplatform.com                (default)
//     --max-attempts=20   (per date; a partial run continues on the next attempt)
//
// Refuses to run without --confirm and without CRON_SECRET set, so it can
// never fire by accident.

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const opt = (name, fallback) => {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : fallback;
};

const DEFAULT_DATES = ['2026-09-25', '2026-09-26', '2026-09-27'];
const BASE_URL = opt('url', 'https://app.financialhealthplatform.com');
const DATES = opt('dates', DEFAULT_DATES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const MAX_ATTEMPTS = Number(opt('max-attempts', '20'));
const JOB_KEY = 'pc6_amfi_daily_nav_reconciliation';
const SOURCE_CONFIG_ID = 'amfi_nav_history';

if (!has('--confirm')) {
  console.error('Refusing to run without --confirm. This makes real production writes. Read this file\'s header first.');
  process.exit(2);
}
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error('Refusing to run without CRON_SECRET in the environment (the same secret production\'s pg_cron jobs send as x-cron-secret).');
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATES[0] ?? '')) {
  console.error('No valid --dates given (expected ISO yyyy-mm-dd, comma-separated).');
  process.exit(2);
}

async function callOnce(publicationDate) {
  const res = await fetch(`${BASE_URL}/api/investment-intelligence/cron/pc6-nav-reconciliation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
    body: JSON.stringify({ sourceConfigId: SOURCE_CONFIG_ID, jobKey: JOB_KEY, publicationDate }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { httpStatus: res.status, body };
}

async function backfillOneDate(publicationDate) {
  console.log(`\n=== ${publicationDate} ===`);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { httpStatus, body } = await callOnce(publicationDate);
    if (httpStatus !== 200) {
      console.error(`  attempt ${attempt}: HTTP ${httpStatus} -- ${JSON.stringify(body).slice(0, 500)}`);
      console.error(`  Stopping this date. Check CRON_SECRET, that the code is deployed, and that migrations 0220-0222 are applied.`);
      return { publicationDate, ok: false, reason: `HTTP ${httpStatus}` };
    }
    const r = body.data ?? body; // ok() wraps in { data: ... } per lib/api.ts convention
    console.log(`  attempt ${attempt}: status=${r.status} detail="${r.detail}"`);
    if (r.coverage) {
      console.log(`    coverage: expected=${r.coverage.expectedCount} present=${r.coverage.presentCountAfter} missing=${r.coverage.missingCountAfter} complete=${r.coverage.complete}`);
    }
    if (r.alert?.fired) console.log(`    ALERT (queryable in ii_reference_coverage_alerts): ${r.alert.detail}`);

    if (r.status === 'complete_no_gap' || (r.status === 'succeeded' && r.coverage?.complete)) {
      console.log(`  DONE: ${publicationDate} is confirmed complete.`);
      return { publicationDate, ok: true, attempts: attempt };
    }
    if (r.status === 'succeeded' && !r.coverage) {
      // Dry-run-shaped response or an edge case with no coverage object -- treat as done, nothing more to do.
      console.log(`  DONE (no coverage detail returned): ${publicationDate}.`);
      return { publicationDate, ok: true, attempts: attempt };
    }
    if (r.status === 'partial') {
      console.log(`  Partial -- continuing (idempotent; the next attempt resumes from here).`);
      continue;
    }
    if (r.status === 'skipped_kill_switch' || r.status === 'skipped_backoff') {
      console.error(`  ${r.status}: ${r.detail}. Check ii_reference_job_control for job_key='${JOB_KEY}'.`);
      return { publicationDate, ok: false, reason: r.status };
    }
    if (r.status === 'skipped_already_running') {
      console.log(`  Another invocation is genuinely running (a 2-minute cron tick may have overlapped) -- waiting 5s and retrying.`);
      await new Promise((r2) => setTimeout(r2, 5000));
      continue;
    }
    if (r.status === 'skipped_source_outage') {
      console.error(`  Source outage on this attempt: ${r.detail}. Waiting 10s and retrying.`);
      await new Promise((r2) => setTimeout(r2, 10000));
      continue;
    }
    if (r.status === 'failed') {
      console.error(`  FAILED: ${r.detail}`);
      return { publicationDate, ok: false, reason: 'failed' };
    }
  }
  console.error(`  Gave up after ${MAX_ATTEMPTS} attempts without reaching completion. Re-run this script later -- it is idempotent and will resume.`);
  return { publicationDate, ok: false, reason: 'max_attempts_exceeded' };
}

const results = [];
for (const d of DATES) {
  // Sequential, not parallel: each call already shares one job-control row
  // (the concurrency guard would otherwise make parallel calls for
  // DIFFERENT dates spuriously see each other as "already running").
  results.push(await backfillOneDate(d));
}

console.log('\n=== Summary ===');
for (const r of results) console.log(`  ${r.publicationDate}: ${r.ok ? 'OK' : `NOT DONE (${r.reason})`}${r.attempts ? ` in ${r.attempts} attempt(s)` : ''}`);
const anyFailed = results.some((r) => !r.ok);
if (anyFailed) {
  console.error('\nOne or more dates did not reach completion. This script is idempotent -- safe to re-run.');
  process.exit(1);
}
console.log('\nAll target dates confirmed complete.');
