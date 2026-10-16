// Migration 0280 (edit a benchmark entitlement record without creating a duplicate) - real-Postgres (PGlite) proof.
//
// The whole migration ledger (0001 .. 0280) is replayed into an ISOLATED in-memory Postgres. Every rule is exercised through
// the real SECURITY DEFINER functions as the real database roles, with auth.uid() driven by request.jwt.claims. Nothing is
// reimplemented in the test.
//
// ADMIN STANDARD: capabilities touched are can_manage_benchmark_catalogue (propose / edit a draft / propose or cancel a revision)
// and can_approve_benchmark_entitlements (approve a revision / reject a revision / revoke). No new capability. Sections 2 and 4
// (database layer, direct-RPC bypass test) are the CAPABILITY MATRIX block below; section 5 (separation of duties) is the
// self-approval block; section 13 (fail closed) is the "refused and nothing written" assertions.
//
// EVIDENCE LABEL: PGlite-verified. NOT DEV-verified and NOT production-verified (0280 is applied nowhere).
//
// NAMED NEGATIVE CONTROLS (NC-E*): each applies a MUTATED copy of one rule to the same database, runs the SAME named assertion
// and requires it to go red, then restores the real definition and requires it to go green again.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hazards } from './support/sqlEditorHazards';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SUPABASE_ROOT = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(ROOT, 'scripts', 'db-rebuild-check', 'shim.sql');
const MIG_NAME = '0280_bench1_entitlement_edit_revision.sql';
const PACK = path.join(ROOT, 'docs', 'benchmark-data', 'po_apply_entitlement_edit');
const MIGRATION = fs.readFileSync(path.join(MIG_DIR, MIG_NAME), 'utf8');
const part = (l: 'a' | 'b' | 'c') => fs.readFileSync(path.join(PACK, 'parts', `0280${l}.sql`), 'utf8');
const strip = (sql: string) => sql.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');

const CAT = 'eeeeeeee-0000-0000-0000-00000000c001'; // catalogue capability only (proposes)
const CAT2 = 'eeeeeeee-0000-0000-0000-00000000c002'; // a second catalogue admin
const APP = 'eeeeeeee-0000-0000-0000-00000000c003'; // approver capability only
const BOTH = 'eeeeeeee-0000-0000-0000-00000000c004'; // catalogue and approver
const VIEW = 'eeeeeeee-0000-0000-0000-00000000c005'; // PC6 view only
const NOCAP = 'eeeeeeee-0000-0000-0000-00000000c006'; // an admin row with no capability
const PLAIN = 'eeeeeeee-0000-0000-0000-00000000c007'; // a signed-in user who is not an admin
const READER = PLAIN;
const USERS = [CAT, CAT2, APP, BOTH, VIEW, NOCAP, PLAIN];

let db: PGlite;
type Json = Record<string, unknown>;
type Role = 'authenticated' | 'anon' | 'service_role';

async function as<T>(uid: string | null, role: Role, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}
const q = async <T = Json>(sql: string, args: unknown[] = []): Promise<T[]> => (await db.query(sql, args)).rows as T[];
const one = async <T = Json>(sql: string, args: unknown[] = []): Promise<T> => (await q<T>(sql, args))[0];
/** Run one statement as an authenticated user and return the first row. */
const callAs = (uid: string | null, sql: string, args: unknown[] = [], role: Role = 'authenticated') => as(uid, role, async () => (await db.query(sql, args)).rows[0] as Json);
/** The SQLSTATE of a failed statement, or OK. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? `ERR:${(e as Error).message}`;
  }
}

// ---------------------------------------------------------------- fixtures ---
let seq = 0;
const catEntry = (key: string, over: Json = {}): Json => ({ benchmark_key: key, official_name: `Edit test ${key}`, owner_name: 'Test Index Owner Ltd', official_identifier: key, asset_class: 'equity', country_code: 'IN', currency_code: 'INR', return_type: 'TRI', return_variant: 'total_return', frequency: 'business_daily', base_date: '1995-11-03', base_value: 1000, launch_date: '1996-04-22', history_start_date: '1996-04-22', history_class: 'live', calendar_code: 'IN_NSE', methodology_url: 'https://example.test/method', source_url: 'https://example.test/src', evidence_ref: 'unit-test fixture', evidence_retrieved_at: '2026-10-01', ...over });
async function newBenchmark(): Promise<string> {
  seq++;
  const key = `EDIT_TEST_${String(seq).padStart(4, '0')}_TRI`;
  const r = await callAs(CAT, `select upsert_benchmark_catalogue_entry($1::jsonb) as id`, [JSON.stringify(catEntry(key))]);
  return r.id as string;
}
const body = (bid: string, over: Json = {}): Json => ({
  benchmark_id: bid, entitlement_kind: 'commercial_licence', return_variant: 'total_return', currency_code: 'INR',
  allow_manual_ingest: true, allow_automation: false, allow_storage: true, allow_calculation: true, allow_customer_display: true, allow_report_export: false,
  valid_from: '2020-01-01', valid_to: '2099-12-31', post_expiry_storage: 'retain', post_expiry_calculation: true, post_expiry_display: false,
  evidence_reference: 'CONTRACT-FIXTURE-001', evidence_url: 'https://example.test/contract', evidence_document_date: '2026-01-01', evidence_retrieved_at: '2026-10-01', ...over,
});
const propose = async (uid: string, p: Json): Promise<string> => (await callAs(uid, `select propose_benchmark_entitlement($1::jsonb) as id`, [JSON.stringify(p)])).id as string;
const approve = (uid: string, id: string, ack = false, expected: number | null = null) => callAs(uid, `select approve_benchmark_entitlement($1::uuid, $2, $3, $4::integer)`, [id, 'approved in the test fixture', ack, expected]);
const revoke = (uid: string, id: string) => callAs(uid, `select revoke_benchmark_entitlement($1::uuid, $2)`, [id, 'revoked in the test fixture']);
const edit = (uid: string, id: string, p: Json, expected: number | null = null) => callAs(uid, `select update_benchmark_entitlement_draft($1::uuid, $2::jsonb, $3::integer) as n`, [id, JSON.stringify(p), expected]);
const revise = async (uid: string, orig: string, p: Json, reason = 'Correct the rights after re-reading the contract'): Promise<string> =>
  (await callAs(uid, `select propose_benchmark_entitlement_revision($1::uuid, $2::jsonb, $3) as id`, [orig, JSON.stringify(p), reason])).id as string;
const closeRev = (uid: string, id: string, mode: string, reason = 'closed in the test fixture') => callAs(uid, `select close_benchmark_entitlement_revision($1::uuid, $2, $3)`, [id, mode, reason]);
async function approvedRecord(bid: string, over: Json = {}, proposer = CAT, approver = APP): Promise<string> {
  const id = await propose(proposer, body(bid, over));
  await approve(approver, id);
  return id;
}
const row = (id: string) => one<Json>(`select * from ii_benchmark_entitlements where id = $1`, [id]);
const grantsNow = async (bid: string, right: string) => ((await one(`select benchmark_right_allowed($1::uuid, $2) as ok`, [bid, right])).ok as boolean) === true;
/** How many rows of this benchmark grant the right today, counted record by record (the number the OR combination is built from). */
const grantingRows = async (bid: string, right: string) =>
  ((await one(`select count(*)::int n from ii_benchmark_entitlements e where e.benchmark_id = $1 and benchmark_entitlement_grants(e, $2, current_date)`, [bid, right])).n as number);
const actionsFor = async (bid: string) => callAs(READER, `select can_calculate, can_display, can_export, data_from::text as data_from, data_to::text as data_to from benchmark_entitled_actions(array[$1::uuid])`, [bid]);
const events = (id: string) => q<{ event_type: string; before_state: Json | null; after_state: Json | null; reason: string | null; actor_user_id: string | null }>(`select event_type, before_state, after_state, reason, actor_user_id from ii_benchmark_governance_events where subject_id = $1 order by created_at, event_type`, [id]);

// Restore a state every negative control may have broken, so the real definitions can be re-applied.
async function repairForRestore() {
  await db.exec(`
    update ii_benchmark_entitlements set status = 'revoked', revoked_by = coalesce(revoked_by, created_by), revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, 'repair after a negative control')
     where superseded_at is not null and status <> 'revoked';
    update ii_benchmark_entitlements r set status = 'revoked', revoked_by = created_by, revoked_at = now(), revoked_reason = 'repair after a negative control'
     where r.status = 'draft' and r.supersedes_entitlement_id is not null
       and exists (select 1 from ii_benchmark_entitlements o where o.supersedes_entitlement_id = r.supersedes_entitlement_id and o.status = 'draft' and o.id < r.id);
  `);
}
async function restoreReal() {
  await repairForRestore();
  await db.exec(strip(part('a')));
  await db.exec(strip(part('b')));
  await db.exec(strip(part('c')));
}
/** The assertion must fail (red) under the mutation; the control name is part of any failure message. */
async function expectRed(name: string, assertion: () => Promise<void>) {
  let red = false;
  try {
    await assertion();
  } catch {
    red = true;
  }
  if (!red) throw new Error(`${name}: the named assertion stayed GREEN under the mutation, so the rule is not proven`);
}
function mutate(src: string, from: string | RegExp, to: string): string {
  const out = src.replace(from, to);
  if (out === src) throw new Error(`mutation did not apply: ${String(from).slice(0, 60)}`);
  return out;
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  expect(files).toContain(MIG_NAME);
  // 16-10-2026: was `files.at(-1) === MIG_NAME`, which fails the moment ANY later migration exists (0284 per-user AI cap,
  // NAV2 0281/0282, ...). What this guard is for is a number collision, so it now asserts exactly that: 0280 is this file alone.
  expect(files.filter((f) => f.startsWith('0280')), 'two migrations share the number 0280: re-check the number choice').toEqual([MIG_NAME]);
  for (const f of files) {
    await db.exec(strip(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  for (const u of USERS) await db.exec(`insert into auth.users (id, email) values ('${u}', '${u.slice(-4)}@edit.test') on conflict do nothing;`);
  for (const u of [CAT, CAT2, APP, BOTH, VIEW, NOCAP]) await db.exec(`insert into admin_users (user_id) values ('${u}') on conflict do nothing;`);
  await db.exec(`
    update admin_users set can_manage_benchmark_catalogue = true where user_id in ('${CAT}', '${CAT2}', '${BOTH}');
    update admin_users set can_approve_benchmark_entitlements = true where user_id in ('${APP}', '${BOTH}');
    update admin_users set can_view_reference_data_quality = true where user_id = '${VIEW}';
  `);
}, 900_000);

afterAll(async () => {
  await db?.close();
});

// ------------------------------------------------------------------ named assertions (used by tests AND controls) ---
/** Approving a revision leaves exactly ONE approved record and the original is closed as superseded. */
async function assertRevisionApprovalSupersedesOriginal() {
  const bid = await newBenchmark();
  const o = await approvedRecord(bid, { allow_report_export: false });
  const r = await revise(CAT, o, body(bid, { allow_report_export: true }));
  await approve(APP, r);
  expect(await grantingRows(bid, 'calculation'), 'exactly one record grants calculation after the revision is approved').toBe(1);
  expect((await row(o)).status).toBe('revoked');
  expect((await row(o)).superseded_by).toBe(r);
  expect((await row(r)).status).toBe('approved');
}
/** Two revisions can never be open for one record. */
async function assertSingleOpenRevision() {
  const bid = await newBenchmark();
  const o = await approvedRecord(bid);
  await revise(CAT, o, body(bid, { allow_report_export: true }));
  expect(await codeOf(revise(CAT2, o, body(bid, { allow_report_export: false, notes: 'second attempt' }))), 'a second open revision is refused').toBe('55000');
  expect((await one(`select count(*)::int n from ii_benchmark_entitlements where supersedes_entitlement_id = $1 and status = 'draft'`, [o])).n).toBe(1);
  // the database itself, not only the function, refuses a second open revision
  const dup = await codeOf(db.exec(`insert into ii_benchmark_entitlements (benchmark_id, entitlement_kind, return_variant, currency_code, valid_from, evidence_reference, created_by, supersedes_entitlement_id, revision_reason, allow_storage)
    values ('${bid}', 'commercial_licence', 'total_return', 'INR', date '2020-01-01', 'DIRECT-INSERT-1', '${CAT}', '${o}', 'a direct insert attempt', true)`));
  expect(dup, 'the unique index refuses a second open revision even by a direct insert').toBe('23505');
}
/** A catalogue-capability check on editing a draft. */
async function assertDraftEditNeedsCatalogueCapability() {
  const bid = await newBenchmark();
  const d = await propose(CAT, body(bid));
  for (const [who, uid] of [['non-admin', PLAIN], ['view only', VIEW], ['admin without capability', NOCAP], ['approver only', APP]] as const) {
    expect(await codeOf(edit(uid, d, body(bid, { notes: `edit by ${who}` }))), `${who} must not edit a draft`).toBe('42501');
  }
  expect((await row(d)).edit_count).toBe(0);
  // the proposer whose catalogue capability was withdrawn after proposing can no longer edit (capability is read fresh, not remembered)
  await db.exec(`update admin_users set can_manage_benchmark_catalogue = false where user_id = '${CAT}'`);
  try {
    expect(await codeOf(edit(CAT, d, body(bid, { notes: 'edit after the capability was withdrawn' }))), 'a proposer without the capability must not edit').toBe('42501');
  } finally {
    await db.exec(`update admin_users set can_manage_benchmark_catalogue = true where user_id = '${CAT}'`);
  }
  expect((await row(d)).edit_count).toBe(0);
}
/** Only the proposer edits a draft. */
async function assertOnlyProposerEditsDraft() {
  const bid = await newBenchmark();
  const d = await propose(CAT, body(bid));
  expect(await codeOf(edit(CAT2, d, body(bid, { notes: 'edited by someone else' }))), 'another catalogue admin must not edit').toBe('42501');
  expect((await row(d)).edit_count).toBe(0);
}
/** A proposer approves their own record only with the acknowledgement (revisions included). */
async function assertSelfApprovalNeedsAcknowledgement() {
  const bid = await newBenchmark();
  const o = await approvedRecord(bid);
  const r = await revise(BOTH, o, body(bid, { allow_report_export: true }));
  expect(await codeOf(approve(BOTH, r, false)), 'self approval without acknowledgement is refused').toBe('42501');
  expect((await row(r)).status).toBe('draft');
  expect((await row(o)).status).toBe('approved');
}
/** Approving a record that was edited after it was opened is refused. */
async function assertStaleApprovalRefused() {
  const bid = await newBenchmark();
  const d = await propose(CAT, body(bid));
  await edit(CAT, d, body(bid, { notes: 'edited after the approver opened it' }), 0);
  expect(await codeOf(approve(APP, d, false, 0)), 'approving with an out-of-date edit count is refused').toBe('40001');
  expect((await row(d)).status).toBe('draft');
}
/** Revoking an approved record also closes its open revision. */
async function assertRevokeClosesOpenRevision() {
  const bid = await newBenchmark();
  const o = await approvedRecord(bid);
  const r = await revise(CAT, o, body(bid, { allow_report_export: true }));
  await revoke(APP, o);
  expect((await row(r)).status, 'the open revision is closed with its original').toBe('revoked');
  expect(await codeOf(approve(APP, r)), 'a closed revision cannot be approved afterwards').toBe('55000');
  expect(await grantingRows(bid, 'calculation')).toBe(0);
}
/** Approving a revision is all or nothing: a failure at either step leaves the original in force and the revision a draft. */
async function assertApprovalIsAtomic() {
  for (const guard of ['revision', 'original'] as const) {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid);
    const r = await revise(CAT, o, body(bid, { allow_report_export: true }));
    const cond = guard === 'revision' ? `new.status = 'approved' and new.supersedes_entitlement_id is not null and new.benchmark_id = '${bid}'` : `new.superseded_at is not null and new.benchmark_id = '${bid}'`;
    await db.exec(`
      create or replace function public.zz_inject_failure_step() returns trigger language plpgsql as $t$ begin raise exception 'injected failure for the atomicity test'; end $t$;
      drop trigger if exists trg_inject_failure on ii_benchmark_entitlements;
      create trigger trg_inject_failure before update on ii_benchmark_entitlements for each row when (${cond}) execute function public.zz_inject_failure_step();
    `);
    const code = await codeOf(approve(APP, r));
    await db.exec(`drop trigger if exists trg_inject_failure on ii_benchmark_entitlements; drop function if exists public.zz_inject_failure_step();`);
    expect(code, `the injected ${guard} failure surfaces`).not.toBe('OK');
    expect((await row(o)).status, `after a failure at the ${guard} step the original is still approved`).toBe('approved');
    expect((await row(o)).superseded_at).toBeNull();
    expect((await row(r)).status, `after a failure at the ${guard} step the revision is still a draft`).toBe('draft');
    expect(await grantingRows(bid, 'calculation'), 'the rights never lapsed').toBe(1);
  }
}

// ---------------------------------------------------------------- tests ---
describe('migration 0280 - shape, idempotency, grants', () => {
  it('re-applying the whole migration changes nothing and raises nothing (idempotent), and the parts joined are byte-equal to it', async () => {
    const before = await one<{ c: number; i: number; f: number }>(`select (select count(*)::int from pg_constraint where conrelid = 'public.ii_benchmark_entitlements'::regclass) c, (select count(*)::int from pg_indexes where tablename = 'ii_benchmark_entitlements') i, (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%benchmark_entitlement%') f`);
    expect(await codeOf(db.exec(strip(MIGRATION)))).toBe('OK');
    expect(await codeOf(db.exec(strip(MIGRATION)))).toBe('OK');
    const after = await one<{ c: number; i: number; f: number }>(`select (select count(*)::int from pg_constraint where conrelid = 'public.ii_benchmark_entitlements'::regclass) c, (select count(*)::int from pg_indexes where tablename = 'ii_benchmark_entitlements') i, (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%benchmark_entitlement%') f`);
    expect(after).toEqual(before);
    expect(part('a') + part('b') + part('c')).toBe(MIGRATION);
  });

  it('running the older migration 0241 again after 0280 puts back its three-argument approve and its older revoke; running 0280 again repairs both (documented in the README)', async () => {
    const m0241 = fs.readFileSync(path.join(MIG_DIR, fs.readdirSync(MIG_DIR).find((f) => f.startsWith('0241_')) as string), 'utf8');
    expect(await codeOf(db.exec(strip(m0241)))).toBe('OK');
    expect((await one(`select count(*)::int n from pg_proc where proname = 'approve_benchmark_entitlement'`)).n, '0241 re-run leaves two approve functions').toBe(2);
    expect(await codeOf(db.exec(strip(MIGRATION)))).toBe('OK');
    expect((await one(`select count(*)::int n from pg_proc where proname = 'approve_benchmark_entitlement'`)).n, '0280 re-run repairs it').toBe(1);
    await assertRevisionApprovalSupersedesOriginal();
    await assertRevokeClosesOpenRevision();
  });

  it('RELEASE ORDER, SQL first: the OLD app (calls by name with the three older arguments, reads the 0241 columns) keeps working on the 0280 database, including approving a revision', async () => {
    // PostgREST calls an RPC by argument NAME. These are exactly the calls the previous application version makes.
    const bid = await newBenchmark();
    const d = await propose(CAT, body(bid));
    await as(APP, 'authenticated', () => db.query(`select approve_benchmark_entitlement(p_id => $1::uuid, p_note => $2, p_self_approval_ack => $3::boolean)`, [d, 'approved by the old application', false]));
    expect((await row(d)).status).toBe('approved');
    // the old overview selects only the 0241 columns: they all still exist
    const old = await as(VIEW, 'authenticated', () => db.query(`select id, benchmark_id, entitlement_kind, status, allow_manual_ingest, allow_automation, allow_storage, allow_calculation, allow_customer_display, allow_report_export, data_from, data_to, valid_from, valid_to, post_expiry_storage, evidence_reference, evidence_url, created_by, approved_at from ii_benchmark_entitlements where benchmark_id = $1`, [bid]));
    expect(old.rows).toHaveLength(1);
    // a revision (only the NEW application can create one) approved through the OLD approve call is handled by the database: the original is superseded
    const r = await revise(CAT, d, body(bid, { allow_report_export: true }));
    await as(APP, 'authenticated', () => db.query(`select approve_benchmark_entitlement(p_id => $1::uuid, p_note => $2, p_self_approval_ack => $3::boolean)`, [r, 'approved by the old application', false]));
    expect(await grantingRows(bid, 'calculation')).toBe(1);
    expect((await row(d)).superseded_by).toBe(r);
    await as(APP, 'authenticated', () => db.query(`select revoke_benchmark_entitlement(p_id => $1::uuid, p_reason => $2)`, [r, 'revoked by the old application']));
    expect(await grantingRows(bid, 'calculation')).toBe(0);
  });

  it('adds columns, four new checks and two unique indexes, and does NOT touch the existing status check or any 0241 constraint', async () => {
    const cols = (await q<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'ii_benchmark_entitlements' and column_name in ('supersedes_entitlement_id','superseded_by','superseded_at','revision_reason','edit_count','last_edited_at')`)).map((c) => c.column_name);
    expect(cols.sort()).toEqual(['edit_count', 'last_edited_at', 'revision_reason', 'superseded_at', 'superseded_by', 'supersedes_entitlement_id']);
    const names = (await q<{ conname: string }>(`select conname from pg_constraint where conrelid = 'public.ii_benchmark_entitlements'::regclass`)).map((c) => c.conname);
    for (const n of ['ii_benchmark_entitlements_term', 'ii_benchmark_entitlements_data_range', 'ii_benchmark_entitlements_approved_attributed', 'ii_benchmark_entitlements_revoked_attributed', 'ii_benchmark_entitlements_public_needs_evidence', 'ii_benchmark_entitlements_rights_coherent', 'ii_benchmark_entitlements_status_check', 'ii_benchmark_entitlements_entitlement_kind_check'])
      expect(names, `0241 constraint ${n} still exists`).toContain(n);
    for (const n of ['ii_benchmark_entitlements_superseded_pair', 'ii_benchmark_entitlements_superseded_is_closed', 'ii_benchmark_entitlements_revision_reason', 'ii_benchmark_entitlements_no_self_link']) expect(names).toContain(n);
    const status = (await one<{ d: string }>(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'ii_benchmark_entitlements_status_check'`)).d;
    expect(status).toMatch(/draft/);
    expect(status).toMatch(/approved/);
    expect(status).toMatch(/revoked/);
    expect(status, 'no superseded value was added to the shared status list').not.toMatch(/superseded/);
    const idx = (await q<{ indexname: string }>(`select indexname from pg_indexes where tablename = 'ii_benchmark_entitlements'`)).map((i) => i.indexname);
    expect(idx).toContain('uq_ii_benchmark_entitlements_one_open_revision');
    expect(idx).toContain('uq_ii_benchmark_entitlements_superseded_by');
  });

  it('every new RPC is SECURITY DEFINER with a fixed search_path; anon cannot execute; authenticated can; the internal helpers are not callable by API roles', async () => {
    const rpcs = ['update_benchmark_entitlement_draft(uuid,jsonb,integer)', 'propose_benchmark_entitlement_revision(uuid,jsonb,text)', 'approve_benchmark_entitlement(uuid,text,boolean,integer)', 'revoke_benchmark_entitlement(uuid,text)', 'close_benchmark_entitlement_revision(uuid,text,text)'];
    for (const f of rpcs) {
      const r = await one<{ secdef: boolean; cfg: string[] | null; anon: boolean; auth: boolean; pub: boolean }>(`select prosecdef secdef, proconfig cfg, has_function_privilege('anon', oid, 'execute') anon, has_function_privilege('authenticated', oid, 'execute') auth, has_function_privilege('public', oid, 'execute') pub from pg_proc where oid = 'public.${f}'::regprocedure`);
      expect(r.secdef, `${f} security definer`).toBe(true);
      expect((r.cfg ?? []).join(','), `${f} search_path`).toMatch(/search_path=public/);
      expect(r.anon, `${f} anon`).toBe(false);
      expect(r.pub, `${f} public`).toBe(false);
      expect(r.auth, `${f} authenticated`).toBe(true);
    }
    for (const f of ['ii_bm_entitlement_editable(ii_benchmark_entitlements)', 'ii_bm_entitlement_normalise(jsonb,uuid,uuid)']) {
      const r = await one<{ anon: boolean; auth: boolean }>(`select has_function_privilege('anon', 'public.${f}'::regprocedure, 'execute') anon, has_function_privilege('authenticated', 'public.${f}'::regprocedure, 'execute') auth`);
      expect(r.anon || r.auth, `${f} must not be callable by API roles`).toBe(false);
    }
    // the previous three-argument approve is gone: exactly one approve function exists
    expect((await one(`select count(*)::int n from pg_proc where proname = 'approve_benchmark_entitlement'`)).n).toBe(1);
  });

  it('writes to the table stay closed: an authenticated admin cannot insert, update or delete a record directly, and the audit log stays append-only', async () => {
    const bid = await newBenchmark();
    const d = await propose(CAT, body(bid));
    expect(await codeOf(as(BOTH, 'authenticated', () => db.query(`update ii_benchmark_entitlements set status = 'approved' where id = $1`, [d])))).toBe('42501');
    expect(await codeOf(as(BOTH, 'authenticated', () => db.query(`delete from ii_benchmark_entitlements where id = $1`, [d])))).toBe('42501');
    expect((await row(d)).status).toBe('draft');
    expect(await codeOf(db.exec(`update ii_benchmark_governance_events set reason = 'tampered' where subject_id = '${d}'`))).not.toBe('OK');
  });
});

describe('draft: the proposer edits in place, each save audited', () => {
  it('edits any field, counts the edit, and records the fields before and after (no person or user id in the audit images)', async () => {
    const bid = await newBenchmark();
    const d = await propose(CAT, body(bid, { notes: 'first wording' }));
    const n1 = (await edit(CAT, d, body(bid, { notes: 'second wording', allow_report_export: true, valid_to: '2030-12-31' }), 0)).n;
    expect(n1).toBe(1);
    const r = await row(d);
    expect(r.notes).toBe('second wording');
    expect(r.allow_report_export).toBe(true);
    expect(r.valid_to).toBeTruthy();
    expect(r.edit_count).toBe(1);
    expect(r.status).toBe('draft');
    const ev = (await events(d)).find((e) => e.event_type === 'entitlement_draft_edited');
    expect(ev, 'the save is audited').toBeTruthy();
    expect(ev?.before_state?.notes).toBe('first wording');
    expect(ev?.after_state?.notes).toBe('second wording');
    expect(ev?.before_state?.allow_report_export).toBe(false);
    expect(ev?.after_state?.allow_report_export).toBe(true);
    const blob = JSON.stringify([ev?.before_state, ev?.after_state]);
    for (const u of USERS) expect(blob, 'no user id inside the audit images').not.toContain(u);
    expect(ev?.actor_user_id).toBe(CAT);
  });

  it('can also move the draft to another benchmark and the variant and currency follow the catalogue row', async () => {
    const a = await newBenchmark();
    const b = await newBenchmark();
    const d = await propose(CAT, body(a));
    await edit(CAT, d, body(b));
    expect((await row(d)).benchmark_id).toBe(b);
  });

  it('refuses, and writes nothing, for: a stale screen, a save that changes nothing, an unknown benchmark, rights that do not fit together, and a public-use permission without a document', async () => {
    const bid = await newBenchmark();
    const d = await propose(CAT, body(bid));
    await edit(CAT, d, body(bid, { notes: 'v1' }), 0);
    expect(await codeOf(edit(CAT, d, body(bid, { notes: 'v2' }), 0)), 'stale edit count').toBe('40001');
    expect(await codeOf(edit(CAT, d, body(bid, { notes: 'v1' }))), 'nothing changed').toBe('22023');
    expect(await codeOf(edit(CAT, d, body('00000000-0000-0000-0000-000000000000', { notes: 'v3' }))), 'unknown benchmark').toBe('22023');
    expect(await codeOf(edit(CAT, d, body(bid, { allow_calculation: true, allow_storage: false, allow_manual_ingest: false, allow_customer_display: false }))), 'calculation needs storage').toBe('23514');
    expect(await codeOf(edit(CAT, d, body(bid, { entitlement_kind: 'public_use_permission', evidence_url: null }))), 'public use needs evidence').toBe('23514');
    expect(await codeOf(edit(CAT, d, body(bid, { return_variant: 'price' }))), 'variant must equal the catalogue').toBe('22023');
    const r = await row(d);
    expect(r.notes).toBe('v1');
    expect(r.edit_count).toBe(1);
  });

  it('an approved, revoked or closed record cannot be edited in place (it is revised instead)', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid);
    expect(await codeOf(edit(CAT, o, body(bid, { notes: 'in place' })))).toBe('55000');
    const d = await propose(CAT, body(bid, { notes: 'to be revoked' }));
    await revoke(APP, d);
    expect(await codeOf(edit(CAT, d, body(bid, { notes: 'after revoke' })))).toBe('55000');
  });
});

describe('approved: edit means ONE open revision; the original stays in force until the revision is approved', () => {
  it('proposing a revision creates a linked draft, requires a reason of at least 10 characters, and grants nothing yet', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid, { allow_report_export: false });
    expect(await codeOf(revise(CAT, o, body(bid, { allow_report_export: true }), 'too short'))).toBe('22023');
    const r = await revise(CAT, o, body(bid, { allow_report_export: true }));
    const rr = await row(r);
    expect(rr.status).toBe('draft');
    expect(rr.supersedes_entitlement_id).toBe(o);
    expect(rr.revision_reason).toBe('Correct the rights after re-reading the contract');
    expect(rr.created_by).toBe(CAT);
    // the original is untouched and still grants; the revision grants nothing
    expect((await row(o)).status).toBe('approved');
    expect(await grantingRows(bid, 'calculation')).toBe(1);
    expect(await grantsNow(bid, 'report_export'), 'the new right is not granted before approval').toBe(false);
    expect((await one(`select count(*)::int n from ii_benchmark_entitlements where benchmark_id = $1`, [bid])).n, 'no duplicate approved record').toBe(2);
  });

  it('refuses: a revision of a draft, of a missing record, that changes nothing, that moves to another benchmark, and by a caller without the catalogue capability', async () => {
    const bid = await newBenchmark();
    const other = await newBenchmark();
    const o = await approvedRecord(bid);
    const draft = await propose(CAT, body(bid, { notes: 'still a draft' }));
    expect(await codeOf(revise(CAT, draft, body(bid, { notes: 'x' })))).toBe('55000');
    expect(await codeOf(revise(CAT, '00000000-0000-0000-0000-000000000000', body(bid)))).toBe('P0002');
    expect(await codeOf(revise(CAT, o, body(bid)))).toBe('22023');
    expect(await codeOf(revise(CAT, o, body(other, { allow_report_export: true })))).toBe('22023');
    for (const uid of [PLAIN, VIEW, NOCAP, APP]) expect(await codeOf(revise(uid, o, body(bid, { allow_report_export: true })))).toBe('42501');
    expect((await one(`select count(*)::int n from ii_benchmark_entitlements where supersedes_entitlement_id = $1`, [o])).n).toBe(0);
  });

  it('at most one open revision per record, enforced by the function and by the database', assertSingleOpenRevision);

  it('the proposer edits an open revision (reason included); its benchmark stays that of the original', async () => {
    const bid = await newBenchmark();
    const other = await newBenchmark();
    const o = await approvedRecord(bid);
    const r = await revise(CAT, o, body(bid, { allow_report_export: true }));
    await edit(CAT, r, { ...body(bid, { allow_report_export: true, notes: 'reworded' }), revision_reason: 'A better explanation of the change' }, 0);
    const rr = await row(r);
    expect(rr.notes).toBe('reworded');
    expect(rr.revision_reason).toBe('A better explanation of the change');
    expect(await codeOf(edit(CAT, r, body(other, { allow_report_export: true })))).toBe('22023');
    expect(await codeOf(edit(CAT, r, { ...body(bid, { allow_report_export: true, notes: 'reworded' }), revision_reason: 'short' }))).toBe('22023');
    const ev = (await events(r)).map((e) => e.event_type);
    expect(ev).toEqual(expect.arrayContaining(['entitlement_revision_proposed', 'entitlement_revision_edited']));
  });

  it('approving the revision approves it and closes the original as superseded, in one transaction; the original is kept', assertRevisionApprovalSupersedesOriginal);

  it('the history keeps the superseded original (never deleted) with its link, the approver and a reason, and it is visible to a view-only admin but not to a plain user', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid);
    const r = await revise(CAT, o, body(bid, { notes: 'v2' }));
    await approve(APP, r);
    const orig = await row(o);
    expect(orig.status).toBe('revoked');
    expect(orig.superseded_at).toBeTruthy();
    expect(orig.superseded_by).toBe(r);
    expect(orig.revoked_by).toBe(APP);
    expect(String(orig.revoked_reason)).toMatch(/superseded/i);
    expect(orig.allow_storage, 'its rights are kept as they were').toBe(true);
    const seen = await as(VIEW, 'authenticated', async () => (await db.query(`select id from ii_benchmark_entitlements where benchmark_id = $1`, [bid])).rows.length);
    expect(seen).toBe(2);
    const plain = await as(PLAIN, 'authenticated', async () => (await db.query(`select id from ii_benchmark_entitlements where benchmark_id = $1`, [bid])).rows.length);
    expect(plain).toBe(0);
    const types = [...(await events(r)), ...(await events(o))].map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['entitlement_revision_proposed', 'entitlement_revision_approved', 'entitlement_superseded']));
    const approvedEv = (await events(r)).find((e) => e.event_type === 'entitlement_revision_approved');
    expect(approvedEv?.before_state?.notes ?? null).not.toBe('v2');
    expect(approvedEv?.after_state?.notes).toBe('v2');
    expect(approvedEv?.reason).toBe('approved in the test fixture');
  });

  it('a revision can be revised again: the chain O -> R1 -> R2 leaves exactly one record in force', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid);
    const r1 = await revise(CAT, o, body(bid, { notes: 'r1' }));
    await approve(APP, r1);
    const r2 = await revise(CAT2, r1, body(bid, { notes: 'r2', allow_report_export: true }));
    await approve(APP, r2);
    expect(await grantingRows(bid, 'calculation')).toBe(1);
    expect((await row(o)).superseded_by).toBe(r1);
    expect((await row(r1)).superseded_by).toBe(r2);
    expect((await row(r2)).status).toBe('approved');
    expect(await grantsNow(bid, 'report_export')).toBe(true);
  });

  it('cancelling (by the proposer) or rejecting (by an approver) leaves the original untouched and frees the slot for a new revision', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid);
    const r1 = await revise(CAT, o, body(bid, { allow_report_export: true }));
    expect(await codeOf(closeRev(CAT2, r1, 'cancel')), 'only the proposer cancels').toBe('42501');
    expect(await codeOf(closeRev(CAT, r1, 'reject')), 'a catalogue admin cannot reject').toBe('42501');
    expect(await codeOf(closeRev(CAT, r1, 'cancel', 'short'))).toBe('22023');
    await closeRev(CAT, r1, 'cancel');
    expect((await row(r1)).status).toBe('revoked');
    expect((await row(o)).status).toBe('approved');
    expect((await row(o)).superseded_at).toBeNull();
    expect(await grantingRows(bid, 'calculation')).toBe(1);
    const r2 = await revise(CAT, o, body(bid, { allow_report_export: true, notes: 'second try' }));
    await closeRev(APP, r2, 'reject');
    expect((await row(r2)).status).toBe('revoked');
    expect((await row(o)).status).toBe('approved');
    expect((await events(r1)).map((e) => e.event_type)).toContain('entitlement_revision_cancelled');
    expect((await events(r2)).map((e) => e.event_type)).toContain('entitlement_revision_rejected');
    expect(await codeOf(closeRev(APP, o, 'reject')), 'an original is not a revision').toBe('55000');
    expect(await codeOf(closeRev(APP, r2, 'reject')), 'a closed revision cannot be closed twice').toBe('55000');
    expect(await codeOf(closeRev(APP, r2, 'delete')), 'unknown mode').toBe('22023');
  });

  it('revoking the original closes its open revision, so a revoked licence cannot be brought back by approving a revision made earlier', assertRevokeClosesOpenRevision);

  it('revoke behaviour is unchanged: needs the approver capability and a reason of 10 characters, is idempotent, and a revoked record grants nothing', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid);
    expect(await codeOf(callAs(CAT, `select revoke_benchmark_entitlement($1::uuid, $2)`, [o, 'a long enough reason']))).toBe('42501');
    expect(await codeOf(callAs(APP, `select revoke_benchmark_entitlement($1::uuid, $2)`, [o, 'short']))).toBe('22023');
    await revoke(APP, o);
    await revoke(APP, o);
    expect(await grantingRows(bid, 'calculation')).toBe(0);
    expect(await grantsNow(bid, 'storage')).toBe(false);
    expect(await codeOf(revise(CAT, o, body(bid, { allow_report_export: true })))).toBe('55000');
  });

  it('a draft can still be approved and a plain approval is unchanged (audit event entitlement_approved)', async () => {
    const bid = await newBenchmark();
    const d = await propose(CAT, body(bid));
    await approve(APP, d);
    expect((await row(d)).status).toBe('approved');
    expect((await events(d)).map((e) => e.event_type)).toEqual(expect.arrayContaining(['entitlement_proposed', 'entitlement_approved']));
    expect(await codeOf(approve(APP, d)), 'approving twice').toBe('55000');
  });
});

describe('the rights combination never counts a superseded record, and never has a gap', () => {
  it('while a revision is open the original alone grants; the revision (with more rights) grants nothing', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid, { allow_report_export: false });
    await revise(CAT, o, body(bid, { allow_report_export: true }));
    expect(await grantingRows(bid, 'calculation')).toBe(1);
    expect(await grantingRows(bid, 'report_export')).toBe(0);
    const a = await actionsFor(bid);
    expect(a.can_calculate).toBe(true);
    expect(a.can_export).toBe(false);
  });

  it('after approval the NEW rights apply and a right removed by the revision is really gone (the superseded original does not keep it alive)', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid, { allow_report_export: true, allow_customer_display: true });
    const r = await revise(CAT, o, body(bid, { allow_report_export: false, allow_customer_display: false, allow_calculation: true }));
    expect(await grantsNow(bid, 'customer_display')).toBe(true);
    await approve(APP, r);
    expect(await grantsNow(bid, 'customer_display'), 'removed right').toBe(false);
    expect(await grantsNow(bid, 'report_export'), 'removed right').toBe(false);
    expect(await grantsNow(bid, 'calculation')).toBe(true);
    const a = await actionsFor(bid);
    expect([a.can_calculate, a.can_display, a.can_export]).toEqual([true, false, false]);
  });

  it('the data-date scope reported to consumers is the revision only: a superseded original does not widen or narrow it', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid, { data_from: '2010-01-01', data_to: '2020-12-31' });
    const r = await revise(CAT, o, body(bid, { data_from: '2012-01-01', data_to: '2018-12-31' }));
    let a = await actionsFor(bid);
    expect([String(a.data_from).slice(0, 10), String(a.data_to).slice(0, 10)]).toEqual(['2010-01-01', '2020-12-31']);
    await approve(APP, r);
    a = await actionsFor(bid);
    expect([String(a.data_from).slice(0, 10), String(a.data_to).slice(0, 10)]).toEqual(['2012-01-01', '2018-12-31']);
    expect(await grantsNow(bid, 'calculation')).toBe(true);
    expect((await one(`select benchmark_right_allowed($1::uuid, 'calculation', current_date, date '2010-06-01', date '2011-01-01') as ok`, [bid])).ok, 'a data range only the superseded original covered is no longer allowed').toBe(false);
  });

  it('the series read policy follows: a plain reader sees the series before and after, and sees nothing once a revision removes calculation', async () => {
    const bid = await newBenchmark();
    await db.exec(`insert into ii_benchmark_series (benchmark_id, series_date, value, currency_code) values ('${bid}', date '2024-01-02', 1000, 'INR')`);
    const seen = () => as(READER, 'authenticated', async () => (await db.query(`select 1 from ii_benchmark_series where benchmark_id = $1`, [bid])).rows.length);
    expect(await seen(), 'no entitlement, no read').toBe(0);
    const o = await approvedRecord(bid);
    expect(await seen()).toBe(1);
    const r = await revise(CAT, o, body(bid, { allow_calculation: false, allow_customer_display: false, allow_report_export: false }));
    expect(await seen(), 'an open revision changes nothing for readers').toBe(1);
    await approve(APP, r);
    expect(await seen(), 'the superseded original no longer opens the series').toBe(0);
    const ids = (await callAs(READER, `select benchmark_calc_readable_ids() as ids`)).ids as string[];
    expect(ids).not.toContain(bid);
  });

  it('a superseded record can never grant: it is stored as revoked and the database refuses superseded_at on an approved row', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid);
    const r = await revise(CAT, o, body(bid, { allow_report_export: true }));
    await approve(APP, r);
    for (const right of ['ingest_manual', 'storage', 'calculation', 'customer_display']) {
      const g = await one(`select benchmark_entitlement_grants(e, $2, current_date) as g from ii_benchmark_entitlements e where e.id = $1`, [o, right]);
      expect(g.g, `superseded original must not grant ${right}`).toBe(false);
    }
    expect(await codeOf(db.exec(`update ii_benchmark_entitlements set status = 'approved' where id = '${o}'`)), 'a superseded row cannot be set back to approved').toBe('23514');
    expect(await codeOf(db.exec(`update ii_benchmark_entitlements set superseded_at = null where id = '${o}'`)), 'superseded_at and superseded_by travel together').toBe('23514');
    expect(await grantingRows(bid, 'calculation')).toBe(1);
  });

  it('there is no moment without a record in force: a failure at either step of the approval rolls everything back', assertApprovalIsAtomic);

  it('inside the approval transaction at least one record is always in force; at the commit exactly one', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid);
    const r = await revise(CAT, o, body(bid, { allow_report_export: true }));
    await db.exec(`
      create table public.zz_step_observer (step integer generated always as identity, granting integer not null);
      create or replace function public.zz_observe_step() returns trigger language plpgsql as $t$
      begin
        insert into public.zz_step_observer (granting) select count(*) from public.ii_benchmark_entitlements e where e.benchmark_id = new.benchmark_id and public.benchmark_entitlement_grants(e, 'calculation', current_date);
        return null;
      end $t$;
      create trigger trg_zz_observe after update on public.ii_benchmark_entitlements for each row when (new.benchmark_id = '${bid}') execute function public.zz_observe_step();
    `);
    try {
      await approve(APP, r);
      const steps = (await q<{ granting: number }>(`select granting from public.zz_step_observer order by step`)).map((s) => s.granting);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(Math.min(...steps), 'never zero inside the transaction').toBeGreaterThanOrEqual(1);
      expect(steps.at(-1), 'exactly one after the last step').toBe(1);
    } finally {
      await db.exec(`drop trigger if exists trg_zz_observe on public.ii_benchmark_entitlements; drop function if exists public.zz_observe_step(); drop table if exists public.zz_step_observer;`);
    }
  });
});

describe('capability matrix (Standard sections 2 and 4, database layer, direct-RPC bypass)', () => {
  const WHO: Array<[string, string | null]> = [['non-admin', PLAIN], ['view only', VIEW], ['admin without capability', NOCAP], ['catalogue only', CAT], ['approver only', APP], ['catalogue and approver', BOTH]];

  async function scenario() {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid, {}, BOTH, APP);
    const draftByCat = await propose(CAT, body(bid, { notes: 'a draft' }));
    return { bid, o, draftByCat };
  }
  const matrix: Array<{ fn: string; allowed: string[]; run: (uid: string, s: Awaited<ReturnType<typeof scenario>>) => Promise<unknown>; setup?: (s: Awaited<ReturnType<typeof scenario>>) => Promise<string> }> = [
    { fn: 'update_benchmark_entitlement_draft (only the proposer of the draft)', allowed: [CAT], run: (uid, s) => edit(uid, s.draftByCat, body(s.bid, { notes: `edited by ${uid}` })) },
    { fn: 'propose_benchmark_entitlement_revision', allowed: [CAT, BOTH], run: (uid, s) => revise(uid, s.o, body(s.bid, { allow_report_export: true })) },
    { fn: 'approve_benchmark_entitlement (a draft proposed by someone else)', allowed: [APP, BOTH], run: (uid, s) => approve(uid, s.draftByCat) },
    { fn: 'revoke_benchmark_entitlement', allowed: [APP, BOTH], run: (uid, s) => revoke(uid, s.o) },
  ];
  for (const m of matrix) {
    it(`${m.fn}: allowed only for ${m.allowed.map((a) => WHO.find((w) => w[1] === a)?.[0]).join(' / ')}; every other caller gets 42501 and nothing changes`, async () => {
      for (const [label, uid] of WHO) {
        const s = await scenario();
        const before = await q(`select id, status, edit_count from ii_benchmark_entitlements where benchmark_id = $1 order by id`, [s.bid]);
        const code = await codeOf(m.run(uid as string, s));
        if (m.allowed.includes(uid as string)) expect(code, `${m.fn}: ${label} should pass`).toBe('OK');
        else {
          expect(code, `${m.fn}: ${label} must be denied`).toBe('42501');
          expect(await q(`select id, status, edit_count from ii_benchmark_entitlements where benchmark_id = $1 order by id`, [s.bid]), `${m.fn}: ${label} must change nothing`).toEqual(before);
        }
      }
    });
  }
  it('close_benchmark_entitlement_revision: cancel needs the catalogue capability and the proposer, reject needs the approver capability', async () => {
    for (const [label, uid] of WHO) {
      for (const mode of ['cancel', 'reject'] as const) {
        const s = await scenario();
        const rev = await revise(CAT, s.o, body(s.bid, { allow_report_export: true }));
        const expectOk = (mode === 'cancel' && uid === CAT) || (mode === 'reject' && (uid === APP || uid === BOTH));
        const code = await codeOf(closeRev(uid as string, rev, mode));
        expect(code, `${mode} by ${label}`).toBe(expectOk ? 'OK' : '42501');
        expect((await row(rev)).status).toBe(expectOk ? 'revoked' : 'draft');
      }
    }
  });
  it('approving a REVISION needs the approver capability (the catalogue capability proposes, it never approves)', async () => {
    for (const [label, uid] of WHO) {
      const s = await scenario();
      const rev = await revise(CAT, s.o, body(s.bid, { allow_report_export: true }));
      const code = await codeOf(approve(uid as string, rev));
      expect(code, `approve revision by ${label}`).toBe(uid === APP || uid === BOTH ? 'OK' : '42501');
      expect((await row(s.o)).status).toBe(uid === APP || uid === BOTH ? 'revoked' : 'approved');
    }
  });
  it('the anonymous role cannot execute any of the new functions at all', async () => {
    const s = await scenario();
    for (const sql of [`select update_benchmark_entitlement_draft($1::uuid, '{}'::jsonb, null)`, `select propose_benchmark_entitlement_revision($1::uuid, '{}'::jsonb, 'a reason that is long enough')`, `select approve_benchmark_entitlement($1::uuid, 'note', false, null)`, `select close_benchmark_entitlement_revision($1::uuid, 'reject', 'a reason that is long enough')`])
      expect(await codeOf(as(null, 'anon', () => db.query(sql, [s.o]))), sql).toBe('42501');
  });
  it('a draft edit is allowed for the catalogue capability only (non-admin, view only, no capability and approver-only callers are refused)', assertDraftEditNeedsCatalogueCapability);
  it('only the person who proposed the draft edits it', assertOnlyProposerEditsDraft);
});

describe('separation of duties (Standard section 5): self-approval acknowledgement is unchanged and covers revisions', () => {
  it('the proposer approves their own draft or revision only with the explicit acknowledgement, which is recorded as self_approved', async () => {
    const bid = await newBenchmark();
    const d = await propose(BOTH, body(bid));
    expect(await codeOf(approve(BOTH, d, false))).toBe('42501');
    await approve(BOTH, d, true);
    expect((await row(d)).self_approved).toBe(true);
    const r = await revise(BOTH, d, body(bid, { allow_report_export: true }));
    expect(await codeOf(approve(BOTH, r, false))).toBe('42501');
    expect((await row(d)).status, 'a refused approval leaves the original in force').toBe('approved');
    await approve(BOTH, r, true);
    expect((await row(r)).self_approved).toBe(true);
    expect((await row(d)).status).toBe('revoked');
  });
  it('an independent approver needs no acknowledgement and the revision is not marked self approved', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid);
    const r = await revise(CAT, o, body(bid, { allow_report_export: true }));
    await approve(APP, r);
    expect((await row(r)).self_approved).toBe(false);
    expect((await row(r)).approved_by).toBe(APP);
  });
  it('self-approval without the acknowledgement is refused for a revision', assertSelfApprovalNeedsAcknowledgement);
  it('approving a record that changed after the approver opened it is refused; a matching count, or none, is accepted', async () => {
    await assertStaleApprovalRefused();
    const bid = await newBenchmark();
    const d = await propose(CAT, body(bid));
    await approve(APP, d, false, 0);
    expect((await row(d)).status).toBe('approved');
    const bid2 = await newBenchmark();
    const d2 = await propose(CAT, body(bid2));
    await approve(APP, d2);
    expect((await row(d2)).status).toBe('approved');
  });
});

describe('audit trail', () => {
  it('every new action writes an event with the right type, only whitelisted fields, and never a user id', async () => {
    const bid = await newBenchmark();
    const d = await propose(CAT, body(bid));
    await edit(CAT, d, body(bid, { notes: 'edit 1' }));
    await approve(APP, d);
    const r = await revise(CAT, d, body(bid, { notes: 'rev', allow_report_export: true }));
    await edit(CAT, r, body(bid, { notes: 'rev 2', allow_report_export: true }));
    await approve(APP, r);
    const o2 = await approvedRecord(bid, { notes: 'x' });
    const r2 = await revise(CAT, o2, body(bid, { notes: 'y' }));
    await closeRev(CAT, r2, 'cancel');
    const r3 = await revise(CAT, o2, body(bid, { notes: 'z' }));
    await closeRev(APP, r3, 'reject');
    const r4 = await revise(CAT, o2, body(bid, { notes: 'w' }));
    await revoke(APP, o2);
    const all = [...(await events(d)), ...(await events(r)), ...(await events(o2)), ...(await events(r2)), ...(await events(r3)), ...(await events(r4))];
    const types = new Set(all.map((e) => e.event_type));
    for (const t of ['entitlement_draft_edited', 'entitlement_revision_proposed', 'entitlement_revision_edited', 'entitlement_revision_approved', 'entitlement_superseded', 'entitlement_revision_cancelled', 'entitlement_revision_rejected', 'entitlement_revision_closed'])
      expect(types, t).toContain(t);
    const allowed = new Set(['benchmark_id', 'source_id', 'entitlement_kind', 'allow_manual_ingest', 'allow_automation', 'allow_storage', 'allow_calculation', 'allow_customer_display', 'allow_report_export', 'data_from', 'data_to', 'valid_from', 'valid_to', 'post_expiry_storage', 'post_expiry_calculation', 'post_expiry_display', 'evidence_reference', 'evidence_url', 'evidence_document_date', 'evidence_retrieved_at', 'attribution_text', 'notes', 'revision_reason', 'self_approved', 'superseded_by']);
    for (const e of all.filter((x) => x.event_type !== 'entitlement_approved' && x.event_type !== 'entitlement_proposed' && x.event_type !== 'entitlement_revoked')) {
      for (const st of [e.before_state, e.after_state]) {
        if (!st) continue;
        for (const k of Object.keys(st)) expect(allowed, `${e.event_type} carries only whitelisted field ${k}`).toContain(k);
        for (const u of USERS) expect(JSON.stringify(st), `${e.event_type} must not carry a user id`).not.toContain(u);
      }
      expect(e.actor_user_id, `${e.event_type} records who acted`).toBeTruthy();
    }
  });
});

describe('hand-over files', () => {
  const read = (rel: string) => fs.readFileSync(path.join(PACK, rel), 'utf8');
  it('the migration, each part, the rollback and the verification query pass the editor-safety lint (no percent, no bare dollar quote, no statement word after into/from/join in a comment or string)', () => {
    expect(hazards(MIGRATION)).toEqual([]);
    for (const l of ['a', 'b', 'c'] as const) expect(hazards(part(l)), `part ${l}`).toEqual([]);
    expect(hazards(read('rollback.sql'))).toEqual([]);
    expect(hazards(read('verify.sql'))).toEqual([]);
  });
  it('the read-only verification query runs on the replayed database, returns 12 rows, every one PASS, and changes nothing', async () => {
    const before = await one<{ n: number }>(`select count(*)::int n from ii_benchmark_entitlements`);
    const rows = await q<{ n: number; check_name: string; expected: string; actual: string; result: string }>(read('verify.sql').replace(/;\s*$/, ''));
    expect(rows).toHaveLength(12);
    for (const r of rows) expect(r.result, `${r.n} ${r.check_name}: expected ${r.expected}, actual ${r.actual}`).toBe('PASS');
    expect((await one<{ n: number }>(`select count(*)::int n from ii_benchmark_entitlements`)).n).toBe(before.n);
  });
  it('NC-E10: the verification query goes FAIL when the structure is damaged (an index removed, a superseded row left granting)', async () => {
    await db.exec('drop index if exists public.uq_ii_benchmark_entitlements_one_open_revision;');
    try {
      const rows = await q<{ n: number; result: string }>(read('verify.sql').replace(/;\s*$/, ''));
      expect(rows.find((r) => r.n === 4)?.result).toBe('FAIL');
    } finally {
      await db.exec(strip(part('a')));
    }
    const ok = await q<{ result: string }>(read('verify.sql').replace(/;\s*$/, ''));
    expect(ok.every((r) => r.result === 'PASS')).toBe(true);
  });
  it('the editor lint itself flags a bad snippet (negative control)', () => {
    expect(hazards('-- rows from public')).not.toEqual([]);
    expect(hazards("select 'insert into foo'")).not.toEqual([]);
    expect(hazards('select 1 -- a; b')).not.toEqual([]);
    expect(hazards("select 'a %s'")).not.toEqual([]);
    expect(hazards('do $$ begin end $$;')).not.toEqual([]);
  });
});

describe('named negative controls: each mutation turns a named assertion red, and restoring the real definition turns it green again', () => {
  const C = part('c');
  const B = part('b');

  it('NC-E1: the approval does not close the original -> "approving a revision supersedes the original" goes red', async () => {
    const mutated = mutate(C, /  update public\.ii_benchmark_entitlements\n     set status = 'revoked', revoked_by = v_uid, revoked_at = now\(\),\n         revoked_reason = 'Superseded by an approved revision', superseded_by = p_id, superseded_at = now\(\)\n   where id = v_orig;\n/, '');
    await db.exec(strip(mutated));
    try {
      await expectRed('NC-E1', assertRevisionApprovalSupersedesOriginal);
    } finally {
      await restoreReal();
    }
    await assertRevisionApprovalSupersedesOriginal();
  });

  it('NC-E2: no precheck and no unique index -> "at most one open revision" goes red', async () => {
    await db.exec('drop index if exists public.uq_ii_benchmark_entitlements_one_open_revision;');
    const mutated = mutate(B, /  if exists \(select 1 from public\.ii_benchmark_entitlements r where r\.supersedes_entitlement_id = p_original and r\.status = 'draft'\) then\n    raise exception[^\n]*\n  end if;\n/, '');
    await db.exec(strip(mutated));
    try {
      await expectRed('NC-E2', assertSingleOpenRevision);
    } finally {
      await restoreReal();
    }
    await assertSingleOpenRevision();
  });

  it('NC-E3: no capability check when editing a draft -> "a draft edit needs the catalogue capability" goes red', async () => {
    const start = B.indexOf('create or replace function public.update_benchmark_entitlement_draft');
    const end = B.indexOf('-- Propose ONE open revision');
    const fn = B.slice(start, end);
    const bad = mutate(fn, 'if v_uid is null or not public.is_benchmark_catalogue_admin() then', 'if v_uid is null then');
    await db.exec(strip(bad));
    try {
      await expectRed('NC-E3', assertDraftEditNeedsCatalogueCapability);
    } finally {
      await restoreReal();
    }
    await assertDraftEditNeedsCatalogueCapability();
  });

  it('NC-E4: any catalogue admin may edit a draft -> "only the proposer edits a draft" goes red', async () => {
    const start = B.indexOf('create or replace function public.update_benchmark_entitlement_draft');
    const end = B.indexOf('-- Propose ONE open revision');
    const bad = mutate(B.slice(start, end), 'if e.created_by <> v_uid then', 'if false then');
    await db.exec(strip(bad));
    try {
      await expectRed('NC-E4', assertOnlyProposerEditsDraft);
    } finally {
      await restoreReal();
    }
    await assertOnlyProposerEditsDraft();
  });

  it('NC-E5: the self-approval rule removed -> "self-approval needs the acknowledgement" goes red', async () => {
    const bad = mutate(C, 'if e.created_by = v_uid and p_self_approval_ack is not true then', 'if false then');
    await db.exec(strip(bad));
    try {
      await expectRed('NC-E5', assertSelfApprovalNeedsAcknowledgement);
    } finally {
      await restoreReal();
    }
    await assertSelfApprovalNeedsAcknowledgement();
  });

  it('NC-E6: the superseded-is-closed check dropped AND the original left approved -> "exactly one record grants" goes red (the structural guard is what keeps a superseded record from granting)', async () => {
    await db.exec('alter table public.ii_benchmark_entitlements drop constraint if exists ii_benchmark_entitlements_superseded_is_closed;');
    const bad = mutate(C, "set status = 'revoked', revoked_by = v_uid, revoked_at = now(),\n         revoked_reason = 'Superseded by an approved revision'", "set status = 'approved', revoked_by = v_uid, revoked_at = now(),\n         revoked_reason = 'Superseded by an approved revision'");
    await db.exec(strip(bad));
    try {
      await expectRed('NC-E6', assertRevisionApprovalSupersedesOriginal);
    } finally {
      await restoreReal();
    }
    await assertRevisionApprovalSupersedesOriginal();
  });

  it('NC-E7: the approval swallows a failure of its second step (not atomic) -> "no moment without a record in force" goes red', async () => {
    const bad = mutate(
      C,
      /  update public\.ii_benchmark_entitlements\n     set status = 'approved', approved_by = v_uid, approved_at = now\(\), self_approved = \(e\.created_by = v_uid\)\n   where id = p_id;\n  update public\.ii_benchmark_entitlements\n     set status = 'revoked'/,
      "  update public.ii_benchmark_entitlements set superseded_by = p_id, superseded_at = now(), status = 'revoked', revoked_by = v_uid, revoked_at = now(), revoked_reason = 'Superseded by an approved revision' where id = v_orig;\n  begin\n    update public.ii_benchmark_entitlements\n     set status = 'approved', approved_by = v_uid, approved_at = now(), self_approved = (e.created_by = v_uid)\n   where id = p_id;\n  exception when others then null;\n  end;\n  update public.ii_benchmark_entitlements\n     set status = 'revoked'"
    );
    await db.exec(strip(bad));
    try {
      await expectRed('NC-E7', assertApprovalIsAtomic);
    } finally {
      await restoreReal();
    }
    await assertApprovalIsAtomic();
  });

  it('NC-E8: revoke no longer closes the open revision -> "revoking the original closes its open revision" goes red', async () => {
    const bad = mutate(C, /  for r in select id from public\.ii_benchmark_entitlements where supersedes_entitlement_id = p_id and status = 'draft' for update loop/, "  for r in select id from public.ii_benchmark_entitlements where false loop");
    await db.exec(strip(bad));
    try {
      await expectRed('NC-E8', assertRevokeClosesOpenRevision);
    } finally {
      await restoreReal();
    }
    await assertRevokeClosesOpenRevision();
  });

  it('NC-E9: the stale-edit check removed from approve -> "approving a stale record is refused" goes red', async () => {
    const bad = mutate(C, 'if p_expected_edit_count is not null and p_expected_edit_count <> e.edit_count then', 'if false then');
    await db.exec(strip(bad));
    try {
      await expectRed('NC-E9', assertStaleApprovalRefused);
    } finally {
      await restoreReal();
    }
    await assertStaleApprovalRefused();
  });
});

describe('rollback restores the previous behaviour and the migration can be applied again', () => {
  it('after the rollback the three-argument approve works, the new functions are gone, no open revision can be approved by mistake, superseded records stay closed, and re-applying 0280 restores everything', async () => {
    const bid = await newBenchmark();
    const o = await approvedRecord(bid);
    const r = await revise(CAT, o, body(bid, { allow_report_export: true }));
    const o2 = await approvedRecord(await newBenchmark());
    const bid3 = await newBenchmark();
    const o3 = await approvedRecord(bid3);
    const r3 = await revise(CAT, o3, body(bid3, { notes: 'superseded before rollback' }));
    await approve(APP, r3);
    const rollback = fs.readFileSync(path.join(PACK, 'rollback.sql'), 'utf8');
    expect(await codeOf(db.exec(strip(rollback)))).toBe('OK');
    expect(await codeOf(db.exec(strip(rollback))), 'rollback is safe to run twice').toBe('OK');
    const fns = (await q<{ proname: string }>(`select proname from pg_proc where proname in ('update_benchmark_entitlement_draft','propose_benchmark_entitlement_revision','close_benchmark_entitlement_revision','ii_bm_entitlement_editable','ii_bm_entitlement_normalise')`)).map((f) => f.proname);
    expect(fns).toEqual([]);
    expect((await row(r)).status, 'the open revision was closed by the rollback, so the old approve cannot create a duplicate').toBe('revoked');
    expect((await row(o)).status).toBe('approved');
    expect((await row(o3)).status, 'a superseded record stays closed').toBe('revoked');
    expect(await grantingRows(bid3, 'calculation')).toBe(1);
    // RELEASE ORDER, push first: the NEW application omits the 4th argument unless the screen has a counter; with the older function the named 4-argument call does not exist
    const d0 = await propose(CAT, body(await newBenchmark()));
    expect(await codeOf(as(APP, 'authenticated', () => db.query(`select approve_benchmark_entitlement(p_id => $1::uuid, p_note => $2, p_self_approval_ack => $3::boolean, p_expected_edit_count => $4::integer)`, [d0, 'x approved', false, null])))).toBe('42883');
    await as(APP, 'authenticated', () => db.query(`select approve_benchmark_entitlement(p_id => $1::uuid, p_note => $2, p_self_approval_ack => $3::boolean)`, [d0, 'approved without a counter', false]));
    expect((await row(d0)).status).toBe('approved');
    // old behaviour: three-argument approve and revoke
    const d = await propose(CAT, body(await newBenchmark()));
    await callAs(APP, `select approve_benchmark_entitlement($1::uuid, $2, false)`, [d, 'approved after the rollback']);
    expect((await row(d)).status).toBe('approved');
    expect((await one(`select count(*)::int n from pg_proc where proname = 'approve_benchmark_entitlement'`)).n).toBe(1);
    void o2;
    // and the migration applies again on top
    expect(await codeOf(db.exec(strip(MIGRATION)))).toBe('OK');
    const bid4 = await newBenchmark();
    await assertRevisionApprovalSupersedesOriginal();
    expect(bid4).toBeTruthy();
  });
});
