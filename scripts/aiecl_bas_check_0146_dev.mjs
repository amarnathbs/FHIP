// AIECL-BAS-04/I46-01: verify migration 0146 is genuinely applied to DEV by
// reproducing the exact live defect it fixed (wrong column reference on the
// shared trigger) and confirming it no longer occurs -- not just checking a
// migrations-ledger row exists, since this migration's own DDL is a pure
// function-body replacement with no new queryable object.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const URL = 'https://vqycarelcoijzwlpkpcz.supabase.co';
const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const SERVICE_KEY = raw.match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)$/m)?.[1]?.trim();
const admin = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const stamp = Date.now();
const email = `bas0146-${stamp}@example.com`;
const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
let userId, intakeId, runId, policyId, linkId;
try {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  userId = data.user.id;

  const { data: intake, error: intakeErr } = await admin
    .from('aie_document_intake')
    .insert({ user_id: userId, declared_mime_type: 'application/pdf', byte_size: 1000, storage_key: `test/${stamp}.pdf`, status: 'quarantined' })
    .select('id')
    .single();
  if (intakeErr) throw intakeErr;
  intakeId = intake.id;

  const { data: run, error: runErr } = await admin
    .from('aie_extraction_run')
    .insert({ intake_id: intakeId, user_id: userId, run_number: 1, status: 'accepted' })
    .select('id')
    .single();
  if (runErr) throw runErr;
  runId = run.id;

  const { data: policy, error: policyErr } = await admin
    .from('insurance_policies')
    .insert({ user_id: userId, policy_name: 'bas-0146-check', cover_type: 'life', cover_amount: 1000, premium: 10, premium_frequency: 'monthly', currency_code: 'AUD', is_active: true })
    .select('id')
    .single();
  if (policyErr) throw policyErr;
  policyId = policy.id;

  // The exact operation 0146 fixes: inserting into aie_insurance_adapter_link,
  // which references aie_intake_id (not intake_id) on this table specifically
  // -- the OLD shared trigger checked new.intake_id (a column this table does
  // NOT have), so this insert would fail with 42703 before the fix.
  const { data: link, error: linkErr } = await admin
    .from('aie_insurance_adapter_link')
    .insert({ user_id: userId, aie_intake_id: intakeId, aie_run_id: runId, insurance_policy_id: policyId, accepted_by_user_id: userId })
    .select('id')
    .single();

  if (linkErr) {
    console.log('RESULT: 0146 NOT applied (or not effective) -- insert failed:', linkErr.code, linkErr.message);
  } else {
    linkId = link.id;
    console.log('RESULT: 0146 CONFIRMED applied and effective on DEV -- insert into aie_insurance_adapter_link succeeded, link id:', link.id);
  }
} finally {
  if (linkId) await admin.from('aie_insurance_adapter_link').delete().eq('id', linkId);
  if (policyId) await admin.from('insurance_policies').delete().eq('id', policyId);
  if (runId) await admin.from('aie_extraction_run').delete().eq('id', runId);
  if (intakeId) await admin.from('aie_document_intake').delete().eq('id', intakeId);
  if (userId) await admin.auth.admin.deleteUser(userId);
  console.log('Cleanup done.');
}
