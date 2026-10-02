// BENCH-1 Phase 2 - DATABASE negative controls for migration 0239.
//
// For each rule: copy migration 0239 to a temp file with ONE rule broken, replay the whole chain 0001..0239 on PGlite
// (B1P2_MIG_OVERRIDE), run the verification harness, and record which NAMED checks FAIL. A control with no failing
// check is reported NOT_DEMONSTRATED (the harness is too weak for that rule). The real migration file is never edited.
//
// Run: node scripts/bench1_phase2_0239_negative_controls.mjs [idPrefix]      (each control replays ~240 migrations: slow)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations', fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).find((f) => f.startsWith('0239_')));
const OUT = path.join(ROOT, 'docs/investment-intelligence/evidence/bench1_phase2/db_negative_controls.json');
const original = fs.readFileSync(MIG, 'utf8');

const C = [
  { id: 'DB-01', rule: 'the central entitlement predicate (benchmark_right_allowed) fails closed', find: 'return coalesce(ok, false);', replace: 'return true;' },
  { id: 'DB-02', rule: 'a stale preview / concurrent conflicting import is detected at publication (classification revalidation)', find: 'if v_mismatch > 0 then', replace: 'if false then' },
  { id: 'DB-03', rule: 'staged rows edited after validation are refused (digest recomputed at publication)', find: 'if public.ii_bm_staging_digest(p_job) is distinct from j.staging_digest then', replace: 'if false then' },
  { id: 'DB-04', rule: 'the series reader gate: an unentitled series is invisible to ordinary users', find: "and benchmark_id = any ((select benchmark_calc_readable_ids())::uuid[]))", replace: 'and true)' },
  { id: 'DB-05', rule: 'a correction needs the correct capability, not the publish capability', find: "    if not public.is_benchmark_corrector() then raise exception 'benchmark import: correction capability required' using errcode = '42501'; end if;", replace: '    if false then null; end if;' },
  { id: 'DB-06', rule: 'overlapping PRIMARY mappings are refused by the database', find: 'create trigger trg_ii_instrument_benchmarks_no_primary_overlap\n  before insert or update on ii_instrument_benchmarks\n  for each row execute function ii_instrument_benchmarks_no_primary_overlap();', replace: '' },
  { id: 'DB-07', rule: 'single-flight lease: a live lease cannot be taken over', find: 'where benchmark_id = p_benchmark and (lease_expires_at is null or lease_expires_at < now() or lease_holder = p_holder)', replace: 'where benchmark_id = p_benchmark' },
  { id: 'DB-08', rule: 'the staging admin may not publish without the explicit self-publish acknowledgement (separation of duties)', find: "if j.staged_by = v_uid and coalesce((p ->> 'self_publish_ack')::boolean, false) is not true then", replace: 'if false then' },
  { id: 'DB-09', rule: 'the completeness watermark cannot exceed the latest valid data date (clamp, least() and CHECK all removed)', edits: [{ find: 'if v_wm is not null and v_latest is not null and v_wm > v_latest then v_wm := v_latest; end if;', replace: '' }, { find: 'completeness_watermark = least(coalesce(v_wm, s.completeness_watermark), v_latest),', replace: 'completeness_watermark = coalesce(v_wm, s.completeness_watermark),' }, { find: 'constraint ii_benchmark_ingestion_state_watermark_order check (completeness_watermark is null or latest_valid_data_date is null or completeness_watermark <= latest_valid_data_date)', replace: 'constraint ii_benchmark_ingestion_state_watermark_order check (true)' }] },
  { id: 'DB-10', rule: 'the feed write path enforces both kill switches', find: "if (select count(*) from public.ii_reference_job_control where job_key in ('benchmark_ingestion_global', 'benchmark_ingestion_write') and enabled = true) <> 2 then", replace: 'if false then' },
  { id: 'DB-11', rule: 'post-expiry retention never applies before the term starts', find: "retained boolean := e.post_expiry_storage = 'retain' and e.valid_to is not null and p_on > e.valid_to;", replace: "retained boolean := e.post_expiry_storage = 'retain';" },
  { id: 'DB-12', rule: 'an entitlement for another variant grants nothing (exact variant match)', find: 'and b.return_variant is not null and e.return_variant = b.return_variant\n       and b.currency_code is not null and e.currency_code = b.currency_code\n       and (p_data_from', replace: 'and b.return_variant is not null\n       and b.currency_code is not null and e.currency_code = b.currency_code\n       and (p_data_from' },
  { id: 'DB-13', rule: 'the 0232 single-step upload RPC (attestation checkbox only) is no longer executable', find: 'revoke execute on function commit_market_index_upload(text, text, text, jsonb, boolean, text) from authenticated;', replace: 'perform 1;' },
  { id: 'DB-14', rule: 'publication is blocked while hard validation errors remain (no partial publish)', find: 'if j.hard_error_total > 0 then', replace: 'if false then' },
  { id: 'DB-15', rule: 'rollback refuses when later revisions exist on the rows', find: 'if v_owned <> v_touched then', replace: 'if false then' },
  { id: 'DB-16', rule: 'the same file cannot be published twice', find: 'if v_prior is not null then\n    raise exception \'benchmark import: this exact file', replace: 'if false then\n    raise exception \'benchmark import: this exact file' },
  { id: 'DB-17', rule: 'the entitlement CHOSEN at staging is re-validated by id at publication (another approved entitlement must not rescue a revoked one)', find: "    if nullif(j.entitlement_refs ->> rec.benchmark_key, '') is null\n       or not (public.benchmark_entitlement_id_allows((j.entitlement_refs ->> rec.benchmark_key)::uuid, 'ingest_manual', current_date, rec.mn, rec.mx)\n               and public.benchmark_entitlement_id_allows((j.entitlement_refs ->> rec.benchmark_key)::uuid, 'storage', current_date, rec.mn, rec.mx)) then", replace: '    if false then' },
];

const only = process.argv[2];
const results = fs.existsSync(OUT) && only ? JSON.parse(fs.readFileSync(OUT, 'utf8')).results ?? [] : [];
for (const c of C.filter((x) => !only || x.id.startsWith(only))) {
  const entry = { id: c.id, rule: c.rule, status: 'NOT_RUN', failingChecks: [] };
  const edits = c.edits ?? [{ find: c.find, replace: c.replace }];
  if (!edits.every((e) => original.includes(e.find))) {
    entry.status = 'MUTATION_TARGET_NOT_FOUND';
  } else {
    const tmp = path.join(os.tmpdir(), `0239_mut_${c.id}.sql`);
    fs.writeFileSync(tmp, edits.reduce((acc, e) => acc.replace(e.find, e.replace), original));
    const res = path.join(os.tmpdir(), `0239_mut_${c.id}.json`);
    const r = spawnSync(process.execPath, [path.join(HERE, 'bench1_phase2_0239_pglite_verification.mjs')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, B1P2_MIG_OVERRIDE: tmp, B1P2_RESULTS_OUT: res }, timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 });
    const lines = (r.stdout ?? '').split(/\r?\n/);
    entry.failingChecks = lines.filter((l) => /^\s+FAIL\s/.test(l)).map((l) => l.trim().replace(/\s+/g, ' ').slice(0, 220));
    const crashed = /UNCAUGHT|REJECTED/.test(r.stdout + r.stderr) || (r.status !== 0 && entry.failingChecks.length === 0);
    entry.crashedHarnessOrMigration = crashed;
    entry.status = entry.failingChecks.length > 0 || crashed ? 'DEMONSTRATED' : 'NOT_DEMONSTRATED';
    if (crashed && entry.failingChecks.length === 0) entry.note = ((r.stdout ?? '') + (r.stderr ?? '')).split(/\r?\n/).filter((l) => /UNCAUGHT|REJECTED/.test(l)).slice(0, 2).join(' | ');
    fs.rmSync(tmp, { force: true });
    fs.rmSync(res, { force: true });
  }
  const at = results.findIndex((x) => x.id === c.id);
  if (at >= 0) results[at] = entry;
  else results.push(entry);
  console.log(`${entry.status.padEnd(26)} ${c.id} ${c.rule} (${entry.failingChecks.length} failing check(s): ${entry.failingChecks[0] ?? entry.note ?? '-'})`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedBy: 'scripts/bench1_phase2_0239_negative_controls.mjs', note: 'Each rule broken in a TEMP COPY of 0239 and replayed on PGlite; the real migration was never modified.', results }, null, 2));
}
const bad = results.filter((r) => r.status !== 'DEMONSTRATED');
console.log(`\n${results.length - bad.length}/${results.length} database controls demonstrated`);
if (fs.readFileSync(MIG, 'utf8') !== original) { console.error('migration file changed!'); process.exit(3); }
process.exit(bad.length ? 1 : 0);
