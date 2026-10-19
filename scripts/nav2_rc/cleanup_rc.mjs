// NAV2 release candidate, D9: the prepared EXACT cleanup of everything the DEV certification created. DEV only. Dry run by default.
//   node scripts/nav2_rc/cleanup_rc.mjs            dry run: counts what would go, deletes nothing
//   node scripts/nav2_rc/cleanup_rc.mjs --apply    deletes, children before parents, prints attempted / committed / remaining per table
//
// WHAT IS REMOVED (and nothing else): (1) every row the five standing fixture users hold in the investment-intelligence tables, their fund analytics reports (the
// pins and render tokens go with them), the publications and the investments those created, their household members and business entities created since the run
// began (before the run they had none: checked at the start), by the existing tested reset script; (2) the price rows of the fixture funds that carry the marker
// NAV2RC_FIXTURE and the hydration-fetched HISTORY price rows of the 26 funds that had none before the run (ledger); (3) the hydration attempt rows of those funds; (4) the cache
// entries created during the run (keys not in the ledger of keys that existed before); (5) the switches are put back; (6) the temporary cron secret file is deleted.
// NOT removed by design: the append-only audit events and correction ledger rows, and the users' own earlier manual investments.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db, OUT, USERS, userIdOf } from '../nav2_stage3/_lib.mjs';

const apply = process.argv.includes('--apply');
const RC = path.join(OUT, '..', 'nav2_rc');
const START = '2026-10-14T12:00:00Z';
const ledgerFile = path.join(RC, 'big_user_ledger.json');
const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : { instruments: [], cacheKeysBefore: null };
const USER_TABLES = ['ii_source_documents', 'ii_accounts', 'ii_transactions', 'ii_holding_snapshots', 'ii_portfolio_truth_status', 'ii_reconciliation_cases', 'ii_fhip_publications', 'ii_investment_date_inputs', 'ii_tax_lots', 'ii_analytics_results', 'nav2_fund_analytics_reports', 'nav2_report_render_tokens', 'household_members', 'business_entities'];
const count = async (t, build) => { const q = build(db.from(t).select('*', { count: 'exact', head: true })); const { count: c, error } = await q; return error ? `err:${error.message.slice(0, 30)}` : c; };
const report = [];
const line = (what, attempted, committed, remaining) => { report.push({ what, attempted, committed, remaining }); console.log(`  ${what.padEnd(58)} attempted ${String(attempted).padStart(6)}  committed ${String(committed).padStart(6)}  remaining ${String(remaining).padStart(6)}`); };
console.log(`=== RC cleanup ${apply ? 'APPLY' : 'DRY RUN'}  ${new Date().toISOString()} ===`);

// ---- (1) the fixture users ----------------------------------------------------------------------------------------------------------------------------
const ids = {};
for (const [k, email] of Object.entries(USERS)) ids[k] = await userIdOf(email);
const before = {};
for (const [k, uid] of Object.entries(ids)) {
  before[k] = {};
  for (const t of USER_TABLES) before[k][t] = await count(t, (q) => (['household_members', 'business_entities'].includes(t) ? q.eq('user_id', uid).gte('created_at', START) : q.eq('user_id', uid)));
}
const keyOf = (t) => t;
for (const t of USER_TABLES) {
  const attempted = Object.values(before).reduce((s, b) => s + (typeof b[t] === 'number' ? b[t] : 0), 0);
  if (!apply) line(`users: ${keyOf(t)}`, attempted, '-', '-');
}
if (apply) {
  for (const k of Object.keys(USERS)) {
    try { execFileSync('node', ['scripts/nav2_stage3/reset_user.mjs', k], { stdio: 'pipe', timeout: 600000 }); } catch (e) { console.log(`  reset ${k} failed: ${String(e.stderr ?? e.message).slice(0, 200)}`); }
    // members and entities created since the run began (the reset script does not know them)
    for (const t of ['household_members', 'business_entities']) {
      const ownership = await db.from('ii_ownership_allocation').select('id').eq('user_id', ids[k]);
      void ownership;
      const del = await db.from(t).delete().eq('user_id', ids[k]).gte('created_at', START).select('id');
      if (del.error) console.log(`  ${t} ${k}: ${del.error.message.slice(0, 80)}`);
    }
  }
  for (const t of USER_TABLES) {
    const attempted = Object.values(before).reduce((s, b) => s + (typeof b[t] === 'number' ? b[t] : 0), 0);
    let remaining = 0;
    for (const [k, uid] of Object.entries(ids)) {
      const c = await count(t, (q) => (['household_members', 'business_entities'].includes(t) ? q.eq('user_id', uid).gte('created_at', START) : q.eq('user_id', uid)));
      remaining += typeof c === 'number' ? c : 0;
    }
    line(`users: ${t}`, attempted, attempted - remaining, remaining);
  }
}

// ---- (2) price rows -------------------------------------------------------------------------------------------------------------------------------------
const marker = await count('ii_prices_nav', (q) => q.like('data_version', 'NAV2RC_FIXTURE%'));
const rIds = ledger.instruments ?? [];
// only the HISTORY rows (before the NAV 1 changeover) created during the run: the daily job's newest-days rows for every fund are not ours
const histQ = (q) => q.in('instrument_id', rIds).lt('price_date', '2026-09-21').gte('created_at', START);
const ledgerNav = rIds.length ? await count('ii_prices_nav', histQ) : 0;
if (!apply) { line('prices: marked fixture rows (NAV2RC_FIXTURE)', marker, '-', '-'); line(`prices: stored for the ${rIds.length} fund(s) that had none before`, ledgerNav, '-', '-'); } else {
  let delM = 0, delL = 0;
  const m = await db.from('ii_prices_nav').delete().like('data_version', 'NAV2RC_FIXTURE%').select('id'); delM = m.data?.length ?? 0;
  for (let i = 0; i < rIds.length; i += 3) { const r = await db.from('ii_prices_nav').delete().in('instrument_id', rIds.slice(i, i + 3)).lt('price_date', '2026-09-21').gte('created_at', START).select('id'); delL += r.data?.length ?? 0; }
  line('prices: marked fixture rows (NAV2RC_FIXTURE)', marker, delM, await count('ii_prices_nav', (q) => q.like('data_version', 'NAV2RC_FIXTURE%')));
  line(`prices: stored for the ${rIds.length} fund(s) that had none before`, ledgerNav, delL, await count('ii_prices_nav', histQ));
}

// ---- (3) hydration attempts of those funds ---------------------------------------------------------------------------------------------------------------
if (rIds.length) {
  const a = await count('ii_nav_hydration_attempts', (q) => q.in('instrument_id', rIds));
  if (!apply) line('hydration attempts of the funds that had no history', a, '-', '-'); else { const d = await db.from('ii_nav_hydration_attempts').delete().in('instrument_id', rIds).select('instrument_id'); line('hydration attempts of the funds that had no history', a, d.data?.length ?? 0, await count('ii_nav_hydration_attempts', (q) => q.in('instrument_id', rIds))); }
}

// ---- (4) cache entries created during the run -----------------------------------------------------------------------------------------------------------
if (ledger.cacheKeysBefore) {
  const keep = new Set(ledger.cacheKeysBefore);
  const all = ((await db.from('nav2_result_cache').select('cache_key')).data ?? []).map((x) => x.cache_key);
  const mine = all.filter((k) => !keep.has(k));
  if (!apply) line('cache entries created during the run', mine.length, '-', '-'); else {
    let d = 0;
    for (let i = 0; i < mine.length; i += 100) { const r = await db.from('nav2_result_cache').delete().in('cache_key', mine.slice(i, i + 100)).select('cache_key'); d += r.data?.length ?? 0; }
    const left = ((await db.from('nav2_result_cache').select('cache_key')).data ?? []).filter((x) => !keep.has(x.cache_key)).length;
    line('cache entries created during the run', mine.length, d, left);
  }
} else console.log('  (no cache ledger: the cache entries of the run are left; they are derived, recomputable data)');

// ---- (5) and (6) switches, fixtures, secret ---------------------------------------------------------------------------------------------------------------
if (apply) {
  for (const k of ['nav2_trigger_planner', 'nav2_correction_worker', 'nav2_risk_free_weekly_refresh', 'pc6_selective_historical_hydration']) await db.from('ii_reference_job_control').update({ enabled: false, disabled_reason: 'RC certification finished: back to OFF' }).eq('job_key', k);
  try { execFileSync('node', ['scripts/nav2_stage3/setup.mjs', 'revert'], { stdio: 'pipe' }); console.log('  fixture users: country confirmation and plan restored'); } catch (e) { console.log('  setup revert:', String(e.stderr ?? e.message).slice(0, 160)); }
  const secret = path.join(OUT, '.cron_secret');
  if (fs.existsSync(secret)) { fs.rmSync(secret); console.log('  cron secret file deleted'); }
}
const failed = report.filter((r) => apply && (typeof r.remaining === 'number' && r.remaining > 0));
fs.writeFileSync(path.join(RC, apply ? 'cleanup_applied.json' : 'cleanup_dry_run.json'), JSON.stringify(report, null, 1));
console.log(failed.length ? `\nNOT CLEAN: ${failed.map((f) => f.what).join('; ')}` : apply ? '\nclean: every target re-queried and found empty' : '\ndry run only: nothing deleted');
process.exitCode = failed.length ? 1 : 0;
