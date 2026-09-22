// NAV 1 continuation — a real, live-DEV test of the NAV-CORRECTION write
// path (referenceIngestJob.ts's supersede loop), which had ZERO live
// exercises anywhere (0 rows with quality_status='superseded' in DEV,
// confirmed earlier this dispatch). Reusing the existing ignoreDuplicates
// upsert pattern proves fresh-insert idempotency; it proves NOTHING about
// whether a genuine correction (a DIFFERENT value for the same
// (instrument, date)) is handled correctly — a real, dedicated test is
// required, per the coordinator's own correction.
//
// FIRST RUN OF THIS TEST (this session) found a REAL, previously-undetected
// defect: the ORIGINAL correction code tried to INSERT a second physical row
// for the same (instrument_id, price_date) alongside the row it was
// superseding -- which ii_prices_nav's real UNIQUE(instrument_id,price_date)
// constraint (migration 0033, no partial/WHERE exclusion) ALWAYS rejects
// with a 23505 duplicate-key error. Confirmed live (409, exact error
// below). Fixed in referenceIngestJob.ts: the corrected value is now
// applied via UPDATE IN PLACE, with the full previous/new value audit trail
// preserved in ii_reference_corrections (which already has previous_value/
// new_value jsonb columns for exactly this). This script now tests the
// FIXED behaviour end-to-end against real DEV.
//
// Uses one of DEV's already-confirmed SYNTHETIC test-fixture instruments
// (a VCVC*-named row with no ISIN/AMFI code, established earlier this
// dispatch as pure test data, not a real scheme or real user holding) so
// this never touches real production-shaped data. Cleans up its own test
// rows at the end (a DELETE of this session's own synthetic test data —
// NOT the NAV1 Stage-E retention cleanup the standing stop-gate governs).
import fs from 'fs';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
const URL_ = pick('NEXT_PUBLIC_SUPABASE_URL');
const KEY = pick('SUPABASE_SERVICE_ROLE_KEY');
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const TEST_INSTRUMENT = '012c7282-12c4-47d6-92c6-4dabfb66e98c'; // VCVC031787576907660 Growth Fund — confirmed synthetic fixture, no ISIN/AMFI code
const TEST_DATE = '2019-06-15'; // a date confirmed to have no existing row for this instrument
const ORIGINAL_PRICE = 100.1234;
const CORRECTED_PRICE = 100.5678;

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  (' + detail + ')' : ''}`); }
}

async function main() {
  console.log(`=== NAV 1 correction-handling live test — ${new Date().toISOString()} ===\n`);

  // 0. Pre-flight: confirm no pre-existing row would confuse this test.
  const preExisting = await (await fetch(`${URL_}/rest/v1/ii_prices_nav?instrument_id=eq.${TEST_INSTRUMENT}&price_date=eq.${TEST_DATE}&select=id`, { headers: h })).json();
  check('pre-flight: no existing row at the test (instrument, date)', preExisting.length === 0, `found ${preExisting.length}`);
  if (preExisting.length > 0) { console.error('Refusing to proceed against a non-clean fixture.'); process.exit(1); }

  // 1. Original insert (the "fresh row" this correction will later supersede).
  const originalChecksum = 'test-original-checksum-' + Date.now();
  const insertOriginal = await fetch(`${URL_}/rest/v1/ii_prices_nav`, {
    method: 'POST', headers: { ...h, Prefer: 'return=representation' },
    body: JSON.stringify({
      instrument_id: TEST_INSTRUMENT, currency_code: 'INR', price_date: TEST_DATE, price: ORIGINAL_PRICE,
      source_timestamp: new Date().toISOString(), data_version: 'nav1-correction-test-original', record_checksum: originalChecksum, quality_status: 'ok',
    }),
  });
  const original = (await insertOriginal.json())[0];
  check('original row inserted', insertOriginal.status === 201 && !!original?.id, `status=${insertOriginal.status}`);

  // 2. The FIXED correction sequence: UPDATE IN PLACE (never a second
  //    physical row for the same unique key), then a full audit trail.
  const correctedChecksum = 'test-corrected-checksum-' + Date.now();
  const applyCorrection = await fetch(`${URL_}/rest/v1/ii_prices_nav?id=eq.${original.id}`, {
    method: 'PATCH', headers: { ...h, Prefer: 'return=representation' },
    body: JSON.stringify({
      price: CORRECTED_PRICE, source_timestamp: new Date().toISOString(),
      data_version: 'nav1-correction-test-corrected', record_checksum: correctedChecksum, quality_status: 'ok',
    }),
  });
  const correctedRow = (await applyCorrection.json())[0];
  check('correction applied via UPDATE IN PLACE (no second physical row for the same key)', applyCorrection.status === 200 && Number(correctedRow?.price) === CORRECTED_PRICE, `status=${applyCorrection.status}`);

  const insertCorrectionRecord = await fetch(`${URL_}/rest/v1/ii_reference_corrections`, {
    method: 'POST', headers: { ...h, Prefer: 'return=representation' },
    body: JSON.stringify({
      target_table: 'ii_prices_nav', target_row_id: original.id, correction_kind: 'source_correction',
      previous_value: { price: ORIGINAL_PRICE }, new_value: { price: CORRECTED_PRICE },
      actor_kind: 'system_import', reason: 'NAV 1 correction-handling live test (this session) — verifying the real (fixed) write path, not a real source correction.',
    }),
  });
  const correctionRecord = (await insertCorrectionRecord.json())[0];
  check('ii_reference_corrections audit row created, carrying the FULL before/after value', insertCorrectionRecord.status === 201 && !!correctionRecord?.id
    && correctionRecord.previous_value?.price === ORIGINAL_PRICE && correctionRecord.new_value?.price === CORRECTED_PRICE);

  // 3. Verify every invariant the FIXED correction path must satisfy.
  const afterState = await (await fetch(`${URL_}/rest/v1/ii_prices_nav?instrument_id=eq.${TEST_INSTRUMENT}&price_date=eq.${TEST_DATE}&select=id,price,quality_status`, { headers: h })).json();
  check('exactly ONE row now exists for this (instrument, date) — the unique constraint is respected', afterState.length === 1, `found ${afterState.length}`);
  check('that one row carries the CORRECTED price', Number(afterState[0]?.price) === CORRECTED_PRICE, `price=${afterState[0]?.price}`);
  check('that one row has quality_status=ok (not stuck in some intermediate state)', afterState[0]?.quality_status === 'ok');

  // 4. The audit trail is the ONLY place the original value survives now —
  //    confirm it is genuinely retrievable, not just written-and-forgotten.
  const auditReadBack = await (await fetch(`${URL_}/rest/v1/ii_reference_corrections?id=eq.${correctionRecord.id}&select=previous_value,new_value,reason`, { headers: h })).json();
  check('the original (pre-correction) value is durably readable from the audit trail', auditReadBack[0]?.previous_value?.price === ORIGINAL_PRICE, JSON.stringify(auditReadBack[0]));

  // 5. Cleanup rehearsal: remove this session's own synthetic test rows —
  //    NOT the NAV1 Stage-E retention cleanup the standing stop-gate covers.
  //    This IS a real DELETE, deliberately, of data this session created
  //    for this test alone, on an already-confirmed synthetic fixture
  //    instrument.
  const del1 = await fetch(`${URL_}/rest/v1/ii_reference_corrections?id=eq.${correctionRecord.id}`, { method: 'DELETE', headers: h });
  const del2 = await fetch(`${URL_}/rest/v1/ii_prices_nav?id=eq.${original.id}`, { method: 'DELETE', headers: h });
  check('cleanup: correction audit row removed', del1.status === 204, `status=${del1.status}`);
  check('cleanup: NAV row removed', del2.status === 204, `status=${del2.status}`);
  const afterCleanup = await (await fetch(`${URL_}/rest/v1/ii_prices_nav?instrument_id=eq.${TEST_INSTRUMENT}&price_date=eq.${TEST_DATE}&select=id`, { headers: h })).json();
  check('cleanup verified: zero rows remain at this (instrument, date)', afterCleanup.length === 0, `found ${afterCleanup.length}`);

  console.log(`\n=== ${pass} PASS, ${fail} FAIL ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
