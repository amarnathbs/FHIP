// NAV 1 \u2014 independent live-DEV functional verification that migration
// 0168_nav1_acceptance_triggered_hold.sql (function
// pc6_hold_instrument_on_statement_acceptance + trigger
// trg_pc6_hold_on_statement_acceptance on ii_portfolio_truth_status) is
// actually live, run AFTER the PO reported applying 0167/0168 to DEV with
// "no error". Does not trust that report on its own.
//
// Same catalog-access constraint as the 0167 check: pg_trigger/pg_proc are
// not exposed via PostgREST, so this proves the trigger's real BEHAVIOUR
// instead -- the strongest evidence actually available, arguably stronger
// than a bare catalog-name check since it also proves the function's exact
// business logic (fires on certifying transitions, not on unrelated
// updates, and does not dedupe against an already-open hold).
//
// Uses only pre-existing, already-in-DEV synthetic fixture rows that carry
// no real user data: account fae0ba75-d393-4137-ad9c-3e608678d1e4 ("R6-FINAL
// Test AMC", one of 14 pre-existing R6 test fixtures) and instrument
// 11111111-1111-4111-8111-111111111101 ("HDFC Flexi Cap Fund - Growth
// (Direct Plan)", a provisional/no-ISIN fixture -- NOT the real HDFC
// instrument 37a3d60e-... used by the priority-4 real accepted-statement
// journey). Zero DELETE statements: cleanup releases every hold this test
// creates via released_at (matching the existing NAV 1.39 audit-trail
// pattern) and archives the one new ii_portfolio_truth_status row via its
// own 'archived' status, rather than deleting either.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
const raw = fs.readFileSync('.env.local', 'utf8').replace(/^\uFEFF/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
const url = pick('NEXT_PUBLIC_SUPABASE_URL');
const key = pick('SUPABASE_SERVICE_ROLE_KEY');
const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const TEST_ACCOUNT_ID = 'fae0ba75-d393-4137-ad9c-3e608678d1e4'; // pre-existing "R6-FINAL Test AMC" fixture account
const TEST_USER_ID = '5cd74253-7852-45bf-91ff-e372c9c3a189'; // owner of that account
const TEST_INSTRUMENT_ID = '11111111-1111-4111-8111-111111111101'; // pre-existing synthetic fixture instrument, no ISIN, status=provisional

async function countHoldsFor(instrumentId) {
  const { data, error } = await client
    .from('ii_nav_retention_holds')
    .select('*')
    .eq('instrument_id', instrumentId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

console.log('=== 0168 trigger live-DEV functional test ===');
console.log('Baseline holds for test instrument BEFORE test:', await countHoldsFor(TEST_INSTRUMENT_ID));

// Step 1: INSERT with status='pending' -- must NOT create a hold.
console.log('\n--- Step 1: INSERT ii_portfolio_truth_status with status=pending ---');
const { data: row1, error: err1 } = await client
  .from('ii_portfolio_truth_status')
  .insert({
    user_id: TEST_USER_ID,
    account_id: TEST_ACCOUNT_ID,
    instrument_id: TEST_INSTRUMENT_ID,
    status: 'pending',
  })
  .select()
  .single();
console.log({ error: err1?.message, id: row1?.id, status: row1?.status });
if (err1) process.exit(1);
const rowId = row1.id;

let holdsAfterInsertPending = await countHoldsFor(TEST_INSTRUMENT_ID);
console.log('Holds for test instrument AFTER pending insert (expect 0 new):', holdsAfterInsertPending.length);

// Step 2: UPDATE status -> 'certified' -- MUST create exactly one new hold row.
console.log('\n--- Step 2: UPDATE status pending -> certified ---');
const { data: row2, error: err2 } = await client
  .from('ii_portfolio_truth_status')
  .update({ status: 'certified' })
  .eq('id', rowId)
  .select()
  .single();
console.log({ error: err2?.message, status: row2?.status });

let holdsAfterCertify = await countHoldsFor(TEST_INSTRUMENT_ID);
console.log('Holds for test instrument AFTER certify (expect 1):', JSON.stringify(holdsAfterCertify, null, 2));

// Step 3: UPDATE again, status UNCHANGED (touch a different column) -- must NOT add another hold.
console.log('\n--- Step 3: UPDATE unrelated column, status unchanged (expect no new hold) ---');
const { error: err3 } = await client
  .from('ii_portfolio_truth_status')
  .update({ statement_freshness_days: 5 })
  .eq('id', rowId);
console.log({ error: err3?.message });

let holdsAfterNoopUpdate = await countHoldsFor(TEST_INSTRUMENT_ID);
console.log('Holds for test instrument AFTER no-op status update (expect still 1):', holdsAfterNoopUpdate.length);

// Step 4: UPDATE status -> 'certified_with_warnings' from 'certified' -- this IS a status
// change (old.status is distinct from new.status), so a SECOND hold row is expected per
// the function's own logic (it does not dedupe against existing unreleased holds -- that
// is a real, disclosed characteristic, not a test bug).
console.log('\n--- Step 4: UPDATE certified -> certified_with_warnings (still a status change) ---');
const { error: err4 } = await client
  .from('ii_portfolio_truth_status')
  .update({ status: 'certified_with_warnings' })
  .eq('id', rowId);
console.log({ error: err4?.message });
let holdsAfterSecondTransition = await countHoldsFor(TEST_INSTRUMENT_ID);
console.log('Holds for test instrument AFTER 2nd certifying transition (expect 2):', holdsAfterSecondTransition.length);
console.log(JSON.stringify(holdsAfterSecondTransition, null, 2));

// Cleanup (non-destructive, per standing rule -- zero DELETE statements this dispatch):
// release every hold this test created, and archive the test portfolio_truth_status row.
console.log('\n--- Cleanup: release holds via released_at (UPDATE, not DELETE) ---');
const holdIds = holdsAfterSecondTransition.map((h) => h.id);
const { error: releaseErr } = await client
  .from('ii_nav_retention_holds')
  .update({ released_at: new Date().toISOString() })
  .in('id', holdIds)
  .is('released_at', null);
console.log({ error: releaseErr?.message, releasedCount: holdIds.length });

console.log('\n--- Cleanup: archive the test portfolio_truth_status row (UPDATE, not DELETE) ---');
const { error: archiveErr } = await client
  .from('ii_portfolio_truth_status')
  .update({ status: 'archived' })
  .eq('id', rowId);
console.log({ error: archiveErr?.message });

console.log('\n--- Final verification: holds released, row archived ---');
const finalHolds = await countHoldsFor(TEST_INSTRUMENT_ID);
console.log('Final hold rows for test instrument:', JSON.stringify(finalHolds, null, 2));
const { data: finalRow } = await client.from('ii_portfolio_truth_status').select('*').eq('id', rowId).single();
console.log('Final portfolio_truth_status row:', JSON.stringify(finalRow, null, 2));
console.log('\nTest instrument id (fixture, no real ISIN):', TEST_INSTRUMENT_ID);
console.log('Test account id (pre-existing R6-FINAL Test AMC fixture):', TEST_ACCOUNT_ID);
console.log('Test portfolio_truth_status row id (left archived, not deleted):', rowId);
