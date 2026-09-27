// NAV 1 completion (2026-09-27) -- READ-ONLY scheduled-proof checks for production.
//
// Prints a PASS / FAIL / INFO table for one genuine scheduled window, so the
// proof is judged by fixed criteria written BEFORE the window, not after.
//
// Production is read with GET only; the host is asserted before every request;
// there is no code path that can send any other method. AMFI: at most two
// public GETs (daily mode only).
//
// Modes:
//   daily <windowDateUtc> [outFile]
//       The 0205 daily window 03:30-04:30 UTC on that date (cron Tue-Sat).
//       First run: 2026-09-29 (Tuesday), any time after 04:45 UTC.
//   scheme-master <windowDateUtc> <heldIdentityBaseline.json> [outFile]
//       The 0205 scheme-master window 03:00-03:28 UTC on that date. 0205's
//       cron is '0-28/2 3 * * 2' = TUESDAY. The first window is therefore
//       Tuesday 2026-09-29 -- NOT "Tue 30 Sep" as earlier reports said
//       (30 Sep 2026 is a Wednesday). Run after 03:40 UTC (S10 needs the
//       04:00 hydration tick, so run after 04:05 UTC for a full table).
//   held-identity-baseline <outFile>
//       Snapshot of the user-held instruments' scheme identity (AMFI code,
//       ISINs, fund house, lifecycle) to compare after a scheme-master run.
//   hydration <sinceIsoUtc> [expectedHeld] [outFile]
//       Every scheduled hydration batch since <since> (e.g. the deploy time of
//       the monitoring fix), and the job-control row they should have moved.
//
// Usage: node scripts/nav1_scheduled_proof_check.mjs <mode> ...

import fs from 'node:fs';

const HOST = 'twwpnltizhtjxhamyoxt.supabase.co';
const env = Object.fromEntries(fs.readFileSync('D:/FHIP/.env.local', 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]));
const BASE = env.PRODUCTION_SUPABASE_URL;
const KEY = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || new URL(BASE).host !== HOST) { console.error('REFUSING: PRODUCTION_SUPABASE_URL is not the production project'); process.exit(3); }

let gets = 0;
async function get(q, prefer) {
  if (new URL(BASE).host !== HOST) throw new Error('HOST ASSERTION FAILED');
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  if (prefer) headers.Prefer = prefer;
  gets++;
  const r = await fetch(`${BASE}/rest/v1/${q}`, { method: 'GET', headers });
  if (r.status >= 400) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return { body: await r.json(), range: r.headers.get('content-range') };
}
async function pageAll(q, order) {
  const out = [];
  for (let o = 0; ; o += 1000) {
    const { body } = await get(`${q}&order=${order}&limit=1000&offset=${o}`);
    out.push(...body);
    if (body.length < 1000) return out;
  }
}
const count = async (t, f) => Number((await get(`${t}?select=*&${f}&limit=1`, 'count=exact')).range.split('/')[1]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const amfiLabel = (iso) => `${iso.slice(8, 10)}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const secs = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000;

const rows = [];
const check = (id, criterion, pass, observed) => rows.push({ id, criterion, result: pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL', observed });
function printTable(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
  const w = Math.max(...rows.map((r) => r.criterion.length), 20);
  for (const r of rows) console.log(`${r.id.padEnd(4)} ${r.result.padEnd(4)}  ${r.criterion.padEnd(w)}  ${typeof r.observed === 'string' ? r.observed : JSON.stringify(r.observed)}`);
  const fails = rows.filter((r) => r.result === 'FAIL').length;
  console.log(`\n${rows.filter((r) => r.result === 'PASS').length} PASS, ${fails} FAIL, ${rows.filter((r) => r.result === 'INFO').length} INFO -- ${fails === 0 ? 'OVERALL PASS' : 'OVERALL FAIL'} (${gets} GET requests, 0 writes)`);
  return fails;
}
async function heldInstrumentIds() {
  const r = await get('rpc/pc6_user_held_instrument_ids?select=instrument_id&order=instrument_id');
  return r.body.map((x) => x.instrument_id);
}

const [mode, ...args] = process.argv.slice(2);

if (mode === 'daily') {
  const [day, outFile] = args;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) { console.error('usage: daily <windowDateUtc> [outFile]'); process.exit(2); }
  const winStart = `${day}T03:30:00Z`, winEnd = `${day}T04:30:00Z`;
  // The window collects the previous calendar day's NAV (Tue collects Mon, ..., Sat collects Fri).
  const navDate = addDays(day, -1);
  if (Date.now() < Date.parse(winEnd) + 10 * 60000) { console.error(`too early: run after ${new Date(Date.parse(winEnd) + 10 * 60000).toISOString()}`); process.exit(4); }
  const batches = (await get(`ii_reference_import_batches?select=id,status,started_at,finished_at,rows_inserted,rows_unchanged,rows_superseded,rows_rejected,error_code,source_sha256,notes&batch_kind=eq.daily_nav&started_at=gte.${winStart}&started_at=lt.${winEnd}&order=started_at.asc`)).body;
  const first = batches[0];
  check('D1', 'first daily_nav batch opened within 90 s of the 03:30 tick (cron fired, secret + route auth OK)', !!first && secs(winStart, first.started_at) <= 90, first ? `${first.started_at} (+${secs(winStart, first.started_at)} s)` : 'no batch in window');
  check('D2', 'no daily_nav batch left running', batches.every((b) => b.status !== 'running'), batches.filter((b) => b.status === 'running').map((b) => b.id));
  const succeeded = batches.filter((b) => b.status === 'succeeded');
  const badFailures = batches.filter((b) => b.status === 'failed' && b.error_code !== 'PARTIAL_BATCH_CONTINUING');
  check('D3', 'at least one batch succeeded (remaining 0)', succeeded.length > 0 && succeeded.some((b) => (b.notes?.remaining?.inserts ?? 0) === 0 && (b.notes?.remaining?.corrections ?? 0) === 0), `${succeeded.length} succeeded`);
  check('D4', 'every failed batch is a planned continuation (PARTIAL_BATCH_CONTINUING); none STALE/BUDGET/BATCH_FAILED', badFailures.length === 0, badFailures.map((b) => `${b.started_at} ${b.error_code}`));
  check('D5', 'no duplicate-key / correction failure', !batches.some((b) => /23505|duplicate/i.test(`${b.error_code ?? ''}`)), `superseded total ${batches.reduce((a, b) => a + (b.rows_superseded ?? 0), 0)}`);
  const jc = (await get('ii_reference_job_control?select=last_success_at,last_success_batch_id,consecutive_failures&job_key=eq.pc6_amfi_daily_nav')).body[0];
  const jcInWindow = jc?.last_success_at && Date.parse(jc.last_success_at) >= Date.parse(winStart) && Date.parse(jc.last_success_at) < Date.parse(winEnd) + 5 * 60000;
  check('D6', 'job control: last_success_at advanced into the window and names a succeeded batch of the window; streak 0', !!jcInWindow && succeeded.some((b) => b.id === jc.last_success_batch_id) && jc.consecutive_failures === 0, jc);
  // Idempotency: after the first success, a later batch exists only for a CHANGED source file, and succeeds.
  const firstSuccessIdx = batches.findIndex((b) => b.status === 'succeeded');
  const after = firstSuccessIdx >= 0 ? batches.slice(firstSuccessIdx + 1) : [];
  const shaRepeats = after.filter((b, i) => b.source_sha256 && b.source_sha256 === (i === 0 ? batches[firstSuccessIdx] : after[i - 1]).source_sha256);
  check('D7', 'idempotent re-runs: after success, calls on an unchanged file open no batch; later batches are new files and succeed', shaRepeats.length === 0 && after.every((b) => b.status === 'succeeded'), `${after.length} later batch(es): ${after.map((b) => `${b.started_at.slice(11, 19)} +${b.rows_inserted}`).join(', ')}`);
  // Coverage for the NAV date vs the recent full weekdays.
  const cov = {};
  for (let i = 0; i < 10; i++) { const d = addDays(navDate, -i); cov[d] = await count('ii_prices_nav', `price_date=eq.${d}`); }
  const refDays = Object.keys(cov).filter((d) => d !== navDate && dow(d) >= 1 && dow(d) <= 5).slice(0, 5);
  const ref = refDays.map((d) => cov[d]).sort((a, b) => a - b)[Math.floor(refDays.length / 2)];
  check('D8', `broad coverage for NAV date ${navDate}: >= 8,000 rows and >= 95% of the median of the last full weekdays`, cov[navDate] >= 8000 && cov[navDate] >= 0.95 * ref, `${cov[navDate]} vs median ${ref} (${refDays.join(',')})`);
  check('D9', 'no downward drift: no earlier weekday count fell below its value one run ago (see baseline)', null, cov);
  const held = await heldInstrumentIds();
  let heldWith = 0;
  for (const id of held) if ((await count('ii_prices_nav', `instrument_id=eq.${id}&price_date=eq.${navDate}`)) === 1) heldWith++;
  check('D10', `every user-held fund has exactly one NAV for ${navDate}`, heldWith === held.length, `${heldWith}/${held.length}`);
  const navRows = await pageAll(`ii_prices_nav?select=id,instrument_id,price,data_version,source_timestamp&price_date=eq.${navDate}`, 'id');
  const dup = navRows.length - new Set(navRows.map((r) => r.instrument_id)).size;
  const nonPos = navRows.filter((r) => !(Number(r.price) > 0)).length;
  const prov = navRows.reduce((a, r) => { const k = String(r.data_version ?? 'null').split(':')[0]; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  // (D11 is judged after the AMFI read below: AMFI itself publishes 0.0000 for
  // segregated portfolios, so a stored zero is correct exactly when AMFI's is.)
  // Independent AMFI comparison: NAVAll.txt now.
  const res = await fetch('https://portal.amfiindia.com/spages/NAVAll.txt', { headers: { 'User-Agent': 'FHIP-NAV1-scheduled-proof/1.0' }, signal: AbortSignal.timeout(60000) });
  const text = (await res.text()).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const hdr = lines.find((l) => l.startsWith('Scheme Code;')).split(';').map((h) => h.trim());
  const iC = hdr.indexOf('Scheme Code'), iN = hdr.indexOf('Net Asset Value'), iD = hdr.indexOf('Date');
  const amfi = new Map();
  for (const l of lines) {
    const f = l.split(';');
    if (f.length > iD && /^\d+$/.test(f[iC]?.trim() ?? '') && f[iD].trim() === amfiLabel(navDate) && Number.isFinite(Number(f[iN])) && f[iN].trim() !== '') amfi.set(f[iC].trim(), Number(f[iN]));
  }
  const ids = await pageAll('ii_instrument_identifiers?select=id,instrument_id,identifier_value&identifier_scheme=eq.amfi_scheme_code&is_active=eq.true', 'id');
  const codeOf = new Map(ids.map((r) => [r.instrument_id, r.identifier_value]));
  let compared = 0, exact = 0;
  const onFile = new Set();
  for (const r of navRows) {
    const c = codeOf.get(r.instrument_id);
    if (!c) continue;
    onFile.add(c);
    if (!amfi.has(c)) continue;
    compared++;
    if (amfi.get(c) === Number(r.price)) exact++;
  }
  const zeroNotAmfiZero = navRows.filter((r) => !(Number(r.price) > 0) && !(Number(r.price) === 0 && amfi.get(codeOf.get(r.instrument_id)) === 0)).length;
  check('D11', 'no duplicate instrument/date; every row has provider + source timestamp; a non-positive NAV only where AMFI itself publishes 0 (segregated portfolios)', dup === 0 && zeroNotAmfiZero === 0 && navRows.every((r) => r.data_version && r.source_timestamp), { dup, zero_nav_rows: nonPos, zero_nav_rows_not_matching_amfi_zero: zeroNotAmfiZero, provenance: prov });
  check('D12', `independent AMFI NAVAll.txt: every comparable ${navDate} value identical`, compared > 0 && exact === compared, `${exact}/${compared} exact (AMFI now carries ${amfi.size} schemes dated ${amfiLabel(navDate)}; a value AMFI later corrected shows here as a mismatch -- inspect before failing the run)`);
  const knownCodes = new Set(ids.map((r) => r.identifier_value));
  const missingCodes = [...amfi.keys()].filter((c) => !onFile.has(c));
  const unmapped = missingCodes.filter((c) => !knownCodes.has(c)).length;
  // Mapped-but-absent is the real gap (a NAV the job could have stored); unmapped
  // schemes are the ingest's known rejections (no instrument yet -- the scheme
  // master adds them), and late publications arrive after the window closes.
  check('D13', 'AMFI schemes for the date that map to an instrument but have no stored row (<= 1%)', missingCodes.length - unmapped <= Math.max(20, 0.01 * amfi.size), { missing_total: missingCodes.length, unmapped_no_instrument: unmapped, mapped_but_absent: missingCodes.length - unmapped, sample_mapped_absent: missingCodes.filter((c) => knownCodes.has(c)).slice(0, 8) });
  const sun = await count('ii_reference_import_batches', `batch_kind=eq.daily_nav&started_at=gte.${addDays(day, -2)}T00:00:00Z&started_at=lt.${day}T00:00:00Z`);
  check('D14', 'cron calendar Tue-Sat: no daily_nav batch on the preceding Sunday/Monday (UTC)', dow(day) !== 2 || sun === 0, `${sun} batch(es) on ${addDays(day, -2)}..${addDays(day, -1)}`);
  const fails = printTable(`NAV1 daily NAV scheduled-window proof -- window ${winStart}..${winEnd}, NAV date ${navDate}`);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ mode, day, navDate, checkedAt: new Date().toISOString(), rows, batches: batches.map(({ notes, ...b }) => ({ ...b, source_sha256: b.source_sha256 ? `${String(b.source_sha256).slice(0, 12)}...` : null, remaining: notes?.remaining ?? null })) }, null, 1));
  process.exitCode = fails ? 1 : 0;
} else if (mode === 'held-identity-baseline') {
  const [outFile] = args;
  if (!outFile) { console.error('usage: held-identity-baseline <outFile>'); process.exit(2); }
  const held = await heldInstrumentIds();
  const sm = (await get(`ii_scheme_master?select=instrument_id,amfi_scheme_code,isin_growth_or_payout,isin_reinvestment,amc_name,lifecycle_status,merged_into_instrument_id,record_checksum&instrument_id=in.(${held.join(',')})&order=instrument_id`)).body;
  const idf = (await get(`ii_instrument_identifiers?select=instrument_id,identifier_scheme,identifier_value,is_active&instrument_id=in.(${held.join(',')})&order=instrument_id,identifier_scheme,identifier_value`)).body;
  const totals = { scheme_master: await count('ii_scheme_master', 'id=not.is.null'), instruments: await count('ii_instruments', 'id=not.is.null') };
  fs.writeFileSync(outFile, JSON.stringify({ takenAt: new Date().toISOString(), held, scheme_master: sm, identifiers: idf, totals }, null, 1));
  console.log(`baseline written: ${held.length} held instruments, ${sm.length} scheme-master rows, ${idf.length} identifiers; totals ${JSON.stringify(totals)}`);
} else if (mode === 'scheme-master') {
  const [day, baselineFile, outFile] = args;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !baselineFile) { console.error('usage: scheme-master <windowDateUtc> <heldIdentityBaseline.json> [outFile]'); process.exit(2); }
  const winStart = `${day}T03:00:00Z`, winEnd = `${day}T03:30:00Z`;
  if (Date.now() < Date.parse(winEnd) + 10 * 60000) { console.error(`too early: run after ${new Date(Date.parse(winEnd) + 10 * 60000).toISOString()}`); process.exit(4); }
  const base = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const batches = (await get(`ii_reference_import_batches?select=id,status,started_at,finished_at,rows_read,rows_accepted,rows_inserted,rows_unchanged,rows_superseded,rows_rejected,error_code,notes&batch_kind=eq.scheme_master&started_at=gte.${winStart}&started_at=lt.${winEnd}&order=started_at.asc`)).body;
  const first = batches[0];
  check('S1', 'first scheme_master batch opened within 90 s of the 03:00 tick', !!first && secs(winStart, first.started_at) <= 90, first ? `${first.started_at} (+${secs(winStart, first.started_at)} s)` : 'no batch in window');
  check('S2', 'no scheme_master batch left running', batches.every((b) => b.status !== 'running'), batches.filter((b) => b.status === 'running').length);
  const ok = batches.filter((b) => b.status === 'succeeded');
  const bad = batches.filter((b) => b.status === 'failed' && b.error_code !== 'PARTIAL_BATCH_CONTINUING');
  check('S3', 'a batch succeeded; every failure is a planned continuation', ok.length > 0 && bad.length === 0, { succeeded: ok.length, other_failures: bad.map((b) => `${b.started_at} ${b.error_code}`) });
  const jc = (await get('ii_reference_job_control?select=last_success_at,last_success_batch_id,consecutive_failures&job_key=eq.pc6_amfi_scheme_master')).body[0];
  check('S4', 'job control: last_success_at advanced past 2026-09-20 into the window, names a succeeded batch', !!jc?.last_success_at && Date.parse(jc.last_success_at) >= Date.parse(winStart) && ok.some((b) => b.id === jc.last_success_batch_id), jc);
  const totals = { scheme_master: await count('ii_scheme_master', 'id=not.is.null'), instruments: await count('ii_instruments', 'id=not.is.null') };
  check('S5', 'no scheme-master or instrument rows lost (totals >= baseline)', totals.scheme_master >= base.totals.scheme_master && totals.instruments >= base.totals.instruments, { baseline: base.totals, now: totals });
  const lc = {};
  for (const s of ['active', 'inactive', 'closed', 'merged', 'suspended']) lc[s] = await count('ii_scheme_master', `lifecycle_status=eq.${s}`);
  check('S6', 'lifecycle transitions recorded (known F-7: lifecycle_status is never maintained -- all rows active)', null, lc);
  const sm = (await get(`ii_scheme_master?select=instrument_id,amfi_scheme_code,isin_growth_or_payout,isin_reinvestment,amc_name,lifecycle_status,merged_into_instrument_id,record_checksum&instrument_id=in.(${base.held.join(',')})&order=instrument_id`)).body;
  const key = (r) => `${r.instrument_id}|${r.amfi_scheme_code}|${r.isin_growth_or_payout}|${r.isin_reinvestment}|${r.merged_into_instrument_id}`;
  const was = new Set(base.scheme_master.map(key));
  const changed = sm.filter((r) => !was.has(key(r)));
  check('S7', 'no user-held instrument orphaned or remapped (AMFI code, ISINs, merge link unchanged)', sm.length === base.scheme_master.length && changed.length === 0, { held: base.held.length, rows_now: sm.length, changed: changed.length });
  const idf = (await get(`ii_instrument_identifiers?select=instrument_id,identifier_scheme,identifier_value,is_active&instrument_id=in.(${base.held.join(',')})&order=instrument_id,identifier_scheme,identifier_value`)).body;
  check('S8', 'user-held identifiers unchanged (daily + hydration resolve the same schemes)', JSON.stringify(idf) === JSON.stringify(base.identifiers), `${idf.length} vs ${base.identifiers.length}`);
  const amcChanged = sm.filter((r) => { const b = base.scheme_master.find((x) => x.instrument_id === r.instrument_id); return b && b.amc_name !== r.amc_name; }).length;
  check('S9', 'fund-house mapping of user-held schemes unchanged (hydration resolves the fund house by amc_name)', amcChanged === 0, amcChanged);
  const hyd = (await get(`ii_reference_import_batches?select=started_at,status,notes&batch_kind=eq.nav_hydration&started_at=gte.${winEnd}&order=started_at.asc&limit=2`)).body;
  check('S10', 'the next hydration tick still examines every held fund and finds them covered', hyd.length > 0 && hyd[0].status === 'succeeded' && hyd[0].notes?.telemetry?.examined === base.held.length, hyd[0] ? { status: hyd[0].status, telemetry: hyd[0].notes?.telemetry } : 'no hydration batch after the window yet');
  check('S11', 'scheme-master batch counts', null, batches.map((b) => ({ at: b.started_at.slice(11, 19), status: b.status, read: b.rows_read, accepted: b.rows_accepted, inserted: b.rows_inserted, unchanged: b.rows_unchanged, superseded: b.rows_superseded, rejected: b.rows_rejected, code: b.error_code })));
  const fails = printTable(`NAV1 scheme-master scheduled-window proof -- window ${winStart}..${winEnd}`);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ mode, day, checkedAt: new Date().toISOString(), rows }, null, 1));
  process.exitCode = fails ? 1 : 0;
} else if (mode === 'hydration') {
  const [since, expectedHeldArg, outFile] = args;
  if (!since) { console.error('usage: hydration <sinceIsoUtc> [expectedHeld] [outFile]'); process.exit(2); }
  const held = await heldInstrumentIds();
  const expectedHeld = expectedHeldArg ? Number(expectedHeldArg) : held.length;
  const b = await pageAll(`ii_reference_import_batches?select=id,status,started_at,finished_at,rows_read,rows_inserted,rows_rejected,error_code,notes&batch_kind=eq.nav_hydration&started_at=gte.${since}`, 'started_at.asc,id.asc');
  check('H1', 'scheduled hydration batches present since <since>, each on a :00/:30 tick (+-90 s)', b.length > 0 && b.every((x) => { const d = new Date(x.started_at); const s = (d.getUTCMinutes() % 30) * 60 + d.getUTCSeconds(); return s <= 90; }), `${b.length} batch(es)`);
  const gaps = b.slice(1).map((x, i) => secs(b[i].started_at, x.started_at)).filter((s) => s > 31 * 60);
  check('H2', 'no missed tick (consecutive batches <= 31 min apart)', gaps.length === 0, gaps.length ? `${gaps.length} gap(s), max ${Math.max(...gaps)} s` : 'none');
  let overlap = 0;
  for (let i = 1; i < b.length; i++) if (b[i - 1].finished_at && Date.parse(b[i].started_at) < Date.parse(b[i - 1].finished_at)) overlap++;
  const running = b.filter((x) => x.status === 'running' && secs(x.started_at, new Date().toISOString()) > 30 * 60).length;
  check('H3', 'no overlapping runs; none left running > 30 min', overlap === 0 && running === 0, { overlap, stale_running: running });
  check('H4', 'every batch carries telemetry with fair ordering from the 0199 ledger', b.every((x) => x.notes?.telemetry?.ordering === 'least_recently_attempted' && x.notes?.telemetry?.attemptLedgerError === null), b.filter((x) => x.notes?.telemetry?.ordering !== 'least_recently_attempted').length + ' without');
  check('H5', `every run examined every held fund (${expectedHeld}) and listed each in perInstrument`, b.every((x) => x.notes?.telemetry?.examined === expectedHeld && (x.notes?.perInstrument ?? []).length === expectedHeld), [...new Set(b.map((x) => `${x.notes?.telemetry?.examined}/${(x.notes?.perInstrument ?? []).length}`))]);
  const outcomes = b.reduce((a, x) => { const k = `${x.status}${x.error_code ? `:${x.error_code}` : ''}`; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  check('H6', 'outcome mix (succeeded / partial codes / failed)', null, outcomes);
  const jc = (await get('ii_reference_job_control?select=last_success_at,last_success_batch_id,last_failure_at,consecutive_failures&job_key=eq.pc6_selective_historical_hydration')).body[0];
  const lastOk = [...b].reverse().find((x) => x.status === 'succeeded' && !x.error_code);
  check('H7', 'MONITORING: last_success_at = finish of the latest clean success, and names that batch', !!lastOk && !!jc.last_success_at && Date.parse(jc.last_success_at) === Date.parse(lastOk.finished_at) && jc.last_success_batch_id === lastOk.id, { job_control: jc, latest_clean_success: lastOk ? { id: lastOk.id, finished_at: lastOk.finished_at } : null });
  const lastFail = [...b].reverse().find((x) => x.status === 'failed');
  let trailing = 0;
  for (const x of [...b].reverse()) { if (x.status === 'failed') trailing++; else if (x.status === 'succeeded' && !x.error_code) break; }
  check('H8', 'MONITORING: failures are visible (last_failure_at covers the latest failed batch; streak = trailing failures)', lastFail ? !!jc.last_failure_at && Date.parse(jc.last_failure_at) >= Date.parse(lastFail.started_at) && jc.consecutive_failures === trailing : jc.consecutive_failures === 0, { latest_failed: lastFail?.started_at ?? null, trailing_failures: trailing, consecutive_failures: jc.consecutive_failures });
  const ledger = await count('ii_nav_hydration_attempts', 'instrument_id=not.is.null');
  check('H9', 'attempt ledger rows (0 is correct while every fund is covered: no fetch was attempted)', null, ledger);
  const fails = printTable(`NAV1 hydration monitoring proof -- batches since ${since}`);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ mode, since, checkedAt: new Date().toISOString(), rows }, null, 1));
  process.exitCode = fails ? 1 : 0;
} else {
  console.error('mode must be one of: daily | scheme-master | held-identity-baseline | hydration');
  process.exit(2);
}
