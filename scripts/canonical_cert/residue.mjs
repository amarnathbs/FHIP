/**
 * Residue ledger CLI (DEV, service role; setup / observation / cleanup only).
 *
 *   node scripts/canonical_cert/residue.mjs baseline --ledger A-run1 --emails a@x,b@y   # key snapshot of every
 *                                                            # user-scoped table + storage, BEFORE any journey
 *   node scripts/canonical_cert/residue.mjs prepare  --ledger A-run1 --email a@x --port 3971
 *        # saves the user_profiles row, then confirms the fixture country THROUGH THE APP ROUTE
 *        # (POST /api/user/country/confirm as the user: every fixture user is unconfirmed, and
 *        # upload/apply routes refuse unconfirmed users). restore puts the row back.
 *   node scripts/canonical_cert/residue.mjs capture  --ledger A-run1   # add every new row/object since baseline
 *   node scripts/canonical_cert/residue.mjs record   --ledger A-run1 --table T --ids id1,id2   # e.g. a global row
 *   node scripts/canonical_cert/residue.mjs cleanup  --ledger A-run1 [--dry-run]   # capture + delete by PK + restore
 *   node scripts/canonical_cert/residue.mjs verify   --ledger A-run1   # exit 0 ONLY if every table matches baseline
 *   node scripts/canonical_cert/residue.mjs status   --ledger A-run1
 *
 * Ledger files live in .canonical-cert/ (gitignored). One ledger per certifier run.
 */
import { ResidueLedger, summarise } from './lib/residueLedger.mjs';
import { signIn, api, loadSession } from './lib/session.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const ledgerId = arg('--ledger');
if (!cmd || !ledgerId) { console.error('usage: residue.mjs <baseline|prepare|capture|record|cleanup|verify|status> --ledger <id> ...'); process.exit(1); }
const L = ResidueLedger.open(ledgerId);
const { serviceClient } = await import('./lib/env.mjs');

async function idsForEmails(emails) {
  const sb = await serviceClient();
  const out = [];
  for (let page = 1; page < 50 && out.length < emails.length; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) if (emails.includes(u.email)) out.push(u.id);
    if (data.users.length < 1000) break;
  }
  if (out.length !== emails.length) throw new Error(`resolved ${out.length} of ${emails.length} emails on DEV`);
  return out;
}

const print = (o) => console.log(JSON.stringify(o, null, 2));

switch (cmd) {
  case 'baseline': {
    const emails = String(arg('--emails') ?? '').split(',').filter(Boolean);
    const ids = await idsForEmails(emails);
    print(await L.baseline(ids, { force: rest.includes('--force') }));
    break;
  }
  case 'prepare': {
    const email = arg('--email'); const port = Number(arg('--port'));
    const [userId] = await idsForEmails([email]);
    if (!L.data.users.includes(userId)) throw new Error('user is not in this ledger baseline; run baseline first');
    const saved = await L.snapshotRows('user_profiles', `user_id=eq.${userId}&select=*`, ['user_id']);
    const sb = await serviceClient();
    const { data: prof } = await sb.from('user_profiles').select('country_of_residence,country_confirmed_at').eq('user_id', userId).single();
    if (prof.country_confirmed_at) { console.log(`already confirmed (${prof.country_of_residence}); profile row saved (${saved})`); break; }
    let haveSession = false;
    try { loadSession(email); haveSession = true; } catch { /* none yet */ }
    if (!haveSession) await signIn(email, { method: arg('--method') ?? 'mint' });
    const r = await api(email, 'POST', '/api/user/country/confirm', { port, json: { country_of_residence: prof.country_of_residence } });
    console.log(`profile rows saved: ${saved}; POST /api/user/country/confirm (${prof.country_of_residence}) -> HTTP ${r.status} ${r.text.slice(0, 160)}`);
    if (r.status >= 300) process.exitCode = 1;
    break;
  }
  case 'capture': print(await L.captureNew()); break;
  case 'touched': {
    // Pre-existing rows UPDATED since the baseline (invisible to verify's key diff). Exit 1 if any is unsaved.
    const t = await L.touchedSince();
    print({ since: t.since, touched: t.touched, unsaved: t.touched.filter((x) => !x.saved).length, uncoveredTables: t.uncovered.length });
    if (t.touched.some((x) => !x.saved)) process.exitCode = 1;
    break;
  }
  case 'record': {
    const ids = String(arg('--ids') ?? '').split(',').filter(Boolean);
    const pk = String(arg('--pk') ?? 'id').split(',');
    L.recordGlobal(arg('--table'), ids, pk, arg('--note') ?? 'global (no user_id)');
    console.log(`recorded ${ids.length} ${arg('--table')} rows`);
    break;
  }
  case 'cleanup': {
    if (rest.includes('--dry-run')) { print({ captured: await L.captureNew(), plan: await L.cleanup({ dryRun: true }), restoreRows: L.data.updated.length }); break; }
    const captured = await L.captureNew();
    const res = await L.cleanup();
    const restoreFailures = await L.restoreRows();
    print({ captured, deleted: res.deleted, blocked: res.blocked, storageFailures: res.storageFailures, restoreFailures });
    if (res.blocked.length || res.storageFailures.length || restoreFailures.length) process.exitCode = 1;
    break;
  }
  case 'verify': {
    const v = await L.verify();
    print({ ok: v.ok, tablesCompared: v.tablesCompared, updatedRowsChecked: v.updatedRowsChecked, rowDrift: v.rowDrift, diffs: v.diffs, globalsRemaining: v.globalsRemaining, before: v.before, after: v.after });
    if (!v.ok) process.exitCode = 1;
    break;
  }
  case 'status': print({ file: L.file, users: L.data.users, baseline: L.data.baseline ? summarise(L.data.baseline) : null, rowsRecorded: L.data.rows.length, storageRecorded: L.data.storage.length, updatedRowsSaved: L.data.updated.length, events: L.data.events.slice(-10) }); break;
  default: console.error(`unknown command ${cmd}`); process.exit(1);
}
