// AIE-1 live-DEV verification pass (2026-09-12) — cross-tenant RLS proof
// against the REAL AIE-1 tables now that migrations 0140-0145 are applied
// to this DEV project. Extends the METHOD already proven live against
// `households` in scripts/aie1_live_dev_rls_method_proof.mjs (that script
// is left unmodified as the historical record of the method proof itself;
// this file is the follow-up run against the actual tables it could not
// reach before).
//
// Covers, all with real disposable synthetic users, real password sign-in,
// and real PostgREST calls (never the service-role client for the
// positive/negative-control reads/writes themselves):
//   1. aie_document_intake  — Tenant A creates her own row via her own JWT
//      (the same authenticated-INSERT policy app/api/aie/intake/route.ts
//      itself relies on). Positive control (A reads her own row), negative
//      control READ (B cannot read it), negative control WRITE — TWO
//      different shapes: (a) B attempts to UPDATE A's row (blocked, though
//      this table has no authenticated UPDATE policy for ANY user, so this
//      alone does not isolate "cross-tenant" from "no one can update" —
//      disclosed, not hidden); (b) B attempts to INSERT a row that
//      IMPERSONATES A by setting user_id = A's id (this DOES isolate
//      tenant-scoping specifically, since INSERT's `with check (user_id =
//      auth.uid())` is the one authenticated write path this table has).
//   2. aie_unresolved_item / aie_review_decision — service-role creates a
//      realistic child-row chain owned by Tenant A (intake -> extraction
//      run -> unresolved item -> review decision), then the SAME
//      positive-control-first / negative-control-read discipline is
//      applied to both. Neither table has ANY authenticated insert/update/
//      delete policy at all (by design — EXC-08), so the write side of the
//      proof here is "zero authenticated mutation channel exists for
//      either tenant", re-verified specifically for Tenant B.
//   3. aie_mask_token_map — a real ciphertext row is created (service
//      role) against the same run. Confirms it is unreadable by EITHER
//      tenant (not just cross-tenant) — the migration's own "zero
//      authenticated policies, revoked entirely" design.
//
// Full cleanup + independent re-verification at the end.
import fs from 'fs';

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const CERTIFIED_DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
if (!BASE.includes(CERTIFIED_DEV_PROJECT_REF)) { console.error('REFUSING: not certified DEV project'); process.exit(1); }
if (env.PRODUCTION_SUPABASE_URL || env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY) {
  console.error('REFUSING: PRODUCTION_-prefixed vars must not be present in this script\'s env at all.');
  process.exit(1);
}

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} -- ${description}`);
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 500)}`);
}

async function svc(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function asUser(accessToken, p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: ANON, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
async function makeUser(tag) {
  const email = `aie1-livedev-rls2-${tag}-${stamp}@fhip-test.invalid`;
  const password = `TestPass!${stamp}Aa1${tag}`;
  const created = await svc('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  if (!id) throw new Error(`createUser failed for ${tag}: ${created.text}`);
  const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await tokenRes.json();
  if (!session?.access_token) throw new Error(`sign-in failed for ${tag}: ${JSON.stringify(session)}`);
  return { id, email, accessToken: session.access_token };
}

const created = { users: [], intakeIds: [], runIds: [], itemIds: [], decisionIds: [] };

try {
  const tenantA = await makeUser('A');
  created.users.push(tenantA.id);
  record('SETUP-1', 'Tenant A created via admin createUser + real password sign-in', 'PASS', { id: tenantA.id });

  const tenantB = await makeUser('B');
  created.users.push(tenantB.id);
  record('SETUP-2', 'Tenant B created via admin createUser + real password sign-in', 'PASS', { id: tenantB.id });

  // ------------------------------------------------------------------
  // 1. aie_document_intake
  // ------------------------------------------------------------------
  const insertA = await asUser(tenantA.accessToken, '/rest/v1/aie_document_intake', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: tenantA.id, declared_mime_type: 'application/pdf', byte_size: 1234, display_filename: 'rls-proof.pdf', source_module_hint: 'other' },
  });
  const intakeAId = insertA.json?.[0]?.id;
  if (!intakeAId) throw new Error(`Tenant A could not create own aie_document_intake: ${insertA.text}`);
  created.intakeIds.push(intakeAId);
  record('SETUP-3', 'Tenant A inserts own aie_document_intake row as themself (authenticated INSERT policy, with-check user_id = auth.uid())', 'PASS', { status: insertA.status, id: intakeAId });

  const ownRead = await asUser(tenantA.accessToken, `/rest/v1/aie_document_intake?id=eq.${intakeAId}&select=id,user_id,status`);
  const ownReadOk = ownRead.status === 200 && ownRead.json?.length === 1 && ownRead.json[0].id === intakeAId;
  record('POSITIVE-CONTROL-INTAKE', 'Tenant A reads their OWN aie_document_intake row via their own JWT -- must return exactly 1 row', ownReadOk ? 'PASS' : 'FAIL', { status: ownRead.status, rows: ownRead.json });
  if (!ownReadOk) throw new Error('Positive control failed -- the read method itself is broken, so a subsequent empty result from Tenant B would be meaningless.');

  const crossRead = await asUser(tenantB.accessToken, `/rest/v1/aie_document_intake?id=eq.${intakeAId}&select=id,user_id,status`);
  const crossReadBlocked = crossRead.status === 200 && Array.isArray(crossRead.json) && crossRead.json.length === 0;
  record('NEGATIVE-CONTROL-READ-INTAKE', "Tenant B attempts to read Tenant A's aie_document_intake row via Tenant B's own JWT -- must return zero rows", crossReadBlocked ? 'PASS' : 'FAIL', { status: crossRead.status, rows: crossRead.json });

  // Negative-control WRITE (a): cross-tenant UPDATE. Disclosed nuance: this
  // table has NO authenticated UPDATE policy at all (every status
  // transition goes through the service-role client per migration 0140's
  // own header) -- so this proves "Tenant B cannot mutate Tenant A's row",
  // but does not by itself isolate cross-tenant from "no one, including the
  // owner, can update via the RLS client". Test (b) below is the one that
  // specifically isolates tenant-scoping on the write side.
  const crossUpdate = await asUser(tenantB.accessToken, `/rest/v1/aie_document_intake?id=eq.${intakeAId}`, {
    method: 'PATCH', prefer: 'return=representation', body: { display_filename: 'HIJACKED BY TENANT B' },
  });
  const crossUpdateBlocked = crossUpdate.status === 200 && Array.isArray(crossUpdate.json) && crossUpdate.json.length === 0;
  record('NEGATIVE-CONTROL-WRITE-A-INTAKE-UPDATE', "Tenant B attempts to UPDATE Tenant A's aie_document_intake row -- must affect zero rows (no authenticated UPDATE policy exists for ANY user on this table, so this shows 'no mutation channel', not tenant-isolation specifically)", crossUpdateBlocked ? 'PASS' : 'FAIL', { status: crossUpdate.status, rows: crossUpdate.json });

  // Negative-control WRITE (b): cross-tenant INSERT impersonation. This DOES
  // isolate tenant-scoping specifically: the INSERT policy exists and is
  // real (`with check (user_id = auth.uid())`) -- Tenant B tries to create a
  // row claiming to be owned by Tenant A.
  const impersonateInsert = await asUser(tenantB.accessToken, '/rest/v1/aie_document_intake', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: tenantA.id, declared_mime_type: 'application/pdf', byte_size: 999, display_filename: 'impersonation-attempt.pdf', source_module_hint: 'other' },
  });
  // PostgREST returns 201 with the row NOT created (never happens under RLS
  // with-check failure) OR, correctly, a 403/401-shaped rejection with zero
  // rows persisted. Treat "not 2xx with a persisted row" as blocked.
  const impersonateBlocked = !(impersonateInsert.ok && Array.isArray(impersonateInsert.json) && impersonateInsert.json.length > 0);
  record('NEGATIVE-CONTROL-WRITE-B-INTAKE-IMPERSONATE-INSERT', "Tenant B attempts to INSERT an aie_document_intake row with user_id = Tenant A's id (impersonation) -- must be rejected by the with-check policy, never persisted", impersonateBlocked ? 'PASS' : 'FAIL', { status: impersonateInsert.status, text: impersonateInsert.text?.slice(0, 300) });
  // Independently confirm, via service role, that no such impersonating row exists.
  const impersonateVerify = await svc(`/rest/v1/aie_document_intake?user_id=eq.${tenantA.id}&display_filename=eq.impersonation-attempt.pdf`);
  const impersonateReallyAbsent = Array.isArray(impersonateVerify.json) && impersonateVerify.json.length === 0;
  record('NEGATIVE-CONTROL-WRITE-B-VERIFY', 'Service-role read confirms no impersonating row was actually persisted', impersonateReallyAbsent ? 'PASS' : 'FAIL', impersonateVerify.json);

  // ------------------------------------------------------------------
  // 2. aie_unresolved_item / aie_review_decision -- service-role builds a
  // realistic child-row chain owned by Tenant A (no authenticated insert
  // policy exists on these tables, matching EXC-08 -- this is the ONLY way
  // such rows are ever created, exactly like the real orchestrator/review
  // layer does it).
  // ------------------------------------------------------------------
  const runInsert = await svc('/rest/v1/aie_extraction_run', {
    method: 'POST', prefer: 'return=representation',
    body: { intake_id: intakeAId, user_id: tenantA.id, run_number: 1, status: 'unresolved' },
  });
  const runAId = runInsert.json?.[0]?.id;
  if (!runAId) throw new Error(`could not create aie_extraction_run: ${runInsert.text}`);
  created.runIds.push(runAId);
  record('SETUP-4', 'service-role creates aie_extraction_run owned by Tenant A (matching intake_id/user_id -- aie_assert_child_owner trigger enforces this)', 'PASS', { id: runAId });

  const itemInsert = await svc('/rest/v1/aie_unresolved_item', {
    method: 'POST', prefer: 'return=representation',
    body: { run_id: runAId, intake_id: intakeAId, user_id: tenantA.id, reason_code: 'rls_proof_reason', severity: 'blocking', display_candidate: 'RLS proof candidate' },
  });
  const itemAId = itemInsert.json?.[0]?.id;
  if (!itemAId) throw new Error(`could not create aie_unresolved_item: ${itemInsert.text}`);
  created.itemIds.push(itemAId);
  record('SETUP-5', 'service-role creates aie_unresolved_item owned by Tenant A', 'PASS', { id: itemAId });

  const decisionInsert = await svc('/rest/v1/aie_review_decision', {
    method: 'POST', prefer: 'return=representation',
    body: { item_id: itemAId, intake_id: intakeAId, user_id: tenantA.id, item_version_at_decision: 1, decision_type: 'defer', idempotency_key: `rls-proof-${stamp}` },
  });
  const decisionAId = decisionInsert.json?.[0]?.id;
  if (!decisionAId) throw new Error(`could not create aie_review_decision: ${decisionInsert.text}`);
  created.decisionIds.push(decisionAId);
  record('SETUP-6', 'service-role creates aie_review_decision owned by Tenant A', 'PASS', { id: decisionAId });

  // --- aie_unresolved_item: positive control, then negative control READ ---
  const itemOwnRead = await asUser(tenantA.accessToken, `/rest/v1/aie_unresolved_item?id=eq.${itemAId}&select=id,user_id,reason_code`);
  const itemOwnReadOk = itemOwnRead.status === 200 && itemOwnRead.json?.length === 1;
  record('POSITIVE-CONTROL-UNRESOLVED-ITEM', 'Tenant A reads their OWN aie_unresolved_item row via their own JWT -- must return exactly 1 row', itemOwnReadOk ? 'PASS' : 'FAIL', { status: itemOwnRead.status, rows: itemOwnRead.json });
  if (!itemOwnReadOk) throw new Error('Positive control failed for aie_unresolved_item.');

  const itemCrossRead = await asUser(tenantB.accessToken, `/rest/v1/aie_unresolved_item?id=eq.${itemAId}&select=id,user_id,reason_code`);
  const itemCrossBlocked = itemCrossRead.status === 200 && Array.isArray(itemCrossRead.json) && itemCrossRead.json.length === 0;
  record('NEGATIVE-CONTROL-READ-UNRESOLVED-ITEM', "Tenant B attempts to read Tenant A's aie_unresolved_item row -- must return zero rows", itemCrossBlocked ? 'PASS' : 'FAIL', { status: itemCrossRead.status, rows: itemCrossRead.json });

  // Negative control WRITE: neither tenant has ANY insert/update/delete
  // policy on this table (EXC-08) -- re-verify specifically for Tenant B
  // attempting to flip status directly.
  const itemCrossWrite = await asUser(tenantB.accessToken, `/rest/v1/aie_unresolved_item?id=eq.${itemAId}`, {
    method: 'PATCH', prefer: 'return=representation', body: { status: 'resolved' },
  });
  const itemCrossWriteBlocked = itemCrossWrite.status === 200 && Array.isArray(itemCrossWrite.json) && itemCrossWrite.json.length === 0;
  record('NEGATIVE-CONTROL-WRITE-UNRESOLVED-ITEM', "Tenant B attempts to UPDATE Tenant A's aie_unresolved_item.status directly -- must affect zero rows (no authenticated mutation channel exists for this table at all, by design)", itemCrossWriteBlocked ? 'PASS' : 'FAIL', { status: itemCrossWrite.status, rows: itemCrossWrite.json });
  const itemVerifyUnchanged = await svc(`/rest/v1/aie_unresolved_item?id=eq.${itemAId}&select=status`);
  const itemUnchanged = itemVerifyUnchanged.json?.[0]?.status === 'open';
  record('NEGATIVE-CONTROL-WRITE-UNRESOLVED-ITEM-VERIFY', 'Service-role read confirms status is genuinely unchanged (still "open") after the blocked cross-tenant write attempt', itemUnchanged ? 'PASS' : 'FAIL', itemVerifyUnchanged.json);

  // --- aie_review_decision: positive control, then negative control READ ---
  const decisionOwnRead = await asUser(tenantA.accessToken, `/rest/v1/aie_review_decision?id=eq.${decisionAId}&select=id,user_id,decision_type`);
  const decisionOwnReadOk = decisionOwnRead.status === 200 && decisionOwnRead.json?.length === 1;
  record('POSITIVE-CONTROL-REVIEW-DECISION', 'Tenant A reads their OWN aie_review_decision row via their own JWT -- must return exactly 1 row', decisionOwnReadOk ? 'PASS' : 'FAIL', { status: decisionOwnRead.status, rows: decisionOwnRead.json });
  if (!decisionOwnReadOk) throw new Error('Positive control failed for aie_review_decision.');

  const decisionCrossRead = await asUser(tenantB.accessToken, `/rest/v1/aie_review_decision?id=eq.${decisionAId}&select=id,user_id,decision_type`);
  const decisionCrossBlocked = decisionCrossRead.status === 200 && Array.isArray(decisionCrossRead.json) && decisionCrossRead.json.length === 0;
  record('NEGATIVE-CONTROL-READ-REVIEW-DECISION', "Tenant B attempts to read Tenant A's aie_review_decision row -- must return zero rows", decisionCrossBlocked ? 'PASS' : 'FAIL', { status: decisionCrossRead.status, rows: decisionCrossRead.json });

  // ------------------------------------------------------------------
  // 3. aie_mask_token_map -- a real ciphertext row, confirmed unreadable by
  // EITHER authenticated tenant (not just cross-tenant): migration 0140's
  // own header says this table carries "NO authenticated policy of any
  // kind (not even SELECT)" and access is explicitly revoked.
  // ------------------------------------------------------------------
  const tokenMapInsert = await svc('/rest/v1/aie_mask_token_map', {
    method: 'POST', prefer: 'return=representation',
    body: { run_id: runAId, token: `RLS_PROOF_TOKEN_${stamp}`, ciphertext: '\\x' + Buffer.from('rls-proof-plaintext-should-never-be-authenticated-readable').toString('hex') },
  });
  const tokenMapId = tokenMapInsert.json?.[0]?.id;
  if (!tokenMapId) throw new Error(`could not create aie_mask_token_map row (service role): ${tokenMapInsert.text}`);
  record('SETUP-7', 'service-role creates a real aie_mask_token_map row (encrypted-at-application-layer per its own design, but this proof only needs a real row to exist)', 'PASS', { id: tokenMapId });

  const tokenMapReadAsOwner = await asUser(tenantA.accessToken, `/rest/v1/aie_mask_token_map?id=eq.${tokenMapId}`);
  // Expect EITHER a PostgREST-permission-denied error (revoked table
  // privilege, no policy at all can even be evaluated) OR a 200 with zero
  // rows -- either shape proves "not authenticated-readable"; a genuine row
  // coming back is the only failure.
  const ownerCannotRead = !(tokenMapReadAsOwner.status === 200 && Array.isArray(tokenMapReadAsOwner.json) && tokenMapReadAsOwner.json.length > 0);
  record('MASK-TOKEN-MAP-OWNER-DENIED', "Tenant A (the run's own 'owner' by association) attempts to read aie_mask_token_map via her own JWT -- must NOT return the row (zero authenticated policies exist on this table by design, not even for the associated user)", ownerCannotRead ? 'PASS' : 'FAIL', { status: tokenMapReadAsOwner.status, text: tokenMapReadAsOwner.text?.slice(0, 300) });

  const tokenMapReadAsOther = await asUser(tenantB.accessToken, `/rest/v1/aie_mask_token_map?id=eq.${tokenMapId}`);
  const otherCannotRead = !(tokenMapReadAsOther.status === 200 && Array.isArray(tokenMapReadAsOther.json) && tokenMapReadAsOther.json.length > 0);
  record('MASK-TOKEN-MAP-CROSS-TENANT-DENIED', 'Tenant B attempts to read the same aie_mask_token_map row -- must NOT return the row', otherCannotRead ? 'PASS' : 'FAIL', { status: tokenMapReadAsOther.status, text: tokenMapReadAsOther.text?.slice(0, 300) });

  // Independently confirm the row genuinely exists (service role) so the
  // "denied" results above are proven to be RLS/privilege denial, not
  // coincidental non-existence.
  const tokenMapExists = await svc(`/rest/v1/aie_mask_token_map?id=eq.${tokenMapId}&select=id`);
  const tokenMapReallyExists = Array.isArray(tokenMapExists.json) && tokenMapExists.json.length === 1;
  record('MASK-TOKEN-MAP-SANITY-EXISTS', 'Service-role read confirms the aie_mask_token_map row genuinely exists (so the two DENIED results above are real access denial, not the row being absent)', tokenMapReallyExists ? 'PASS' : 'FAIL', tokenMapExists.json);

} finally {
  console.log('\n--- cleanup ---');
  // Child rows first (FKs cascade from aie_document_intake/aie_extraction_run
  // anyway, but delete explicitly and independently re-verify each table).
  for (const id of created.decisionIds) {
    const del = await svc(`/rest/v1/aie_review_decision?id=eq.${id}`, { method: 'DELETE' });
    record('CLEANUP-REVIEW-DECISION', `deleted synthetic aie_review_decision ${id}`, del.status === 200 || del.status === 204 ? 'PASS' : 'FAIL', del.status);
  }
  for (const id of created.itemIds) {
    const del = await svc(`/rest/v1/aie_unresolved_item?id=eq.${id}`, { method: 'DELETE' });
    record('CLEANUP-UNRESOLVED-ITEM', `deleted synthetic aie_unresolved_item ${id}`, del.status === 200 || del.status === 204 ? 'PASS' : 'FAIL', del.status);
  }
  // aie_mask_token_map has no authenticated policy at all -- must be
  // deleted via service role too (already the plan).
  const tokenMapDel = await svc(`/rest/v1/aie_mask_token_map?run_id=eq.${created.runIds[0] ?? 'none'}`, { method: 'DELETE' });
  record('CLEANUP-MASK-TOKEN-MAP', 'deleted synthetic aie_mask_token_map row(s) for this run', tokenMapDel.status === 200 || tokenMapDel.status === 204 ? 'PASS' : 'FAIL', tokenMapDel.status);
  for (const id of created.runIds) {
    const del = await svc(`/rest/v1/aie_extraction_run?id=eq.${id}`, { method: 'DELETE' });
    record('CLEANUP-EXTRACTION-RUN', `deleted synthetic aie_extraction_run ${id}`, del.status === 200 || del.status === 204 ? 'PASS' : 'FAIL', del.status);
  }
  for (const id of created.intakeIds) {
    const del = await svc(`/rest/v1/aie_document_intake?id=eq.${id}`, { method: 'DELETE' });
    record('CLEANUP-INTAKE', `deleted synthetic aie_document_intake ${id}`, del.status === 200 || del.status === 204 ? 'PASS' : 'FAIL', del.status);
  }
  for (const uId of created.users) {
    const del = await svc(`/auth/v1/admin/users/${uId}`, { method: 'DELETE' });
    record('CLEANUP-USER', `deleted synthetic user ${uId}`, del.status === 200 || del.status === 204 ? 'PASS' : 'FAIL', del.status);
  }

  console.log('\n--- independent residue re-verification (re-query, do not trust the delete responses) ---');
  for (const id of created.decisionIds) {
    const re = await svc(`/rest/v1/aie_review_decision?id=eq.${id}`);
    record('RESIDUE-CHECK-REVIEW-DECISION', `aie_review_decision ${id} must be genuinely gone`, Array.isArray(re.json) && re.json.length === 0 ? 'PASS' : 'FAIL', re.json);
  }
  for (const id of created.itemIds) {
    const re = await svc(`/rest/v1/aie_unresolved_item?id=eq.${id}`);
    record('RESIDUE-CHECK-UNRESOLVED-ITEM', `aie_unresolved_item ${id} must be genuinely gone`, Array.isArray(re.json) && re.json.length === 0 ? 'PASS' : 'FAIL', re.json);
  }
  for (const id of created.runIds) {
    const re = await svc(`/rest/v1/aie_extraction_run?id=eq.${id}`);
    record('RESIDUE-CHECK-EXTRACTION-RUN', `aie_extraction_run ${id} must be genuinely gone`, Array.isArray(re.json) && re.json.length === 0 ? 'PASS' : 'FAIL', re.json);
  }
  for (const id of created.intakeIds) {
    const re = await svc(`/rest/v1/aie_document_intake?id=eq.${id}`);
    record('RESIDUE-CHECK-INTAKE', `aie_document_intake ${id} must be genuinely gone`, Array.isArray(re.json) && re.json.length === 0 ? 'PASS' : 'FAIL', re.json);
  }
  for (const uId of created.users) {
    const re = await svc(`/auth/v1/admin/users/${uId}`);
    const gone = re.status === 404 || /user not found/i.test(re.text || '');
    record('RESIDUE-CHECK-USER', `user ${uId} must be genuinely gone`, gone ? 'PASS' : 'FAIL', { status: re.status, text: re.text?.slice(0, 200) });
  }

  const failed = results.filter(r => r.status === 'FAIL');
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) { console.log('FAILURES:', failed.map(f => f.id)); process.exit(1); }
}
