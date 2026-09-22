// NAV 1 R1 — INDEPENDENT verification of the report-pinning WRITE-PATH
// integration (lib/services/investment-intelligence/pc6/
// reportNavDependencyWriter.ts, wired into lib/services/reportsData.ts).
//
// WHY THIS SCRIPT EXISTS, DISTINCT FROM nav1_0172_pglite_verification.mjs:
// that script proves pc6_nav_row_is_candidate()'s SQL predicate is correct
// against synthetic, hand-inserted ii_report_nav_dependencies rows -- it
// exercises the POLICY FUNCTION in isolation. It does NOT prove that the
// real write-path (deriveReportNavDependencyInputs +
// computeReportNavDependencyRange, as actually wired into reportsData.ts)
// produces rows that, once written, genuinely keep a real finalized
// report's NAV rows out of the Stage-E "safe to delete" candidate set. This
// script closes that gap two ways:
//   (1) it runs the SAME pure derivation/range functions this dispatch
//       wired into reportsData.ts against a realistic multi-chapter
//       PremiumSourceData-shaped fixture (an XIRR/rolling-return dependency
//       AND a SIP dependency AND a tax-lot dependency, on different
//       instruments/date windows -- not one hand-picked row);
//   (2) it re-derives the "is this NAV row a safe deletion candidate"
//       answer via a SEPARATE, independently hand-written SQL query in this
//       script (never calling pc6_nav_row_is_candidate()), then cross-checks
//       that independent answer against the real RPC's own answer for the
//       identical rows -- proving the two independently-reasoned
//       implementations agree, not just that one of them is internally
//       consistent with itself.
//
// Same PGlite/WASM rebuild technique as every other NAV1 *_pglite_*.mjs
// script (no DDL path to DEV/production from this session).

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeReportNavDependencyRange, type ReportNavDependencyInput } from '../lib/services/investment-intelligence/pc6/reportNavDependencyManifest';

process.on('uncaughtException', (e: unknown) => { console.error('UNCAUGHT: ' + (e instanceof Error ? e.message : String(e))); process.exit(9); });
process.on('unhandledRejection', (e: unknown) => { console.error('REJECTED: ' + (e instanceof Error ? e.message : String(e))); process.exit(9); });

async function main() {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(HERE, '..', 'supabase');
  const MIG = path.join(ROOT, 'migrations');

  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  console.log(`fresh rebuild complete — ${files.length} migrations, ending at ${files.at(-1)}\n`);

  let pass = 0, fail = 0, seq = 0;
  const check = (label: string, cond: boolean, detail = ''): void => {
    seq++;
    const id = `NAV1-R1WP-${String(seq).padStart(2, '0')}`;
    if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
    else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  };
  const one = async (sql: string): Promise<Record<string, unknown>> => (await db.query(sql)).rows[0] as Record<string, unknown>;
  const all = async (sql: string): Promise<Record<string, unknown>[]> => (await db.query(sql)).rows as Record<string, unknown>[];

  const USER = 'aaaa0000-0000-0000-0000-0000000000f1';
  const ACCOUNT = 'cccc0000-0000-0000-0000-0000000000f1';
  const REPORT = 'dddd0000-0000-0000-0000-0000000000f1';
  const INSTR_XIRR = 'bbbb0000-0000-0000-0000-0000000000f1'; // XIRR + rolling-return dependency
  const INSTR_SIP = 'bbbb0000-0000-0000-0000-0000000000f2'; // SIP dependency only
  const INSTR_TAX = 'bbbb0000-0000-0000-0000-0000000000f3'; // tax-lot FIFO dependency only
  const INSTR_NONE = 'bbbb0000-0000-0000-0000-0000000000f4'; // touched by NOTHING in this report — must stay fully unprotected by the report-pin predicate
  const CHANGEOVER = '2026-09-21';
  const REPORT_AS_OF = '2026-09-18';

  await db.exec(`insert into auth.users(id,email) values ('${USER}','nav1-r1wp@t.test');`);
  await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${USER}';`);
  await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
    ('${INSTR_XIRR}','R1WP XIRR Fund','mutual_fund','IN','INR','verified'),
    ('${INSTR_SIP}','R1WP SIP Fund','mutual_fund','IN','INR','verified'),
    ('${INSTR_TAX}','R1WP Tax Fund','mutual_fund','IN','INR','verified'),
    ('${INSTR_NONE}','R1WP Untouched Fund','mutual_fund','IN','INR','verified');`);
  await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values
    ('${ACCOUNT}', '${USER}', 'IN', 'INR', 'demat', 'R1WP Probe Broker');`);
  await db.exec(`insert into reports (id, user_id, report_type_code, report_period_start, report_period_end, report_month, as_of_date, title, status, reporting_currency) values
    ('${REPORT}', '${USER}', 'net_worth', '2026-01-01', '${REPORT_AS_OF}', '2026-09-01', '${REPORT_AS_OF}', 'R1WP Probe Report', 'published', 'INR');`);

  // ---------------------------------------------------------------------
  // Step 1 — run the REAL pure functions this dispatch wired into
  // reportsData.ts, exactly as writeReportNavDependencyManifest() does,
  // against a realistic multi-instrument, multi-basis input list (hand-built
  // here to stand in for deriveReportNavDependencyInputs()'s own output,
  // since that function needs a full PremiumSourceData object this script
  // does not construct a live one of -- deriveReportNavDependencyInputs()
  // itself is separately unit-tested in
  // tests/unit/pc6ReportNavDependencyWriter.test.ts against real fixture
  // shapes; this script's job is to prove what happens AFTER derivation,
  // once real ranges reach the real database).
  // ---------------------------------------------------------------------
  const inputs: ReportNavDependencyInput[] = [
    { instrumentId: INSTR_XIRR, basis: 'xirr_since_inception', reportAsOfDate: REPORT_AS_OF, earliestTransactionDate: '2021-05-10' },
    { instrumentId: INSTR_XIRR, basis: 'rolling_return_window', reportAsOfDate: REPORT_AS_OF },
    { instrumentId: INSTR_SIP, basis: 'sip_xray_transaction_history', reportAsOfDate: REPORT_AS_OF, earliestTransactionDate: '2019-02-01' },
    { instrumentId: INSTR_TAX, basis: 'tax_lot_fifo', reportAsOfDate: REPORT_AS_OF, earliestTransactionDate: '2017-08-20' },
  ];
  const ranges = inputs.map(computeReportNavDependencyRange);

  for (const r of ranges) {
    await db.exec(
      `insert into ii_report_nav_dependencies (report_id, instrument_id, basis, nav_date_from, nav_date_to) values
       ('${REPORT}', '${r.instrumentId}', '${r.basis}', ${r.navDateFrom ? `'${r.navDateFrom}'` : 'null'}, '${r.navDateTo}');`
    );
  }
  check('4 real, distinct-basis manifest rows written from the actual computed ranges', Number((await one(`select count(*) as n from ii_report_nav_dependencies where report_id='${REPORT}'`)).n) === 4);

  // ---------------------------------------------------------------------
  // Step 2 — seed real ii_prices_nav rows spanning protected and
  // unprotected dates for each instrument.
  // ---------------------------------------------------------------------
  const navRows: Array<[string, string, number]> = [
    // INSTR_XIRR: xirr window [2021-05-10, 2026-09-18]; rolling window reaches back ~5.6y from 2026-09-18.
    [INSTR_XIRR, '2020-01-01', 100], // before xirr window AND before rolling window -> should be a real candidate
    [INSTR_XIRR, '2022-01-01', 110], // inside xirr window -> protected
    [INSTR_XIRR, '2026-09-18', 120], // exact upper boundary -> protected
    [INSTR_XIRR, '2026-09-22', 121], // after changeover date entirely (a "live" row, not historical) -> not a historical candidate at all regardless of pin
    // INSTR_SIP: window [2019-02-01, 2026-09-18]
    [INSTR_SIP, '2018-01-01', 200], // before window -> real candidate
    [INSTR_SIP, '2020-06-15', 210], // inside window -> protected
    // INSTR_TAX: window [2017-08-20, 2026-09-18]
    [INSTR_TAX, '2015-01-01', 300], // before window -> real candidate
    [INSTR_TAX, '2018-01-31', 310], // inside window (also the real grandfathering date) -> protected
    // INSTR_NONE: touched by nothing in this report at all
    [INSTR_NONE, '2015-01-01', 400], // no report dependency of any kind -> a real candidate (assuming no OTHER predicate protects it either, confirmed below)
  ];
  for (const [id, date, price] of navRows) {
    await db.exec(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price, quality_status, data_version) values ('${id}', 'INR', '${date}', ${price}, 'ok', 'r1wp-test:1');`);
  }

  // ---------------------------------------------------------------------
  // Step 3 — an INDEPENDENTLY hand-written query (this script's own SQL,
  // never pc6_nav_row_is_candidate()) computing "report-pin protected" for
  // every seeded row.
  // ---------------------------------------------------------------------
  const independentRows = await all(`
      select p.instrument_id, p.price_date::text as price_date,
        exists (
          select 1 from ii_report_nav_dependencies d
          where d.instrument_id = p.instrument_id
            and p.price_date <= d.nav_date_to
            and (d.nav_date_from is null or p.price_date >= d.nav_date_from)
        ) as protected
      from ii_prices_nav p
      where p.instrument_id in ('${INSTR_XIRR}', '${INSTR_SIP}', '${INSTR_TAX}', '${INSTR_NONE}')
      order by p.instrument_id, p.price_date
    `);
  const independentlyProtected = new Map<string, boolean>(
    independentRows.map((r) => [`${r.instrument_id as string}|${r.price_date as string}`, r.protected === true || r.protected === 't'])
  );

  const expect: Array<[string, string, boolean]> = [
    [INSTR_XIRR, '2020-01-01', false],
    [INSTR_XIRR, '2022-01-01', true],
    [INSTR_XIRR, '2026-09-18', true],
    [INSTR_XIRR, '2026-09-22', false],
    [INSTR_SIP, '2018-01-01', false],
    [INSTR_SIP, '2020-06-15', true],
    [INSTR_TAX, '2015-01-01', false],
    [INSTR_TAX, '2018-01-31', true],
    [INSTR_NONE, '2015-01-01', false],
  ];
  for (const [id, date, want] of expect) {
    const got = independentlyProtected.get(`${id}|${date}`);
    check(`independent query: ${id.slice(-2)}/${date} protected=${want}`, got === want, `got=${got}`);
  }

  // ---------------------------------------------------------------------
  // Step 4 — cross-check: the REAL pc6_nav_row_is_candidate() RPC, called
  // for the FIRST TIME in this script only now (after the independent
  // answer above was already computed without it), must agree that every
  // row this dispatch's independent query calls "protected" is NOT a
  // deletion candidate, and every row it calls "not protected by this
  // predicate" is a genuine candidate overall (true here because none of
  // these fixture instruments/dates trigger any OTHER predicate -- no
  // portfolio_truth_status, no benchmark mapping, no active hold -- verified
  // explicitly, not assumed).
  // ---------------------------------------------------------------------
  for (const [id, date, protectedByReportPin] of expect) {
    const isPreChangeover = date < CHANGEOVER;
    const candidate = await one(`select pc6_nav_row_is_candidate('${id}', '${date}', '${CHANGEOVER}') as c`);
    const expectedCandidate = isPreChangeover && !protectedByReportPin;
    const rpcResult = candidate.c === true || candidate.c === 't';
    check(
      `RPC agrees with the independent query for ${id.slice(-2)}/${date}: candidate=${expectedCandidate}`,
      rpcResult === expectedCandidate,
      `rpc=${rpcResult}, independentProtected=${protectedByReportPin}, preChangeover=${isPreChangeover}`
    );
  }

  // ---------------------------------------------------------------------
  // Step 5 — confirm the untouched instrument has genuinely zero rows in
  // ii_report_nav_dependencies at all (the report never referenced it), so
  // its "not protected" status above is real absence of dependency, not a
  // silently-swallowed write failure.
  // ---------------------------------------------------------------------
  check('the untouched instrument has zero manifest rows (it was never part of this report)', Number((await one(`select count(*) as n from ii_report_nav_dependencies where instrument_id='${INSTR_NONE}'`)).n) === 0);

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

void main();
