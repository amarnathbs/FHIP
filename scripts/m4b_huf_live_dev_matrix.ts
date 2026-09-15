/**
 * M4B — HUF (Hindu Undivided Family) live-DEV proof, run against the real DEV
 * Supabase project.
 *
 * Run: npx tsx scripts/m4b_huf_live_dev_matrix.ts
 *
 * ================================================================
 * WHAT MAKES THIS REAL RATHER THAN A SIMULATION
 * ================================================================
 * Every scenario calls the SAME production units the API route calls, in the
 * SAME order the route calls them, against real rows belonging to real
 * disposable auth users in the real DEV database:
 *
 *   `businessEntityCreateInputSchema`  (the real validation)
 *   `getUserFullExperienceHomeCountry` (the real authoritative-country read)
 *   `BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY` (the real gate table)
 *   `createBusinessEntity`             (the real insert)
 *   `computeBusinessEntityOwnershipValue` / `loadBusinessEntitiesForValuation`
 *                                      (the real Net Worth consolidation)
 *   `resolveOwnerOptions`              (the real PC5 K.5 option set)
 *
 * Nothing here reimplements the logic it is checking.
 *
 * HONEST BOUNDARY. This exercises the route's constituent functions, not the
 * route over HTTP: `lib/supabase/server.ts`'s `createClient()` reads
 * `cookies()` from `next/headers` and cannot run outside a Next request. The
 * HTTP layer above these functions is covered by
 * `tests/unit/businessEntityRoutes.test.ts`, which drives the REAL exported
 * `POST`/`PATCH` handlers. Neither is claimed to be the other.
 *
 * ================================================================
 * THE 0154 GATE, AND WHY THIS SCRIPT HAS TWO MODES
 * ================================================================
 * Migration 0154 CANNOT be applied from this environment. Re-verified fresh,
 * not inherited: `scripts/pc5_ddl_capability_probe.mjs` (2026-09-15) finds no
 * exec/DDL RPC on DEV, no Management-API token and no Postgres connection
 * string. Applying it needs an operator with Supabase dashboard or CLI
 * access.
 *
 * So, exactly as `scripts/pc5_live_dev_matrix.ts` does for 0153, this script
 * detects 0154 up front and runs in one of two modes:
 *
 *   FULL      — 0154 is applied. Every scenario runs for real.
 *   SUBSTRATE — 0154 is absent. Every scenario that does not depend on it
 *               still runs for real, and every scenario that does is
 *               ATTEMPTED anyway so the exact database refusal is captured.
 *               `BLOCKED_ON_0154` means PC5-style "the code genuinely reached
 *               the database and the only thing missing was the schema" —
 *               materially different evidence from "not tested".
 *
 * Nothing is reported as passing that did not actually pass.
 *
 * ================================================================
 * CLEANUP
 * ================================================================
 * Every row and every disposable user is tracked and deleted in a `finally`
 * block, then INDEPENDENTLY RE-VERIFIED absent by a second query. A delete
 * call returning success is not treated as proof. The residue check is its
 * own reported line and fails the run if anything survives.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(__dirname, '..');
// M12E: an agent worktree has no `.env.local` of its own, and this mission's
// standing discipline is that none is ever CREATED in a worktree (no secret is
// written to any persisted config file). So the shared checkout's copy is used
// as a fallback — the identical two-candidate pattern
// `scripts/pc6_live_dev_matrix.ts` and `scripts/pc7_networth_safety_live_dev.mjs`
// already use. No credential is copied, printed or committed.
const ENV_CANDIDATES = [path.join(repoRoot, '.env.local'), path.join('D:', 'FHIP', '.env.local')];
function loadEnv(): Record<string, string> {
  const envPath = ENV_CANDIDATES.find((p) => fs.existsSync(p));
  if (!envPath) {
    console.error('REFUSING: no .env.local found in the worktree or the shared checkout.');
    process.exit(1);
  }
  const raw = fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '');
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error('DEV credentials missing from .env.local — cannot run the live matrix.');
  process.exit(1);
}
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;

import { businessEntityCreateInputSchema, BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY } from '@/lib/validation/businessEntity';
import { getUserFullExperienceHomeCountry } from '@/lib/services/jurisdiction';
import { createBusinessEntity, loadBusinessEntitiesForValuation } from '@/lib/services/businessEntityData';
import { computeBusinessEntityOwnershipValue } from '@/lib/engines/businessEntityValuation';
import { resolveOwnerOptions, businessEntityOwnerRole, BUSINESS_ENTITY_TYPE_DETAIL } from '@/lib/pc5/optionSets';

const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// ---------------------------------------------------------------------------
// Result recording
// ---------------------------------------------------------------------------
type Status = 'PASS' | 'FAIL' | 'BLOCKED_ON_0154' | 'NOT_APPLICABLE';
interface Result {
  id: string;
  description: string;
  status: Status;
  detail?: unknown;
}
const results: Result[] = [];
function record(id: string, description: string, status: Status, detail?: unknown): void {
  results.push({ id, description, status, detail });
  console.log(`[${status.padEnd(15)}] ${id.padEnd(9)} ${description}`);
  if (detail !== undefined) console.log(`${' '.repeat(20)}${JSON.stringify(detail).slice(0, 320)}`);
}

/** The single shape a missing-0154 refusal takes: the entity_type CHECK
 *  rejecting 'huf' (SQLSTATE 23514). Matched on the constraint 0154 owns, so
 *  an unrelated error is never mistaken for this one. */
function looksLike0154Gap(message: string): boolean {
  return /business_entities_entity_type_check/i.test(message);
}

// ---------------------------------------------------------------------------
// Created-row tracking, for guaranteed cleanup
// ---------------------------------------------------------------------------
const created = { users: [] as string[], entities: [] as string[] };
const stamp = Date.now();

/**
 * A disposable user with a REAL confirmed country. `country_confirmed_at` is
 * set because the production route sits behind `requireCountryConfirmedUser`
 * (Mandatory Country Confirmation) — a user who has not confirmed never
 * reaches the HUF gate at all, so a fixture that skipped it would be testing
 * a state the route cannot be in.
 */
async function makeUser(tag: string, country: string | null): Promise<{ id: string; email: string; accessToken: string }> {
  const email = `m4b-huf-${tag}-${stamp}@fhip-test.invalid`;
  const pw = `M4bHuf-${Math.random().toString(36).slice(2)}-Aa1!`;
  const res = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (res.error || !res.data.user) throw new Error(`createUser(${tag}) failed: ${res.error?.message}`);
  const id = res.data.user.id;
  created.users.push(id);

  const profile: Record<string, unknown> = { user_id: id };
  if (country !== null) {
    profile.country_of_residence = country;
    profile.country_confirmed_at = new Date().toISOString();
    // G3 (migration 0127): a GENERIC-experience residence country can never
    // be marked confirmed without a matching coverage-disclosure
    // acknowledgement — enforced by `enforce_generic_disclosure_acknowledgement`
    // against service_role too. Discovered live by this script's first run,
    // and honoured here rather than worked around, so the GB fixture is the
    // REAL state a GB user reaches rather than an impossible one.
    if (country === 'GB') {
      profile.generic_disclosure_acknowledged_at = new Date().toISOString();
      profile.generic_disclosure_version = 'v1';
      profile.generic_disclosure_country = country;
    }
  }
  const up = await admin.from('user_profiles').upsert(profile, { onConflict: 'user_id' });
  if (up.error) throw new Error(`user_profiles upsert(${tag}) failed: ${up.error.message}`);

  const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  });
  const session = (await tokenRes.json()) as { access_token?: string };
  if (!session.access_token) throw new Error(`sign-in(${tag}) failed`);
  return { id, email, accessToken: session.access_token };
}

/** A user-scoped client — RLS applies exactly as it does for a browser. */
function asUser(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * The POST route's real body, unit for unit and in route order. Returns
 * either the route's own 403 refusal or the real insert's outcome.
 */
async function createEntityThroughRouteLogic(
  userId: string,
  supabase: SupabaseClient,
  body: unknown
): Promise<{ stage: 'validation' | 'jurisdiction' | 'insert'; ok: boolean; status?: number; errorCode?: string; message?: string; data?: Record<string, unknown> }> {
  const parsed = businessEntityCreateInputSchema.safeParse(body);
  if (!parsed.success) return { stage: 'validation', ok: false, status: 422, message: parsed.error.message };

  const requiredCountry = BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY[parsed.data.entity_type];
  if (requiredCountry) {
    const homeCountry = await getUserFullExperienceHomeCountry(userId, supabase);
    if (homeCountry !== requiredCountry) {
      return { stage: 'jurisdiction', ok: false, status: 403, errorCode: 'ENTITY_TYPE_UNAVAILABLE_FOR_COUNTRY', message: `resolved home country = ${String(homeCountry)}` };
    }
  }

  const { data, error } = await createBusinessEntity(userId, parsed.data, supabase);
  if (error) return { stage: 'insert', ok: false, status: 400, message: error.message };
  if (data?.id) created.entities.push(data.id as string);
  return { stage: 'insert', ok: true, status: 200, data: data as Record<string, unknown> };
}

function entityBody(entityType: string, overrides: Record<string, unknown> = {}) {
  return {
    name: `M4B ${entityType} ${stamp}`,
    entity_type: entityType,
    ownership_percentage: 60,
    currency_code: 'INR',
    valuation_mode: 'summary',
    summary_net_asset_value: 2_500_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------
let mode: 'FULL' | 'SUBSTRATE' = 'SUBSTRATE';

async function main(): Promise<void> {
  console.log(`\n=== M4B HUF live-DEV matrix — ${new URL(SUPABASE_URL).host} — ${new Date().toISOString()} ===\n`);

  // ---- GATE: is migration 0154 applied? ------------------------------------
  // Probed BEHAVIOURALLY, not structurally: a real service-role insert with
  // entity_type='huf'. A 23514 on `business_entities_entity_type_check`
  // proves the old two-value CHECK is still live, i.e. 0154 has not run.
  const probeUserId = '00000000-0000-0000-0000-000000000000';
  const gateProbe = await admin
    .from('business_entities')
    .insert({ user_id: probeUserId, name: `m4b gate probe ${stamp}`, entity_type: 'huf', currency_code: 'INR', ownership_percentage: 100, valuation_mode: 'summary', summary_net_asset_value: 1 })
    .select('id')
    .single();
  const checkRefusedHuf = Boolean(gateProbe.error && looksLike0154Gap(gateProbe.error.message));
  // Any row that somehow landed is tracked so cleanup removes it.
  if (gateProbe.data?.id) created.entities.push(gateProbe.data.id as string);
  mode = checkRefusedHuf ? 'SUBSTRATE' : 'FULL';
  record(
    'GATE-1',
    `migration 0154 applied to DEV? ${mode === 'FULL' ? 'YES — running in FULL mode' : 'NO — running in SUBSTRATE mode'}`,
    'PASS',
    { code: gateProbe.error?.code, message: gateProbe.error?.message?.slice(0, 200) }
  );
  record(
    'GATE-2',
    'the live entity_type CHECK genuinely refuses \'huf\' today, proving 0154 is required and has not silently already run',
    checkRefusedHuf ? 'PASS' : 'NOT_APPLICABLE',
    { sqlstate: gateProbe.error?.code }
  );

  // ---- Users ---------------------------------------------------------------
  const india = await makeUser('india', 'IN');
  const australia = await makeUser('australia', 'AU');
  const generic = await makeUser('generic', 'GB');
  const unconfirmed = await makeUser('unconfirmed', null);
  record('SETUP-1', 'four real disposable DEV users created with real password sign-in', 'PASS', {
    india: india.id,
    australia: australia.id,
    generic: generic.id,
    unconfirmed: unconfirmed.id,
  });

  // ---- H-01: the gate reads the right authoritative field, live ------------
  const inCountry = await getUserFullExperienceHomeCountry(india.id, asUser(india.accessToken));
  const auCountry = await getUserFullExperienceHomeCountry(australia.id, asUser(australia.accessToken));
  const gbCountry = await getUserFullExperienceHomeCountry(generic.id, asUser(generic.accessToken));
  const noneCountry = await getUserFullExperienceHomeCountry(unconfirmed.id, asUser(unconfirmed.accessToken));
  record(
    'H-01',
    'getUserFullExperienceHomeCountry resolves IN/AU from user_profiles.country_of_residence live, and narrows GB and unset to null',
    inCountry === 'IN' && auCountry === 'AU' && gbCountry === null && noneCountry === null ? 'PASS' : 'FAIL',
    { inCountry, auCountry, gbCountry, noneCountry }
  );

  // ---- H-02: an India user creates a real HUF -----------------------------
  const hufCreate = await createEntityThroughRouteLogic(india.id, asUser(india.accessToken), entityBody('huf'));
  const hufPassedGate = hufCreate.stage === 'insert';
  record(
    'H-02a',
    'an India-confirmed user PASSES the jurisdiction gate for entity_type=huf (the gate is not the blocker)',
    hufPassedGate ? 'PASS' : 'FAIL',
    { stage: hufCreate.stage, status: hufCreate.status, message: hufCreate.message?.slice(0, 160) }
  );
  record(
    'H-02b',
    'an India-confirmed user creates a real HUF row through the real service layer',
    hufCreate.ok ? 'PASS' : looksLike0154Gap(hufCreate.message ?? '') ? 'BLOCKED_ON_0154' : 'FAIL',
    hufCreate.ok ? { id: hufCreate.data?.id, entity_type: hufCreate.data?.entity_type, ownership_percentage: hufCreate.data?.ownership_percentage } : { message: hufCreate.message?.slice(0, 200) }
  );

  // ---- H-03: the server-side refusal for a non-India user -----------------
  // THIS IS THE SECURITY-RELEVANT HALF, AND IT IS FULLY PROVABLE TODAY: the
  // route's own gate fires BEFORE any database write, so it does not depend
  // on 0154 at all.
  for (const [tag, user, expected] of [
    ['australia', australia, 'AU'],
    ['generic(GB)', generic, 'null (GENERIC experience)'],
    ['unconfirmed', unconfirmed, 'null (unresolved)'],
  ] as const) {
    const refused = await createEntityThroughRouteLogic(user.id, asUser(user.accessToken), entityBody('huf'));
    record(
      `H-03 ${tag}`,
      `a ${tag} user is REFUSED entity_type=huf server-side, before any write (expected home country ${expected})`,
      refused.stage === 'jurisdiction' && refused.status === 403 ? 'PASS' : 'FAIL',
      { stage: refused.stage, status: refused.status, errorCode: refused.errorCode, message: refused.message }
    );
  }

  // ---- H-04: a client-supplied country cannot buy the gate off ------------
  const spoofed = await createEntityThroughRouteLogic(
    australia.id,
    asUser(australia.accessToken),
    entityBody('huf', { country_code: 'IN', currency_code: 'INR' })
  );
  record(
    'H-04',
    'an AU user sending country_code=IN and currency_code=INR in the body is still refused — the gate reads user_profiles, never the payload',
    spoofed.stage === 'jurisdiction' && spoofed.status === 403 ? 'PASS' : 'FAIL',
    { stage: spoofed.stage, status: spoofed.status, errorCode: spoofed.errorCode }
  );

  // ---- H-05: the DB backstop against a direct PostgREST insert ------------
  // The route is not the only way in: business_entities' RLS is
  // `for all using (auth.uid() = user_id)`, so an AU user can POST straight
  // to PostgREST with their own token. Migration 0154's trigger is what
  // refuses that. Until 0154 is applied the CHECK refuses it first — for the
  // wrong reason — so the trigger's own 42501 cannot yet be observed.
  const directRes = await fetch(`${SUPABASE_URL}/rest/v1/business_entities`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${australia.accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: australia.id, name: `m4b direct ${stamp}`, entity_type: 'huf', currency_code: 'AUD', ownership_percentage: 100, valuation_mode: 'summary', summary_net_asset_value: 1000 }),
  });
  const directText = await directRes.text();
  let directRowId: string | null = null;
  try {
    const rows = JSON.parse(directText) as Array<{ id?: string }>;
    if (Array.isArray(rows) && rows[0]?.id) directRowId = rows[0].id;
  } catch {
    /* an error body, not rows */
  }
  if (directRowId) created.entities.push(directRowId);
  const directBlockedByTrigger = directRes.status === 403 || /42501|huf: a Hindu Undivided Family/i.test(directText);
  const directBlockedByCheck = looksLike0154Gap(directText);
  record(
    'H-05',
    'an AU user\'s DIRECT PostgREST insert of entity_type=huf (bypassing the route entirely) is refused by the database',
    directBlockedByTrigger ? 'PASS' : directBlockedByCheck ? 'BLOCKED_ON_0154' : 'FAIL',
    { status: directRes.status, body: directText.slice(0, 220) }
  );

  // ---- H-06: Family Trust regression control, live ------------------------
  // The PO's instruction was to ADD HUF, not to change Family Trust. Proven
  // live for BOTH an India and an Australia user, because the HUF gate must
  // not have made the jurisdiction-agnostic types jurisdiction-dependent.
  const ftIn = await createEntityThroughRouteLogic(india.id, asUser(india.accessToken), entityBody('family_trust', { name: `M4B FT IN ${stamp}`, ownership_percentage: 30, summary_net_asset_value: 400_000 }));
  const ftAu = await createEntityThroughRouteLogic(australia.id, asUser(australia.accessToken), entityBody('family_trust', { name: `M4B FT AU ${stamp}`, currency_code: 'AUD', ownership_percentage: 30, summary_net_asset_value: 400_000 }));
  const coAu = await createEntityThroughRouteLogic(australia.id, asUser(australia.accessToken), entityBody('company', { name: `M4B CO AU ${stamp}`, currency_code: 'AUD', ownership_percentage: 100, summary_net_asset_value: 100_000 }));
  record(
    'H-06',
    'Family Trust and Company still create for BOTH an India and an Australia user — unchanged, and NOT made jurisdiction-dependent by the HUF gate',
    ftIn.ok && ftAu.ok && coAu.ok ? 'PASS' : 'FAIL',
    { ftIn: ftIn.ok ? ftIn.data?.entity_type : ftIn.message, ftAu: ftAu.ok ? ftAu.data?.entity_type : ftAu.message, coAu: coAu.ok ? coAu.data?.entity_type : coAu.message }
  );

  // ---- H-07: ownership-scaled value reaches Net Worth ---------------------
  // Read back through the REAL consolidation path the dashboard uses.
  const val = await loadBusinessEntitiesForValuation(india.id, asUser(india.accessToken));
  const rows = (val.data ?? []) as Parameters<typeof computeBusinessEntityOwnershipValue>[0];
  const consolidatedInr = computeBusinessEntityOwnershipValue(rows, 'INR', 56);
  const hufRow = rows.find((r) => (r.entity as unknown as { id: string }).id === hufCreate.data?.id);
  // Expected: the HUF's own 60% of 2,500,000 = 1,500,000, plus the India
  // Family Trust's 30% of 400,000 = 120,000.
  const expectedWithHuf = 1_500_000 + 120_000;
  const expectedWithoutHuf = 120_000;
  record(
    'H-07',
    'the HUF\'s ownership-scaled share reaches Net Worth through the SAME consolidation path as Company/Family Trust',
    hufCreate.ok
      ? consolidatedInr === expectedWithHuf && hufRow !== undefined
        ? 'PASS'
        : 'FAIL'
      : consolidatedInr === expectedWithoutHuf
        ? 'BLOCKED_ON_0154'
        : 'FAIL',
    { consolidatedInr, expectedWithHuf, expectedWithoutHuf, entitiesLoaded: rows.length, hufPresent: hufRow !== undefined }
  );

  // ---- H-08: PC5's own K.5 option set sees the entity ---------------------
  const ownerOptions = await resolveOwnerOptions(india.id);
  const hufOption = ownerOptions.find((o) => o.value === hufCreate.data?.id);
  record(
    'H-08',
    'PC5\'s resolveOwnerOptions surfaces the HUF entity with detail "Hindu Undivided Family (HUF)" and ownerRole \'other\'',
    hufCreate.ok
      ? hufOption?.detail === BUSINESS_ENTITY_TYPE_DETAIL.huf && hufOption?.ownerRole === 'other' && hufOption?.kind === 'business_entity'
        ? 'PASS'
        : 'FAIL'
      : 'BLOCKED_ON_0154',
    { options: ownerOptions.map((o) => ({ label: o.label, detail: o.detail, role: o.ownerRole })).slice(0, 6) }
  );

  // ---- H-09: no ninth ownership value was invented ------------------------
  // Read live off the option set that just came back from the real database,
  // not off a constant.
  const liveRoles = ownerOptions.map((o) => o.ownerRole);
  record(
    'H-09',
    'every owner role in the live option set is one of the canonical EIGHT — no \'huf\' role was invented',
    liveRoles.every((r) => ['self', 'spouse', 'joint', 'child', 'family_trust', 'company', 'smsf', 'other'].includes(r)) && !liveRoles.includes('huf' as never)
      ? 'PASS'
      : 'FAIL',
    { liveRoles, hufMapsTo: businessEntityOwnerRole('huf'), familyTrustMapsTo: businessEntityOwnerRole('family_trust') }
  );
}

// ---------------------------------------------------------------------------
// Cleanup + independent residue re-verification
// ---------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  for (const id of created.entities) await admin.from('business_entities').delete().eq('id', id);
  for (const id of created.users) {
    await admin.from('business_entities').delete().eq('user_id', id);
    await admin.from('user_profiles').delete().eq('user_id', id);
    await admin.auth.admin.deleteUser(id);
  }

  // A delete call returning success is NOT proof. Re-query.
  const residue: Record<string, number> = {};
  if (created.users.length > 0) {
    const ent = await admin.from('business_entities').select('id').in('user_id', created.users);
    residue.business_entities = (ent.data ?? []).length;
    const prof = await admin.from('user_profiles').select('user_id').in('user_id', created.users);
    residue.user_profiles = (prof.data ?? []).length;
    let survivingUsers = 0;
    for (const id of created.users) {
      const got = await admin.auth.admin.getUserById(id);
      if (got.data?.user) survivingUsers += 1;
    }
    residue.auth_users = survivingUsers;
  }
  if (created.entities.length > 0) {
    const byId = await admin.from('business_entities').select('id').in('id', created.entities);
    residue.tracked_entities = (byId.data ?? []).length;
  }
  const clean = Object.values(residue).every((n) => n === 0);
  record('CLEANUP', 'every disposable user and row independently re-verified absent (zero residue)', clean ? 'PASS' : 'FAIL', residue);
}

main()
  .catch((e) => {
    record('FATAL', 'the matrix threw before completing', 'FAIL', { message: e instanceof Error ? e.message : String(e) });
  })
  .finally(async () => {
    await cleanup().catch((e) => record('CLEANUP', 'cleanup itself threw', 'FAIL', { message: String(e) }));

    const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    console.log(`\n=== M4B HUF live-DEV matrix — mode ${mode} — ${JSON.stringify(counts)} ===`);
    const failed = results.filter((r) => r.status === 'FAIL');
    if (failed.length > 0) {
      console.log('\nFAILURES:');
      for (const f of failed) console.log(`  ${f.id}: ${f.description}\n    ${JSON.stringify(f.detail)}`);
    }
    process.exit(failed.length > 0 ? 1 : 0);
  });
