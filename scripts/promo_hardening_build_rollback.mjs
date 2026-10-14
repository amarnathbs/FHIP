// Builds the rollback scripts of the promo hardening release from the text of the migrations that created the OLD objects.
//   node scripts/promo_hardening_build_rollback.mjs          (write the rollback files)
//   node scripts/promo_hardening_build_rollback.mjs --check  (exit 1 if a file differs from what would be written)
//
// R1  after the cleanup 0279: puts the five OLD function shapes back (taken byte for byte from 0231, 0237 and 0242, which created them).
// R2  after 0264 to 0268: removes what they added and restores the two functions they replaced under the same signature.
// Both are hand-run files. They follow the editor safety rules (scripts/migration_editor_safety_lint.mjs checks them).
//
// IMPORTANT, said in the files too: the additive migrations do NOT need to be rolled back to roll the APPLICATION back. Redeploying the
// previous application release is enough until the plain values have been blanked (the finalise step). R1 and R2 are for a database
// that must be taken back to its earlier shape, for example after a part failed on the way in.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const OUT = path.join(ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release', 'rollback');

const read = (prefix) => {
  const f = fs.readdirSync(MIG).find((x) => x.startsWith(prefix));
  if (!f) throw new Error(`migration ${prefix} not found`);
  return fs.readFileSync(path.join(MIG, f), 'utf8').replace(/\r/g, '');
};

/**
 * Editor safety: the old bodies carry comments with semicolons and quotes, and a percent type. The hand-run rule forbids both, so the
 * comments are dropped and a rowtype variable becomes a plain record. Behaviour is identical (a test runs the old release's calls).
 */
export function editorSafe(block) {
  return block
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .map((l) => l.replace(/\s+--.*$/, ''))
    .join('\n')
    .replace(/public\.[a-z_]+%rowtype/g, 'record')
    .replace("'promo_code_events is append-only: % is not permitted', tg_op using errcode = '42501'", "'promo_code_events is append-only' using errcode = '42501', detail = tg_op");
}

/** The text of one function definition, from its create line to its closing dollar quote line. */
export function functionBlock(sql, name, signatureStartsWith) {
  const re = new RegExp(`^create or replace function public\\.${name}\\(${signatureStartsWith ? signatureStartsWith.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''}[\\s\\S]*?^\\$fn\\$;[ \\t]*$`, 'm');
  const m = re.exec(sql);
  if (!m) throw new Error(`function ${name} not found`);
  return editorSafe(m[0]);
}

/** Statements that grant or comment on one function, copied as they appear (single line each). */
function lines(sql, re) {
  const out = sql.split('\n').filter((l) => re.test(l));
  if (out.length === 0) throw new Error(`no lines for ${re}`);
  return out;
}

const m231 = read('0231_');
const m237 = read('0237_');
const m238 = read('0238_');
const m242 = read('0242_');

function buildR1() {
  const create = functionBlock(m242, 'admin_create_promo_code');
  const list = functionBlock(m242, 'admin_list_promo_codes');
  const redeem = functionBlock(m242, 'redeem_promo_code_for_user');
  const begin = functionBlock(m242, 'admin_promo_email_begin');
  const manage = functionBlock(m237, 'admin_manage_premium_entitlement');
  const manageComment = m231.split('\n').findIndex((l) => l.startsWith('comment on function public.admin_manage_premium_entitlement(text, uuid, date, text) is'));
  const manageCommentText = m231.split('\n').slice(manageComment, manageComment + 2).join('\n');
  return [
    '-- R1 rollback of 0279, the legacy cleanup: put the OLD function shapes back',
    '-- =============================================================================',
    '-- Hand-run. The bodies below are the exact text of the migrations that created these functions (0231, 0237, 0242).',
    '--',
    '-- READ FIRST. 0279 only runs after the plain code values were blanked by the finalise step. This file puts the old',
    '-- FUNCTIONS back, but the plain values are gone, so the OLD application release still cannot redeem an existing code.',
    '-- If the old release must serve users again, restore the database using the backup taken before the finalise step instead.',
    '-- Use this file when you only need the old function shapes to exist again (for example to re-run the cleanup later).',
    '-- =============================================================================',
    '',
    create,
    ...lines(m242, /^(revoke all|grant execute) on function public\.admin_create_promo_code\(text, int, int, boolean, date, boolean, text, text, int\)/),
    '',
    list,
    ...lines(m242, /^(revoke all|grant execute) on function public\.admin_list_promo_codes\(\)/),
    '',
    redeem,
    ...lines(m242, /^(revoke all|grant execute) on function public\.redeem_promo_code_for_user\(uuid, text, text, text\)/),
    '',
    manage,
    manageCommentText,
    ...lines(m231, /^(revoke all|grant execute) on function public\.admin_manage_premium_entitlement\(text, uuid, date, text\)/),
    '',
    begin,
    ...lines(m242, /^(revoke all|grant execute) on function public\.admin_promo_email_begin\(text, int, boolean\)/),
    '',
  ].join('\n');
}

function buildR2() {
  const claim = functionBlock(m238, 'premium_reminder_claim');
  const immutable = functionBlock(m237, 'promo_code_events_immutable');
  const claimGrants = lines(m238, /^(revoke all|grant execute) on function public\.premium_reminder_claim\(/);
  return [
    '-- R2 rollback of 0264 to 0268: remove what they added, restore the two functions they replaced under the same signature',
    '-- =============================================================================',
    '-- Hand-run, ONE statement block at a time is fine. You normally do NOT need this file: the migrations are additive, and',
    '-- redeploying the previous application release is enough to roll the application back (until the finalise step has been run).',
    '-- Use it only to take a database back to its earlier shape, for example after a part failed on the way in.',
    '--',
    '-- BEFORE YOU RUN IT',
    '--   * If 0279 was applied, run R1 first.',
    '--   * Export these tables if they hold anything you want to keep: admin_monitoring_events, premium_entitlement_overrides,',
    '--     promo_retention_runs, promo_email_circuit. They are dropped here.',
    '--   * The guard below stops the file when some code exists only as a digest (created by the new release, or blanked by the',
    '--     finalise). Dropping the digest columns would orphan those codes for good. Disable them and restore a backup instead.',
    '--',
    '-- WHAT IT KEEPS ON PURPOSE: the protective changes to platform_deployment_environment from 0268 (row level security on, no API',
    '-- access, one row, allowed values). They are harmless to the old release and protect production. The code column stays nullable.',
    '-- =============================================================================',
    '',
    'do $fn$',
    'begin',
    "  if exists (select 1 from public.promo_codes where code is null and anonymised_at is null) then",
    "    raise exception 'PROMO_ROLLBACK_BLOCKED' using errcode = 'P0001',",
    "      detail = 'some promo codes exist only as a digest. Disable them and restore a backup instead of dropping the digest columns.';",
    '  end if;',
    "  if to_regprocedure('public.admin_list_promo_codes()') is null",
    "     or to_regprocedure('public.redeem_promo_code_for_user(uuid,text,text,text)') is null",
    "     or to_regprocedure('public.admin_create_promo_code(text,integer,integer,boolean,date,boolean,text,text,integer)') is null",
    "     or to_regprocedure('public.admin_manage_premium_entitlement(text,uuid,date,text)') is null",
    "     or to_regprocedure('public.admin_promo_email_begin(text,integer,boolean)') is null then",
    "    raise exception 'PROMO_ROLLBACK_BLOCKED' using errcode = 'P0001',",
    "      detail = 'the old function shapes are missing. Run R1 first.';",
    '  end if;',
    'end $fn$;',
    '',
    '-- the scheduled retention job and its switch',
    'do $fn$',
    'begin',
    "  if to_regclass('cron.job') is not null then",
    "    perform cron.unschedule('promo-retention-cleanup') where exists (select 1 from cron.job where jobname = 'promo-retention-cleanup');",
    '  end if;',
    'end $fn$;',
    "delete from public.premium_reminder_job_control where job_key = 'promo_retention';",
    '',
    '-- new functions (0268, 0267, 0266, 0265, 0264)',
    'drop function if exists public.premium_cron_verify(text);',
    'drop function if exists public.platform_is_production();',
    'drop function if exists public.promo_retention_run(boolean, timestamptz);',
    'drop function if exists public.promo_retention_user_held(uuid, text);',
    'drop function if exists public.promo_email_circuit_report(boolean);',
    'drop function if exists public.promo_email_circuit_status();',
    'drop function if exists public.admin_promo_email_request_status(text, text[]);',
    'drop function if exists public.admin_promo_email_begin(text, int, boolean, text, text, uuid);',
    'drop function if exists public.promo_email_limits();',
    'drop function if exists public.promo_codes_backfill_record(uuid, int, int);',
    'drop function if exists public.admin_promo_codes_hash_status();',
    'drop function if exists public.promo_codes_finalise_hash_only(boolean);',
    'drop function if exists public.promo_codes_digest_mark_verified(uuid, text);',
    'drop function if exists public.promo_codes_digest_apply(uuid, text, int);',
    'drop function if exists public.promo_codes_digest_pending(int);',
    'drop function if exists public.admin_manage_premium_entitlement(text, uuid, date, text, boolean);',
    'drop function if exists public.redeem_promo_code_for_user(uuid, text[], text, text, text);',
    'drop function if exists public.admin_list_promo_codes_v2();',
    'drop function if exists public.admin_create_promo_code(text, text, int, int, int, boolean, date, boolean, text, text, int);',
    'drop function if exists public.promo_attempts_retention_days();',
    '',
    '-- new tables',
    'drop table if exists public.promo_retention_runs;',
    'drop table if exists public.promo_retention_holds;',
    'drop table if exists public.promo_retention_policy;',
    'drop table if exists public.promo_email_circuit;',
    'drop table if exists public.premium_entitlement_overrides;',
    'drop table if exists public.admin_monitoring_events;',
    '',
    '-- the two functions replaced under the same signature go back to their earlier text',
    immutable,
    '',
    claim,
    ...claimGrants,
    '',
    '-- new columns and what hangs on them',
    'alter table public.promo_email_sends drop column if exists anonymised_at;',
    'alter table public.promo_code_events drop column if exists anonymised_at;',
    'drop index if exists public.idx_promo_email_requests_replaces;',
    'drop index if exists public.idx_promo_email_requests_time;',
    'alter table public.promo_email_requests drop column if exists replaces_promo_code_id;',
    'alter table public.promo_email_requests drop column if exists kind;',
    'alter table public.promo_email_requests drop column if exists purpose;',
    'alter table public.promo_codes drop constraint if exists promo_codes_has_identity;',
    'alter table public.promo_codes drop constraint if exists promo_codes_digest_shape;',
    'drop index if exists public.uq_promo_codes_digest;',
    'alter table public.promo_codes drop column if exists code_digest_verified_at;',
    'alter table public.promo_codes drop column if exists code_digest_version;',
    'alter table public.promo_codes drop column if exists code_digest;',
    'alter table public.promo_codes drop column if exists anonymised_at;',
    '-- the table grant as 0237 had it (the column grants of 0264 are removed by the revoke)',
    'revoke select on public.promo_codes from anon, authenticated;',
    'grant select on public.promo_codes to authenticated;',
    'alter table public.user_entitlements drop constraint if exists user_entitlements_lifetime_units_check;',
    'alter table public.user_entitlements drop column if exists admin_lifetime_grant_units;',
    'drop function if exists public.is_entitlement_override_admin();',
    'alter table public.admin_users drop column if exists can_override_entitlement_limits;',
    'drop function if exists public.admin_list_monitoring_events(int);',
    'drop function if exists public.promo_hardening_append_only();',
    'drop function if exists public.premium_grant_lifetime_ceiling();',
    'drop function if exists public.promo_normalise_email(text);',
    'drop function if exists public.access_window_days(date, date);',
    'drop function if exists public.access_end_date(date, int);',
    '',
  ].join('\n');
}

export const ROLLBACK_FILES = [
  { file: 'R1_after_0279_restore_old_function_shapes.sql', build: buildR1 },
  { file: 'R2_undo_0264_to_0268.sql', build: buildR2 },
];

if (process.argv[1] && process.argv[1].endsWith('promo_hardening_build_rollback.mjs')) {
  let bad = 0;
  fs.mkdirSync(OUT, { recursive: true });
  for (const r of ROLLBACK_FILES) {
    const text = r.build();
    const target = path.join(OUT, r.file);
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) {
        bad += 1;
        console.log(`DIFFERS: ${r.file}`);
      }
    } else {
      fs.writeFileSync(target, text);
      console.log(`wrote ${r.file} (${text.length} bytes)`);
    }
  }
  process.exit(bad ? 1 : 0);
}
