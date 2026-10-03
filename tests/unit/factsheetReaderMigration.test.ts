// Migration 0252 (factsheet benchmark reader): static guarantees on the SQL text, and that it cannot drift from the code.
// No database is touched (this reads the file). Live behaviour of the functions is NOT verified here: see the report.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FACTSHEET_SOURCE_SEED } from '@/lib/services/investment-intelligence/factsheetReader/sourceRegistry';
import { TERMINAL_OUTCOMES, TERMS_REVIEW_STATUSES } from '@/lib/services/investment-intelligence/factsheetReader/types';
import { AWAITING_REVIEW_CATALOGUE_STATES, NOT_COMPARABLE_CATALOGUE_STATES } from '@/lib/services/investment-intelligence/benchmarkData/declaredRecordStatus';

const ROOT = path.resolve(__dirname, '..', '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const FILE = '0252_bench1_factsheet_benchmark_reader.sql';
const sql = fs.readFileSync(path.join(MIG_DIR, FILE), 'utf8');
const lower = sql.toLowerCase();
const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n');
const codeLower = code.toLowerCase();

const NEW_TABLES = ['ii_factsheet_sources', 'ii_scheme_declared_benchmark_versions', 'ii_factsheet_version_events', 'ii_factsheet_attempts'];

/** The values of `<column> in ('a', 'b', ...)` inside the CREATE TABLE of `table`. */
function checkList(table: string, column: string): string[] {
  const start = code.indexOf(`create table if not exists ${table} (`);
  expect(start, table).toBeGreaterThan(-1);
  const end = code.indexOf('\n);', start);
  const body = code.slice(start, end);
  const m = new RegExp(String.raw`\b${column}\s+in\s+\(([^)]*)\)`).exec(body);
  expect(m, `${table}.${column}`).not.toBeNull();
  return [...(m as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('numbering and preconditions', () => {
  it('is migration 0252, the highest, with no sibling of the same number', () => {
    const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{4}_/.test(f)).sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.filter((f) => f.startsWith('0252_'))).toEqual([FILE]);
    expect(files).toContain('0251_bench1_held_schemes_for_benchmark_mapping.sql');
  });
  it('fails loudly unless 0241 (mapping governance) is applied first', () => {
    expect(sql).toMatch(/requires migration 0241/);
    for (const needle of ['is_benchmark_data_viewer()', 'propose_benchmark_mapping(jsonb)', 'auto_publish_benchmark_mapping(uuid)', 'review_benchmark_mapping(uuid,text,text,boolean)']) expect(sql).toContain(needle);
  });
});

describe('additive and idempotent: nothing existing is dropped, altered or re-created (no constraint drop-and-recreate)', () => {
  it('no DROP of a table, column, constraint, function or type; only DROP POLICY / TRIGGER IF EXISTS on its own new objects', () => {
    expect(codeLower).not.toMatch(/\bdrop\s+(table|column|constraint|function|type|index|view|schema)\b/);
    expect(codeLower).not.toMatch(/\balter\s+table\s+\w+\s+(drop|rename|alter\s+column)\b/);
    for (const m of codeLower.matchAll(/drop\s+policy\s+if\s+exists\s+"[^"]+"\s+on\s+(\w+)/g)) expect(NEW_TABLES).toContain(m[1]);
    for (const m of codeLower.matchAll(/drop\s+trigger\s+if\s+exists\s+\w+\s+on\s+(\w+)/g)) expect(NEW_TABLES).toContain(m[1]);
  });
  it('every ALTER TABLE targets one of the four new tables (and only to enable row-level security)', () => {
    const alters = [...codeLower.matchAll(/alter\s+table\s+(\w+)\s+([a-z ]+?);/g)];
    expect(alters.length).toBeGreaterThan(0);
    for (const a of alters) {
      expect(NEW_TABLES, a[0]).toContain(a[1]);
      expect(a[2].trim(), a[0]).toBe('enable row level security');
    }
  });
  it('it never re-creates a 0241 function or touches 0241 tables', () => {
    for (const fn of ['auto_publish_benchmark_mapping', 'propose_benchmark_mapping', 'review_benchmark_mapping', 'ii_bm_apply_mapping', 'upsert_benchmark_catalogue_entry', 'ii_instrument_benchmarks_no_primary_overlap']) {
      expect(codeLower, fn).not.toMatch(new RegExp(`create (or replace )?function ${fn}\\b`));
    }
    expect(codeLower).not.toMatch(/(insert into|update|delete from|alter table)\s+(ii_benchmark_mapping_proposals|ii_benchmarks|ii_benchmark_series)\b/);
  });
  it('re-runnable: IF NOT EXISTS on every table and index, CREATE OR REPLACE on every function, guarded inserts', () => {
    for (const m of codeLower.matchAll(/create\s+(unique\s+)?(table|index)\s+(?!if not exists)/g)) throw new Error(`not idempotent: ${m[0]}`);
    for (const m of codeLower.matchAll(/create\s+function\b/g)) throw new Error(`use create or replace: ${m[0]}`);
    for (const m of codeLower.matchAll(/insert\s+into\s+(?:public\.)?(\w+)/g)) expect([...NEW_TABLES, 'ii_reference_job_control'], m[0]).toContain(m[1]);
    expect(codeLower).toMatch(/on conflict \(source_key\) do nothing/);
    expect(codeLower).toMatch(/where not exists \(select 1 from ii_reference_job_control where job_key = 'factsheet_benchmark_reader'\)/);
  });
});

describe('history is append-only, in the database', () => {
  it('versions, events and the attempt ledger block UPDATE, DELETE and TRUNCATE; the source registry (operational state) does not', () => {
    for (const t of ['ii_scheme_declared_benchmark_versions', 'ii_factsheet_version_events', 'ii_factsheet_attempts']) {
      expect(codeLower, t).toMatch(new RegExp(`before update or delete on ${t} for each row execute function ii_factsheet_append_only\\(\\)`));
      expect(codeLower, t).toMatch(new RegExp(`before truncate on ${t} for each statement execute function ii_factsheet_append_only\\(\\)`));
    }
    expect(codeLower).not.toMatch(/(before update or delete|before truncate) on ii_factsheet_sources/);
    expect(code).toMatch(/raise exception '% is append-only/);
  });
  it('a stale "previous version" is refused inside the write function (two overlapping runs cannot both append v2)', () => {
    expect(codeLower).toMatch(/pg_advisory_xact_lock\(hashtextextended\('factsheet_version:'/);
    expect(codeLower).toMatch(/v_latest is distinct from p_expected_previous/);
    expect(code).toMatch(/errcode = '40001'/);
    expect(codeLower).toMatch(/constraint ii_scheme_declared_benchmark_versions_unique_no unique \(instrument_id, version_no\)/);
  });
  it('the idempotent month: ONE terminal result per scheme per source per month (a unique partial index), same list as the code', () => {
    const m = /create unique index if not exists uq_ii_factsheet_attempts_terminal on ii_factsheet_attempts \(source_id, instrument_id, run_month\)\s+where outcome in \(([^)]*)\)/i.exec(code);
    expect(m).not.toBeNull();
    const sqlList = [...(m as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(sqlList).toEqual([...TERMINAL_OUTCOMES].sort());
  });
});

describe('access and privacy', () => {
  it('every new table has RLS on, a viewer-only SELECT policy, and no write grant to anon or authenticated', () => {
    for (const t of NEW_TABLES) {
      expect(codeLower, t).toContain(`alter table ${t} enable row level security`);
      expect(codeLower, t).toMatch(new RegExp(`create policy "viewer read ${t}" on ${t} for select using \\(is_benchmark_data_viewer\\(\\)\\)`));
      expect(codeLower, t).toContain(`revoke insert, update, delete, truncate on ${t} from anon, authenticated`);
    }
  });
  it('no new table holds a user, household, account, folio, unit or amount column', () => {
    for (const t of NEW_TABLES) {
      const start = code.indexOf(`create table if not exists ${t} (`);
      const body = code.slice(start, code.indexOf('\n);', start)).toLowerCase();
      expect(body, t).not.toMatch(/\b(user_id|household|account|folio|units?\b|amount|holder|email|name_of_user)\w*/);
    }
    // the actor of an admin decision is recorded, but that is an ADMIN user id, never an investor
    expect(codeLower).toContain('actor_user_id uuid');
  });
  it('the held-instruments function returns instrument identity only (four columns), to the service role only', () => {
    const m = /create or replace function factsheet_reader_held_instruments\(\)\s+returns table \(([^)]*)\)/i.exec(code);
    expect(m).not.toBeNull();
    expect((m as RegExpExecArray)[1].split(',').map((c) => c.trim().split(' ')[0])).toEqual(['instrument_id', 'instrument_name', 'amc_name', 'amfi_scheme_code']);
    expect(codeLower).toMatch(/revoke all on function factsheet_reader_held_instruments\(\) from public, anon, authenticated/);
    expect(codeLower).toMatch(/grant execute on function factsheet_reader_held_instruments\(\) to service_role/);
  });
  it('every job writer is service-role only: checked inside the function, EXECUTE revoked from public/anon/authenticated, granted to service_role', () => {
    for (const fn of ['record_factsheet_attempt(jsonb)', 'record_factsheet_version(jsonb, uuid)', 'record_factsheet_version_event(jsonb)', 'touch_factsheet_source(uuid, jsonb)', 'factsheet_reader_held_instruments()']) {
      expect(codeLower, fn).toContain(`revoke all on function ${fn} from public, anon, authenticated`);
      expect(codeLower, fn).toContain(`grant execute on function ${fn} to service_role`);
    }
    expect((codeLower.match(/coalesce\(auth\.role\(\), ''\) <> 'service_role'/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
  it('the admin functions use the EXISTING capabilities (no new column, no new capability) and authenticate inside the database', () => {
    expect(codeLower).not.toMatch(/alter table admin_users/);
    expect(codeLower).toMatch(/v_uid is null or not public\.is_benchmark_catalogue_admin\(\)/);
    expect(codeLower).toMatch(/v_uid is null or not public\.is_benchmark_entitlement_approver\(\)/);
    expect(codeLower).toMatch(/grant execute on function review_factsheet_change\(uuid, text, text, boolean\) to authenticated/);
    expect(codeLower).toMatch(/grant execute on function set_factsheet_source_terms_status\(uuid, text, text\) to authenticated/);
    expect(codeLower).toMatch(/revoke all on function review_factsheet_change\(uuid, text, text, boolean\) from public, anon/);
  });
  it('approve goes through the EXISTING review path, and a review needs a note', () => {
    expect(codeLower).toContain("public.review_benchmark_mapping(v_proposal, 'approve', p_note, coalesce(p_close_previous, false))");
    expect(codeLower).toMatch(/length\(trim\(p_note\)\) < 10/);
    expect(codeLower).toMatch(/this item has already been decided/);
  });
  it('every SECURITY DEFINER function pins its search_path', () => {
    const defs = [...code.matchAll(/create or replace function (\w+)\([^)]*\)[\s\S]*?\bas \$\$/gi)];
    expect(defs.length).toBeGreaterThanOrEqual(9);
    for (const d of defs) {
      if (/security definer/i.test(d[0])) expect(d[0], d[1]).toMatch(/set search_path = public/i);
    }
  });
  it('the end-user read function needs a signed-in caller, caps its input, and returns public fund facts only', () => {
    expect(codeLower).toMatch(/if auth\.uid\(\) is null then raise exception 'declared benchmark records: sign-in required'/);
    expect(codeLower).toMatch(/cardinality\(p_instrument_ids\) > 500/);
    const m = /create or replace function declared_benchmark_records_for\(p_instrument_ids uuid\[\]\)\s+returns table \(([^)]*)\)/i.exec(code);
    expect((m as RegExpExecArray)[1].split(',').map((c) => c.trim().split(' ')[0])).toEqual(['instrument_id', 'declared_name', 'benchmark_kind', 'catalogue_state']);
    expect(codeLower).toMatch(/grant execute on function declared_benchmark_records_for\(uuid\[\]\) to authenticated/);
  });
});

describe('the kill switch and the terms gate ship OFF', () => {
  it('the job-control row is created DISABLED with a reason, and no pg_cron schedule is created', () => {
    expect(codeLower).toMatch(/select 'factsheet_benchmark_reader', false,/);
    expect(codeLower).not.toMatch(/cron\.schedule|pg_cron/);
  });
  it('terms_review_status defaults to not_reviewed and "approved" needs a reviewer, a time and a note', () => {
    expect(codeLower).toMatch(/terms_review_status text not null default 'not_reviewed'/);
    expect(codeLower).toMatch(/terms_review_status <> 'approved' or \(terms_reviewed_by is not null and terms_reviewed_at is not null and length\(coalesce\(terms_review_note, ''\)\) >= 10\)/);
    expect(checkList('ii_factsheet_sources', 'terms_review_status')).toEqual([...TERMS_REVIEW_STATUSES]);
  });
});

describe('the SQL cannot drift from the code', () => {
  it('the seeded sources are exactly the TypeScript seed (key, fund house, type, URL, AMFI codes, scheme name, scope, priority) and every one is not_reviewed', () => {
    const rows = [...code.matchAll(/\('([a-z0-9_]+)', '([a-z]+)', '([^']+)', '(amc_[a-z]+|other)',\s*'(https:[^']+)', '([^']+)', array\[([^\]]*)\], '([^']+)', '(single_scheme|multi_scheme)', (\d+), '(not_reviewed)'/g)];
    expect(rows).toHaveLength(FACTSHEET_SOURCE_SEED.length);
    for (const seed of FACTSHEET_SOURCE_SEED) {
      const r = rows.find((x) => x[1] === seed.sourceKey);
      expect(r, seed.sourceKey).toBeDefined();
      const row = r as RegExpExecArray;
      expect(row.slice(2, 11)).toEqual([seed.amcKey, seed.amcName, seed.documentType, seed.url, new URL(seed.url).hostname, `'${seed.amfiSchemeCodes.join("','")}'`, seed.documentSchemeName, seed.documentScope, String(seed.priority)]);
    }
    expect(rows.every((r) => r[11] === 'not_reviewed')).toBe(true); // no source is seeded as approved
  });
  it('the attempt outcome list, the version enums and the catalogue states match the TypeScript types', () => {
    const outcomes = checkList('ii_factsheet_attempts', 'outcome');
    expect(new Set(outcomes)).toEqual(new Set(['refused_terms_not_approved', ...TERMINAL_OUTCOMES, 'fetch_failed', 'error']));
    expect(checkList('ii_scheme_declared_benchmark_versions', 'catalogue_state').sort()).toEqual(['matched_other', 'matched_verified', 'no_catalogue_match', 'unsupported_commodity', 'unsupported_composite']);
    expect(checkList('ii_scheme_declared_benchmark_versions', 'review_state').sort()).toEqual(['awaiting_confirmation', 'consistent_with_mapping', 'pending_review', 'recorded_only']);
    expect(checkList('ii_scheme_declared_benchmark_versions', 'extraction_method').sort()).toEqual(['ai', 'manual', 'text_pattern', 'text_pattern_and_ai']);
    expect(checkList('ii_factsheet_version_events', 'event_type').sort()).toEqual(['acknowledged', 'approved', 'auto_publish_refused', 'auto_published', 'manual_entry', 'proposal_created', 'rejected']);
    expect(checkList('ii_scheme_declared_benchmark_versions', 'benchmark_kind').sort()).toEqual(['commodity_price', 'composite', 'single_index']);
  });
  it('the "declared but not comparable" states in declared_benchmark_records_for() are exactly the code\'s list', () => {
    const m = /where x\.catalogue_state in \(([^)]*)\)/i.exec(code);
    expect(m).not.toBeNull();
    const sqlStates = [...(m as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(sqlStates).toEqual([...NOT_COMPARABLE_CATALOGUE_STATES, ...AWAITING_REVIEW_CATALOGUE_STATES].sort());
  });
  it('the seed contains no performance, return or index-level column: facts only', () => {
    expect(codeLower).not.toMatch(/\b(return_pct|returns_1y|cagr|xirr|performance_|index_level|nav_value|aum)\b/);
  });
});
