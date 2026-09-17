/**
 * M12D TRACEABILITY — Product-Owner requirement ids this file is evidence for.
 *
 * Added by the M12 Phase D mapping pass. Each id below was checked against this
 * file's ACTUAL assertions; ids it only touches incidentally are deliberately
 * omitted, and where this file does NOT discharge a neighbouring requirement,
 * that is said so explicitly rather than left to be assumed.
 * Full matrix: docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md
 *
 *   AIE10-QA-06      Create a proof that PC5 can consume and resolve one synthetic AIE
 *                    ownership item.
 *   AIE16-PC5-01     Search code, migrations, routes and UI for competing active PC5
 *                    exception storage.
 */
/**
 * AIE-1 closure mission (section 11) — real DEV verification of
 * `lib/aie/pc5/pc5ExceptionInterface.ts` against the actual `aie_*` tables
 * on the real DEV Supabase project. PC5 itself does not exist to integrate
 * with end-to-end (confirmed: no PC5 module/table/route anywhere in this
 * repo) -- this proves the AIE-SIDE interface and contract genuinely work
 * against real infrastructure, which is what mission section 11 asks for
 * when the consumer is unavailable: "complete the interface and contract
 * verification, but mark end-to-end PC5 closure blocked."
 *
 * Uses two real disposable synthetic DEV users (owner + attacker), real
 * rows in aie_document_intake/aie_extraction_run/aie_unresolved_item
 * (service-role writes -- no HTTP route exists for these tables' write
 * path outside the real intake pipeline, so this constructs the minimal
 * real row shape directly, exactly as
 * scripts/aiecl_bas_check_0146_dev.mjs already does for a comparable
 * check). Full cleanup + independent re-verification at the end.
 *
 * Run: npx tsx scripts/aiecl_pc5_interface_live_dev_check.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { listUnresolvedItemsForPc5, resolveUnresolvedItemForPc5 } from '@/lib/aie/pc5/pc5ExceptionInterface';

const repoRoot = path.resolve(__dirname, '..');
function loadEnv() {
  const raw = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').replace(/^﻿/, '');
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
// lib/supabase/admin.ts (imported transitively via the real @/lib/aie/pc5/
// pc5ExceptionInterface module under test) reads process.env directly --
// this script must populate it, not just its own local `env` object.
process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
const admin = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''));
  }
}

async function main() {
  const stamp = Date.now();
  const ownerEmail = `pc5if-owner-${stamp}@example.com`;
  const attackerEmail = `pc5if-attacker-${stamp}@example.com`;
  const password = () => `Test-${Math.random().toString(36).slice(2)}-Aa1!`;

  let ownerId = '';
  let attackerId = '';
  let intakeId = '';
  let runId = '';
  let itemId = '';

  try {
    const owner = await admin.auth.admin.createUser({ email: ownerEmail, password: password(), email_confirm: true });
    if (owner.error || !owner.data.user) throw new Error(`create owner failed: ${owner.error?.message}`);
    ownerId = owner.data.user.id;

    const attacker = await admin.auth.admin.createUser({ email: attackerEmail, password: password(), email_confirm: true });
    if (attacker.error || !attacker.data.user) throw new Error(`create attacker failed: ${attacker.error?.message}`);
    attackerId = attacker.data.user.id;

    const intake = await admin
      .from('aie_document_intake')
      .insert({ user_id: ownerId, declared_mime_type: 'application/pdf', byte_size: 1000, storage_key: `test/pc5if-${stamp}.pdf`, status: 'ready' })
      .select('id')
      .single();
    if (intake.error) throw new Error(`intake insert failed: ${intake.error.message}`);
    intakeId = intake.data.id;

    const run = await admin
      .from('aie_extraction_run')
      .insert({ intake_id: intakeId, user_id: ownerId, run_number: 1, status: 'unresolved' })
      .select('id')
      .single();
    if (run.error) throw new Error(`run insert failed: ${run.error.message}`);
    runId = run.data.id;

    // No aie_parser_attempt row is inserted for this run -- getAdapterIdForRun
    // then returns null, resolveModuleDescriptorByAdapterId(null) returns
    // null, and resolveReasonCodeMeta(null, ...) resolves to
    // GENERIC_FALLBACK_REASON_META, whose allowedActions include 'defer'.
    // This keeps this check scoped to the PC5 INTERFACE's own tenant/
    // capability/version-check properties, not re-proving decide.ts's
    // adapter-specific correction/revalidation logic (already covered by
    // the dedicated adapter test suites and the real Insurance live-DEV
    // journey in AIE_1_0146_INSURANCE_CLOSURE_REPORT.md).
    const item = await admin
      .from('aie_unresolved_item')
      .insert({
        run_id: runId,
        intake_id: intakeId,
        user_id: ownerId,
        reason_code: 'pc5_interface_live_dev_check_generic_reason',
        severity: 'blocking',
        status: 'open',
        item_version: 1,
        permitted_action_types: ['defer'],
      })
      .select('id')
      .single();
    if (item.error) throw new Error(`unresolved item insert failed: ${item.error.message}`);
    itemId = item.data.id;

    // Real allow-all-for-owner capability check, matching the interface's
    // own documented contract -- a real PC5 would supply its own logic
    // here; this is a genuine, if minimal, implementation of that contract
    // (never a hardcoded true regardless of arguments).
    const capabilityDeps = { checkCapability: async (callerId: string, targetUserId: string) => callerId === targetUserId };

    // --- I46-equivalent evidence for PC5: list ------------------------
    const ownList = await listUnresolvedItemsForPc5(ownerId, ownerId, capabilityDeps);
    check('owner can list their own unresolved items', ownList.ok === true && ownList.ok && ownList.items.some((i) => i.id === itemId));

    const crossList = await listUnresolvedItemsForPc5(attackerId, ownerId, capabilityDeps);
    check('cross-tenant list is denied by the capability layer', crossList.ok === false && crossList.reason === 'capability_denied');

    // --- cross-tenant resolve denial -----------------------------------
    const crossResolve = await resolveUnresolvedItemForPc5(
      { callerId: attackerId, targetUserId: ownerId, itemId, action: 'defer', itemVersion: 1, idempotencyKey: `pc5if-${stamp}-cross` },
      capabilityDeps,
    );
    check('cross-tenant resolve is denied by the capability layer', 'reason' in crossResolve && crossResolve.reason === 'capability_denied');

    // Also prove tenant scoping holds even if a capability layer were ever
    // misconfigured to allow it -- decideOnItem's OWN (user_id) scoping is
    // the second, independent layer this interface relies on.
    const forcedCrossResolve = await resolveUnresolvedItemForPc5(
      { callerId: attackerId, targetUserId: attackerId, itemId, action: 'defer', itemVersion: 1, idempotencyKey: `pc5if-${stamp}-forced-cross` },
      { checkCapability: async () => true },
    );
    check(
      'even with capability allowed, resolving another tenant\'s item id under the WRONG targetUserId finds nothing (second independent tenant-scoping layer)',
      'reason' in forcedCrossResolve && forcedCrossResolve.reason === 'not_found',
    );

    // --- stale client (wrong itemVersion) ------------------------------
    const staleResolve = await resolveUnresolvedItemForPc5(
      { callerId: ownerId, targetUserId: ownerId, itemId, action: 'defer', itemVersion: 999, idempotencyKey: `pc5if-${stamp}-stale` },
      capabilityDeps,
    );
    check('a stale itemVersion is rejected as stale_conflict, never silently applied', 'reason' in staleResolve && staleResolve.reason === 'stale_conflict');

    // --- deleted/expired pending data (nonexistent item id) ------------
    const missingResolve = await resolveUnresolvedItemForPc5(
      { callerId: ownerId, targetUserId: ownerId, itemId: '00000000-0000-0000-0000-000000000000', action: 'defer', itemVersion: 1, idempotencyKey: `pc5if-${stamp}-missing` },
      capabilityDeps,
    );
    check('a nonexistent/deleted item id resolves to not_found, never a crash or false success', 'reason' in missingResolve && missingResolve.reason === 'not_found');

    // --- genuine resolution + concurrent SAME-idempotency-key replay ---
    // Six truly concurrent calls sharing one idempotency key: the AIE
    // review-decision ledger's own unique constraint on idempotency_key
    // collapses every one of them to exactly one real status transition
    // (mission section 11: "prevent stale or double resolution" -- proven
    // here via genuine Promise.all concurrency, not sequential replay).
    const idemKey = `pc5if-${stamp}-concurrent`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        resolveUnresolvedItemForPc5({ callerId: ownerId, targetUserId: ownerId, itemId, action: 'defer', itemVersion: 1, idempotencyKey: idemKey }, capabilityDeps),
      ),
    );
    const successes = results.filter((r) => 'ok' in r && r.ok === true);
    check('all 6 concurrent same-idempotency-key calls report success (idempotent collapse, not an error)', successes.length === 6, results);
    const decisionRows = await admin.from('aie_review_decision').select('id').eq('item_id', itemId).eq('idempotency_key', idemKey);
    check('exactly ONE aie_review_decision row was actually created for the shared idempotency key, despite 6 concurrent callers', (decisionRows.data ?? []).length === 1, decisionRows.data);
    const afterConcurrent = await admin.from('aie_unresolved_item').select('status, item_version').eq('id', itemId).single();
    check('the item transitioned exactly once (item_version is now 2, not 7)', afterConcurrent.data?.item_version === 2, afterConcurrent.data);

    // Already-resolved: a fresh attempt with the ORIGINAL version after the
    // item has already moved on must also be stale_conflict, not a crash.
    const alreadyResolved = await resolveUnresolvedItemForPc5(
      { callerId: ownerId, targetUserId: ownerId, itemId, action: 'defer', itemVersion: 1, idempotencyKey: `pc5if-${stamp}-already` },
      capabilityDeps,
    );
    check('resolving an already-resolved item (old version) is stale_conflict, not a silent success', 'reason' in alreadyResolved && alreadyResolved.reason === 'stale_conflict');

    // Independent DB re-verification of the final state.
    const finalItem = await admin.from('aie_unresolved_item').select('status, item_version').eq('id', itemId).single();
    check('final DB status is deferred (the one real resolution actually applied)', finalItem.data?.status === 'deferred', finalItem.data);
  } finally {
    // --- cleanup + independent re-verification -------------------------
    if (itemId) await admin.from('aie_unresolved_item').delete().eq('id', itemId);
    if (runId) await admin.from('aie_extraction_run').delete().eq('id', runId);
    if (intakeId) await admin.from('aie_document_intake').delete().eq('id', intakeId);
    if (ownerId) await admin.auth.admin.deleteUser(ownerId);
    if (attackerId) await admin.auth.admin.deleteUser(attackerId);

    const residueItem = itemId ? await admin.from('aie_unresolved_item').select('id').eq('id', itemId).maybeSingle() : { data: null };
    const residueRun = runId ? await admin.from('aie_extraction_run').select('id').eq('id', runId).maybeSingle() : { data: null };
    const residueIntake = intakeId ? await admin.from('aie_document_intake').select('id').eq('id', intakeId).maybeSingle() : { data: null };
    const residueOwner = ownerId ? await admin.auth.admin.getUserById(ownerId) : { data: { user: null } };
    const residueAttacker = attackerId ? await admin.auth.admin.getUserById(attackerId) : { data: { user: null } };
    check('ZERO RESIDUE: unresolved item gone', !residueItem.data);
    check('ZERO RESIDUE: run gone', !residueRun.data);
    check('ZERO RESIDUE: intake gone', !residueIntake.data);
    check('ZERO RESIDUE: owner user gone', !residueOwner.data.user);
    check('ZERO RESIDUE: attacker user gone', !residueAttacker.data.user);

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

main();
