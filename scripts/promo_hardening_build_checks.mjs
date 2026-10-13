// Builds the read-only DETECTION pack of the promo hardening hand-over (checks/D1_before_detect.sql).
//   node scripts/promo_hardening_build_checks.mjs          (write the file)
//   node scripts/promo_hardening_build_checks.mjs --check  (exit 1 if the file differs from what would be written)
//
// WHY GENERATED. The pack compares the five OLD functions that are live today with the text the repository says they have
// (an md5 of each function body, taken from the migration that created its latest version). A difference means the database is not
// in the state this release was built and tested against, and the PO must stop and report it BEFORE applying anything.
// Everything else in the pack is a catalogue or count query. The verification packs (V*.sql) are written by hand.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const OUT = path.join(ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release', 'checks', 'D1_before_detect.sql');

const read = (prefix) => fs.readFileSync(path.join(MIG, fs.readdirSync(MIG).find((x) => x.startsWith(prefix))), 'utf8').replace(/\r/g, '');

/** The text a function body has inside the database: between the two dollar quote tags (the tags excluded). */
export function bodyOf(sql, name) {
  const header = new RegExp(`^create or replace function public\\.${name}\\(`, 'm').exec(sql);
  if (!header) throw new Error(`function ${name} not found`);
  const open = sql.indexOf('$fn$', header.index);
  const close = sql.indexOf('\n$fn$;', open + 4);
  return sql.slice(open + 4, close + 1);
}

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/**
 * NORMALISATION. A function body that was pasted into the SQL editor may differ from the migration file only in layout: line endings,
 * indentation, trailing space, or comment lines (the editor safety rules forced some hand-run text to be reworded in comments). Such a
 * difference is cosmetic. The comparison therefore removes every comment (two hyphens to the end of the line), collapses every run of
 * white space (including carriage returns) to one space and trims. The database computes the SAME thing with the SQL expression below, and a
 * test proves the two agree on the real migrations. Anything that survives the normalisation (a changed word, number, condition) changes the hash.
 */
export function normaliseBody(text) {
  return text.replace(/-{2}[^\n]*/g, '').replace(/\s+/g, ' ').trim();
}
/** The same normalisation as a SQL expression over a text expression. */
export const normalisedSql = (expr) => `btrim(regexp_replace(regexp_replace(${expr}, '-{2}[^' || chr(10) || ']*', '', 'g'), '\\s+', ' ', 'g'))`;

export const OLD_FUNCTIONS = [
  { name: 'admin_create_promo_code', ident: 'public.admin_create_promo_code(text,integer,integer,boolean,date,boolean,text,text,integer)', file: '0242_', label: 'create (old, 9 arguments)' },
  { name: 'admin_list_promo_codes', ident: 'public.admin_list_promo_codes()', file: '0242_', label: 'list (old, returns the plain code)' },
  { name: 'redeem_promo_code_for_user', ident: 'public.redeem_promo_code_for_user(uuid,text,text,text)', file: '0242_', label: 'redeem (old, 4 arguments)' },
  { name: 'admin_manage_premium_entitlement', ident: 'public.admin_manage_premium_entitlement(text,uuid,date,text)', file: '0237_', label: 'grant (old, 4 arguments)' },
  { name: 'admin_promo_email_begin', ident: 'public.admin_promo_email_begin(text,integer,boolean)', file: '0242_', label: 'e-mail request start (old, 3 arguments)' },
];

export function fingerprints() {
  const out = {};
  for (const f of OLD_FUNCTIONS) out[f.name] = md5(normaliseBody(bodyOf(read(f.file), f.name)));
  return out;
}

function build() {
  const fp = fingerprints();
  const rows = [];
  const add = (section, check, actual, expected) => rows.push({ section, check, actual, expected });
  const t = (cond) => `(${cond})::text`;

  // A. the state this release was built against
  add('A', 'promo code table exists', t(`to_regclass('public.promo_codes') is not null`), `'true'`);
  add('A', 'promo redemption table exists', t(`to_regclass('public.promo_code_redemptions') is not null`), `'true'`);
  add('A', 'reminder ledger table exists', t(`to_regclass('public.premium_expiry_email_ledger') is not null`), `'true'`);
  add('A', 'e-mail send ledger table exists', t(`to_regclass('public.promo_email_sends') is not null`), `'true'`);
  add('A', 'Premium grant audit table exists', t(`to_regclass('public.admin_entitlement_events') is not null`), `'true'`);
  add('A', 'address binding column exists', t(`(select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'promo_codes' and column_name = 'bound_email_hash')`), `'true'`);
  for (const f of OLD_FUNCTIONS) add('A', `old function exists: ${f.label}`, t(`to_regprocedure('${f.ident}') is not null`), `'true'`);
  // B. the old functions are exactly the repository text
  for (const f of OLD_FUNCTIONS) {
    add('B', `old function text matches the repository (layout and comments ignored): ${f.label}`, `(select md5(${normalisedSql('prosrc')}) from pg_proc where oid = to_regprocedure('${f.ident}'))`, `'${fp[f.name]}'`);
    add('B2', `old function raw size in characters and raw hash (information only): ${f.label}`, `(select length(prosrc)::text || ' / ' || md5(prosrc) from pg_proc where oid = to_regprocedure('${f.ident}'))`, null);
  }
  // C. nothing of this release is there yet (every row says false before you apply)
  add('C', 'digest column exists (false before you apply)', t(`(select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'promo_codes' and column_name = 'code_digest')`), `'false'`);
  add('C', 'new list function exists (false before you apply)', t(`to_regprocedure('public.admin_list_promo_codes_v2()') is not null`), `'false'`);
  add('C', 'override capability column exists (false before you apply)', t(`(select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name = 'can_override_entitlement_limits')`), `'false'`);
  add('C', 'retention policy table exists (false before you apply)', t(`to_regclass('public.promo_retention_policy') is not null`), `'false'`);
  add('C', 'monitoring table exists (false before you apply)', t(`to_regclass('public.admin_monitoring_events') is not null`), `'false'`);
  // D. data (information only)
  add('D', 'promo codes in total', `(select count(*) from public.promo_codes)::text`, null);
  add('D', 'promo codes that hold their text', `(select count(*) from public.promo_codes where code is not null)::text`, null);
  add('D', 'promo codes bound to an address', `(select count(*) from public.promo_codes where bound_email_hash is not null)::text`, null);
  add('D', 'promo codes that are active', `(select count(*) from public.promo_codes where status = 'active')::text`, null);
  add('D', 'promo redemptions in total', `(select count(*) from public.promo_code_redemptions)::text`, null);
  add('D', 'people on an active admin grant', `(select count(*) from public.user_entitlements where entitlement_source = 'admin_grant' and plan_tier = 'premium' and effective_to >= current_date)::text`, null);
  add('D', 'people on an active promo code entitlement', `(select count(*) from public.user_entitlements where entitlement_source = 'promo_code' and plan_tier = 'premium' and effective_to >= current_date)::text`, null);
  add('D', 'people on paid Premium', `(select count(*) from public.user_entitlements where entitlement_source = 'payment' and plan_tier = 'premium')::text`, null);
  add('D', 'admin grant audit rows', `(select count(*) from public.admin_entitlement_events)::text`, null);
  add('D', 'e-mail requests so far', `(select count(*) from public.promo_email_requests)::text`, null);
  add('D', 'people who hold the Premium grant capability', `(select count(*) from public.admin_users where can_manage_premium_entitlements)::text`, null);
  add('D', 'people who hold the promo code capability', `(select count(*) from public.admin_users where can_manage_promo_codes)::text`, null);
  // E. environment marker
  add('E', 'environment marker rows', `(select count(*) from public.platform_deployment_environment)::text`, null);
  add('E', 'environment marker value', `(select coalesce(string_agg(environment, ', '), 'none') from public.platform_deployment_environment)`, null);
  add('E', 'at most one environment marker row (needed by 0268)', t(`(select count(*) from public.platform_deployment_environment) <= 1`), `'true'`);
  // F. switches
  add('F', 'job switches', `(select coalesce(string_agg(job_key || '=' || enabled::text, ', ' order by job_key), 'none') from public.premium_reminder_job_control)`, null);

  // The first row names its columns, later rows are positional.
  const body = rows
    .map((r, i) => {
      const cols = `${i + 1}${i === 0 ? ' as n' : ''}, '${r.section}'${i === 0 ? ' as section' : ''}, '${r.check.replace(/'/g, "''")}'${i === 0 ? ' as check_name' : ''}, ${r.actual}${i === 0 ? ' as actual' : ''}, ${r.expected ?? 'null'}${i === 0 ? ' as expected' : ''}`;
      return i === 0 ? `  select ${cols}` : `  union all select ${cols}`;
    })
    .join('\n');

  return [
    '-- D1 detection pack: read only, safe to run on DEV and on production, any number of times',
    '-- Paste the whole file in the SQL editor and press Run. You get one row per check.',
    '-- Section A: the database is in the state this release was built against (ok must be true).',
    '-- Section B: the five old functions are the text the repository says they are, ignoring layout and comments (ok must be true). Section B2 is information only.',
    '-- Section C: nothing of this release is applied yet (every row must say false before you apply, and ok true).',
    '-- Section D and F: facts for the record. They have no expected value, so ok is true. Copy them to your reply.',
    '-- Section E: the environment marker. At most one row is allowed.',
    '-- If any ok is false in section A, B or E: STOP. Do not apply anything. Send the result back.',
    '',
    'select section, check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok',
    'from (',
    body,
    ') c',
    'order by n;',
    '',
  ].join('\n');
}

/** The chunk size, in characters, of one result row of the definition pack. */
export const D2_CHUNK = 900;

/**
 * D2: the read-only DEFINITION pack. It returns each old function in its normalised form (comments removed, white space collapsed) cut into
 * rows of ${D2_CHUNK} characters, with the normalised hash and length, so a difference reported by D1 can be pasted back and compared
 * word by word. Same normalisation as D1 (normalisedSql). Writes nothing.
 */
function buildD2() {
  const norm = normalisedSql('p.prosrc');
  const rows = OLD_FUNCTIONS.map((f, i) => `  ${i === 0 ? 'select' : 'union all select'} ${i + 1}${i === 0 ? ' as k' : ''}, '${f.label}'${i === 0 ? ' as function_name' : ''}, ${norm}${i === 0 ? ' as norm' : ''} from pg_proc p where p.oid = to_regprocedure('${f.ident}')`).join('\n');
  return [
    '-- D2 definition pack: read only, safe to run on DEV and on production',
    '-- Paste the whole file in the SQL editor and press Run. It returns the five old functions as normalised text (comments removed and white space',
    '-- collapsed) cut in pieces, with the hash and the length of each. Use it when D1 section B says a function differs: send me the whole result.',
    '-- The hash column must equal the expected value in D1 for the function to match the repository.',
    '',
    'select f.function_name, g.n as part, substr(f.norm, (g.n - 1) * ' + D2_CHUNK + ' + 1, ' + D2_CHUNK + ') as text_part, md5(f.norm) as normalised_hash, length(f.norm) as normalised_length',
    'from (',
    rows,
    ') f',
    'cross join lateral generate_series(1, greatest(ceil(length(f.norm) / ' + D2_CHUNK + '.0)::int, 1)) g(n)',
    'order by f.k, g.n;',
    '',
  ].join('\n');
}

export const CHECK_FILES = [
  { file: 'D1_before_detect.sql', build: build },
  { file: 'D2_old_function_definitions.sql', build: buildD2 },
];

if (process.argv[1] && process.argv[1].endsWith('promo_hardening_build_checks.mjs')) {
  let bad = 0;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  for (const c of CHECK_FILES) {
    const text = c.build();
    const target = path.join(path.dirname(OUT), c.file);
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) {
        bad += 1;
        console.log(`DIFFERS: ${c.file}`);
      }
    } else {
      fs.writeFileSync(target, text);
      console.log(`wrote ${c.file} (${text.length} bytes)`);
    }
  }
  process.exit(bad ? 1 : 0);
}
