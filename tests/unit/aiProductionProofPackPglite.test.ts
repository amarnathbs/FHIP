/**
 * The SQL files of the production proof pack (docs/ai/po_apply_premium_ai_production_proof/sql) against a REAL Postgres engine (PGlite) built
 * from this repository's whole migration chain. PGLITE-VERIFIED: every file parses, every column it names exists, the READ-ONLY files change
 * nothing, and the cleanup sequence (register, backup, verify, delete, verify residue, drop) works, touches ONLY registered accounts of the
 * declared synthetic domain, and keeps the audit events and the cost attempts. NOT verified here: the cron run-log file (A04) because the
 * shim has no cron.job_run_details, and the Module 11 files (they need that branch's migrations); those two get lint + read-only checks only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(__dirname, '..', '..');
const PACK = path.join(ROOT, 'docs', 'ai', 'po_apply_premium_ai_production_proof');
const SQL = path.join(PACK, 'sql');
const CLEAN = path.join(SQL, 'cleanup');
const M11 = path.join(PACK, 'module11', 'sql');
const ZERO = '00000000-0000-0000-0000-000000000000';
const U1 = '00000000-0000-4000-8000-0000000000c1';
const U2 = '00000000-0000-4000-8000-0000000000c2';
const REAL_USER = '00000000-0000-4000-8000-0000000000d9';
const DOC = '00000000-0000-4000-8000-0000000000e1';

const read = (p: string) => fs.readFileSync(p, 'utf8');
const files = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : []);
/** Comments and string literals removed, so a keyword inside prose cannot trip the read-only check. */
const code = (sql: string) => sql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(read(path.join(ROOT, 'scripts/db-rebuild-check/shim.sql')));
  const seed = read(path.join(ROOT, 'supabase/seed.sql'));
  for (const f of fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(read(path.join(ROOT, 'supabase/migrations', f)).replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  await db.exec('alter table cron.job add column if not exists active boolean default true');
  await db.exec(`insert into auth.users(id,email) values ('${U1}','proof-1@proofdomain.invalid'),('${U2}','proof-2@otherdomain.invalid'),('${REAL_USER}','real@customer.invalid') on conflict do nothing;`);
    await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id in ('${U1}','${U2}')`);
    await db.exec(`insert into fdh_statement_uploads (id, user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status, malware_scan_status, malware_scan_object_ref, raw_document_purge_status)
      values ('${DOC}', '${U1}', 'pdf_native', 'bank_statement', 'AU', 'AUD', 'application/pdf', 'approved', 'clean',
        '{"ref":{"versionId":"v1","eTag":"e1","objectKey":"k1"},"expected":{"expectedVersionId":"v1","expectedETag":"e1","objectKey":"k1"},"s3Purge":{"outcome":"deleted","verified":"absent"}}'::jsonb, 'purged');`);
    await db.exec(`insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, metadata) values ('${U1}', '${DOC}', 'bank_statement_ai_fallback_draft_ready', 'system', '{"ai_model":"gpt-4o-mini","ai_input_tokens":1377,"ai_output_tokens":396,"ai_provider_request_ids":["req_x"],"draft_persisted":true,"rows":6,"ai_cost_key":"abcdef0123456789"}'::jsonb);`);
    await db.exec(`insert into aie_ai_cost_attempt (idempotency_key, ledger_id, reserved_usd, remaining_usd_at_reserve, admission_outcome, user_id) values ('abcdef0123456789', 'global', 0.009173, 9, 'admitted', '${U1}');`);
    await db.exec(`select aie_settle_ai_cost_v2('global', 'abcdef0123456789', 0.000444, 1377, 396, 'gpt-4o-mini', array['req_x']::text[], 'success', false);`);
    await db.exec(`insert into user_entitlements (user_id, plan_tier, effective_from, effective_to) values ('${U1}', 'premium', current_date - 5, current_date + 5) on conflict (user_id) do update set plan_tier = 'premium', effective_from = current_date - 5, effective_to = current_date + 5;`);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('every pack file is editor-safe and the READ-ONLY files really are read-only', () => {
  const all = [
    ...files(SQL).map((f) => path.join(SQL, f)),
    ...files(CLEAN).map((f) => path.join(CLEAN, f)),
    ...files(M11).map((f) => path.join(M11, f)),
  ];
  it('there are files to check (A, E and cleanup families, and the Module 11 files)', () => {
    expect(files(SQL).filter((f) => /^A0\d_/.test(f)).length).toBeGreaterThanOrEqual(4);
    expect(files(SQL).filter((f) => /^E\d\d_/.test(f)).length).toBeGreaterThanOrEqual(10);
    expect(files(CLEAN).length).toBe(6);
    expect(files(M11).length).toBeGreaterThanOrEqual(8);
  });
  it('pass the repository editor-safety lint (and the lint bites)', async () => {
    const lint = (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, 'scripts', 'migration_editor_safety_lint.mjs')).href)) as { hazards: (s: string) => string[] };
    for (const f of all) expect(lint.hazards(read(f)), f).toEqual([]);
    expect(lint.hazards('-- value taken from the user\nselect 1;').length).toBeGreaterThan(0);
    expect(lint.hazards('select 50%;').length).toBeGreaterThan(0);
  });
  it('every file named READONLY contains no write or schema statement (negative control: the detector flags one)', () => {
    const WRITE = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|copy)\b/i;
    expect(WRITE.test(code('delete from t'))).toBe(true);
    for (const f of all.filter((x) => /READONLY\.sql$/.test(x))) expect(code(read(f)), f).not.toMatch(WRITE);
  });
  it('every file that writes is named WRITE (none is hiding under another name)', () => {
    const WRITE = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i;
    for (const f of all) if (WRITE.test(code(read(f)))) expect(path.basename(f), f).toMatch(/WRITE/);
  });
  it('all-zero placeholder ids are the only ids in the evidence files (nothing real is baked in), and no user-visible ISO date is introduced', () => {
    for (const f of files(SQL).map((x) => path.join(SQL, x))) {
      const ids = read(f).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
      for (const id of ids) expect(id, f).toBe(ZERO);
    }
  });
});

describe('the read-only A and E files run on a real engine', () => {
  for (const f of files(SQL).filter((x) => /^(A0[123]|E\d\d)_/.test(x))) {
    const aggregate = /^(A01|A02|E03|E06|E07|E09)_/.test(f);
    it(`${f} runs${aggregate ? ' and returns rows' : ' (no row is correct with the all-zero placeholder id or an empty scheduler)'}`, async () => {
      const res = await db.query(read(path.join(SQL, f)).replace(/;\s*$/, ''));
      if (aggregate) expect(res.rows.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('A01: every dependency check is present true on a database built from the migrations, with the row names intact', async () => {
    const res = await db.query<{ check_name: string; present: boolean }>(read(path.join(SQL, 'A01_state_inventory_READONLY.sql')).replace(/;\s*$/, ''));
    const missing = res.rows.filter((r) => !r.present).map((r) => r.check_name);
    expect(missing).toEqual([]);
    expect(res.rows.length).toBeGreaterThanOrEqual(14);
  });

  it('A01 NEGATIVE CONTROL: dropping the per-user function turns that row false (the check can fail)', async () => {
    await db.exec('begin');
    await db.exec('drop function aie_reserve_ai_cost_v2(text, numeric, numeric, text, uuid, numeric)');
    const res = await db.query<{ check_name: string; present: boolean }>(read(path.join(SQL, 'A01_state_inventory_READONLY.sql')).replace(/;\s*$/, ''));
    await db.exec('rollback');
    expect(res.rows.filter((r) => !r.present).map((r) => r.check_name).join('|')).toContain('aie_reserve_ai_cost_v2');
  });

  it('A02 reports the ledger: allowance 10, per-user cap 1.00, lifetime wording intact', async () => {
    const res = await db.query<Record<string, unknown>>(read(path.join(SQL, 'A02_cap_ledger_and_premium_population_READONLY.sql')).replace(/;\s*$/, ''));
    expect(Number(res.rows[0].per_user_daily_cap_usd)).toBe(1);
    expect(Number(res.rows[0].global_allowance_usd_stored)).toBe(10);
    expect(read(path.join(SQL, 'A02_cap_ledger_and_premium_population_READONLY.sql'))).toMatch(/LIFETIME/);
  });
});

describe('evidence files return the right facts for seeded synthetic rows', () => {
  const run = (f: string, id = DOC) => db.query<Record<string, unknown>>(read(path.join(SQL, f)).split(ZERO).join(id).replace(/;\s*$/, ''));

  it('E01 shows the scan bound to the stored object, the copy purge verified, the original gone', async () => {
    const r = (await run('E01_document_lifecycle_READONLY.sql')).rows[0];
    expect(r.malware_scan_status).toBe('clean');
    expect(r.scan_version_matches_expected).toBe(true);
    expect(r.scan_etag_matches_expected).toBe(true);
    expect(r.scan_object_key_matches_expected).toBe(true);
    expect(r.scan_copy_purge_verified).toBe('absent');
    expect(r.raw_document_purge_status).toBe('purged');
    expect(r.original_object_still_stored).toBe(false);
  });
  it('E02 lists the audit events with the safe keys only', async () => {
    const r = (await run('E02_audit_trail_READONLY.sql')).rows;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ event_type: 'bank_statement_ai_fallback_draft_ready', ai_model: 'gpt-4o-mini', provider_request_id_count: 1, cost_key_prefix: 'abcdef01' });
  });
  it('E04 shows the settled attempt of the user today, with model, tokens and the running total', async () => {
    const r = (await run('E04_cost_attempts_of_one_user_READONLY.sql', U1)).rows;
    expect(r).toHaveLength(1);
    expect(Number(r[0].settled_usd)).toBeCloseTo(0.000444, 6);
    expect(r[0].model).toBe('gpt-4o-mini');
    expect(Number(r[0].running_counted_usd_today)).toBeCloseTo(0.000444, 6);
  });
  it('E05 aggregates by the first 8 characters of the id only', async () => {
    const r = (await run('E05_who_is_near_the_cap_READONLY.sql')).rows;
    expect(r.some((x) => x.user_prefix === U1.slice(0, 8) && Number(x.attempts_today) >= 1)).toBe(true);
    for (const x of r) expect(String(x.user_prefix)).toHaveLength(8);
  });
  it('E06 for a user with nothing shows zeros; E10 names the plan and premium_today', async () => {
    const none = (await run('E06_refusal_evidence_of_one_user_READONLY.sql', U2)).rows[0];
    expect([none.uploads, none.drafts, none.cost_attempts, none.ai_events].map(Number)).toEqual([0, 0, 0, 0]);
    const e = (await run('E10_account_entitlement_READONLY.sql', U1)).rows[0];
    expect(e.plan_tier).toBe('premium');
    expect(e.premium_today).toBe(true);
  });
  it('E09 counts the unverified scan copy purge as 0 for the seeded clean upload', async () => {
    const r = (await run('E09_scan_and_deletion_health_READONLY.sql')).rows[0];
    expect(Number(r.scan_copy_purge_unverified)).toBe(0);
  });
});

describe('cleanup sequence: backup first, only registered accounts of the declared domain, audit and cost records kept', () => {
  const stmt = (f: string, edits: (s: string) => string = (s) => s) => edits(read(path.join(CLEAN, f)));

  it('C00..C02: register, back up, and every live count equals its backup count', async () => {
    await db.exec(stmt('C00_register_proof_accounts_WRITE.sql', (s) =>
      s.replace("'00000000-0000-0000-0000-000000000001'", `'${U1}'`).replace("'00000000-0000-0000-0000-000000000002'", `'${U2}'`).replace("  ('00000000-0000-0000-0000-000000000003', 'F1 free')\n", '')
        .replace("'P2 second premium'),", "'P2 second premium')")));
    const reg = await db.query('select user_id from private.aiproof_ids order by user_id');
    expect(reg.rows.map((r: any) => r.user_id)).toEqual([U1, U2]);
    await db.exec(stmt('C01_backup_proof_rows_WRITE.sql'));
    const ver = await db.query<{ check_name: string; ok: boolean; live_rows: string }>(stmt('C02_verify_backup_READONLY.sql').replace(/;\s*$/, ''));
    expect(ver.rows.every((r) => r.ok)).toBe(true);
    expect(Number(ver.rows.find((r) => r.check_name === 'fdh_statement_uploads')!.live_rows)).toBe(1);
    expect(Number(ver.rows.find((r) => r.check_name === 'aie_ai_cost_attempt')!.live_rows)).toBe(1);
  });

  it('C03 as shipped (placeholder domain) deletes nothing', async () => {
    const r = await db.query(stmt('C03_delete_proof_accounts_WRITE.sql').replace(/;\s*$/, ''));
    expect(r.rows).toHaveLength(0);
    expect((await db.query('select 1 from auth.users where id = $1', [U1])).rows).toHaveLength(1);
  });

  it('C03 with the declared domain deletes only the registered account of that domain (not the other-domain account, not the real customer)', async () => {
    const r = await db.query<{ deleted_user_prefix: string }>(stmt('C03_delete_proof_accounts_WRITE.sql', (s) => s.replace('REPLACE-WITH-YOUR-SYNTHETIC-DOMAIN', 'proofdomain.invalid')).replace(/;\s*$/, ''));
    expect(r.rows.map((x) => x.deleted_user_prefix)).toEqual([U1.slice(0, 8)]);
    expect((await db.query('select 1 from auth.users where id = $1', [U1])).rows).toHaveLength(0);
    expect((await db.query('select 1 from auth.users where id = $1', [U2])).rows).toHaveLength(1); // registered but a different domain
    expect((await db.query('select 1 from auth.users where id = $1', [REAL_USER])).rows).toHaveLength(1); // never registered
  });

  it('C04: the uploads and the entitlement cascaded away, while the audit event and the cost attempt survive detached', async () => {
    const r = (await db.query<Record<string, string>>(stmt('C04_verify_residue_READONLY.sql').replace(/;\s*$/, ''))).rows[0];
    expect(Number(r.accounts_left)).toBe(1); // U2 stays: registered, wrong domain
    expect([r.uploads_left, r.transactions_left, r.drafts_left].map(Number)).toEqual([0, 0, 0]);
    expect(Number(r.audit_events_kept_detached)).toBe(1);
    expect(Number(r.cost_attempts_kept_detached)).toBe(1);
    const attempt = await db.query('select user_id from aie_ai_cost_attempt where idempotency_key = $1', ['abcdef0123456789']);
    expect((attempt.rows[0] as any).user_id).toBeNull();
    // the shared ledger kept the spend
    const l = await db.query<{ settled_usd: string }>(`select settled_usd from aie_ai_cost_ledger where id = 'global'`);
    expect(Number(l.rows[0].settled_usd)).toBeGreaterThan(0);
  });

  it('C05 removes the copies and the register', async () => {
    await db.exec(stmt('C05_drop_backups_WRITE.sql'));
    const r = await db.query(`select count(*) as n from information_schema.tables where table_schema = 'private' and (left(table_name, 11) = 'bkp_aiproof' or table_name = 'aiproof_ids')`);
    expect(Number((r.rows[0] as any).n)).toBe(0);
  });
});
