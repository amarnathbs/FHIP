// Resources Bulk Upload -- the PRODUCTION hand-over pack (docs/resources/po_apply_bulk_upload_production/).
//
// Nothing here touches production. This suite proves, on a REAL Postgres (PGlite) holding the whole current migration
// ledger WITHOUT 0272-0274 (the state production is expected to be in), that every file in the pack behaves as its
// README says:
//   * the migration copies and parts are byte-identical to the repository migrations;
//   * every SQL file passes the Supabase editor-safety lint (no percent sign, no semicolon or quote in a comment, no
//     into / from / join + word inside a comment or string);
//   * P0 (precheck) is all-ok BEFORE and shows the three migration states false; P1, P2, P3 are all-ok after each step;
//   * the backup (B1) is complete and locked away from the API roles, and B2 matches;
//   * the two synthetic files in the pack pass the real parser and validators, are applied through the real functions
//     (twin and signed-in), and the verification query (V1) says they are private never-published drafts;
//   * the cleanup (C2) removes ONLY the synthetic rows and nothing else, and refuses (deleting nothing) when the
//     expected count is wrong, a synthetic post is not a private draft, or a real post uses a synthetic source (named
//     negative controls); C3 then shows zero residue and B2 shows the live tables equal the backup again;
//   * the stop switch (R2) really stops the apply for BOTH callers (the old runbook revoked only one of the two; a
//     negative control shows the single revoke leaves the server twin working), R3 restores it;
//   * R4 restores a deleted real row from the backup without touching live rows;
//   * R1 removes every bulk upload object, leaves created drafts alone, and the migrations can be applied again.
//
// EVIDENCE LABEL: PGlite-verified. Not production-verified.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseImportFile } from '@/lib/resources/import/parser';
import { validateImportTable } from '@/lib/resources/import/validation';
import { getImportAdapter } from '@/lib/resources/import/adapters';
import { refs, SCHEMAS } from '../support/resourcesImportFixtures';
import { buildSyntheticFiles } from '../../scripts/resources_bulk_upload_make_synthetic_prod_files';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const SHIM = path.join(ROOT, 'scripts', 'db-rebuild-check', 'shim.sql');
const PACK = path.join(ROOT, 'docs', 'resources', 'po_apply_bulk_upload_production');
const read = (rel: string) => fs.readFileSync(path.join(PACK, rel), 'utf8');
const readBuf = (p: string) => fs.readFileSync(p);

const MIGS = ['0272_resource_content_bulk_import.sql', '0273_resource_content_bulk_import_apply_as_actor.sql', '0274_resource_content_bulk_import_faster_apply.sql'];

function walkSql(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSql(p, acc);
    else if (e.name.endsWith('.sql')) acc.push(p);
  }
  return acc;
}

describe('pack integrity (no database needed)', () => {
  it('PACK-1 the migration copies are byte-identical to the repository migrations', () => {
    for (const m of MIGS) expect(readBuf(path.join(PACK, 'sql', m)).equals(readBuf(path.join(MIG_DIR, m))), m).toBe(true);
  });

  it('PACK-2 the parts are byte-identical to the DEV parts and join back to the migration', () => {
    const dev272 = path.join(ROOT, 'docs', 'resources', 'po_apply_bulk_upload', 'parts');
    const dev273 = path.join(ROOT, 'docs', 'resources', 'po_apply_bulk_upload_0273', 'parts');
    for (const l of ['a', 'b', 'c']) expect(readBuf(path.join(PACK, 'sql', 'parts', `0272${l}.sql`)).equals(readBuf(path.join(dev272, `0272${l}.sql`))), `0272${l}`).toBe(true);
    for (const l of ['a', 'b']) expect(readBuf(path.join(PACK, 'sql', 'parts', `0273${l}.sql`)).equals(readBuf(path.join(dev273, `0273${l}.sql`))), `0273${l}`).toBe(true);
    const j272 = Buffer.concat(['a', 'b', 'c'].map((l) => readBuf(path.join(PACK, 'sql', 'parts', `0272${l}.sql`))));
    const j273 = Buffer.concat(['a', 'b'].map((l) => readBuf(path.join(PACK, 'sql', 'parts', `0273${l}.sql`))));
    expect(j272.equals(readBuf(path.join(MIG_DIR, MIGS[0])))).toBe(true);
    expect(j273.equals(readBuf(path.join(MIG_DIR, MIGS[1])))).toBe(true);
  });

  it('PACK-3 every SQL file in the pack passes the editor-safety lint, and the lint really bites (negative control)', async () => {
    const lint = (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, 'scripts', 'migration_editor_safety_lint.mjs')).href)) as { hazards: (s: string) => string[] };
    const files = walkSql(PACK);
    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const f of files) expect(lint.hazards(fs.readFileSync(f, 'utf8')), path.relative(PACK, f)).toEqual([]);
    // NEGATIVE CONTROL: the rules this pack was fixed for during authoring
    expect(lint.hazards("select 1; -- copy it into your reply\n").length).toBeGreaterThan(0);
    expect(lint.hazards("select * from t where a like 'x%';").length).toBeGreaterThan(0);
    expect(lint.hazards("do $$ begin null; end $$;").length).toBeGreaterThan(0);
    expect(lint.hazards("select 'link from a post';").length).toBeGreaterThan(0);
  });

  it('PACK-4 the synthetic files in the pack equal what the generator makes, and carry the markers the cleanup matches on', () => {
    const made = buildSyntheticFiles(1, 'financial-health');
    for (const f of made) expect(read(`synthetic/${f.name}`), f.name).toBe(f.csv);
    for (const f of made) {
      expect(f.name.startsWith('ZZ_BULKVERIFY')).toBe(true);
      expect(f.csv).toContain('zz-bulkverify-');
      expect(f.csv).toContain('ZZ BULKVERIFY Source');
      expect(f.csv).toContain('delete me');
    }
  });

  it('PACK-5 the 250 row capacity files the generator can make are accepted and 251 is refused by the generator guard (single constant of the importer)', () => {
    const made = buildSyntheticFiles(250, 'financial-health');
    for (const f of made) expect(f.csv.split('\r\n').filter(Boolean).length).toBe(251);
    const unique = new Set(made[0].csv.match(/zz-bulkverify-article-\d+/g));
    expect(unique.size).toBe(250);
  });

  it('PACK-6 no pack SQL file can run without being read first: the destructive files name their guard (cleanup count assertion, rollback order)', () => {
    expect(read('cleanup/C2_cleanup_synthetic_rows.sql')).toContain('CLEANUP_STOPPED');
    expect(read('cleanup/C2_cleanup_synthetic_rows.sql')).toContain('expected_posts');
    expect(read('rollback/R2_disable_apply_only.sql')).toContain('apply_resource_content_import_as_actor');
    expect(read('rollback/R2_disable_apply_only.sql')).toContain('apply_resource_content_import(uuid)');
  });
});

// -------------------------------------------------------------------------------------------------------------------
const U = (n: number) => `eeeeeeee-0000-0000-0000-${String(n).padStart(12, '0')}`;
const SUPER = U(1);
const RADMIN = U(2);
const EDITOR = U(3);
const AUTHOR = U(4);

let db: PGlite;
type Json = Record<string, unknown>;
const one = async <T = Json>(sql: string, params: unknown[] = []): Promise<T> => (await db.query(sql, params)).rows[0] as T;
const rows = async <T = Json>(sql: string): Promise<T[]> => (await db.query(sql)).rows as T[];
const count = async (sql: string) => Number((await one<{ n: string }>(sql)).n);

async function as<T>(uid: string | null, role: 'authenticated' | 'anon' | 'service_role', fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}
async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

/** Runs a pack check file and returns its result rows. */
async function checkRows(rel: string): Promise<{ section?: string; check_name: string; ok: boolean; actual?: string }[]> {
  return (await db.query(read(rel))).rows as never;
}
const allOk = (r: { ok: boolean }[]) => r.every((x) => x.ok === true);

let CAT: string;
const FILES = buildSyntheticFiles(1, 'financial-health');

/** Stage a synthetic file exactly as the importer does: real parser + real adapter validation, then the normalised rows. */
async function stageSynthetic(type: 'article' | 'money_update', csv: string, fileName: string, uploader: string): Promise<string> {
  const parsed = parseImportFile({ fileName, bytes: new TextEncoder().encode(csv) }, SCHEMAS[type]);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const r = refs({ categories: [{ id: CAT, name: 'Financial Health', slug: 'financial-health' }], tags: [], authors: [], ctas: [] });
  const out = validateImportTable(parsed.table, parsed.cellIssues, getImportAdapter(type).hooks, r, '2026-10-15');
  expect(out.rows.map((x) => x.errors), 'the synthetic file must validate cleanly with the real validators').toEqual(out.rows.map(() => []));
  const sha = createHash('sha256').update(fileName + csv).digest('hex');
  return as(null, 'service_role', async () => {
    const run = await one<{ id: string }>(
      `insert into public.resource_content_import_runs (content_type, uploaded_by, file_name, file_sha256, template_version, status, row_count, valid_count)
       values ($1,$2,$3,$4,'1.0','ready',$5,$5) returning id`,
      [type, uploader, fileName, sha, out.rows.length]
    );
    for (let i = 0; i < out.rows.length; i++) {
      const p = out.rows[i].payload as unknown as Json;
      await db.query(
        `insert into public.resource_content_import_rows (import_run_id, row_number, external_id, slug, title, normalized_payload, validation_errors) values ($1,$2,$3,$4,$5,$6,'[]')`,
        [run.id, i + 2, p.external_id ?? null, p.slug ?? null, p.title ?? null, JSON.stringify(p)]
      );
    }
    return run.id;
  });
}
const applyTwin = (run: string, actor: string) => as(null, 'service_role', async () => (await one<{ v: Json }>(`select public.apply_resource_content_import_as_actor($1,$2) v`, [run, actor])).v);
const applyNormal = (run: string, actor: string) => as(actor, 'authenticated', async () => (await one<{ v: Json }>(`select public.apply_resource_content_import($1) v`, [run])).v);

async function replay(upTo: (name: string) => boolean) {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (!upTo(f)) continue;
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
}

beforeAll(async () => {
  // The state production is expected to be in: the whole ledger except the three bulk upload migrations.
  await replay((f) => !MIGS.includes(f));
  await db.exec(`insert into auth.users(id,email) values ('${SUPER}','s@pg.test'),('${RADMIN}','r@pg.test'),('${EDITOR}','e@pg.test'),('${AUTHOR}','a@pg.test');`);
  await db.exec(`insert into admin_users(user_id) values ('${SUPER}');`);
  await db.exec(`insert into resource_user_roles(user_id, role) values ('${RADMIN}','resource_admin'),('${EDITOR}','editor'),('${AUTHOR}','author');`);
  CAT = (await one<{ id: string }>(`select id from resource_categories where slug = 'financial-health'`)).id;
  // Real, non-synthetic content that must survive everything below.
  await db.exec(`insert into resource_sources (source_name, url) values ('Real Source One','https://real.example/1');`);
  for (let i = 1; i <= 3; i++) {
    await db.exec(`insert into resource_posts (title, slug, content_type, status, visibility, published_at, excerpt, content_blocks, jurisdiction, compliance_classification, created_by)
      values ('Real post ${i}','real-post-${i}','article','draft','private',null,'Real excerpt.','[{"id":"11111111-1111-4111-8111-111111111111","type":"paragraph","data":{"text":"Real."}}]'::jsonb,'global','green','${EDITOR}');`);
  }
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('P0 precheck on a database that is in the expected pre-release state', () => {
  it('PACK-DB1 every A and B row is ok and every C row is false and ok (nothing of this release is applied)', async () => {
    const r = await checkRows('checks/P0_precheck_readonly.sql');
    expect(r.length).toBeGreaterThanOrEqual(40);
    expect(r.filter((x) => !x.ok).map((x) => `${x.section}:${x.check_name}=${x.actual}`)).toEqual([]);
    for (const x of r.filter((y) => y.section === 'C')) expect(x.actual, x.check_name).toBe('false');
    expect(r.filter((x) => x.section === 'A').length).toBeGreaterThanOrEqual(21);
  });

  it('PACK-DB2 NEGATIVE CONTROL: P0 goes red when a required column is missing, and when a C object already exists', async () => {
    await db.exec(`alter table resource_post_sources rename column sort_order to sort_order_gone;`);
    const broken = await checkRows('checks/P0_precheck_readonly.sql');
    expect(broken.filter((x) => !x.ok).map((x) => x.check_name).join('|')).toContain('resource_post_sources has post_id, source_id, sort_order');
    await db.exec(`alter table resource_post_sources rename column sort_order_gone to sort_order;`);
    await db.exec(`create table public.resource_content_import_runs (id int);`);
    const already = await checkRows('checks/P0_precheck_readonly.sql');
    expect(already.filter((x) => !x.ok).map((x) => x.check_name).join('|')).toContain('staging table resource_content_import_runs exists');
    await db.exec(`drop table public.resource_content_import_runs;`);
    expect(allOk(await checkRows('checks/P0_precheck_readonly.sql'))).toBe(true);
  });
});

describe('the three migrations, in order, each followed by its check', () => {
  let baseline: Record<string, string>;
  it('PACK-DB3 P0 baseline facts are recorded, then 0272 (as the three parts) passes P1', async () => {
    const d = await checkRows('checks/P0_precheck_readonly.sql');
    baseline = Object.fromEntries(d.filter((x) => x.section === 'D').map((x) => [x.check_name, String(x.actual)]));
    for (const l of ['a', 'b', 'c']) await db.exec(read(`sql/parts/0272${l}.sql`));
    const p1 = await checkRows('checks/P1_after_0272.sql');
    expect(p1.filter((x) => !x.ok).map((x) => x.check_name)).toEqual([]);
    expect(p1.length).toBe(13);
    // 0272 changed no existing table: the three resource_posts facts equal the P0 numbers
    const get = (rel: string, name: string) => String((rel === 'p1' ? p1 : []).find((x) => x.check_name.startsWith(name))?.actual);
    expect(get('p1', 'resource_posts column count')).toBe(baseline['resource_posts column count (P1 must show the same number)']);
    expect(get('p1', 'resource_posts constraint count')).toBe(baseline['resource_posts constraint count (P1 must show the same number)']);
    expect(get('p1', 'resource_posts policy count')).toBe(baseline['resource_posts policy count (P1 must show the same number)']);
  });

  it('PACK-DB4 0273 (two parts) passes P2 and 0274 (the whole file) passes P3', async () => {
    for (const l of ['a', 'b']) await db.exec(read(`sql/parts/0273${l}.sql`));
    const p2 = await checkRows('checks/P2_after_0273.sql');
    expect(p2.filter((x) => !x.ok).map((x) => x.check_name)).toEqual([]);
    expect(String(p2.find((x) => x.check_name.startsWith('resource_posts column count'))?.actual)).toBe(baseline['resource_posts column count (P1 must show the same number)']);
    await db.exec(read(`sql/${MIGS[2]}`));
    const p3 = await checkRows('checks/P3_after_0274.sql');
    expect(p3.filter((x) => !x.ok).map((x) => x.check_name)).toEqual([]);
  });

  it('PACK-DB5 NEGATIVE CONTROLS: P1 goes red if anon may run apply; P2 goes red if a signed in person may run the twin; P3 goes red on the 0273 core', async () => {
    await db.exec(`grant execute on function public.apply_resource_content_import(uuid) to anon;`);
    expect((await checkRows('checks/P1_after_0272.sql')).some((x) => !x.ok)).toBe(true);
    await db.exec(`revoke execute on function public.apply_resource_content_import(uuid) from anon;`);
    await db.exec(`grant execute on function public.apply_resource_content_import_as_actor(uuid, uuid) to authenticated;`);
    expect((await checkRows('checks/P2_after_0273.sql')).some((x) => !x.ok)).toBe(true);
    await db.exec(`revoke execute on function public.apply_resource_content_import_as_actor(uuid, uuid) from authenticated;`);
    // re-emit the 0273 core (it still writes a version per draft): P3 must notice
    const m273 = fs.readFileSync(path.join(MIG_DIR, MIGS[1]), 'utf8');
    await db.exec(m273.match(/create or replace function private\.apply_resource_content_import_core\([\s\S]*?\n\$fn\$;/)![0]);
    expect((await checkRows('checks/P3_after_0274.sql')).some((x) => !x.ok)).toBe(true);
    await db.exec(fs.readFileSync(path.join(MIG_DIR, MIGS[2]), 'utf8'));
    expect(allOk(await checkRows('checks/P3_after_0274.sql'))).toBe(true);
  });

  it('PACK-DB6 the capability model P0 reported: only Super Admin, Resource Admin and Editor can apply; an Author cannot', async () => {
    const runId = await stageSynthetic('article', FILES[0].csv, 'ZZ_BULKVERIFY_probe.csv', AUTHOR);
    expect(await as(null, 'service_role', () => rejects(db.query(`select public.apply_resource_content_import_as_actor('${runId}','${AUTHOR}')`)))).toContain('FORBIDDEN');
    await as(null, 'service_role', () => db.query(`delete from public.resource_content_import_runs where id = '${runId}'`));
  });
});

describe('backup, synthetic verification, cleanup', () => {
  let liveBefore: Record<string, number>;
  const tables = ['resource_posts', 'resource_post_categories', 'resource_post_tags', 'resource_sources', 'resource_post_sources', 'resource_audit_log'];
  const snap = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(`select count(*) n from public.${t}`)])));
  let articleRun = '';
  let muRun = '';

  it('PACK-DB7 B1 copies the six tables, locks them away from the API roles, and B2 says they match', async () => {
    await db.exec(read('backup/B1_manual_backup_before_synthetic_verification.sql'));
    const b2 = await checkRows('backup/B2_backup_check_readonly.sql');
    expect(b2.length).toBe(6);
    expect(allOk(b2)).toBe(true);
    for (const t of tables) {
      expect((await one<{ r: boolean }>(`select relrowsecurity r from pg_class where oid = 'private.bkp_bulkupload_${t}'::regclass`)).r, t).toBe(true);
      for (const role of ['anon', 'authenticated']) {
        expect((await one<{ b: boolean }>(`select has_table_privilege('${role}', 'private.bkp_bulkupload_${t}', 'select') b`)).b, `${role} on ${t}`).toBe(false);
      }
    }
    // running B1 twice is harmless
    await db.exec(read('backup/B1_manual_backup_before_synthetic_verification.sql'));
    expect(allOk(await checkRows('backup/B2_backup_check_readonly.sql'))).toBe(true);
    liveBefore = await snap();
  });

  it('PACK-DB8 the two synthetic files validate with the real validators and apply through the REAL functions (twin and signed in)', async () => {
    articleRun = await stageSynthetic('article', FILES[0].csv, 'ZZ_BULKVERIFY_Article_1_row.csv', EDITOR);
    muRun = await stageSynthetic('money_update', FILES[1].csv, 'ZZ_BULKVERIFY_Money_Update_1_row.csv', EDITOR);
    const a = await applyTwin(articleRun, EDITOR);
    const m = await applyNormal(muRun, EDITOR);
    expect(a).toMatchObject({ ok: true, created: 1 });
    expect(m).toMatchObject({ ok: true, created: 1 });
  });

  it('PACK-DB9 V1 reports exactly two private never-published drafts, an applied import history, and no non-synthetic bulk row', async () => {
    // PGlite runs one statement per query(): split the file and run each statement on its own
    const statements = read('verify/V1_after_apply_readonly.sql').split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !s.split('\n').every((l) => l.trim().startsWith('--')));
    const posts = (await db.query(statements[0])).rows as { ok: boolean; status: string; visibility: string; is_indexable: boolean; linked_sources: string | number; bulk_import_audit_rows: string | number }[];
    expect(posts.length).toBe(2);
    expect(posts.every((p) => p.ok === true && p.status === 'draft' && p.visibility === 'private' && p.is_indexable === false)).toBe(true);
    expect(posts.every((p) => Number(p.linked_sources) === 1 && Number(p.bulk_import_audit_rows) === 1)).toBe(true);
    const hist = (await db.query(statements[1])).rows as { ok: boolean }[];
    expect(hist.length).toBe(2);
    expect(hist.every((h) => h.ok === true)).toBe(true);
    expect((await db.query(statements[2])).rows).toEqual([]);
  });

  it('PACK-DB10 the person edits the drafts (a version and a workflow row appear), then C1 lists exactly the synthetic rows', async () => {
    const ids = (await rows<{ id: string }>(`select id from resource_posts where starts_with(slug, 'zz-bulkverify-')`)).map((r) => r.id);
    for (const id of ids) {
      await db.exec(`insert into resource_post_versions (post_id, version_number, snapshot, created_by) values ('${id}', 1, '{}'::jsonb, '${EDITOR}');`);
      await db.exec(`insert into resource_audit_log (entity_type, entity_id, action, actor_user_id, after_state) values ('resource_post','${id}','updated','${EDITOR}','{"title":"ZZ BULKVERIFY edited"}'::jsonb);`);
    }
    const statements = read('cleanup/C1_preview_synthetic_rows_readonly.sql').split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !s.split('\n').every((l) => l.trim().startsWith('--')));
    const list = (await db.query(statements[0])).rows as { kind: string; name: string }[];
    expect(list.filter((x) => x.kind === 'post').length).toBe(2);
    expect(list.filter((x) => x.kind === 'source').length).toBe(2);
    expect(list.filter((x) => x.kind === 'import run').length).toBe(2);
    expect(list.every((x) => /^(zz-bulkverify-|ZZ BULKVERIFY|ZZ_BULKVERIFY)/.test(x.name))).toBe(true);
    const counts = (await db.query(statements[1])).rows[0] as Record<string, string | number>;
    expect(Object.values(counts).map(Number)).toEqual([2, 2, 2, 0]);
  });

  async function c2With(editExpected?: number): Promise<string> {
    let sql = read('cleanup/C2_cleanup_synthetic_rows.sql');
    if (editExpected !== undefined) {
      const changed = sql.replace('expected_posts integer := 2;', `expected_posts integer := ${editExpected};`);
      expect(changed).not.toBe(sql);
      sql = changed;
    }
    return rejects(db.exec(sql));
  }
  const syntheticCount = () => count(`select count(*) n from resource_posts where starts_with(slug, 'zz-bulkverify-')`);

  it('PACK-DB11 NEGATIVE CONTROLS: C2 refuses and deletes NOTHING when the expected count is wrong, a synthetic post is not a private draft, or a real post uses a synthetic source', async () => {
    const before = await syntheticCount();
    expect(before).toBe(2);
    // (a) wrong expected count
    expect(await c2With(3)).toContain('CLEANUP_STOPPED');
    expect(await syntheticCount()).toBe(2);
    // (b) a synthetic post that no longer fits the private draft shape (made searchable)
    await db.exec(`update resource_posts set is_indexable = true where slug = 'zz-bulkverify-article-1';`);
    expect(await c2With()).toContain('CLEANUP_STOPPED');
    expect(await syntheticCount()).toBe(2);
    await db.exec(`update resource_posts set is_indexable = false where slug = 'zz-bulkverify-article-1';`);
    // (c) a real post links a synthetic source
    const src = (await one<{ id: string }>(`select id from resource_sources where source_name = 'ZZ BULKVERIFY Source A'`)).id;
    const real = (await one<{ id: string }>(`select id from resource_posts where slug = 'real-post-1'`)).id;
    await db.exec(`insert into resource_post_sources (post_id, source_id) values ('${real}','${src}');`);
    expect(await c2With()).toContain('CLEANUP_STOPPED');
    expect(await syntheticCount()).toBe(2);
    await db.exec(`delete from resource_post_sources where post_id = '${real}' and source_id = '${src}';`);
    // the control is meaningful: with all three conditions fixed the very same file does NOT refuse (next test)
  });

  it('PACK-DB12 C2 removes ONLY the synthetic rows (posts, their links, versions and audit rows, the import runs and the synthetic sources); real rows are untouched; C3 shows zero', async () => {
    expect(await c2With()).toBe('');
    const c3 = await checkRows('cleanup/C3_zero_residue_check_readonly.sql');
    expect(c3.length).toBe(6);
    expect(allOk(c3)).toBe(true);
    const after = await snap();
    expect(after).toEqual(liveBefore);
    expect(await count(`select count(*) n from resource_posts where starts_with(slug, 'real-post-')`)).toBe(3);
    expect(await count(`select count(*) n from resource_sources where source_name = 'Real Source One'`)).toBe(1);
    expect(allOk(await checkRows('backup/B2_backup_check_readonly.sql'))).toBe(true);
    expect(await count(`select count(*) n from resource_content_import_rows`)).toBe(0);
  });

  it('PACK-DB13 running C2 again when nothing is left refuses (count is 0, not 2): a second run can never delete anything else', async () => {
    expect(await c2With()).toContain('CLEANUP_STOPPED');
  });
});

describe('rollback', () => {
  it('PACK-DB14 R2 stops the apply for BOTH callers, R3 restores it; NEGATIVE CONTROL: revoking only the signed-in function (the old runbook) leaves the server twin working', async () => {
    // single revoke (the previous runbook text)
    await db.exec(`revoke execute on function public.apply_resource_content_import(uuid) from authenticated;`);
    const r1 = await stageSynthetic('article', FILES[0].csv, 'ZZ_BULKVERIFY_Article_1_row.csv', EDITOR);
    const viaTwin = await applyTwin(r1, EDITOR);
    expect(viaTwin, 'the single revoke does NOT stop an apply through the twin').toMatchObject({ ok: true, created: 1 });
    expect(await count(`select count(*) n from resource_posts where starts_with(slug, 'zz-bulkverify-')`)).toBe(1);
    await db.exec(`grant execute on function public.apply_resource_content_import(uuid) to authenticated, service_role;`);
    // R2 removes the drafts of this probe through C2 first so the next stage is clean
    await db.exec(read('cleanup/C2_cleanup_synthetic_rows.sql').replace('expected_posts integer := 2;', 'expected_posts integer := 1;'));
    expect(await count(`select count(*) n from resource_posts where starts_with(slug, 'zz-bulkverify-')`)).toBe(0);

    await db.exec(read('rollback/R2_disable_apply_only.sql'));
    const r2 = await stageSynthetic('article', FILES[0].csv, 'ZZ_BULKVERIFY_Article_1_row.csv', EDITOR);
    expect(await as(null, 'service_role', () => rejects(db.query(`select public.apply_resource_content_import_as_actor('${r2}','${EDITOR}')`)))).toContain('permission denied');
    expect(await as(EDITOR, 'authenticated', () => rejects(db.query(`select public.apply_resource_content_import('${r2}')`)))).toContain('permission denied');
    expect(await count(`select count(*) n from resource_posts where starts_with(slug, 'zz-bulkverify-')`)).toBe(0);

    await db.exec(read('rollback/R3_enable_apply_again.sql'));
    expect(allOk(await checkRows('checks/P2_after_0273.sql'))).toBe(true);
    expect(await applyTwin(r2, EDITOR)).toMatchObject({ ok: true, created: 1 });
    await db.exec(read('cleanup/C2_cleanup_synthetic_rows.sql').replace('expected_posts integer := 2;', 'expected_posts integer := 1;'));
  });

  it('PACK-DB15 R4 re-adds a real row deleted after the backup, changes no live row, and re-adding twice is harmless', async () => {
    const live = await count(`select count(*) n from resource_posts`);
    const victim = (await one<{ id: string }>(`select id from resource_posts where slug = 'real-post-2'`)).id;
    await db.exec(`delete from resource_posts where id = '${victim}';`);
    expect(await count(`select count(*) n from resource_posts`)).toBe(live - 1);
    await db.exec(`update resource_posts set title = 'Real post 3 (edited after backup)' where slug = 'real-post-3';`);
    await db.exec(read('rollback/R4_restore_deleted_rows_from_backup.sql'));
    expect(await count(`select count(*) n from resource_posts`)).toBe(live);
    expect((await one<{ title: string }>(`select title from resource_posts where slug = 'real-post-3'`)).title).toBe('Real post 3 (edited after backup)');
    await db.exec(read('rollback/R4_restore_deleted_rows_from_backup.sql'));
    expect(await count(`select count(*) n from resource_posts`)).toBe(live);
  });

  it('PACK-DB16 B3 drops the six copies', async () => {
    await db.exec(read('backup/B3_drop_backups.sql'));
    expect(await count(`select count(*) n from pg_tables where schemaname = 'private' and starts_with(tablename, 'bkp_bulkupload_')`)).toBe(0);
  });

  it('PACK-DB17 R1 removes every bulk upload object, leaves created drafts and every other table alone, and the three migrations apply again afterwards', async () => {
    // a draft created by an upload must survive R1
    const r = await stageSynthetic('money_update', FILES[1].csv, 'ZZ_BULKVERIFY_Money_Update_1_row.csv', EDITOR);
    await applyTwin(r, EDITOR);
    const posts = await count(`select count(*) n from resource_posts`);
    await db.exec(read('rollback/R1_remove_bulk_upload_database_objects.sql'));
    const left = await count(`select (select count(*) from pg_proc where proname in ('apply_resource_content_import','apply_resource_content_import_as_actor','apply_resource_content_import_core','resource_content_import_lookup','purge_expired_resource_content_import_staging','can_bulk_import_resource_content')) + (select count(*) from pg_class where relname in ('resource_content_import_runs','resource_content_import_rows')) n`);
    expect(left).toBe(0);
    expect(await count(`select count(*) n from resource_posts`)).toBe(posts);
    // P0 section C is false again (the feature is gone) so the pack can be re-run from the start
    const p0 = await checkRows('checks/P0_precheck_readonly.sql');
    expect(allOk(p0)).toBe(true);
    for (const m of MIGS) await db.exec(read(`sql/${m}`));
    expect(allOk(await checkRows('checks/P3_after_0274.sql'))).toBe(true);
    expect(allOk(await checkRows('checks/P1_after_0272.sql'))).toBe(true);
  });
});
