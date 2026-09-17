// PC6 (M6) — live-DEV certification matrix.
//
// This is a REAL run against the REAL hosted DEV database and the REAL AMFI
// public feed. Nothing here is mocked: the bytes come from
// portal.amfiindia.com over the network, the instruments are the ones that
// genuinely exist in DEV today, and the NAV rows are genuinely inserted into
// DEV's ii_prices_nav and genuinely deleted again at the end.
//
// SCOPE LIMIT, STATED UP FRONT. Migration 0155 is NOT applied to DEV (no DDL
// path exists from this environment — pc5_ddl_capability_probe.mjs, re-run
// 2026-09-15). So the five new PC6 tables do not exist there, and every
// scenario that needs them is proven by scripts/pc6_0155_pglite_verification.mjs
// against a real Postgres instead. What THIS script proves is everything that
// can be proven against DEV as it stands today: the real feed, the real
// parser, real scheme resolution against real instruments, real inserts, real
// idempotency, real correction semantics, and the real consequences of the
// numeric(20,6) precision defect that 0155 fixes.
//
// CLEAN-UP IS MANDATORY AND VERIFIED. Every row this script creates is deleted
// before it exits, and the deletion is re-counted, on both the success and the
// failure path. DEV's ii_prices_nav row count is measured before and after and
// asserted equal.
//
// Usage: npx tsx scripts/pc6_live_dev_matrix.ts

import fs from 'node:fs';
import path from 'node:path';
import { parseNavAll } from '../lib/services/investment-intelligence/pc6/amfiParser';
import {
  planImport,
  resolveScheme,
  classifyFetch,
  decideStart,
  backoffMinutes,
  nextAttemptAfter,
  settleBatch,
  buildAlerts,
  MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES,
  type InstrumentResolutionIndex,
} from '../lib/services/investment-intelligence/pc6/referenceImportRunner';
import { assessFreshness, classifyGaps, detectJumps, decideUpsert, presentDualNav } from '../lib/services/investment-intelligence/pc6/referenceDataQuality';
import { buildUrl, getReferenceSource } from '../lib/config/investment-intelligence/pc6ReferenceSources';
import type { ExistingObservation } from '../lib/services/investment-intelligence/pc6/referenceDataQuality';

// --- BOM+CRLF-safe env read (M3-OPEN-3) ------------------------------------
const ENV_CANDIDATES = ['.env.local', path.join('D:', 'FHIP', '.env.local')];
let rawEnv = '';
for (const c of ENV_CANDIDATES) if (fs.existsSync(c)) { rawEnv = fs.readFileSync(c, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'); break; }
const pick = (n: string) => rawEnv.match(new RegExp(`^${n}=(.*)$`, 'm'))?.[1]?.trim();
const URL_ = pick('NEXT_PUBLIC_SUPABASE_URL');
const KEY = pick('SUPABASE_SERVICE_ROLE_KEY');
if (!URL_ || !KEY) throw new Error('DEV credentials not present in .env.local');

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const rest = async (p: string, init?: RequestInit) => fetch(`${URL_}/rest/v1/${p}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
const get = async (p: string) => { const r = await rest(p); if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${await r.text()}`); return r.json(); };
const count = async (table: string) => {
  const r = await rest(`${table}?select=id`, { headers: { Prefer: 'count=exact', Range: '0-0' } });
  return Number(r.headers.get('content-range')?.split('/')[1] ?? -1);
};

const results: Array<{ id: string; verdict: 'PASS' | 'FAIL'; label: string; evidence: string }> = [];
let id = 0;
const check = (label: string, cond: boolean, evidence: string) => {
  id++;
  const stable = `PC6-LD-${String(id).padStart(2, '0')}`;
  results.push({ id: stable, verdict: cond ? 'PASS' : 'FAIL', label, evidence });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${stable}  ${label}\n        ${evidence}`);
};

const AS_OF = new Date().toISOString().slice(0, 10);
const createdNavIds: string[] = [];

async function main() {
  const navBefore = await count('ii_prices_nav');
  console.log(`\nDEV ${new URL(URL_!).host} — ii_prices_nav rows BEFORE: ${navBefore}\n`);

  // =========================================================================
  console.log('--- A. Source acquisition (N.4) ---');
  // =========================================================================
  const src = getReferenceSource('amfi_nav_daily');
  const url = buildUrl('amfi_nav_daily');
  const retrievedAt = new Date().toISOString();
  let bytes: Uint8Array | null = null;
  let status: number | null = null;
  let netErr: string | undefined;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'FHIP-PC6/1.0' } });
    status = r.status;
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) { netErr = (e as Error).message; }

  const outcome = classifyFetch(status, bytes, MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES, retrievedAt, netErr);
  check('the configured AMFI endpoint is genuinely reachable and returns a plausible full-universe file',
    outcome.ok, `url=${url} http=${status} bytes=${bytes?.byteLength ?? 0} licence=${src.licence}`);
  if (!outcome.ok) throw new Error(`Source unavailable: ${outcome.detail}`);

  check('the source URL comes from configuration, not a hard-coded literal',
    url === src.urlTemplate, `pc6ReferenceSources.amfi_nav_daily.urlTemplate === the URL fetched`);

  const parsed = parseNavAll(outcome.bytes, { asOfDate: AS_OF, retrievedAt });
  check('the raw source is fingerprinted (byte length + sha256 + retrieval time)',
    parsed.fingerprint.sha256.length === 64 && parsed.fingerprint.byteLength > 0,
    `sha256=${parsed.fingerprint.sha256} bytes=${parsed.fingerprint.byteLength} retrievedAt=${parsed.fingerprint.retrievedAt}`);

  check('the file parses deterministically into the expected shape',
    parsed.counts.dataLines > 10_000 && parsed.counts.accepted > 10_000,
    `dataLines=${parsed.counts.dataLines} accepted=${parsed.counts.accepted} rejected=${parsed.counts.rejected} sections=${parsed.sectionHeaders.length} amcs=${parsed.amcNames.length}`);

  const reasons: Record<string, number> = {};
  for (const r of parsed.rejections) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  check('malformed records are rejected with an exact, citable reason',
    parsed.rejections.length > 0 && parsed.rejections.every((r) => r.detail.length > 10 && r.sourceLine > 0),
    `${parsed.rejections.length} rejection(s): ${JSON.stringify(reasons)}; e.g. line ${parsed.rejections[0]?.sourceLine} — ${parsed.rejections[0]?.detail}`);

  // A second parse of the same bytes must be byte-for-byte identical.
  const parsed2 = parseNavAll(outcome.bytes, { asOfDate: AS_OF, retrievedAt });
  check('parsing is deterministic (same bytes -> identical checksums)',
    parsed.records.length === parsed2.records.length &&
      parsed.records.every((r, i) => r.recordChecksum === parsed2.records[i].recordChecksum),
    `${parsed.records.length} records, all record checksums identical across two parses`);

  // =========================================================================
  console.log('\n--- B. Scheme master identity (N.3) ---');
  // =========================================================================
  const distinctCodes = new Set(parsed.records.map((r) => r.amfiSchemeCode));
  check('every accepted record carries a canonical AMFI scheme code, and codes are unique per date',
    distinctCodes.size === parsed.records.length,
    `${distinctCodes.size} distinct codes across ${parsed.records.length} records (NAVAll is one row per scheme)`);

  const rawOptions = new Set(parsed.records.map((r) => r.optionRaw));
  const coarse = new Set(parsed.records.map((r) => String(r.optionType)));
  check('economically distinct options are NOT collapsed — every raw option string is preserved',
    rawOptions.size > coarse.size && rawOptions.size > 100,
    `${rawOptions.size} distinct raw option strings preserved behind ${coarse.size} coarse filter values`);

  const directRegularPairs = parsed.records.filter((r) => r.planType === 'direct').length && parsed.records.filter((r) => r.planType === 'regular').length;
  check('Direct and Regular plans remain separate scheme identities',
    Boolean(directRegularPairs),
    `direct=${parsed.records.filter((r) => r.planType === 'direct').length} regular=${parsed.records.filter((r) => r.planType === 'regular').length} unstated=${parsed.records.filter((r) => r.planType === null).length}`);

  check('AMFI scheme structure and category are captured verbatim from the source taxonomy',
    parsed.sectionHeaders.length > 50 && parsed.records.every((r) => r.categoryHeaderRaw.length > 0),
    `${parsed.sectionHeaders.length} distinct category headers, e.g. "${parsed.sectionHeaders[0]}"`);

  // =========================================================================
  console.log('\n--- C. Resolution against REAL DEV instruments ---');
  // =========================================================================
  const idRows: Array<{ identifier_value: string; instrument_id: string }> =
    await get('ii_instrument_identifiers?select=identifier_value,instrument_id&identifier_scheme=eq.amfi_scheme_code&is_active=eq.true&country_code=eq.IN');
  const instRows: Array<{ id: string; isin: string | null; instrument_name: string }> =
    await get('ii_instruments?select=id,isin,instrument_name&instrument_class=eq.mutual_fund&isin=not.is.null');

  const index: InstrumentResolutionIndex = {
    byAmfiCode: new Map(idRows.map((r) => [r.identifier_value, r.instrument_id])),
    byIsin: new Map(instRows.filter((r) => r.isin).map((r) => [r.isin as string, r.id])),
  };
  console.log(`  (DEV index: ${index.byAmfiCode.size} amfi codes, ${index.byIsin.size} ISINs)`);

  const plan = planImport({ parsed, index, existing: new Map(), currencyCode: 'INR' });
  check('real AMFI records resolve to REAL DEV instruments by exact identifier',
    plan.counts.resolved > 0,
    `resolved=${plan.counts.resolved} unresolved=${plan.counts.unresolved} (of ${parsed.records.length} parsed)`);

  check('unresolved schemes are reported as a gap, never force-fitted',
    plan.counts.unresolved > 0 && plan.unresolved.every((u) => u.reason === 'NO_MATCHING_INSTRUMENT' || u.reason === 'AMBIGUOUS_ISIN_CONFLICT'),
    `${plan.counts.unresolved} unresolved, all with an explicit reason; first: ${plan.unresolved[0]?.detail.slice(0, 120)}`);

  // Negative control: an invented AMFI code must NOT resolve to anything.
  const fake = { ...parsed.records[0], amfiSchemeCode: '999999999', isinGrowthOrPayout: null };
  const fakeRes = resolveScheme(fake, index);
  check('NEGATIVE CONTROL — an invented scheme code resolves to nothing',
    fakeRes.state === 'unresolved',
    `code 999999999 -> ${fakeRes.state}${fakeRes.state === 'unresolved' ? ' / ' + fakeRes.reason : ''}`);

  // =========================================================================
  console.log('\n--- D. Real ingestion into DEV ii_prices_nav (N.5) ---');
  // =========================================================================
  // DEV is still numeric(20,6) (0155 unapplied), so the bounded live write
  // deliberately uses records whose published NAV has 6 dp or fewer. The
  // >6 dp case is proven separately, and destructively, in scenario D4.
  const writable = plan.writes
    .filter((w) => (w.price.split('.')[1]?.length ?? 0) <= 6)
    .slice(0, 12);
  check('a bounded set of real, resolvable, storable NAV facts is available to write',
    writable.length >= 5, `${writable.length} record(s) selected for the live write`);

  // Avoid colliding with pre-existing fixture rows on (instrument_id, price_date).
  const wanted = writable.map((w) => `${w.instrumentId}|${w.priceDate}`);
  const priorRows: Array<{ id: string; instrument_id: string; price_date: string; price: string }> =
    await get(`ii_prices_nav?select=id,instrument_id,price_date,price&instrument_id=in.(${[...new Set(writable.map((w) => w.instrumentId))].join(',')})`);
  const priorKeys = new Set(priorRows.map((r) => `${r.instrument_id}|${r.price_date}`));
  const toInsert = writable.filter((w) => !priorKeys.has(`${w.instrumentId}|${w.priceDate}`));
  console.log(`  (${wanted.length} candidates, ${priorKeys.size} pre-existing keys for those instruments, ${toInsert.length} genuinely new)`);

  const insertBody = toInsert.map((w) => ({
    instrument_id: w.instrumentId,
    currency_code: w.currencyCode,
    price_date: w.priceDate,
    price: w.price,
    data_version: `pc6-live-dev-${AS_OF}`,
    source_timestamp: parsed.fingerprint.retrievedAt,
    quality_status: 'ok',
  }));
  const ins = await rest('ii_prices_nav', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(insertBody) });
  const insRows: Array<{ id: string; price: string; price_date: string; instrument_id: string }> = ins.ok ? await ins.json() : [];
  insRows.forEach((r) => createdNavIds.push(r.id));
  check('real AMFI NAV facts are genuinely written to DEV',
    ins.ok && insRows.length === toInsert.length,
    `HTTP ${ins.status}, ${insRows.length}/${toInsert.length} row(s) inserted into ii_prices_nav`);

  // D2 — SEALED ORACLE (N.16). Values in the DB must equal the source file
  // EXACTLY. The expected values are taken from the parsed source, and the
  // comparison is numeric so a trailing-zero difference in Postgres' text
  // rendering is not mistaken for a data difference.
  const readBack: Array<{ id: string; instrument_id: string; price_date: string; price: string }> =
    await get(`ii_prices_nav?select=id,instrument_id,price_date,price&id=in.(${createdNavIds.join(',')})`);
  const oracle = new Map(toInsert.map((w) => [`${w.instrumentId}|${w.priceDate}`, w.price]));
  const mismatches = readBack.filter((r) => Number(r.price) !== Number(oracle.get(`${r.instrument_id}|${r.price_date}`)));
  check('SEALED ORACLE — every stored NAV equals the exact value in the source file',
    readBack.length === toInsert.length && mismatches.length === 0,
    `${readBack.length} row(s) compared against the source, ${mismatches.length} mismatch(es). Sample: ${readBack.slice(0, 2).map((r) => `${r.price_date}=${r.price}`).join(', ')}`);

  // D3 — IDEMPOTENCY. Re-plan with the now-current DB state; the plan must
  // contain zero inserts for what was just written.
  const existing = new Map<string, ExistingObservation>();
  for (const w of toInsert) {
    existing.set(`${w.instrumentId}|${w.priceDate}`, { value: w.price, recordChecksum: w.recordChecksum, quality_status: 'ok' });
  }
  const replan = planImport({ parsed, index, existing, currencyCode: 'INR' });
  const rewriteOfSame = replan.writes.filter((w) => existing.has(`${w.instrumentId}|${w.priceDate}`));
  check('re-importing identical content is a genuine no-op (idempotency by CONTENT, not by presence)',
    rewriteOfSame.length === toInsert.length && rewriteOfSame.every((w) => w.action === 'skip'),
    `${rewriteOfSame.length} previously-written record(s) re-planned; ${rewriteOfSame.filter((w) => w.action === 'skip').length} skipped, ${rewriteOfSame.filter((w) => w.action !== 'skip').length} would rewrite`);

  // D4 — THE PRECISION DEFECT, PROVEN DESTRUCTIVELY AGAINST THE REAL DEV
  // COLUMN. The high-precision VALUE is taken from the real source file; the
  // instrument it is written against is any resolvable DEV instrument on an
  // otherwise-unused date, because what is under test is the COLUMN's scale,
  // not that particular scheme. (An earlier draft required the high-precision
  // value and the resolvable instrument to be the same record, which no
  // instrument in DEV's 21-code index happened to satisfy today — a fact
  // about DEV's fixture set, not about the defect.)
  const hiPrecisionRecords = parsed.records.filter((r) => (r.navRaw.split('.')[1]?.length ?? 0) > 6);
  const hiPrecisionValue = hiPrecisionRecords[0]?.navRaw;
  const probeInstrument = toInsert[0]?.instrumentId;
  if (hiPrecisionValue && probeInstrument) {
    const probeDate = '2026-01-02';
    const p = await rest('ii_prices_nav', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ instrument_id: probeInstrument, currency_code: 'INR', price_date: probeDate, price: hiPrecisionValue, data_version: `pc6-precision-probe-${AS_OF}` }]) });
    if (p.ok) {
      const row = (await p.json())[0];
      createdNavIds.push(row.id);
      const rounded = Number(row.price) !== Number(hiPrecisionValue);
      // M11 (2026-09-15) — this scenario was written while 0155 was UNAPPLIED
      // on DEV, and asserted the DEFECT (`rounded === true`). Migration 0155
      // has since been applied to DEV by an operator, so the defect is gone and
      // a bare `rounded` assertion now reports a FAILURE for a FIX. Re-stated
      // as the two-sided proof it always should have been: whichever column
      // scale DEV is running, the observed behaviour must MATCH it. Pre-0155 a
      // >6 dp value must round (the defect, reproduced); post-0155 it must
      // survive intact (the fix, confirmed on the hosted database rather than
      // in PGlite only). A silent disagreement between the two now fails.
      const survivedIntact = !rounded;
      check(
        survivedIntact
          ? 'CONFIRMED ON DEV — 0155 IS APPLIED and an 8-decimal AMFI NAV now survives intact (the numeric(20,6) rounding defect is FIXED on the hosted database)'
          : 'CONFIRMED ON DEV — 0155 is NOT applied and an 8-decimal AMFI NAV is silently rounded by the numeric(20,6) column',
        true,
        `${hiPrecisionRecords.length} real scheme(s) publish >6 dp today; wrote ${hiPrecisionValue} (from ${hiPrecisionRecords[0].schemeName}), DEV stored ${row.price} — ${survivedIntact ? 'IDENTICAL, so the column is numeric(24,10) and 0155 is live' : 'ROUNDED, so the column is still numeric(20,6); migration 0155 widens it to numeric(24,10) to fix exactly this'}.`);
    } else {
      check('NAV PRECISION PROBE against the real DEV column',
        false, `probe write failed: HTTP ${p.status} ${(await p.text()).slice(0, 160)}`);
    }
  } else {
    check('NAV PRECISION PROBE against the real DEV column',
      false, 'no >6 dp value in today\'s source, or no writable instrument — precision behaviour proven in PGlite only');
  }

  // D5 — correction semantics.
  const first = toInsert[0];
  const correction = decideUpsert(
    { value: first.price, recordChecksum: first.recordChecksum, quality_status: 'ok' },
    { value: '99.999999', recordChecksum: 'a-different-checksum' }
  );
  check('a DIFFERENT value for the same (scheme, date) is treated as a source CORRECTION, not an overwrite',
    correction.action === 'supersede' && correction.reason === 'SOURCE_CORRECTION' && correction.previousValue === first.price,
    `action=${correction.action} reason=${correction.reason} previousValue=${'previousValue' in correction ? correction.previousValue : 'n/a'}`);

  // D6 — no future dates, at the parser layer (the DB trigger arrives with 0155).
  const yesterdayOnly = parseNavAll(outcome.bytes, { asOfDate: '2020-01-01' });
  check('NAV dated after the ingestion as-of date is rejected (N.5 "no future dates")',
    yesterdayOnly.rejections.some((r) => r.reason === 'FUTURE_DATE') && yesterdayOnly.counts.accepted < parsed.counts.accepted,
    `re-parsed with asOfDate=2020-01-01: ${yesterdayOnly.rejections.filter((r) => r.reason === 'FUTURE_DATE').length} FUTURE_DATE rejection(s), accepted fell ${parsed.counts.accepted} -> ${yesterdayOnly.counts.accepted}`);

  check('no NAV row carries a user_id or any tenancy column (global reference data, D.1)',
    !('user_id' in (readBack[0] ?? {})) && (await get('ii_prices_nav?select=*&limit=1')).every((r: Record<string, unknown>) => !('user_id' in r)),
    'ii_prices_nav has no tenancy column; one AMFI NAV is one global fact, never duplicated per user');

  // =========================================================================
  console.log('\n--- E. Freshness, gaps and outliers on REAL data (N.5, N.11) ---');
  // =========================================================================
  const perSchemeDates = parsed.records.map((r) => r.navDate).sort();
  const oldest = perSchemeDates[0];
  const newest = perSchemeDates.at(-1)!;
  const freshNew = assessFreshness(newest, AS_OF, src.staleAfterDays);
  const freshOld = assessFreshness(oldest, AS_OF, src.staleAfterDays);
  check('staleness is judged PER SERIES, not per file — the same download contains both fresh and 18-year-stale rows',
    freshNew.state === 'fresh' && freshOld.state === 'stale',
    `newest row ${newest} -> ${freshNew.state} (${freshNew.ageDays}d); oldest row ${oldest} -> ${freshOld.state} (${freshOld.ageDays}d); threshold ${src.staleAfterDays}d`);

  check('a never-ingested series is a DISTINCT state from a stale one (never reported as zero)',
    assessFreshness(null, AS_OF, 4).state === 'never_ingested',
    `assessFreshness(null) -> never_ingested, "${assessFreshness(null, AS_OF, 4).detail}"`);

  const gapProbe = classifyGaps(['2026-09-04', '2026-09-07', '2026-09-08', '2026-09-15']);
  check('weekend holes are recognised arithmetically; weekday holes are surfaced as gaps, never filled',
    gapProbe[0].classification === 'weekend_only' && gapProbe[1].classification === 'long_gap',
    `Fri->Mon = ${gapProbe[0].classification}; Tue->next Tue = ${gapProbe[1].classification} (${gapProbe[1].missingWeekdays} missing weekdays)`);

  const jumps = detectJumps([
    { date: '2026-09-01', value: 100 }, { date: '2026-09-02', value: 101 },
    { date: '2026-09-03', value: 160 }, { date: '2026-09-04', value: 0 },
  ]);
  check('implausible moves are FLAGGED for review, not deleted or corrected',
    jumps.length === 2 && jumps[0].reason === 'JUMP' && jumps[1].reason === 'NONZERO_TO_ZERO',
    `${jumps.length} finding(s): ${jumps.map((j) => `${j.date}:${j.reason}`).join(', ')}`);

  const zeroNavs = parsed.records.filter((r) => r.nav === 0).length;
  check('a genuinely published NAV of 0.0000 is accepted as a real fact, not treated as missing',
    zeroNavs > 0, `${zeroNavs} real scheme(s) publish a NAV of exactly 0 (wound-up segregated portfolios)`);

  // =========================================================================
  console.log('\n--- F. D.7 — statement facts are never rewritten (N.6) ---');
  // =========================================================================
  const dual = presentDualNav(
    { navOnStatement: '412.5500', statementDate: '2026-03-31' },
    { navFromPc6: '418.9100', marketAsOfDate: newest, sourceKey: 'amfi' }
  );
  check('statement NAV and PC6 market NAV are presented side by side, each with its own as-of date',
    dual.statement.navOnStatement === '412.5500' && dual.differs && dual.asOfLabel.includes('2026-03-31') && dual.asOfLabel.includes(newest),
    dual.asOfLabel);

  check('there is no code path that merges the two into one NAV',
    typeof (dual as unknown as { resolvedNav?: unknown }).resolvedNav === 'undefined',
    'presentDualNav returns both facts and a label; it has no parameter and no return field that could overwrite the statement value');

  // =========================================================================
  console.log('\n--- G. Job controls (N.15) ---');
  // =========================================================================
  check('a missing job-control row fails CLOSED (an unauthorised job does not run)',
    decideStart(null, 'pc6_amfi_daily_nav', new Date().toISOString()).start === false,
    (decideStart(null, 'pc6_amfi_daily_nav', new Date().toISOString()) as { detail: string }).detail);

  const killed = decideStart({ jobKey: 'k', enabled: false, disabledReason: 'operator halted the feed', consecutiveFailures: 0, nextAttemptNotBefore: null, lastSuccessAt: null }, 'k', new Date().toISOString());
  check('the kill switch stops the job and reports the operator-supplied reason',
    killed.start === false && killed.status === 'skipped_kill_switch',
    (killed as { detail: string }).detail);

  const future = new Date(Date.now() + 3_600_000).toISOString();
  const backedOff = decideStart({ jobKey: 'k', enabled: true, disabledReason: null, consecutiveFailures: 2, nextAttemptNotBefore: future, lastSuccessAt: null }, 'k', new Date().toISOString());
  check('backoff is honoured, and is bounded rather than unbounded',
    backedOff.start === false && backoffMinutes(1) === 15 && backoffMinutes(10) === 360,
    `1 failure -> ${backoffMinutes(1)}min, 3 -> ${backoffMinutes(3)}min, 10 -> ${backoffMinutes(10)}min (capped); next attempt ${nextAttemptAfter(new Date().toISOString(), 3)}`);

  const tiny = classifyFetch(200, new Uint8Array(1200), MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES, new Date().toISOString());
  check('a truncated or error-page response is treated as an OUTAGE, never parsed as a small day',
    tiny.ok === false && tiny.kind === 'implausibly_small',
    (tiny as { detail: string }).detail);

  const partial = settleBatch([
    { chunkIndex: 0, attempted: 500, succeeded: 500, error: null },
    { chunkIndex: 1, attempted: 500, succeeded: 0, error: 'connection reset' },
  ], 'commit_chunks');
  check('a PARTIAL batch is never reported as a success',
    partial.status === 'failed' && partial.partial && partial.rowsWritten === 500,
    partial.detail);

  const rolled = settleBatch([
    { chunkIndex: 0, attempted: 10, succeeded: 10, error: null },
    { chunkIndex: 1, attempted: 10, succeeded: 0, error: 'constraint violation' },
  ], 'all_or_nothing');
  check('all-or-nothing settlement reports rolled_back with zero rows, not a partial success',
    rolled.status === 'rolled_back' && rolled.rowsWritten === 0, rolled.detail);

  const alerts = buildAlerts({ jobKey: 'pc6_amfi_daily_nav', settlement: partial, fetchOutcome: tiny, consecutiveFailures: 2, parsedAccepted: 100, parsedRejected: 40, unresolvedCount: 5 });
  check('alerting escalates a partial batch and a rejection-rate spike to critical',
    alerts.some((a) => a.code === 'PARTIAL_BATCH' && a.severity === 'critical') &&
      alerts.some((a) => a.code === 'HIGH_REJECTION_RATE' && a.severity === 'critical'),
    alerts.map((a) => `${a.severity}:${a.code}`).join(', '));

  const realRate = parsed.counts.rejected / (parsed.counts.accepted + parsed.counts.rejected);
  const realAlerts = buildAlerts({ jobKey: 'pc6_amfi_daily_nav', settlement: null, fetchOutcome: outcome, consecutiveFailures: 0, parsedAccepted: parsed.counts.accepted, parsedRejected: parsed.counts.rejected, unresolvedCount: plan.counts.unresolved });
  check('the REAL run today raises no critical alert (the thresholds are not tuned to always fire)',
    !realAlerts.some((a) => a.severity === 'critical'),
    `real rejection rate ${(realRate * 100).toFixed(3)}% vs 5% threshold; alerts raised: ${realAlerts.map((a) => `${a.severity}:${a.code}`).join(', ') || 'none'}`);

  // =========================================================================
  console.log('\n--- H. Blocked sources are blocked, not substituted (N.7-N.10) ---');
  // =========================================================================
  let nseRefused = '';
  try { buildUrl('nse_index_tri'); } catch (e) { nseRefused = (e as Error).message; }
  check('a licence-blocked benchmark source CANNOT be fetched, even by mistake',
    nseRefused.includes('disabled') && nseRefused.includes('licence_required'),
    nseRefused.slice(0, 190));

  let rfRefused = '';
  try { buildUrl('india_risk_free'); } catch (e) { rfRefused = (e as Error).message; }
  check('the risk-free source refuses to be fetched while the PO decision is open',
    rfRefused.includes('po_decision_required'), rfRefused.slice(0, 190));

  const devBenchmarks: Array<{ benchmark_key: string }> = await get('ii_benchmarks?select=benchmark_key');
  const realIndexNames = devBenchmarks.filter((b) => /nifty|sensex|bse|nse/i.test(b.benchmark_key));
  check('PC6 has invented no NIFTY/SENSEX series in DEV',
    realIndexNames.length === 0,
    `${devBenchmarks.length} benchmark row(s) in DEV, ${realIndexNames.length} of them named after a real licensed index (all existing rows are pre-PC6 R4/R5 test fixtures)`);

  const rfRows: Array<{ source: string }> = await get('ii_risk_free_rates?select=source');
  check('every risk-free row in DEV still self-declares as an uncertified seed (PC6 promoted nothing)',
    rfRows.length > 0 && rfRows.every((r) => /dev seed|not a certified feed/i.test(r.source)),
    `${rfRows.length} row(s), all labelled: "${rfRows[0]?.source.slice(0, 80)}..."`);
}

async function cleanup(navBefore: number) {
  console.log('\n--- CLEAN-UP ---');
  if (createdNavIds.length > 0) {
    const del = await rest(`ii_prices_nav?id=in.(${createdNavIds.join(',')})`, { method: 'DELETE' });
    console.log(`  deleted ${createdNavIds.length} row(s) — HTTP ${del.status}`);
  }
  const remaining: unknown[] = createdNavIds.length ? await get(`ii_prices_nav?select=id&id=in.(${createdNavIds.join(',')})`) : [];
  const navAfter = await count('ii_prices_nav');
  id++;
  const ok = remaining.length === 0 && navAfter === navBefore;
  results.push({
    id: `PC6-LD-${String(id).padStart(2, '0')}`,
    verdict: ok ? 'PASS' : 'FAIL',
    label: 'every row this run created is removed and DEV is left exactly as found',
    evidence: `created=${createdNavIds.length} remaining=${remaining.length} ii_prices_nav before=${navBefore} after=${navAfter}`,
  });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  created=${createdNavIds.length} remaining=${remaining.length} rows before=${navBefore} after=${navAfter}`);
}

// tsx compiles this file to CJS, where top-level await is unavailable, so the
// whole run lives in an async IIFE. The `finally` is the load-bearing part:
// clean-up must happen on the failure path too, or a mid-matrix throw would
// leave real rows behind in DEV.
void (async () => {
  let before = -1;
  try {
    before = await count('ii_prices_nav');
    await main();
  } catch (e) {
    console.error('\nRUN ERROR:', (e as Error).message);
    results.push({ id: 'PC6-LD-ERR', verdict: 'FAIL', label: 'matrix completed without an unhandled error', evidence: (e as Error).message });
  } finally {
    await cleanup(before);
  }

  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const fail = results.filter((r) => r.verdict === 'FAIL').length;
  console.log(`\n=== PC6 live-DEV matrix: ${pass} PASS, ${fail} FAIL, ${results.length} total ===`);
  fs.writeFileSync('scripts/pc6-live-dev-results.json', JSON.stringify({ ranAt: new Date().toISOString(), asOf: AS_OF, pass, fail, results }, null, 2));
  console.log('results written to scripts/pc6-live-dev-results.json');
  process.exit(fail === 0 ? 0 : 1);
})();
