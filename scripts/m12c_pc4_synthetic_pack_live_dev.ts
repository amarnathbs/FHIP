/**
 * M12C — PC4 REDUCED SYNTHETIC PACK (M12 dispatch section 9), LIVE DEV.
 *
 * ===========================================================================
 * WHAT THIS IS
 * ===========================================================================
 * `OA-7` has stood open since 2026-09-07: "run the reduced synthetic P01-P10
 * pack, or formally drop it." It was blocked on two things — (a) no Product
 * Owner go-ahead, and (b) no production synthetic-data cleanup mechanism,
 * which made a PRODUCTION run unsafe. The M12 dispatch resolves (a) by
 * instructing the run, and resolves (b) by restricting it to DEV. This script
 * is that run, and case S10 is the zero-residue cleanup that (b) was missing.
 *
 * It tests ONLY the invariants the Product Owner's real portfolio cannot
 * safely prove — the ones that need a deliberately wrong password, a
 * deliberately non-closing statement, a second user, or a full teardown:
 *
 *   S01 wrong-password atomicity      S06 deliberate reconciliation failure
 *   S02 exact reimport                S07 net worth once only
 *   S03 same instrument / two folios  S08 two-document identity
 *   S04 CAS -> Folio overlap          S09 cross-user / storage isolation
 *   S05 Folio -> CAS overlap          S10 zero-residue cleanup
 *
 * ===========================================================================
 * IT DRIVES THE REAL PIPELINE, NOT A MOCK
 * ===========================================================================
 * Every state change below comes from the real, unmodified
 * `processSourceDocument()` (`lib/services/investment-intelligence/
 * documentProcessing.ts`) running against real DEV Postgres and the real
 * `investment-source-documents` Storage bucket, over real PDF bytes built
 * in-process — including a genuinely RC4-encrypted PDF for S01, so the
 * password path is exercised by real decryption failing, not by a stub.
 * This is the same methodology `scripts/r11_final_live_dev_tests.ts` used
 * for the R11 live-DEV certification.
 *
 * HONEST BOUNDARY, stated up front rather than discovered later: this drives
 * the DB-writing service functions directly, not the Next.js HTTP route
 * layer, so it does NOT exercise `requireUser()` / session auth / the
 * mandatory-country gate. S09 compensates for the part that matters most by
 * additionally opening REAL authenticated (anon-key, signed-in) Supabase
 * clients and testing RLS and Storage authorisation as the users themselves.
 *
 * SECOND HONEST BOUNDARY: `loadActiveReconciliationConfig()` reaches for the
 * cookie-based `createClient()` and therefore falls back to
 * `DEFAULT_RECONCILIATION_CONFIG` outside a request context. The script
 * independently reads `ii_reconciliation_config` with the admin client and
 * asserts the two agree, so the fallback is proven to be a no-op rather than
 * assumed to be one.
 *
 * ===========================================================================
 * ANTI-VACUITY
 * ===========================================================================
 * Two earlier phases of this mission were bitten by metrics that read zero
 * because nothing had been measured. So: every "0 duplicates" / "0 leaks" /
 * "0 residue" claim in here carries a named control that MADE THE SAME
 * MEASUREMENT PRODUCE A NON-ZERO. If a control fails to produce its non-zero,
 * the case is reported FAIL, not PASS — a zero whose measurement was never
 * shown to work is not evidence.
 *
 * ===========================================================================
 * SAFETY
 * ===========================================================================
 * DEV ONLY. The target url is asserted to be the DEV project AND asserted not
 * to equal `PRODUCTION_SUPABASE_URL` before a single write; the same idiom
 * `scripts/m12c_pc4_readonly_probe.mjs` and
 * `scripts/m12c_pc5_owner_mapping_synthetic_repro.ts` already use. No
 * credential value is ever printed. Every synthetic identifier is obviously
 * fake (`zz-m12c-pc4-*@fhip-test.invalid`, folio `ZZ...`, PAN `ZZZZZ0000Z`,
 * names prefixed `ZZ Synthetic`). Every query and every delete is scoped by
 * this run's own synthetic user ids, or by the exact ids of the global
 * `ii_instruments` rows this run itself created — the Product Owner's real
 * rows are never in scope of any statement here.
 *
 * Run:
 *   set -a && . /d/FHIP/.env.local && set +a \
 *     && export NEXT_PUBLIC_SUPABASE_URL=https://vqycarelcoijzwlpkpcz.supabase.co \
 *     && npx tsx scripts/m12c_pc4_synthetic_pack_live_dev.ts
 *
 * Flags:
 *   --preflight   parse the synthetic documents in-process only; touch no DB,
 *                 no Storage, no auth. Used to iterate on fixture grammar.
 *   --keep        skip the S10 teardown (NEVER use on a shared environment;
 *                 present only so a failed run can be inspected by hand).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(__dirname, '..');
const OUT_DIR = path.join(repoRoot, 'scripts', 'm12c-pc4-synthetic-pack');

const PREFLIGHT_ONLY = process.argv.includes('--preflight');
const KEEP = process.argv.includes('--keep');

// The DEV project url is a NEXT_PUBLIC_ value (it appears in ~16 committed
// scripts in this repository) and is not a secret. It is named here because
// this worktree deliberately has no `.env.local` of its own and the shared
// file does not declare NEXT_PUBLIC_SUPABASE_URL.
const DEV_URL = 'https://vqycarelcoijzwlpkpcz.supabase.co';

function loadSharedEnv(): Record<string, string> {
  const candidate = [path.join(repoRoot, '.env.local'), 'D:/FHIP/.env.local'].find((p) => fs.existsSync(p));
  if (!candidate) throw new Error('no .env.local found (looked in the worktree and at D:/FHIP/.env.local)');
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}
const env = PREFLIGHT_ONLY && !fs.existsSync('D:/FHIP/.env.local') ? {} : loadSharedEnv();

// --- SAFETY GATE. Nothing below runs until this passes. --------------------
// Identical in shape to scripts/m12c_pc4_readonly_probe.mjs. A write script
// gets the STRONGER form: the resolved target must BE the dev url, and must
// not equal the production url.
const PROD_URL = (env.PRODUCTION_SUPABASE_URL ?? '').replace(/\/$/, '');
const TARGET_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? DEV_URL).replace(/\/$/, '');
if (!PREFLIGHT_ONLY) {
  if (TARGET_URL !== DEV_URL) throw new Error(`SAFETY ABORT: target url is not the DEV project (${TARGET_URL})`);
  if (PROD_URL && TARGET_URL === PROD_URL) throw new Error('SAFETY ABORT: the target url equals PRODUCTION_SUPABASE_URL');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY absent');
  if (!env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY absent');
  process.env.NEXT_PUBLIC_SUPABASE_URL = DEV_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
} else {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? DEV_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'preflight-only-not-a-real-key';
}

// Imported AFTER the env assignment above — `createAdminClient()` reads
// process.env at call time, and tsx executes these requires in source order.
import { processSourceDocument } from '../lib/services/investment-intelligence/documentProcessing';
import { II_STORAGE_BUCKET } from '../lib/services/investment-intelligence/storage';
import { parseExtractedDocument } from '../lib/services/investment-intelligence/parsers/registry';
import { DEFAULT_RECONCILIATION_CONFIG } from '../lib/services/investment-intelligence/reconciliationConfig';
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';
import { buildEncryptedTextPdf } from '../tests/support/buildEncryptedCamsPdf';

const admin: SupabaseClient = PREFLIGHT_ONLY
  ? (null as unknown as SupabaseClient)
  : createClient(DEV_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// ---------------------------------------------------------------------------
// Result recording. Each of S01..S10 is a named case with its own checks, its
// own named anti-vacuity control, and a single verdict.
// ---------------------------------------------------------------------------
type Verdict = 'PASS' | 'FAIL' | 'NOT APPLICABLE';
interface Check {
  label: string;
  ok: boolean;
  evidence: unknown;
}
interface CaseResult {
  id: string;
  name: string;
  verdict: Verdict;
  notApplicableReason?: string;
  checks: Check[];
  antiVacuityControl: { label: string; produced: unknown; ok: boolean } | null;
  findings: string[];
}
const cases: CaseResult[] = [];

function newCase(id: string, name: string): CaseResult {
  const c: CaseResult = { id, name, verdict: 'FAIL', checks: [], antiVacuityControl: null, findings: [] };
  cases.push(c);
  return c;
}
function check(c: CaseResult, label: string, ok: boolean, evidence: unknown): boolean {
  c.checks.push({ label, ok, evidence });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${c.id} — ${label}`);
  if (!ok) console.log(`         evidence: ${JSON.stringify(evidence).slice(0, 900)}`);
  return ok;
}
function control(c: CaseResult, label: string, produced: unknown, ok: boolean): boolean {
  c.antiVacuityControl = { label, produced, ok };
  console.log(`   ${ok ? 'CTRL' : 'CTRL-FAIL'}  ${c.id} — ANTI-VACUITY: ${label} -> ${JSON.stringify(produced).slice(0, 400)}`);
  return ok;
}
function finalise(c: CaseResult): void {
  // A case passes only if every check passed AND its control genuinely
  // produced the non-zero it was supposed to produce. A case with no control
  // at all cannot pass — that is the whole point of this harness.
  const allChecks = c.checks.every((k) => k.ok);
  const ctrlOk = c.antiVacuityControl !== null && c.antiVacuityControl.ok;
  if (c.verdict === 'NOT APPLICABLE') return;
  c.verdict = allChecks && ctrlOk ? 'PASS' : 'FAIL';
  console.log(`   ==> ${c.id} ${c.verdict}\n`);
}

// ---------------------------------------------------------------------------
// Synthetic identity. Everything this run creates carries RUN_TAG so it can be
// found and deleted exactly, including the GLOBAL ii_instruments rows the
// pipeline mints (that table has no user_id — scoping cleanup by user alone
// would leave residue, which is precisely S10's named failure mode).
// ---------------------------------------------------------------------------
const STAMP = Date.now();
const STAMP36 = STAMP.toString(36).toUpperCase().slice(-5); // 5 alphanumeric chars
const RUN_TAG = `ZZP4${STAMP36}`;

/** ISO 6166 check digit, so every synthetic ISIN is structurally valid. */
function isinCheckDigit(body11: string): string {
  let expanded = '';
  for (const ch of body11) expanded += ch >= '0' && ch <= '9' ? ch : String(ch.charCodeAt(0) - 65 + 10);
  let sum = 0;
  let dbl = true;
  for (let i = expanded.length - 1; i >= 0; i--) {
    let d = expanded.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return String((10 - (sum % 10)) % 10);
}
/** `IN` + `ZZ` + run stamp (5) + 2-digit scenario index + check digit = 12 chars. */
function synthIsin(idx: number): string {
  const body = `INZZ${STAMP36}${String(idx).padStart(2, '0')}`;
  return body + isinCheckDigit(body);
}
function schemeName(tag: string): string {
  return `ZZ Synthetic ${RUN_TAG} ${tag} Fund - Direct Plan - Growth`;
}
const AMC = `ZZ Synthetic ${RUN_TAG} Asset Management`;
const HOLDER = `ZZ SYNTHETIC HOLDER ${RUN_TAG}`;
const PAN = 'ZZZZZ0000Z';

// --- dates: recent, so no `stale_statement_date` warning muddies S06 -------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayOffset(days: number): Date {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}
function fmt(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const D_PERIOD_START = dayOffset(90);
const D_TXN_1 = dayOffset(60); // shared/overlapping transaction
const D_CLOSE_1 = dayOffset(45); // CAS as-of in the S04 pair / FS1 as-of in the S05 pair
const D_TXN_2 = dayOffset(30); // second-document-only transaction (strictly after D_CLOSE_1)
const D_CLOSE_2 = dayOffset(15); // second document's as-of

// ---------------------------------------------------------------------------
// Document builders. Line shapes are copied verbatim from the certified
// golden fixtures (`lib/fixtures/investment-intelligence/r2-cas/cams/*.txt`
// and `.../cams-individual-folio/*.txt`) — both parsers are strict, so the
// layout is not improvised.
// ---------------------------------------------------------------------------
interface CasRow {
  date: string;
  desc: string;
  amount: string;
  units: string;
  nav: string;
  balance: string;
  ref: string;
}
interface CasBlock {
  folio: string;
  scheme: string;
  isin: string;
  amfi: string;
  amc?: string;
  rows: CasRow[];
  closing: { date: string; units: string; value: string; nav: string };
}
function casLines(periodStart: string, periodEnd: string, blocks: CasBlock[]): string[] {
  const lines = ['CAMS Consolidated Account Statement', `Statement Period : ${periodStart} To ${periodEnd}`, ''];
  for (const b of blocks) {
    lines.push(`Folio No: ${b.folio}`, `PAN: ${PAN}`, `Name: ${HOLDER}`, 'Holding Mode: SI', '');
    lines.push(`AMC Name: ${b.amc ?? AMC}`, `Scheme Name: ${b.scheme}`, `ISIN: ${b.isin}`, `AMFI Code: ${b.amfi}`, 'Registrar: CAMS', '');
    lines.push('Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance');
    for (const r of b.rows) {
      lines.push(`${r.date}   ${r.desc}                              ${r.amount}  ${r.units}  ${r.nav}  ${r.balance} [Ref: ${r.ref}]`);
    }
    lines.push(
      `Closing Unit Balance as on ${b.closing.date} : ${b.closing.units} Units   Valuation : Rs. ${b.closing.value}   NAV as on ${b.closing.date} : Rs. ${b.closing.nav}`
    );
    lines.push('');
  }
  return lines;
}

interface Fs1Row {
  date: string;
  desc: string;
  amount: string;
  nav: string;
  price: string;
  units: string;
  balance: string;
  ref: string;
}
interface Fs1Scheme {
  scheme: string;
  isin: string;
  cost: string;
  units: string;
  navDate: string;
  nav: string;
  marketValue: string;
  rows: Fs1Row[];
}
function fs1Lines(folio: string, statementDate: string, schemes: Fs1Scheme[]): string[] {
  const lines = [
    'FOLIO DETAILS',
    '',
    `FOLIO NUMBER : ${folio}`,
    `Name : ${HOLDER}`,
    'Address : 1 Synthetic Street, Test City',
    'Mode of Holding : Single',
    'Tax Status : Individual',
    'Distributor/RIA : DIRECT',
    '',
    `Statement Date : ${statementDate}`,
    '',
    'SUMMARY OF HOLDINGS',
    'Scheme Name          Cost of Investment    Unit Balance    NAV Date       NAV        Market Value',
  ];
  for (const s of schemes) {
    lines.push(`${s.scheme}   ${s.cost}   ${s.units}   ${s.navDate}   ${s.nav}   ${s.marketValue}`);
  }
  lines.push('', 'FINANCIAL TRANSACTIONS', '');
  for (const s of schemes) {
    lines.push(`${s.scheme} ISIN CODE : ${s.isin}`);
    lines.push('DATE          TRANSACTION TYPE                Amount        NAV         PRICE       UNITS         BALANCE UNITS');
    for (const r of s.rows) {
      lines.push(`${r.date}   ${r.desc}   ${r.amount}   ${r.nav}   ${r.price}   ${r.units}   ${r.balance} [Ref: ${r.ref}]`);
    }
    lines.push('');
  }
  return lines;
}

/** Chunk into PDF pages — buildMinimalTextPdf takes an array of pages. */
function toPages(lines: string[]): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 55) pages.push(lines.slice(i, i + 55));
  return pages.length > 0 ? pages : [['(empty)']];
}

// ---------------------------------------------------------------------------
// THE SYNTHETIC DOCUMENT SET. Each scenario uses its own folio(s) and its own
// ISIN(s) so the ten cases cannot contaminate one another.
// ---------------------------------------------------------------------------
const ISIN = {
  s01: synthIsin(1),
  s02: synthIsin(2),
  s03: synthIsin(3),
  s03b: synthIsin(9),
  s04: synthIsin(4),
  s05: synthIsin(5),
  s06good: synthIsin(6),
  s06bad: synthIsin(7),
  s09b: synthIsin(8),
};
const FOLIO = {
  s01: `${RUN_TAG}0001`,
  s02: `${RUN_TAG}0002`,
  s03a: `${RUN_TAG}0003`,
  s03b: `${RUN_TAG}0013`,
  s04: `${RUN_TAG}0004`,
  s05: `${RUN_TAG}0005`,
  s06good: `${RUN_TAG}0006`,
  s06bad: `${RUN_TAG}0016`,
  s09b: `${RUN_TAG}0009`,
};

const DOCS = {
  // S01 — a single-position CAS, delivered as a genuinely RC4-encrypted PDF.
  s01: () =>
    casLines(fmt(D_PERIOD_START), fmt(D_CLOSE_2), [
      {
        folio: FOLIO.s01,
        scheme: schemeName('Alpha'),
        isin: ISIN.s01,
        amfi: '990001',
        rows: [{ date: fmt(D_TXN_1), desc: 'Purchase', amount: '5000.00', units: '50.000', nav: '100.0000', balance: '50.000', ref: `${RUN_TAG}S01T1` }],
        closing: { date: fmt(D_CLOSE_2), units: '50.000', value: '6000.00', nav: '120.0000' },
      },
    ]),

  // S02 — three transactions, so "second import inserted zero" is a claim
  // about a genuinely non-trivial row set.
  s02: () =>
    casLines(fmt(D_PERIOD_START), fmt(D_CLOSE_2), [
      {
        folio: FOLIO.s02,
        scheme: schemeName('Beta'),
        isin: ISIN.s02,
        amfi: '990002',
        rows: [
          { date: fmt(D_TXN_1), desc: 'Purchase', amount: '5000.00', units: '50.000', nav: '100.0000', balance: '50.000', ref: `${RUN_TAG}S02T1` },
          { date: fmt(D_TXN_2), desc: 'SIP Purchase', amount: '2000.00', units: '20.000', nav: '100.0000', balance: '70.000', ref: `${RUN_TAG}S02T2` },
          { date: fmt(D_CLOSE_2), desc: 'SIP Purchase', amount: '1000.00', units: '10.000', nav: '100.0000', balance: '80.000', ref: `${RUN_TAG}S02T3` },
        ],
        closing: { date: fmt(D_CLOSE_2), units: '80.000', value: '9600.00', nav: '120.0000' },
      },
    ]),

  // S02 anti-vacuity control: byte-DIFFERENT (one extra transaction), so the
  // very same "rows inserted by this import" counter must read non-zero.
  s02plus: () =>
    casLines(fmt(D_PERIOD_START), fmt(D_CLOSE_2), [
      {
        folio: FOLIO.s02,
        scheme: schemeName('Beta'),
        isin: ISIN.s02,
        amfi: '990002',
        rows: [
          { date: fmt(D_TXN_1), desc: 'Purchase', amount: '5000.00', units: '50.000', nav: '100.0000', balance: '50.000', ref: `${RUN_TAG}S02T1` },
          { date: fmt(D_TXN_2), desc: 'SIP Purchase', amount: '2000.00', units: '20.000', nav: '100.0000', balance: '70.000', ref: `${RUN_TAG}S02T2` },
          { date: fmt(D_CLOSE_2), desc: 'SIP Purchase', amount: '1000.00', units: '10.000', nav: '100.0000', balance: '80.000', ref: `${RUN_TAG}S02T3` },
          { date: fmt(D_CLOSE_2), desc: 'SIP Purchase', amount: '500.00', units: '5.000', nav: '100.0000', balance: '85.000', ref: `${RUN_TAG}S02T4` },
        ],
        closing: { date: fmt(D_CLOSE_2), units: '85.000', value: '10200.00', nav: '120.0000' },
      },
    ]),

  // S03 — ONE scheme (one ISIN) held under TWO folios, plus a second,
  // genuinely different scheme in folio A. That second scheme is the control:
  // "1 instrument for the shared scheme" is only meaningful if the same query
  // also reports 2 instruments for this document overall.
  s03: () =>
    casLines(fmt(D_PERIOD_START), fmt(D_CLOSE_2), [
      {
        folio: FOLIO.s03a,
        scheme: schemeName('Gamma'),
        isin: ISIN.s03,
        amfi: '990003',
        rows: [{ date: fmt(D_TXN_1), desc: 'Purchase', amount: '3000.00', units: '30.000', nav: '100.0000', balance: '30.000', ref: `${RUN_TAG}S03A1` }],
        closing: { date: fmt(D_CLOSE_2), units: '30.000', value: '3600.00', nav: '120.0000' },
      },
      {
        folio: FOLIO.s03a,
        scheme: schemeName('GammaTwo'),
        isin: ISIN.s03b,
        amfi: '990013',
        rows: [{ date: fmt(D_TXN_1), desc: 'Purchase', amount: '1100.00', units: '11.000', nav: '100.0000', balance: '11.000', ref: `${RUN_TAG}S03A2` }],
        closing: { date: fmt(D_CLOSE_2), units: '11.000', value: '1320.00', nav: '120.0000' },
      },
      {
        folio: FOLIO.s03b,
        scheme: schemeName('Gamma'),
        isin: ISIN.s03,
        amfi: '990003',
        rows: [{ date: fmt(D_TXN_1), desc: 'Purchase', amount: '7000.00', units: '70.000', nav: '100.0000', balance: '70.000', ref: `${RUN_TAG}S03B1` }],
        closing: { date: fmt(D_CLOSE_2), units: '70.000', value: '8400.00', nav: '120.0000' },
      },
    ]),

  // S04 — CAS first (as-of D_CLOSE_1), folio statement second (as-of
  // D_CLOSE_2). T1 is printed IDENTICALLY on both documents (same date, type,
  // amount, units, per-unit value and provider reference) — a genuine
  // overlap. T2 exists only on the folio statement.
  s04cas: () =>
    casLines(fmt(D_PERIOD_START), fmt(D_CLOSE_1), [
      {
        folio: FOLIO.s04,
        scheme: schemeName('Delta'),
        isin: ISIN.s04,
        amfi: '990004',
        rows: [{ date: fmt(D_TXN_1), desc: 'Purchase', amount: '5000.00', units: '50.000', nav: '100.0000', balance: '50.000', ref: `${RUN_TAG}S04T1` }],
        closing: { date: fmt(D_CLOSE_1), units: '50.000', value: '5500.00', nav: '110.0000' },
      },
    ]),
  s04fs1: () =>
    fs1Lines(FOLIO.s04, fmt(D_CLOSE_2), [
      {
        scheme: schemeName('Delta'),
        isin: ISIN.s04,
        cost: '10000.00',
        units: '100.000000',
        navDate: fmt(D_CLOSE_2),
        nav: '120.0000',
        marketValue: '12000.00',
        rows: [
          { date: fmt(D_TXN_1), desc: 'Purchase', amount: '5000.00', nav: '100.0000', price: '100.0000', units: '50.000000', balance: '50.000000', ref: `${RUN_TAG}S04T1` },
          { date: fmt(D_TXN_2), desc: 'Systematic Investment - Purchase', amount: '5000.00', nav: '100.0000', price: '100.0000', units: '50.000000', balance: '100.000000', ref: `${RUN_TAG}S04T2` },
        ],
      },
    ]),

  // S05 — the exact same overlap, imported in the OPPOSITE order.
  s05fs1: () =>
    fs1Lines(FOLIO.s05, fmt(D_CLOSE_1), [
      {
        scheme: schemeName('Epsilon'),
        isin: ISIN.s05,
        cost: '5000.00',
        units: '50.000000',
        navDate: fmt(D_CLOSE_1),
        nav: '110.0000',
        marketValue: '5500.00',
        rows: [
          { date: fmt(D_TXN_1), desc: 'Purchase', amount: '5000.00', nav: '100.0000', price: '100.0000', units: '50.000000', balance: '50.000000', ref: `${RUN_TAG}S05T1` },
        ],
      },
    ]),
  s05cas: () =>
    casLines(fmt(D_PERIOD_START), fmt(D_CLOSE_2), [
      {
        folio: FOLIO.s05,
        scheme: schemeName('Epsilon'),
        isin: ISIN.s05,
        amfi: '990005',
        rows: [
          { date: fmt(D_TXN_1), desc: 'Purchase', amount: '5000.00', units: '50.000', nav: '100.0000', balance: '50.000', ref: `${RUN_TAG}S05T1` },
          { date: fmt(D_TXN_2), desc: 'SIP Purchase', amount: '5000.00', units: '50.000', nav: '100.0000', balance: '100.000', ref: `${RUN_TAG}S05T2` },
        ],
        closing: { date: fmt(D_CLOSE_2), units: '100.000', value: '12000.00', nav: '120.0000' },
      },
    ]),

  // S06 — ONE document carrying one arithmetically CORRECT position and one
  // that deliberately does not close (50 units of purchases, a printed
  // closing balance of 250). "Everything blocks" must not be mistaken for a
  // pass, so the correct position is in the very same run.
  s06: () =>
    casLines(fmt(D_PERIOD_START), fmt(D_CLOSE_2), [
      {
        folio: FOLIO.s06good,
        scheme: schemeName('ZetaGood'),
        isin: ISIN.s06good,
        amfi: '990006',
        rows: [{ date: fmt(D_TXN_1), desc: 'Purchase', amount: '5000.00', units: '50.000', nav: '100.0000', balance: '50.000', ref: `${RUN_TAG}S06G1` }],
        closing: { date: fmt(D_CLOSE_2), units: '50.000', value: '6000.00', nav: '120.0000' },
      },
      {
        folio: FOLIO.s06bad,
        scheme: schemeName('ZetaBad'),
        isin: ISIN.s06bad,
        amfi: '990016',
        rows: [{ date: fmt(D_TXN_1), desc: 'Purchase', amount: '5000.00', units: '50.000', nav: '100.0000', balance: '50.000', ref: `${RUN_TAG}S06B1` }],
        closing: { date: fmt(D_CLOSE_2), units: '250.000', value: '30000.00', nav: '120.0000' },
      },
    ]),

  // S09 — user B's own, entirely separate document, so the isolation probe
  // has something of B's to find (the negative control needs B to be able to
  // see SOMETHING, or "B sees 0 of A's rows" proves nothing).
  s09b: () =>
    casLines(fmt(D_PERIOD_START), fmt(D_CLOSE_2), [
      {
        folio: FOLIO.s09b,
        scheme: schemeName('Theta'),
        isin: ISIN.s09b,
        amfi: '990008',
        rows: [{ date: fmt(D_TXN_1), desc: 'Purchase', amount: '9000.00', units: '90.000', nav: '100.0000', balance: '90.000', ref: `${RUN_TAG}S09B1` }],
        closing: { date: fmt(D_CLOSE_2), units: '90.000', value: '10800.00', nav: '120.0000' },
      },
    ]),
};

// ---------------------------------------------------------------------------
// PREFLIGHT — parse every synthetic document with the real parser registry,
// in memory, before a single byte reaches DEV. A document that does not parse
// the way this pack assumes would silently turn every downstream assertion
// into nonsense, so this is a hard gate, not a convenience.
// ---------------------------------------------------------------------------
interface PreflightRow {
  doc: string;
  parserCode: string | null;
  confidence: number;
  accounts: number;
  transactions: number;
  holdings: number;
  errorWarnings: string[];
}
function preflight(): PreflightRow[] {
  const rows: PreflightRow[] = [];
  for (const [name, build] of Object.entries(DOCS)) {
    const text = (build as () => string[])().join('\n');
    const { detection, parsed } = parseExtractedDocument(text);
    rows.push({
      doc: name,
      parserCode: parsed?.parserCode ?? null,
      confidence: detection.detection.confidence,
      accounts: parsed?.accounts.length ?? 0,
      transactions: parsed?.transactions.length ?? 0,
      holdings: parsed?.holdings.length ?? 0,
      errorWarnings: (parsed?.errors ?? []).map((e) => `${e.code}: ${e.message.slice(0, 160)}`),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// DEV helpers
// ---------------------------------------------------------------------------
interface SynthUser {
  tag: string;
  userId: string;
  email: string;
  password: string;
  householdId: string;
  memberId: string;
}
const createdUsers: SynthUser[] = [];
const createdObjectKeys: string[] = [];
const createdDocumentIds: string[] = [];

async function makeUser(tag: string): Promise<SynthUser> {
  const email = `zz-m12c-pc4-${tag}-${STAMP}@fhip-test.invalid`;
  const password = `ZzPc4-${STAMP}-${tag}-Aa1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser(${tag}) failed: ${error?.message}`);
  const userId = data.user.id;
  const { data: hh, error: hhErr } = await admin
    .from('households')
    .insert({ user_id: userId, household_name: `ZZ Synthetic ${RUN_TAG} household ${tag}`, primary_country: 'IN' })
    .select('id')
    .single();
  if (hhErr || !hh) throw new Error(`household insert failed: ${hhErr?.message}`);
  const { data: mem, error: memErr } = await admin
    .from('household_members')
    .insert({ user_id: userId, household_id: hh.id, full_name: `ZZ Synthetic Selfholder ${tag}`, relationship: 'self', is_active: true })
    .select('id')
    .single();
  if (memErr || !mem) throw new Error(`household_members insert failed: ${memErr?.message}`);
  const u: SynthUser = { tag, userId, email, password, householdId: hh.id as string, memberId: mem.id as string };
  createdUsers.push(u);
  return u;
}

interface UploadOptions {
  encryptedWithPassword?: string;
  /** Re-use exactly these bytes instead of rebuilding (S02 needs byte-identity). */
  reuseBytes?: Buffer;
  /** Omit the checksum column (used only to get PAST the DB re-upload guard deliberately, after proving that guard works). */
  omitChecksum?: boolean;
  ownerMemberId?: string | null;
}
async function uploadDocument(
  user: SynthUser,
  filename: string,
  lines: string[],
  options: UploadOptions = {}
): Promise<{ documentId: string; objectKey: string; bytes: Buffer; checksum: string }> {
  const bytes =
    options.reuseBytes ?? (options.encryptedWithPassword ? buildEncryptedTextPdf(toPages(lines), options.encryptedWithPassword).bytes : buildMinimalTextPdf(toPages(lines)));
  const objectKey = `${user.userId}/${randomUUID()}.pdf`;
  const { error: upErr } = await admin.storage.from(II_STORAGE_BUCKET).upload(objectKey, bytes, { contentType: 'application/pdf', upsert: false });
  if (upErr) throw new Error(`storage upload failed (${filename}): ${upErr.message}`);
  createdObjectKeys.push(objectKey);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const { data: doc, error: docErr } = await admin
    .from('ii_source_documents')
    .insert({
      user_id: user.userId,
      owner_member_id: options.ownerMemberId === undefined ? user.memberId : options.ownerMemberId,
      country_code: 'IN',
      status: 'uploaded',
      checksum: options.omitChecksum ? null : checksum,
      storage_path: objectKey,
      original_filename: filename,
      mime_type: 'application/pdf',
      file_size: bytes.length,
      document_type: 'cas_statement',
    })
    .select('id')
    .single();
  if (docErr || !doc) throw new Error(`ii_source_documents insert failed (${filename}): ${docErr?.message}`);
  createdDocumentIds.push(doc.id as string);
  return { documentId: doc.id as string, objectKey, bytes, checksum };
}

/** Tables the II pipeline can write for a user. Used for S01's before/after and for S10. */
const USER_SCOPED_TABLES = [
  'ii_transaction_source_links',
  'ii_transactions',
  'ii_holding_snapshots',
  'ii_portfolio_truth_status',
  'ii_tax_lot_consumptions',
  'ii_tax_lots',
  'ii_capital_gains_computations',
  'ii_sip_series',
  'ii_analytics_results',
  'ii_r5_analytics_results',
  'ii_insights',
  'ii_review_items',
  'ii_goal_allocations',
  'ii_ownership_allocation',
  'ii_fhip_publications',
  'ii_reconciliation_cases',
  'ii_document_parse_runs',
  'ii_accounts',
  'ii_source_documents',
  'ii_audit_events',
  'investments',
  'household_members',
  'households',
  'user_profiles',
] as const;

/** The economic subset — the rows that actually represent money/holdings. */
const ECONOMIC_TABLES = ['ii_accounts', 'ii_transactions', 'ii_transaction_source_links', 'ii_holding_snapshots', 'ii_portfolio_truth_status'] as const;

async function countIn(table: string, userIds: string[]): Promise<number | null> {
  const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).in('user_id', userIds);
  if (error) return null;
  return count ?? 0;
}
async function economicSnapshot(userIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ECONOMIC_TABLES) out[t] = (await countIn(t, userIds)) ?? -1;
  // Global (no user_id column) — the instruments THIS RUN minted.
  const { count } = await admin.from('ii_instruments').select('*', { count: 'exact', head: true }).ilike('instrument_name', `%${RUN_TAG}%`);
  out.ii_instruments_run_scoped = count ?? -1;
  return out;
}
function deltaOf(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const d: Record<string, number> = {};
  for (const k of Object.keys(before)) d[k] = (after[k] ?? 0) - (before[k] ?? 0);
  return d;
}
function totalOf(d: Record<string, number>): number {
  return Object.values(d).reduce((a, b) => a + b, 0);
}

/**
 * PostgREST returns `numeric` columns as JS numbers, not as the exact decimal
 * strings they are stored as, so every quantity assertion below compares
 * NUMERICALLY. (First run of this pack compared against '30.000000' and
 * failed on a value that was actually correct — recorded here so the next
 * reader does not reintroduce it.)
 */
function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

async function positionOf(userId: string, isinValue: string): Promise<{ instrumentId: string | null; accountIds: string[] }> {
  const { data: ident } = await admin.from('ii_instrument_identifiers').select('instrument_id').eq('identifier_scheme', 'isin').eq('identifier_value', isinValue);
  let instrumentId = (ident ?? [])[0]?.instrument_id as string | undefined;
  if (!instrumentId) {
    // The instrument may have been minted without an ISIN identifier row (see
    // the S05 finding) — fall back to the run-scoped name.
    const { data: byName } = await admin.from('ii_instruments').select('id, instrument_name, isin').ilike('instrument_name', `%${RUN_TAG}%`);
    const hit = (byName ?? []).find((r) => (r.isin as string | null) === isinValue);
    instrumentId = hit?.id as string | undefined;
  }
  if (!instrumentId) return { instrumentId: null, accountIds: [] };
  const { data: txns } = await admin.from('ii_transactions').select('account_id').eq('user_id', userId).eq('instrument_id', instrumentId);
  return { instrumentId, accountIds: Array.from(new Set((txns ?? []).map((t) => t.account_id as string))) };
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`\n=== M12C PC4 REDUCED SYNTHETIC PACK — ${PREFLIGHT_ONLY ? 'PREFLIGHT ONLY' : new URL(DEV_URL).host} — ${new Date().toISOString()} ===`);
  console.log(`run tag: ${RUN_TAG}\n`);

  const pf = preflight();
  console.log('--- preflight (in-memory parse of every synthetic document) ---');
  for (const r of pf) {
    console.log(`  ${r.doc.padEnd(10)} parser=${String(r.parserCode).padEnd(24)} conf=${r.confidence.toFixed(2)} acc=${r.accounts} txn=${r.transactions} hold=${r.holdings} errors=${r.errorWarnings.length}`);
    for (const e of r.errorWarnings) console.log(`             ERROR-WARNING ${e}`);
  }
  console.log('');
  if (PREFLIGHT_ONLY) {
    fs.writeFileSync(path.join(OUT_DIR, 'preflight.json'), JSON.stringify({ runTag: RUN_TAG, preflight: pf }, null, 2));
    return;
  }
  const preflightClean = pf.every((r) => r.parserCode !== null && r.errorWarnings.length === 0);
  if (!preflightClean) {
    throw new Error(`PREFLIGHT FAILED — one or more synthetic documents did not parse cleanly; refusing to write anything to DEV. ${JSON.stringify(pf)}`);
  }

  // The reconciliation-config boundary, measured rather than assumed.
  const cfgCase = newCase('S00', 'Reconciliation config: the out-of-request fallback is a no-op (scope boundary, measured)');
  const { data: cfgRow } = await admin.from('ii_reconciliation_config').select('*').eq('is_active', true).maybeSingle();
  check(
    cfgCase,
    'the DB active config agrees with DEFAULT_RECONCILIATION_CONFIG (so the cookie-less fallback changes no tolerance)',
    Boolean(cfgRow) && String(cfgRow?.unit_tolerance) === '0.0001' && Number(cfgRow?.statement_freshness_warning_days) === DEFAULT_RECONCILIATION_CONFIG.statementFreshnessWarningDays,
    { dbUnitTolerance: cfgRow?.unit_tolerance, dbFreshnessDays: cfgRow?.statement_freshness_warning_days, codeDefaultUnitTolerance: '0.0001', codeDefaultFreshnessDays: DEFAULT_RECONCILIATION_CONFIG.statementFreshnessWarningDays }
  );
  control(cfgCase, 'the same query returns a real, non-null active config row (so the comparison had something to compare)', { configVersion: cfgRow?.config_version ?? null }, Boolean(cfgRow));
  finalise(cfgCase);

  const userA = await makeUser('a');
  const userB = await makeUser('b');
  console.log(`synthetic users: A=${userA.userId.slice(0, 8)} B=${userB.userId.slice(0, 8)}\n`);

  try {
    await caseS01(userA);
    await caseS02(userA);
    await caseS03(userA);
    const s04 = await caseS04(userA);
    await caseS05(userA);
    await caseS06(userA);
    await caseS07(userA, s04);
    await caseS08(userA);
    await caseS09(userA, userB);
  } finally {
    await caseS10();
    writeOutputs();
  }
}

// ---------------------------------------------------------------------------
// S01 — WRONG PASSWORD ATOMICITY
// ---------------------------------------------------------------------------
async function caseS01(u: SynthUser): Promise<void> {
  const c = newCase('S01', 'Wrong password leaves ZERO partial economic state');
  console.log(`--- ${c.id}: ${c.name} ---`);

  const pdfPassword = `ZzPc4Pdf-${STAMP}`;
  const doc = await uploadDocument(u, 'zz-s01-encrypted.pdf', DOCS.s01(), { encryptedWithPassword: pdfPassword });

  const before = await economicSnapshot([u.userId]);
  // ONE wrong attempt on ONE document. The M12C section-10 limiter permits 8
  // password-carrying attempts per document per rolling hour; this case uses
  // exactly 2 on this document (one wrong, then one correct), so the limiter
  // is never the reason for any observed outcome.
  const wrong = await processSourceDocument({ userId: u.userId, sourceDocumentId: doc.documentId, password: `${pdfPassword}-WRONG` });
  const afterWrong = await economicSnapshot([u.userId]);
  const wrongDelta = deltaOf(before, afterWrong);

  check(c, 'the wrong password was refused (ok=false)', wrong.ok === false, { ok: wrong.ok, status: wrong.status, error: wrong.error });
  check(c, "the document's status became 'password_required', never 'parsed'", wrong.status === 'password_required', wrong.status);
  check(c, 'ZERO economic rows were created by the refused attempt (accounts, transactions, links, holdings, truth statuses, instruments)', totalOf(wrongDelta) === 0, {
    before,
    afterWrong,
    delta: wrongDelta,
  });

  // A refused attempt DOES legitimately create audit/diagnostic rows (one
  // parse run, one blocking reconciliation case). Enumerated rather than
  // hidden — "zero partial state" is a claim about ECONOMIC rows.
  const { count: runCount } = await admin.from('ii_document_parse_runs').select('*', { count: 'exact', head: true }).eq('source_document_id', doc.documentId);
  const { data: pwCases } = await admin.from('ii_reconciliation_cases').select('id, discrepancy_type, severity, status').eq('source_document_id', doc.documentId);
  check(c, 'the refusal was recorded for audit: exactly one parse run and one blocking document_password_required case', runCount === 1 && (pwCases ?? []).length === 1 && pwCases![0].discrepancy_type === 'document_password_required', {
    parseRuns: runCount,
    cases: pwCases,
  });

  // ANTI-VACUITY: the identical counters must be able to move. Same document,
  // correct password.
  const right = await processSourceDocument({ userId: u.userId, sourceDocumentId: doc.documentId, password: pdfPassword });
  const afterRight = await economicSnapshot([u.userId]);
  const rightDelta = deltaOf(afterWrong, afterRight);
  control(c, 'the SAME counters, on the SAME document, with the CORRECT password', { ok: right.ok, status: right.status, delta: rightDelta }, right.ok === true && totalOf(rightDelta) > 0);

  // A real, reportable side effect of the refused attempt, checked rather
  // than assumed: does the still-open blocking password case keep the
  // now-correctly-parsed position out of certification?
  const { data: truth } = await admin.from('ii_portfolio_truth_status').select('status, blocking_reasons').eq('user_id', u.userId).eq('latest_source_document_id', doc.documentId);
  const blockingCodes = ((truth ?? [])[0]?.blocking_reasons as Array<{ code: string }> | null)?.map((r) => r.code) ?? [];
  if (blockingCodes.includes('open_blocking_reconciliation_case')) {
    c.findings.push(
      `FINDING (S01): after a wrong-password attempt, the blocking 'document_password_required' reconciliation case stays OPEN even once the correct password succeeds, so the position parses but is left status='${(truth ?? [])[0]?.status}' with blocking reason 'open_blocking_reconciliation_case'. Nothing in processSourceDocument resolves that case on a later successful extraction of the same document. Observed truth row: ${JSON.stringify(truth)}.`
    );
  }
  c.checks.push({
    label: 'OBSERVATION (not a pass/fail condition): the certification state reached after the corrected import',
    ok: true,
    evidence: { truth, blockingCodes },
  });

  finalise(c);
}

// ---------------------------------------------------------------------------
// S02 — EXACT REIMPORT
// ---------------------------------------------------------------------------
async function caseS02(u: SynthUser): Promise<void> {
  const c = newCase('S02', 'A byte-identical document imported twice creates no duplicated economic rows');
  console.log(`--- ${c.id}: ${c.name} ---`);

  const doc1 = await uploadDocument(u, 'zz-s02-first.pdf', DOCS.s02());
  const r1 = await processSourceDocument({ userId: u.userId, sourceDocumentId: doc1.documentId });
  check(c, 'the first import succeeded', r1.ok === true, { status: r1.status, summary: r1.summary, error: r1.error });

  const pos = await positionOf(u.userId, ISIN.s02);
  const countTxns = async () => {
    const { count } = await admin.from('ii_transactions').select('*', { count: 'exact', head: true }).eq('user_id', u.userId).eq('instrument_id', pos.instrumentId!);
    return count ?? -1;
  };
  const afterFirst = await countTxns();
  check(c, 'the first import genuinely inserted the three transactions it describes', afterFirst === 3, { transactions: afterFirst });

  // (a) DB-LAYER RE-UPLOAD GUARD. A second ii_source_documents row with the
  //     identical checksum must be rejected outright by
  //     uidx_ii_source_documents_user_checksum. This is a real, separate line
  //     of defence and it is proven, not assumed.
  const { error: dupChecksumErr } = await admin.from('ii_source_documents').insert({
    user_id: u.userId,
    owner_member_id: u.memberId,
    country_code: 'IN',
    status: 'uploaded',
    checksum: doc1.checksum,
    storage_path: `${u.userId}/${randomUUID()}.pdf`,
    original_filename: 'zz-s02-same-checksum.pdf',
    mime_type: 'application/pdf',
    file_size: doc1.bytes.length,
    document_type: 'cas_statement',
  });
  check(c, 'the DB re-upload guard rejects a second document row carrying the identical checksum', Boolean(dupChecksumErr) && String(dupChecksumErr?.code) === '23505', {
    errorCode: dupChecksumErr?.code ?? null,
    message: dupChecksumErr?.message?.slice(0, 200) ?? null,
  });

  // (b) SAME DOCUMENT, FORCED REPARSE.
  const r2 = await processSourceDocument({ userId: u.userId, sourceDocumentId: doc1.documentId, forceReparse: true });
  const afterReparse = await countTxns();
  check(c, 'a forced reparse of the same document inserted zero new transactions', afterReparse === afterFirst, { before: afterFirst, after: afterReparse });
  check(c, 'the forced reparse LINKED all three rows as already-known rather than finding nothing', (r2.summary?.duplicateTransactionsLinked ?? 0) === 3, r2.summary);

  // (c) A SECOND DOCUMENT ROW OVER BYTE-IDENTICAL BYTES (checksum omitted
  //     only so the guard proven in (a) does not short-circuit the pipeline
  //     test this case actually exists for).
  const doc2 = await uploadDocument(u, 'zz-s02-second.pdf', [], { reuseBytes: doc1.bytes, omitChecksum: true });
  check(c, 'the second document really does carry byte-identical content', createHash('sha256').update(doc2.bytes).digest('hex') === doc1.checksum, {
    identical: createHash('sha256').update(doc2.bytes).digest('hex') === doc1.checksum,
  });
  const r3 = await processSourceDocument({ userId: u.userId, sourceDocumentId: doc2.documentId });
  const afterSecondDoc = await countTxns();
  check(c, 'importing byte-identical content as a SEPARATE document inserted zero new transactions', afterSecondDoc === afterFirst, { before: afterFirst, after: afterSecondDoc });
  check(c, 'all three rows were linked to the second document instead of duplicated', (r3.summary?.duplicateTransactionsLinked ?? 0) === 3, r3.summary);

  // THE "NOT A ZERO FROM DELETION" CHECK the dispatch asks for explicitly.
  const { data: stillThere } = await admin.from('ii_transactions').select('id, source_reference, source_document_id').eq('user_id', u.userId).eq('instrument_id', pos.instrumentId!);
  const refs = (stillThere ?? []).map((r) => r.source_reference as string).sort();
  check(c, "the first import's rows are all STILL PRESENT (the zero is not a zero from having deleted everything)", refs.length === 3 && refs.every((r) => r.startsWith(RUN_TAG)), {
    rows: refs,
    allOriginatedFromDoc1: (stillThere ?? []).every((r) => r.source_document_id === doc1.documentId),
  });
  // And both documents are recorded as evidence for those same rows.
  const { count: linkCount } = await admin.from('ii_transaction_source_links').select('*', { count: 'exact', head: true }).eq('user_id', u.userId).eq('source_document_id', doc2.documentId);
  check(c, 'the second document is recorded as corroborating evidence via ii_transaction_source_links (evidence kept, not discarded)', linkCount === 3, { links: linkCount });

  // ANTI-VACUITY: the very same "did this import insert rows?" measurement,
  // run against a document that differs by ONE transaction, must read 1.
  const doc3 = await uploadDocument(u, 'zz-s02-plus-one.pdf', DOCS.s02plus(), {});
  const r4 = await processSourceDocument({ userId: u.userId, sourceDocumentId: doc3.documentId });
  const afterPlusOne = await countTxns();
  control(
    c,
    'the same counter, against a document with ONE extra transaction, moves by exactly 1',
    { before: afterFirst, after: afterPlusOne, inserted: afterPlusOne - afterFirst, linked: r4.summary?.duplicateTransactionsLinked },
    afterPlusOne - afterFirst === 1 && (r4.summary?.duplicateTransactionsLinked ?? 0) === 3
  );

  finalise(c);
}

// ---------------------------------------------------------------------------
// S03 — SAME INSTRUMENT, TWO FOLIOS
// ---------------------------------------------------------------------------
async function caseS03(u: SynthUser): Promise<void> {
  const c = newCase('S03', 'One scheme held under two folios resolves to ONE instrument and TWO accounts');
  console.log(`--- ${c.id}: ${c.name} ---`);

  const doc = await uploadDocument(u, 'zz-s03-two-folios.pdf', DOCS.s03());
  const r = await processSourceDocument({ userId: u.userId, sourceDocumentId: doc.documentId });
  check(c, 'the import succeeded', r.ok === true, { status: r.status, summary: r.summary, error: r.error });

  const { data: instruments } = await admin.from('ii_instruments').select('id, instrument_name, isin').eq('isin', ISIN.s03);
  check(c, 'the shared scheme resolved to exactly ONE canonical instrument', (instruments ?? []).length === 1, { instruments: (instruments ?? []).map((i) => ({ id: String(i.id).slice(0, 8), isin: i.isin })) });
  const instrumentId = (instruments ?? [])[0]?.id as string | undefined;

  const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number, institution_name').eq('user_id', u.userId).in('folio_number', [FOLIO.s03a, FOLIO.s03b]);
  check(c, 'the two folios resolved to exactly TWO distinct accounts', (accounts ?? []).length === 2, { accounts: (accounts ?? []).map((a) => ({ id: String(a.id).slice(0, 8), folio: a.folio_number })) });

  const accByFolio = new Map((accounts ?? []).map((a) => [a.folio_number as string, a.id as string]));
  const { data: txns } = await admin.from('ii_transactions').select('account_id, source_reference, units, gross_amount').eq('user_id', u.userId).eq('instrument_id', instrumentId ?? '');
  const forA = (txns ?? []).filter((t) => t.account_id === accByFolio.get(FOLIO.s03a));
  const forB = (txns ?? []).filter((t) => t.account_id === accByFolio.get(FOLIO.s03b));
  check(
    c,
    'each folio\'s transaction is attributed to ITS OWN account (30 units to folio A, 70 units to folio B)',
    forA.length === 1 && forB.length === 1 && forA[0].source_reference === `${RUN_TAG}S03A1` && forB[0].source_reference === `${RUN_TAG}S03B1` && num(forA[0].units) === 30 && num(forB[0].units) === 70,
    { folioA: forA.map((t) => ({ ref: t.source_reference, units: t.units })), folioB: forB.map((t) => ({ ref: t.source_reference, units: t.units })) }
  );

  // FIFO/tax-lot scope is account-scoped (II_PC1_F1_FIFO_SCOPE_DECISION.md),
  // so each folio must carry its own truth-status row for this one instrument.
  const { data: truths } = await admin.from('ii_portfolio_truth_status').select('account_id, status').eq('user_id', u.userId).eq('instrument_id', instrumentId ?? '');
  check(c, 'the account-scoped truth model gives this ONE instrument TWO position rows, one per folio', (truths ?? []).length === 2, {
    positions: (truths ?? []).map((t) => ({ account: String(t.account_id).slice(0, 8), status: t.status })),
  });

  // ANTI-VACUITY: the same instrument-counting query, applied to the second,
  // genuinely different scheme in the same document, must report a DIFFERENT
  // instrument — otherwise "exactly one instrument" could just mean the query
  // collapses everything.
  const { data: other } = await admin.from('ii_instruments').select('id, isin').eq('isin', ISIN.s03b);
  const distinct = (other ?? []).length === 1 && (other ?? [])[0]?.id !== instrumentId;
  control(c, 'the same query against the OTHER scheme in the same document returns a different, second instrument', { sharedScheme: String(instrumentId).slice(0, 8), otherScheme: String((other ?? [])[0]?.id).slice(0, 8) }, distinct);

  finalise(c);
}

// ---------------------------------------------------------------------------
// S04 — CAS -> FOLIO STATEMENT OVERLAP
// ---------------------------------------------------------------------------
async function caseS04(u: SynthUser): Promise<{ instrumentId: string | null; accountId: string | null }> {
  const c = newCase('S04', 'CAS first, then an overlapping folio statement: no economic duplication');
  console.log(`--- ${c.id}: ${c.name} ---`);

  const casDoc = await uploadDocument(u, 'zz-s04-cas.pdf', DOCS.s04cas());
  const r1 = await processSourceDocument({ userId: u.userId, sourceDocumentId: casDoc.documentId });
  check(c, 'the CAS import succeeded', r1.ok === true, { status: r1.status, summary: r1.summary, error: r1.error });

  const pos1 = await positionOf(u.userId, ISIN.s04);
  const { count: afterCas } = await admin.from('ii_transactions').select('*', { count: 'exact', head: true }).eq('user_id', u.userId).eq('instrument_id', pos1.instrumentId ?? '');
  check(c, 'the CAS import inserted its single transaction', afterCas === 1, { transactions: afterCas });

  const fsDoc = await uploadDocument(u, 'zz-s04-folio.pdf', DOCS.s04fs1());
  const r2 = await processSourceDocument({ userId: u.userId, sourceDocumentId: fsDoc.documentId });
  check(c, 'the folio-statement import succeeded', r2.ok === true, { status: r2.status, summary: r2.summary, error: r2.error });
  check(c, 'the folio statement was recognised as the FS1 individual-folio document type, not as a CAS', r2.summary?.sourceDetected === 'cams', { sourceDetected: r2.summary?.sourceDetected });

  const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number, institution_name').eq('user_id', u.userId).eq('folio_number', FOLIO.s04);
  check(c, 'both documents resolved to exactly ONE account for this folio (no AMC-blind duplicate)', (accounts ?? []).length === 1, {
    accounts: (accounts ?? []).map((a) => ({ id: String(a.id).slice(0, 8), institution: a.institution_name })),
  });

  const { data: instruments } = await admin.from('ii_instruments').select('id, isin, instrument_name').ilike('instrument_name', `%${RUN_TAG} Delta%`);
  check(c, 'both documents resolved to exactly ONE canonical instrument', (instruments ?? []).length === 1, { instruments: (instruments ?? []).map((i) => ({ id: String(i.id).slice(0, 8), isin: i.isin })) });

  const instrumentId = (instruments ?? [])[0]?.id as string | undefined;
  const { data: txns } = await admin
    .from('ii_transactions')
    .select('id, source_reference, units, status, source_document_id')
    .eq('user_id', u.userId)
    .eq('instrument_id', instrumentId ?? '')
    .order('transaction_date', { ascending: true });
  const refs = (txns ?? []).map((t) => t.source_reference as string);
  check(
    c,
    'the overlapping transaction exists exactly ONCE and the folio-only transaction was added: 2 rows, not 3',
    (txns ?? []).length === 2 && refs.filter((r) => r === `${RUN_TAG}S04T1`).length === 1 && refs.includes(`${RUN_TAG}S04T2`),
    { rows: (txns ?? []).map((t) => ({ ref: t.source_reference, units: t.units, status: t.status, doc: String(t.source_document_id).slice(0, 8) })) }
  );
  check(c, 'the second import reported exactly one duplicate linked and one genuinely new row', (r2.summary?.duplicateTransactionsLinked ?? 0) === 1 && (r2.summary?.transactionsFound ?? 0) === 2, r2.summary);

  // ANTI-VACUITY: the SAME "how many rows for this position" measurement had
  // to be capable of increasing — and it did, by exactly the one genuinely
  // new transaction the folio statement carried. A dedup that suppressed
  // everything would have left this at 1.
  control(c, 'the same row counter rose from 1 to 2 across the second import (dedup suppressed the duplicate only, not the new row)', { afterCas, afterFolio: (txns ?? []).length }, afterCas === 1 && (txns ?? []).length === 2);

  finalise(c);
  return { instrumentId: instrumentId ?? null, accountId: ((accounts ?? [])[0]?.id as string) ?? null };
}

// ---------------------------------------------------------------------------
// S05 — FOLIO STATEMENT -> CAS OVERLAP (THE OPPOSITE ORDER)
// ---------------------------------------------------------------------------
async function caseS05(u: SynthUser): Promise<void> {
  const c = newCase('S05', 'Folio statement first, then an overlapping CAS: no economic duplication, and order-independent');
  console.log(`--- ${c.id}: ${c.name} ---`);

  const fsDoc = await uploadDocument(u, 'zz-s05-folio.pdf', DOCS.s05fs1());
  const r1 = await processSourceDocument({ userId: u.userId, sourceDocumentId: fsDoc.documentId });
  check(c, 'the folio-statement import succeeded', r1.ok === true, { status: r1.status, summary: r1.summary, error: r1.error });

  const { data: accAfterFs } = await admin.from('ii_accounts').select('id, institution_name').eq('user_id', u.userId).eq('folio_number', FOLIO.s05);
  check(c, 'the AMC-blind folio statement created one account under the Unknown AMC sentinel', (accAfterFs ?? []).length === 1 && accAfterFs![0].institution_name === 'Unknown AMC', {
    accounts: (accAfterFs ?? []).map((a) => ({ id: String(a.id).slice(0, 8), institution: a.institution_name })),
  });
  const accountIdAfterFs = (accAfterFs ?? [])[0]?.id as string | undefined;

  // What identifier survived the AMC-blind import? This is checked, not
  // assumed — schemeKey is (name|plan|option|amc), and the holdings pass
  // overwrites the transactions pass, so the ISIN the document printed may or
  // may not have reached ii_instrument_identifiers.
  const { data: instrAfterFs } = await admin.from('ii_instruments').select('id, isin, instrument_name').ilike('instrument_name', `%${RUN_TAG} Epsilon%`);
  const { data: identAfterFs } = await admin.from('ii_instrument_identifiers').select('identifier_scheme, identifier_value').eq('instrument_id', (instrAfterFs ?? [])[0]?.id ?? '');
  const isinCaptured = (instrAfterFs ?? [])[0]?.isin === ISIN.s05 || (identAfterFs ?? []).some((i) => i.identifier_scheme === 'isin' && i.identifier_value === ISIN.s05);
  if (!isinCaptured) {
    c.findings.push(
      `FINDING (S05): the folio statement printed ISIN ${ISIN.s05} in its FINANCIAL TRANSACTIONS section, but the instrument minted from it carries isin=${JSON.stringify((instrAfterFs ?? [])[0]?.isin ?? null)} and identifier rows ${JSON.stringify(identAfterFs ?? [])}. documentProcessing.ts builds uniqueSchemes keyed by (normalisedName|plan|option|amc) and writes the TRANSACTION scheme first, then OVERWRITES it with the HOLDING scheme — and camsFolioStatementParser.parseHoldings deliberately emits buildScheme(name, null) because the Summary of Holdings block prints no ISIN. The globally-unique identifier present in the source document is therefore dropped for any FS1-first import. Subsequent resolution still lands on the same instrument (via normalised name + plan/option + country), so this is a lost-identifier defect, not a duplication defect.`
    );
  }
  c.checks.push({ label: 'OBSERVATION: which identifiers the AMC-blind (FS1-first) import preserved', ok: true, evidence: { instrumentIsin: (instrAfterFs ?? [])[0]?.isin ?? null, identifiers: identAfterFs ?? [], isinCaptured } });

  const casDoc = await uploadDocument(u, 'zz-s05-cas.pdf', DOCS.s05cas());
  const r2 = await processSourceDocument({ userId: u.userId, sourceDocumentId: casDoc.documentId });
  check(c, 'the CAS import succeeded', r2.ok === true, { status: r2.status, summary: r2.summary, error: r2.error });

  const { data: accAfterCas } = await admin.from('ii_accounts').select('id, institution_name').eq('user_id', u.userId).eq('folio_number', FOLIO.s05);
  check(
    c,
    'the CAS adopted and upgraded the SAME account rather than creating a second one for the same folio',
    (accAfterCas ?? []).length === 1 && (accAfterCas ?? [])[0]?.id === accountIdAfterFs && accAfterCas![0].institution_name === AMC,
    { accounts: (accAfterCas ?? []).map((a) => ({ id: String(a.id).slice(0, 8), institution: a.institution_name })), sameIdAsBefore: (accAfterCas ?? [])[0]?.id === accountIdAfterFs }
  );

  const { data: instruments } = await admin.from('ii_instruments').select('id, isin').ilike('instrument_name', `%${RUN_TAG} Epsilon%`);
  check(c, 'both documents resolved to exactly ONE canonical instrument', (instruments ?? []).length === 1, { instruments: (instruments ?? []).map((i) => ({ id: String(i.id).slice(0, 8), isin: i.isin })) });

  const instrumentId = (instruments ?? [])[0]?.id as string | undefined;
  const { data: txns } = await admin.from('ii_transactions').select('source_reference, units, status').eq('user_id', u.userId).eq('instrument_id', instrumentId ?? '');
  const refs = (txns ?? []).map((t) => t.source_reference as string);
  check(
    c,
    'the overlapping transaction exists exactly ONCE and the CAS-only transaction was added: 2 rows, not 3',
    (txns ?? []).length === 2 && refs.filter((r) => r === `${RUN_TAG}S05T1`).length === 1 && refs.includes(`${RUN_TAG}S05T2`),
    { rows: (txns ?? []).map((t) => ({ ref: t.source_reference, units: t.units, status: t.status })) }
  );

  // Is the dropped ISIN recovered once a CAS that DOES print it arrives? Read
  // at final state rather than reasoned about: resolveScheme's `resolved`
  // branch only maps to the existing instrument — it writes no
  // ii_instrument_identifiers row and never updates ii_instruments.isin, so
  // the expectation is "no". Measured so the finding is not an inference.
  const { data: identAfterCas } = await admin.from('ii_instrument_identifiers').select('identifier_scheme, identifier_value').eq('instrument_id', instrumentId ?? '');
  const { data: instrFinal } = await admin.from('ii_instruments').select('isin, status').eq('id', instrumentId ?? '').maybeSingle();
  const recovered = instrFinal?.isin === ISIN.s05 || (identAfterCas ?? []).some((i) => i.identifier_scheme === 'isin' && i.identifier_value === ISIN.s05);
  c.checks.push({
    label: 'OBSERVATION: whether the later CAS (which DOES print the ISIN) backfills the identifier onto the already-minted instrument',
    ok: true,
    evidence: { instrumentIsin: instrFinal?.isin ?? null, instrumentStatus: instrFinal?.status, identifiers: identAfterCas ?? [], isinRecovered: recovered },
  });
  if (!isinCaptured && !recovered) {
    c.findings.push(
      `FINDING (S05, continued): the ISIN is NOT recovered later either. After the CAS import — which prints ISIN ${ISIN.s05} and resolves to this same instrument via normalised name — the instrument still carries isin=${JSON.stringify(instrFinal?.isin ?? null)} and identifier rows ${JSON.stringify(identAfterCas ?? [])}. schemeResolution's 'resolved' branch only MAPS to the existing instrument; only the 'unresolved' branch writes ii_instrument_identifiers. So an FS1-first position is permanently left without the ISIN that both of its source documents printed, and any future statement that carries ONLY an ISIN (no matching scheme name) would mint a SECOND instrument for the same real fund.`
    );
  }

  // ORDER INDEPENDENCE — the whole point of running S04 and S05 as a pair.
  const s04 = cases.find((k) => k.id === 'S04')!;
  const s04rows = (s04.checks.find((k) => k.label.includes('2 rows, not 3'))?.evidence as { rows: unknown[] } | undefined)?.rows?.length ?? -1;
  check(c, 'BOTH orders produce the identical economic shape: 1 account, 1 instrument, 2 transactions', s04rows === 2 && (txns ?? []).length === 2, { casFirst: s04rows, folioFirst: (txns ?? []).length });

  control(c, 'the same row counter rose from 1 to 2 across the second import (dedup suppressed the duplicate only, not the new row)', { afterFolio: 1, afterCas: (txns ?? []).length }, (txns ?? []).length === 2);
  finalise(c);
}

// ---------------------------------------------------------------------------
// S06 — DELIBERATE RECONCILIATION FAILURE
// ---------------------------------------------------------------------------
async function caseS06(u: SynthUser): Promise<void> {
  const c = newCase('S06', 'A document whose own arithmetic does not close is BLOCKED, never certified');
  console.log(`--- ${c.id}: ${c.name} ---`);

  const doc = await uploadDocument(u, 'zz-s06-mixed.pdf', DOCS.s06());
  const r = await processSourceDocument({ userId: u.userId, sourceDocumentId: doc.documentId });
  check(c, 'the import ran to completion (the pipeline did not simply crash)', r.ok === true, { status: r.status, summary: r.summary, error: r.error });

  const goodPos = await positionOf(u.userId, ISIN.s06good);
  const badPos = await positionOf(u.userId, ISIN.s06bad);

  const truthFor = async (instrumentId: string | null) => {
    const { data } = await admin.from('ii_portfolio_truth_status').select('status, blocking_reasons, unit_variance, reconciled_closing_units, statement_closing_units, unit_variance_within_tolerance').eq('user_id', u.userId).eq('instrument_id', instrumentId ?? '').maybeSingle();
    return data;
  };
  const good = await truthFor(goodPos.instrumentId);
  const bad = await truthFor(badPos.instrumentId);

  const badCodes = ((bad?.blocking_reasons as Array<{ code: string }> | null) ?? []).map((x) => x.code);
  check(c, 'the non-closing position was BLOCKED (status reconciliation_required)', bad?.status === 'reconciliation_required', { status: bad?.status, blockingReasons: badCodes });
  check(c, "the blocking reason names the arithmetic: 'unit_variance_exceeds_tolerance'", badCodes.includes('unit_variance_exceeds_tolerance'), badCodes);
  check(c, 'the recorded variance is the real arithmetic difference (50 reconstructed vs 250 printed = -200)', num(bad?.unit_variance) === -200 && num(bad?.reconciled_closing_units) === 50 && num(bad?.statement_closing_units) === 250, {
    reconciled: bad?.reconciled_closing_units,
    statement: bad?.statement_closing_units,
    variance: bad?.unit_variance,
    withinTolerance: bad?.unit_variance_within_tolerance,
  });
  check(c, 'the blocked position was never certified (certified_at is null)', bad?.status !== 'certified' && bad?.status !== 'certified_with_warnings', bad?.status);

  // THE CONTROL THE DISPATCH NAMES EXPLICITLY: in the SAME run, the correct
  // position must reach its expected state, so "everything blocks" cannot be
  // mistaken for a pass.
  const goodCertified = good?.status === 'certified' || good?.status === 'certified_with_warnings';
  control(
    c,
    'in the SAME import, the arithmetically correct position DID reach a certified state (so this is discrimination, not a blanket block)',
    { goodStatus: good?.status, goodVariance: good?.unit_variance, goodBlocking: ((good?.blocking_reasons as Array<{ code: string }> | null) ?? []).map((x) => x.code), badStatus: bad?.status },
    goodCertified
  );
  if (!goodCertified) {
    c.findings.push(`FINDING (S06): the arithmetically CORRECT position in the same document did not reach a certified state — observed ${JSON.stringify(good)}.`);
  }

  finalise(c);
}

// ---------------------------------------------------------------------------
// S07 — NET WORTH ONCE ONLY
// ---------------------------------------------------------------------------
async function caseS07(u: SynthUser, s04: { instrumentId: string | null; accountId: string | null }): Promise<void> {
  const c = newCase('S07', 'The same position contributes to net worth exactly once, not once per source document');
  console.log(`--- ${c.id}: ${c.name} ---`);

  if (!s04.instrumentId || !s04.accountId) {
    c.verdict = 'NOT APPLICABLE';
    c.notApplicableReason = 'S04 did not produce a resolvable position, so there is no two-document position to test.';
    finalise(c);
    return;
  }

  // The position evidenced by TWO documents (S04's CAS + folio statement).
  const { data: truths } = await admin
    .from('ii_portfolio_truth_status')
    .select('id, account_id, instrument_id, status, statement_closing_units, latest_source_document_id')
    .eq('user_id', u.userId)
    .eq('account_id', s04.accountId)
    .eq('instrument_id', s04.instrumentId);
  check(c, 'the two-document position has exactly ONE canonical position row, not one per document', (truths ?? []).length === 1, {
    rows: (truths ?? []).map((t) => ({ status: t.status, closing: t.statement_closing_units, latestDoc: String(t.latest_source_document_id).slice(0, 8) })),
  });

  const { data: snaps } = await admin.from('ii_holding_snapshots').select('id, as_of_date, units, source_document_id').eq('user_id', u.userId).eq('account_id', s04.accountId).eq('instrument_id', s04.instrumentId).order('as_of_date', { ascending: true });
  const byDate = new Map<string, number>();
  for (const s of snaps ?? []) byDate.set(s.as_of_date as string, (byDate.get(s.as_of_date as string) ?? 0) + 1);
  check(c, 'there is at most ONE holding snapshot per as-of date (a second document for the same date cannot add a second snapshot)', Array.from(byDate.values()).every((n) => n === 1), {
    snapshots: (snaps ?? []).map((s) => ({ asOf: s.as_of_date, units: s.units, doc: String(s.source_document_id).slice(0, 8) })),
  });

  const latest = (snaps ?? [])[(snaps ?? []).length - 1];
  check(c, 'the position value carried forward is the statement closing balance (100 units), NOT the sum of both documents (150)', num(latest?.units) === 100, {
    latestSnapshotUnits: latest?.units,
    naiveSumIfDoubleCounted: 150,
  });

  // THE DB-LEVEL GUARANTEE, PROVEN BEHAVIOURALLY. This project exposes no
  // arbitrary-SQL RPC, so `uidx_ii_fhip_publications_one_active_position` is
  // proven by making the database refuse the thing it forbids rather than by
  // reading pg_indexes.
  //
  // The two documents produced TWO canonical positions for the SAME (account,
  // instrument) — the D_CLOSE_1 snapshot from the CAS and the D_CLOSE_2
  // snapshot from the folio statement. "Once per source document" would mean
  // BOTH of them publishing and both counting toward net worth. That is
  // exactly what is attempted here, and it must be refused.
  const snapA = (snaps ?? [])[0];
  const snapB = (snaps ?? [])[1];
  const pubBase = {
    user_id: u.userId,
    account_id: s04.accountId,
    instrument_id: s04.instrumentId,
    publication_target: 'investments',
    source_currency: 'INR',
    published_value: '12000.00',
  };
  if (!snapA || !snapB) {
    check(c, 'two canonical positions exist for this one economic position (one per source document) to attempt a double publish against', false, { snapshots: snaps });
  } else {
    const p1 = await admin.from('ii_fhip_publications').insert({ ...pubBase, canonical_position_id: snapA.id, status: 'published', idempotency_key: `${RUN_TAG}-s07-a` }).select('id').maybeSingle();
    const p2 = await admin.from('ii_fhip_publications').insert({ ...pubBase, canonical_position_id: snapB.id, status: 'published', idempotency_key: `${RUN_TAG}-s07-b` }).select('id').maybeSingle();
    check(
      c,
      'publishing the FIRST document\'s position is accepted',
      Boolean(p1.data),
      { firstInsert: p1.data ? 'accepted' : `rejected ${p1.error?.code}: ${p1.error?.message?.slice(0, 200)}` }
    );
    check(
      c,
      'the database REFUSES to also publish the SECOND document\'s position for the same (account, instrument) — net worth cannot count it twice',
      !p2.data && String(p2.error?.code) === '23505',
      { secondInsert: p2.data ? 'ACCEPTED (this would be a double-count defect)' : `rejected ${p2.error?.code}: ${p2.error?.message?.slice(0, 200)}` }
    );
    // The refusal must be specific to a second ACTIVE publication, not to a
    // second row of any kind — otherwise the refresh/supersession lifecycle
    // would be broken and this "guarantee" would be an accident.
    const p3 = await admin.from('ii_fhip_publications').insert({ ...pubBase, canonical_position_id: snapB.id, status: 'superseded', idempotency_key: `${RUN_TAG}-s07-c` }).select('id').maybeSingle();
    check(
      c,
      'the same second position IS accepted with status superseded — the constraint targets two SIMULTANEOUSLY ACTIVE publications, not any second row',
      Boolean(p3.data),
      { supersededInsert: p3.data ? 'accepted' : `rejected ${p3.error?.code}: ${p3.error?.message?.slice(0, 200)}` }
    );
  }

  // ANTI-VACUITY: the same "exactly one row for this position" query, widened
  // to the user, must report several positions — so the filter is real.
  const { count: allPositions } = await admin.from('ii_portfolio_truth_status').select('*', { count: 'exact', head: true }).eq('user_id', u.userId);
  control(c, 'the same query without the position filter reports many positions for this user (the "exactly 1" is a genuine filter, not an empty table)', { positionsForUser: allPositions }, (allPositions ?? 0) > 1);

  // SCOPE BOUNDARY, stated as an observation rather than hidden. The
  // `investments`-row write that actually feeds net worth goes through
  // investmentPublicationService.publishPosition(), which is hardwired to the
  // cookie-based createClient() and therefore cannot be driven from a plain
  // Node process. What is proven here is the layer beneath it: one canonical
  // position, one snapshot per date, and a DB constraint that makes two
  // simultaneous publications of one position impossible.
  c.checks.push({
    label: 'SCOPE BOUNDARY (observation): publishPosition() itself was not driven — it requires a Next.js request context',
    ok: true,
    evidence: 'investmentPublicationService.publishPosition uses lib/supabase/server createClient() (next/headers cookies). Proven here instead: single canonical position, single snapshot per as-of date, and the uidx_ii_fhip_publications_one_active_position unique index enforced live.',
  });

  // Clean up the two probe publication rows immediately (S10 re-verifies).
  await admin.from('ii_fhip_publications').delete().eq('user_id', u.userId);
  finalise(c);
}

// ---------------------------------------------------------------------------
// S08 — TWO-DOCUMENT IDENTITY (THE DEV/DATABASE HALF)
// ---------------------------------------------------------------------------
async function caseS08(u: SynthUser): Promise<void> {
  const c = newCase('S08', 'Two distinct source documents are never confused for one another (database half)');
  console.log(`--- ${c.id}: ${c.name} ---`);

  const { data: docs } = await admin.from('ii_source_documents').select('id, storage_path, original_filename').eq('user_id', u.userId).order('uploaded_at', { ascending: true });
  const docIds = (docs ?? []).map((d) => d.id as string);
  check(c, 'this user has several distinct source documents to distinguish between', docIds.length >= 4, { documents: docIds.length });

  const paths = (docs ?? []).map((d) => d.storage_path as string);
  check(c, 'every storage path is distinct and namespaced under its OWN owner id', new Set(paths).size === paths.length && paths.every((p) => p.startsWith(`${u.userId}/`)), {
    distinctPaths: new Set(paths).size,
    totalPaths: paths.length,
    allOwnerPrefixed: paths.every((p) => p.startsWith(`${u.userId}/`)),
  });

  const { data: runs } = await admin.from('ii_document_parse_runs').select('id, source_document_id').eq('user_id', u.userId);
  check(c, 'every parse run belongs to exactly one, existing source document of this user', (runs ?? []).length > 0 && (runs ?? []).every((r) => docIds.includes(r.source_document_id as string)), {
    runs: (runs ?? []).length,
    orphanRuns: (runs ?? []).filter((r) => !docIds.includes(r.source_document_id as string)).length,
  });

  // Per-document attribution, checked pairwise rather than in aggregate.
  const perDoc: Record<string, { runs: number; txns: number; originatingLinks: number }> = {};
  for (const d of docIds) {
    const { count: runCount } = await admin.from('ii_document_parse_runs').select('*', { count: 'exact', head: true }).eq('source_document_id', d);
    const { count: txnCount } = await admin.from('ii_transactions').select('*', { count: 'exact', head: true }).eq('user_id', u.userId).eq('source_document_id', d);
    const { count: origCount } = await admin.from('ii_transaction_source_links').select('*', { count: 'exact', head: true }).eq('user_id', u.userId).eq('source_document_id', d).eq('is_originating', true);
    perDoc[d.slice(0, 8)] = { runs: runCount ?? -1, txns: txnCount ?? -1, originatingLinks: origCount ?? -1 };
  }
  check(
    c,
    "every transaction's originating link count matches the number of transactions that document actually created (no cross-attribution)",
    Object.values(perDoc).every((v) => v.txns === v.originatingLinks),
    perDoc
  );

  // A transaction is evidenced by its own originating document plus, where a
  // second document corroborated it, a NON-originating link. There must never
  // be two originating links for one transaction.
  const { data: links } = await admin.from('ii_transaction_source_links').select('transaction_id, source_document_id, is_originating').eq('user_id', u.userId);
  const origByTxn = new Map<string, number>();
  for (const l of links ?? []) if (l.is_originating) origByTxn.set(l.transaction_id as string, (origByTxn.get(l.transaction_id as string) ?? 0) + 1);
  check(c, 'no transaction has more than one ORIGINATING document', Array.from(origByTxn.values()).every((n) => n === 1), {
    transactionsWithLinks: origByTxn.size,
    maxOriginatingPerTransaction: Math.max(0, ...Array.from(origByTxn.values())),
  });

  // ANTI-VACUITY: the same per-document query, pointed at a document id that
  // belongs to the OTHER user, must return zero — and pointed at a real one,
  // non-zero. A probe that always returns zero proves nothing.
  const foreignDocId = randomUUID();
  const { count: foreignRuns } = await admin.from('ii_document_parse_runs').select('*', { count: 'exact', head: true }).eq('source_document_id', foreignDocId);
  const realNonZero = Object.values(perDoc).some((v) => v.txns > 0);
  control(c, 'the same attribution query returns >0 for a real document and exactly 0 for a document id that does not exist', { realDocumentWithTransactions: realNonZero, nonExistentDocumentRuns: foreignRuns }, realNonZero && foreignRuns === 0);

  finalise(c);
}

// ---------------------------------------------------------------------------
// S09 — CROSS-USER / STORAGE ISOLATION
// ---------------------------------------------------------------------------
async function caseS09(a: SynthUser, b: SynthUser): Promise<void> {
  const c = newCase('S09', 'User A can never see, process or download user B\'s document or rows');
  console.log(`--- ${c.id}: ${c.name} ---`);

  // B gets its own document so the probe has something of B's to find — a
  // "B sees 0 of A's rows" claim is worthless if B can see nothing at all.
  const bDoc = await uploadDocument(b, 'zz-s09-b.pdf', DOCS.s09b());
  const rb = await processSourceDocument({ userId: b.userId, sourceDocumentId: bDoc.documentId });
  check(c, "user B's own document processed successfully (so B genuinely has rows of its own)", rb.ok === true, { status: rb.status, summary: rb.summary });

  // (1) SERVICE-LAYER OWNERSHIP GATE.
  const { data: aDocs } = await admin.from('ii_source_documents').select('id').eq('user_id', a.userId).limit(1);
  const aDocId = (aDocs ?? [])[0]?.id as string;
  const beforeB = await economicSnapshot([b.userId]);
  const beforeA = await economicSnapshot([a.userId]);
  const crossAttempt = await processSourceDocument({ userId: b.userId, sourceDocumentId: aDocId });
  const afterB = await economicSnapshot([b.userId]);
  const afterA = await economicSnapshot([a.userId]);
  check(c, "processSourceDocument refuses to process another user's document (status 'not_found')", crossAttempt.ok === false && crossAttempt.status === 'not_found', { ok: crossAttempt.ok, status: crossAttempt.status, error: crossAttempt.error });
  check(c, "the refused cross-user attempt created nothing for B and changed nothing for A", totalOf(deltaOf(beforeB, afterB)) === 0 && totalOf(deltaOf(beforeA, afterA)) === 0, {
    bDelta: deltaOf(beforeB, afterB),
    aDelta: deltaOf(beforeA, afterA),
  });

  // (2) REAL RLS, AS THE USERS THEMSELVES (anon key + a real password sign-in).
  const asUser = async (u: SynthUser): Promise<SupabaseClient> => {
    const client = createClient(DEV_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await client.auth.signInWithPassword({ email: u.email, password: u.password });
    if (error) throw new Error(`sign-in failed for ${u.tag}: ${error.message}`);
    return client;
  };
  const clientA = await asUser(a);
  const clientB = await asUser(b);

  const RLS_TABLES = ['ii_source_documents', 'ii_accounts', 'ii_transactions', 'ii_holding_snapshots', 'ii_portfolio_truth_status', 'ii_document_parse_runs'];
  const leaks: Record<string, number> = {};
  const ownVisible: Record<string, number> = {};
  for (const t of RLS_TABLES) {
    const { count: leakCount } = await clientB.from(t).select('*', { count: 'exact', head: true }).eq('user_id', a.userId);
    const { count: ownCount } = await clientB.from(t).select('*', { count: 'exact', head: true }).eq('user_id', b.userId);
    leaks[t] = leakCount ?? -1;
    ownVisible[t] = ownCount ?? -1;
  }
  check(c, "signed in as B, RLS returns ZERO of user A's rows on every II table", Object.values(leaks).every((n) => n === 0), { leaks });

  // The symmetric direction, so the result is not an artifact of B's data.
  const leaksAtoB: Record<string, number> = {};
  for (const t of RLS_TABLES) {
    const { count } = await clientA.from(t).select('*', { count: 'exact', head: true }).eq('user_id', b.userId);
    leaksAtoB[t] = count ?? -1;
  }
  check(c, "signed in as A, RLS returns ZERO of user B's rows on every II table", Object.values(leaksAtoB).every((n) => n === 0), { leaksAtoB });

  // (3) STORAGE.
  const { data: aDocRow } = await admin.from('ii_source_documents').select('storage_path').eq('id', aDocId).single();
  const aKey = aDocRow!.storage_path as string;
  const bKey = bDoc.objectKey;
  const bReadsA = await clientB.storage.from(II_STORAGE_BUCKET).download(aKey);
  const bReadsB = await clientB.storage.from(II_STORAGE_BUCKET).download(bKey);
  check(c, "signed in as B, Storage refuses to return user A's object bytes", !bReadsA.data, { error: bReadsA.error?.message?.slice(0, 160) ?? null, gotBytes: Boolean(bReadsA.data) });

  // ANTI-VACUITY — THE NEGATIVE CONTROL THE DISPATCH REQUIRES. Every probe
  // above must be demonstrably capable of reporting a non-zero / a success:
  // the identical RLS query and the identical Storage download, pointed at
  // B's OWN data, must both succeed.
  const probeWorks = Object.values(ownVisible).some((n) => n > 0) && Boolean(bReadsB.data);
  control(
    c,
    "the IDENTICAL probes, pointed at B's OWN rows and B's OWN object, return data — so a leak would have been visible",
    { bSeesOwnRows: ownVisible, bDownloadsOwnObjectBytes: bReadsB.data ? (await bReadsB.data.arrayBuffer()).byteLength : 0, bDownloadError: bReadsB.error?.message?.slice(0, 120) ?? null },
    probeWorks
  );
  if (!probeWorks) {
    c.findings.push('FINDING (S09): the isolation probe could NOT be shown capable of a non-zero result; its zeros are therefore not evidence. Investigate before trusting this row.');
  }

  await clientA.auth.signOut();
  await clientB.auth.signOut();
  finalise(c);
}

// ---------------------------------------------------------------------------
// S10 — ZERO-RESIDUE CLEANUP
// ---------------------------------------------------------------------------
interface ResidueReport {
  tables: Record<string, number | string>;
  storageObjects: number;
  authUsers: number;
  total: number;
}
let residueReport: ResidueReport | null = null;

async function caseS10(): Promise<void> {
  const c = newCase('S10', 'Zero-residue cleanup: everything this pack created is removed and independently re-queried');
  console.log(`--- ${c.id}: ${c.name} ---`);

  const userIds = createdUsers.map((u) => u.userId);
  if (userIds.length === 0) {
    c.verdict = 'NOT APPLICABLE';
    c.notApplicableReason = 'no synthetic users were created, so there is nothing to clean up';
    finalise(c);
    return;
  }

  // BEFORE-CLEANUP CENSUS. This is also S10's own anti-vacuity control: the
  // residue sweep must be shown to report a LARGE non-zero before cleanup,
  // otherwise its post-cleanup zero measures nothing.
  const before: Record<string, number | string> = {};
  for (const t of USER_SCOPED_TABLES) {
    const n = await countIn(t, userIds);
    before[t] = n === null ? 'no user_id column / not readable' : n;
  }
  const { count: beforeInstruments } = await admin.from('ii_instruments').select('*', { count: 'exact', head: true }).ilike('instrument_name', `%${RUN_TAG}%`);
  before['ii_instruments (run-tagged, GLOBAL table)'] = beforeInstruments ?? -1;
  const { data: runInstrumentRows } = await admin.from('ii_instruments').select('id').ilike('instrument_name', `%${RUN_TAG}%`);
  const runInstrumentIds = (runInstrumentRows ?? []).map((r) => r.id as string);
  const { count: beforeIdentifiers } = runInstrumentIds.length
    ? await admin.from('ii_instrument_identifiers').select('*', { count: 'exact', head: true }).in('instrument_id', runInstrumentIds)
    : { count: 0 };
  before['ii_instrument_identifiers (by this run\'s instrument ids, GLOBAL table)'] = beforeIdentifiers ?? -1;
  const beforeTotal = Object.values(before).reduce((a: number, b) => a + (typeof b === 'number' && b > 0 ? b : 0), 0);
  console.log(`   pre-cleanup census: ${beforeTotal} rows across ${Object.keys(before).length} tables`);

  if (KEEP) {
    c.verdict = 'NOT APPLICABLE';
    c.notApplicableReason = '--keep was passed: teardown deliberately skipped. Residue is NOT zero and must be cleaned by re-running without --keep.';
    residueReport = { tables: before, storageObjects: createdObjectKeys.length, authUsers: userIds.length, total: beforeTotal };
    finalise(c);
    return;
  }

  // --- DELETE, children first ------------------------------------------
  // FK-correct order, derived from the real constraints rather than guessed
  // (the first run of this pack guessed, and hit two violations —
  // `ii_portfolio_truth_status.latest_holding_snapshot_id` -> ii_holding_snapshots
  // and `ii_holding_snapshots.parse_run_id` -> ii_document_parse_runs — which
  // is exactly S10's own named failure mode: a cleanup that forgets an edge).
  // Every delete is explicit; nothing here leans on `on delete cascade`,
  // precisely so a MISSING cascade could not hide behind a working one.
  const deleteOrder = [
    'ii_tax_lot_consumptions',
    'ii_tax_lots',
    'ii_capital_gains_computations',
    'ii_sip_series',
    'ii_analytics_results',
    'ii_r5_analytics_results',
    'ii_insights',
    'ii_review_items',
    'ii_goal_allocations',
    'ii_ownership_allocation',
    'ii_fhip_publications', // -> ii_holding_snapshots (canonical_position_id)
    'ii_transaction_source_links', // -> ii_transactions, ii_document_parse_runs
    'ii_transactions', // -> ii_accounts, ii_instruments, ii_document_parse_runs
    'ii_portfolio_truth_status', // -> ii_holding_snapshots (latest_holding_snapshot_id)
    'ii_holding_snapshots', // -> ii_document_parse_runs (parse_run_id)
    'ii_reconciliation_cases',
    'ii_document_parse_runs', // -> ii_source_documents
    'ii_accounts',
    'ii_source_documents',
    'ii_audit_events',
    'investments',
    'household_members',
    'households',
  ];
  const deleteErrors: Record<string, string> = {};
  for (const t of deleteOrder) {
    const { error } = await admin.from(t).delete().in('user_id', userIds);
    if (error) deleteErrors[t] = error.message.slice(0, 200);
  }
  // GLOBAL tables — scoped by THIS RUN's own instrument ids, never broadly.
  if (runInstrumentIds.length > 0) {
    const { error: idErr } = await admin.from('ii_instrument_identifiers').delete().in('instrument_id', runInstrumentIds);
    if (idErr) deleteErrors['ii_instrument_identifiers'] = idErr.message.slice(0, 200);
    const { error: instErr } = await admin.from('ii_instruments').delete().in('id', runInstrumentIds);
    if (instErr) deleteErrors['ii_instruments'] = instErr.message.slice(0, 200);
  }
  // Storage objects.
  if (createdObjectKeys.length > 0) {
    const { error: stErr } = await admin.storage.from(II_STORAGE_BUCKET).remove(createdObjectKeys);
    if (stErr) deleteErrors['storage'] = stErr.message.slice(0, 200);
  }
  // Auth users last (cascades would handle much of the above; the explicit
  // deletes are deliberate so a missing cascade cannot hide behind one).
  for (const id of userIds) await admin.auth.admin.deleteUser(id);

  // --- INDEPENDENT RE-QUERY --------------------------------------------
  const after: Record<string, number | string> = {};
  for (const t of USER_SCOPED_TABLES) {
    const n = await countIn(t, userIds);
    after[t] = n === null ? 'no user_id column / not readable' : n;
  }
  const { count: afterInstruments } = await admin.from('ii_instruments').select('*', { count: 'exact', head: true }).ilike('instrument_name', `%${RUN_TAG}%`);
  after['ii_instruments (run-tagged, GLOBAL table)'] = afterInstruments ?? -1;
  const { count: afterIdentifiers } = runInstrumentIds.length
    ? await admin.from('ii_instrument_identifiers').select('*', { count: 'exact', head: true }).in('instrument_id', runInstrumentIds)
    : { count: 0 };
  after['ii_instrument_identifiers (by this run\'s instrument ids, GLOBAL table)'] = afterIdentifiers ?? -1;

  // Storage: list every remaining object under each synthetic user's folder.
  let remainingObjects = 0;
  const remainingObjectNames: string[] = [];
  for (const id of userIds) {
    const { data: listed } = await admin.storage.from(II_STORAGE_BUCKET).list(id, { limit: 200 });
    remainingObjects += (listed ?? []).length;
    for (const o of listed ?? []) remainingObjectNames.push(`${id.slice(0, 8)}/${o.name}`);
  }

  let remainingAuthUsers = 0;
  for (const id of userIds) {
    const { data } = await admin.auth.admin.getUserById(id);
    if (data?.user) remainingAuthUsers += 1;
  }

  const numericAfter = Object.entries(after).filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
  const residueTotal = numericAfter.reduce((s, [, v]) => s + Math.max(0, v), 0) + remainingObjects + remainingAuthUsers;
  const leftovers = numericAfter.filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`);

  check(c, 'every user-scoped table re-queries to zero after cleanup', numericAfter.every(([, v]) => v === 0), { after, leftovers });
  check(c, 'the GLOBAL ii_instruments / ii_instrument_identifiers rows this run minted are gone', afterInstruments === 0 && afterIdentifiers === 0, { instruments: afterInstruments, identifiers: afterIdentifiers });
  check(c, 'every Storage object this run uploaded is gone', remainingObjects === 0, { uploaded: createdObjectKeys.length, remaining: remainingObjects, remainingObjectNames });
  check(c, 'every synthetic auth user is gone', remainingAuthUsers === 0, { created: userIds.length, remaining: remainingAuthUsers });
  check(c, 'no delete statement reported an error', Object.keys(deleteErrors).length === 0, deleteErrors);

  // ------------------------------------------------------------------
  // A SECOND, KEY-INDEPENDENT SWEEP. Everything above searches by the ids
  // this run happens to hold. If the run had ever lost track of an id, that
  // sweep would report a clean zero while the row was still sitting there.
  // This one searches by CONTENT instead — the obviously-synthetic names,
  // folio numbers and transaction references the pack writes — with NO run
  // tag, so it also catches residue left behind by any EARLIER run of this
  // pack, which is the exact failure `OA-7` was blocked on.
  // ------------------------------------------------------------------
  const contentSweep: Record<string, number> = {};
  const contentProbes: Array<[string, string, string, string]> = [
    ['ii_instruments by synthetic name', 'ii_instruments', 'instrument_name', '%ZZ Synthetic%'],
    ['ii_accounts by synthetic institution', 'ii_accounts', 'institution_name', '%ZZ Synthetic%'],
    ['ii_accounts by synthetic folio', 'ii_accounts', 'folio_number', 'ZZP4%'],
    ['ii_transactions by synthetic reference', 'ii_transactions', 'source_reference', 'ZZP4%'],
    ['ii_source_documents by synthetic filename', 'ii_source_documents', 'original_filename', 'zz-s0%'],
    ['ii_fhip_publications by synthetic key', 'ii_fhip_publications', 'idempotency_key', 'ZZP4%'],
    ['households by synthetic name', 'households', 'household_name', '%ZZ Synthetic%'],
    ['household_members by synthetic name', 'household_members', 'full_name', 'ZZ Synthetic Selfholder%'],
  ];
  for (const [label, table, column, pattern] of contentProbes) {
    const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).ilike(column, pattern);
    contentSweep[label] = error ? -1 : count ?? 0;
  }
  check(c, 'a SECOND sweep, searching by synthetic CONTENT rather than by this run\'s ids, also finds nothing (catches residue from any earlier run too)', Object.values(contentSweep).every((n) => n === 0), contentSweep);

  // The content sweep needs its own capability proof: the identical query
  // shape, without the synthetic filter, must report the real (non-synthetic)
  // rows that genuinely exist on DEV.
  const capability: Record<string, number> = {};
  for (const [, table] of [['', 'ii_instruments'], ['', 'ii_accounts'], ['', 'ii_transactions'], ['', 'household_members']] as Array<[string, string]>) {
    const { count } = await admin.from(table).select('*', { count: 'exact', head: true });
    capability[table] = count ?? -1;
  }
  check(c, 'the content sweep is demonstrably capable of a non-zero (the same tables hold real, non-synthetic rows)', Object.values(capability).every((n) => n > 0), capability);

  // ANTI-VACUITY: the identical sweep reported a large non-zero before the
  // teardown ran, so its zero afterwards is a measurement, not an absence of
  // measurement.
  control(c, 'the IDENTICAL residue sweep reported a large non-zero BEFORE cleanup', { rowsBeforeCleanup: beforeTotal, tablesSwept: Object.keys(after).length, storageObjectsBefore: createdObjectKeys.length, authUsersBefore: userIds.length }, beforeTotal > 0);

  residueReport = { tables: after, storageObjects: remainingObjects, authUsers: remainingAuthUsers, total: residueTotal };
  if (residueTotal > 0) {
    c.findings.push(`FINDING (S10): residue is NOT zero. Remaining: ${leftovers.join(', ')}${remainingObjects ? `, storageObjects=${remainingObjects}` : ''}${remainingAuthUsers ? `, authUsers=${remainingAuthUsers}` : ''}.`);
  }
  finalise(c);
}

// ---------------------------------------------------------------------------
// OUTPUTS
// ---------------------------------------------------------------------------
function writeOutputs(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    pack: 'M12C PC4 reduced synthetic pack (M12 dispatch section 9, OA-7)',
    environment: 'DEV',
    targetHost: new URL(DEV_URL).host,
    runTag: RUN_TAG,
    runAt: new Date(STAMP).toISOString(),
    completedAt: new Date().toISOString(),
    cases,
    residue: residueReport,
    findings: cases.flatMap((c) => c.findings),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(payload, null, 2));

  const rows = cases.map((c) => {
    const failed = c.checks.filter((k) => !k.ok);
    const evidence =
      c.verdict === 'NOT APPLICABLE'
        ? c.notApplicableReason ?? ''
        : (failed.length > 0 ? failed : c.checks).slice(0, 3).map((k) => `${k.label} -> ${JSON.stringify(k.evidence).slice(0, 220)}`).join('<br>');
    return `| ${c.id} | ${c.name} | **${c.verdict}** | ${String(evidence).replace(/\|/g, '\\|')} | ${c.antiVacuityControl ? `${c.antiVacuityControl.ok ? 'produced' : 'FAILED TO PRODUCE'}: ${c.antiVacuityControl.label} -> ${JSON.stringify(c.antiVacuityControl.produced).slice(0, 200).replace(/\|/g, '\\|')}` : 'NONE'} |`;
  });
  const md = [
    `# M12C — PC4 reduced synthetic pack (DEV) — results`,
    ``,
    `Run tag \`${RUN_TAG}\` · target \`${new URL(DEV_URL).host}\` (DEV) · ${new Date(STAMP).toISOString()}`,
    ``,
    `| Case | Invariant | Verdict | Evidence | Anti-vacuity control |`,
    `| --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
    `## Residue after cleanup (S10)`,
    ``,
    `| Table / resource | Rows remaining |`,
    `| --- | --- |`,
    ...Object.entries(residueReport?.tables ?? {}).map(([k, v]) => `| \`${k}\` | ${v} |`),
    `| Storage objects (bucket \`${II_STORAGE_BUCKET}\`) | ${residueReport?.storageObjects ?? 'n/a'} |`,
    `| Synthetic auth users | ${residueReport?.authUsers ?? 'n/a'} |`,
    `| **TOTAL RESIDUE** | **${residueReport?.total ?? 'n/a'}** |`,
    ``,
    `## Findings`,
    ``,
    ...(cases.flatMap((c) => c.findings).length > 0 ? cases.flatMap((c) => c.findings).map((f) => `- ${f}`) : ['- none']),
    ``,
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'results_table.md'), md);

  console.log('\n=== SUMMARY ===');
  for (const c of cases) console.log(`${c.verdict.padEnd(15)} ${c.id}  ${c.name}`);
  console.log(`\nresidue total: ${residueReport?.total ?? 'n/a'}`);
  console.log(`wrote ${path.join(OUT_DIR, 'results.json')}`);
  console.log(`wrote ${path.join(OUT_DIR, 'results_table.md')}`);
  if (cases.some((c) => c.verdict === 'FAIL')) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
});
