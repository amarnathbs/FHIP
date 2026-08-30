// MCC-14 fix (migration 0111) — DELETE-cascade certification, real Postgres
// via PGlite (same established harness pattern as mcc_pglite_certification.mjs
// / scripts/db-rebuild-check/shim.sql). Proves, item-by-item, the 11 required
// proofs from the Product Owner's MCC-14 fix spec:
//
//  1. Confirmed-user account deletion succeeds.
//  2. Unconfirmed-user account deletion succeeds.
//  3. Missing-country account deletion succeeds.
//  4. Direct DELETE by an unconfirmed user remains blocked.
//  5. Direct DELETE by a confirmed owner remains allowed where RLS permits.
//  6. Cross-tenant DELETE remains blocked.
//  7. All ~85 protected tables cascade without obstruction during a real
//     account deletion (a real row is seeded in every one of the 85 tables
//     for one confirmed test user, via a fully dynamic, information_schema-
//     driven fixture builder -- not a hand-picked "representative sample").
//  8. No orphaned rows remain after a real account deletion.
//  9. Existing INSERT/UPDATE controls remain unchanged (delegates to the
//     existing 58-check mcc_pglite_certification.mjs, re-run against the
//     SAME migration tree that now includes 0111).
// 10. A failed account deletion remains atomic.
// 11. Repeated/already-deleted-account deletion is handled safely.
//
// Proof scope note: this is real Postgres (PGlite), not a mock -- the same
// evidentiary bar this project has used throughout (including for MCC-14's
// own original discovery, per the closure report section U). It does NOT
// include the actual Supabase Admin deletion API against real DEV, because
// migration 0111 has deliberately NOT been applied to DEV (per this
// project's standing policy: migrations are handed to the Product Owner for
// manual application, never applied by this session) -- exercising the fix
// live against DEV before it exists there would either be impossible or
// would require this session to apply it itself, which it will not do. See
// the closure report addendum for this disclosed gap.

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.stack); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.cwd(), 'supabase');
const MIG = path.join(ROOT, 'migrations');
const HERE = path.resolve(process.cwd(), 'scripts');

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));

const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
let replayed = 0;
for (const f of files) {
  const sql = fs
    .readFileSync(path.join(MIG, f), 'utf8')
    .replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
  try {
    await db.exec(sql);
    replayed++;
  } catch (e) {
    console.error(`\nREPLAY FAILED at ${f}\n${e.message}\n`);
    process.exit(3);
  }
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
if (!files.some((f) => f.includes('0111_mandatory_country_confirmation_delete_cascade_fix'))) {
  console.error('FATAL: migration 0111 not found in supabase/migrations -- this certification would be testing the OLD trigger.');
  process.exit(4);
}
console.log(`REPLAY COMPLETE: ${replayed}/${files.length} migrations applied cleanly (0001 -> ${files[files.length - 1]})\n`);

var pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};
async function expectReject(label, fn) {
  try { await fn(); check(label, false, '(expected rejection, but it succeeded)'); }
  catch (e) { check(label, true, `(rejected: ${e.message.slice(0, 140)})`); }
}
async function expectOk(label, fn) {
  try { const r = await fn(); check(label, true); return r; }
  catch (e) { check(label, false, `(unexpected error: ${e.message.slice(0, 200)})`); return undefined; }
}
async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asService(fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await db.exec(`set role service_role;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
// Faithful reproduction of how MCC-14's own root cause was established
// (closure report section U): Supabase Auth's real Admin-API deletion
// connects directly to Postgres with NO request.jwt.claims / role context
// at all -- not service_role, not authenticated. Reset both to their
// unset/default state before issuing the raw DELETE.
async function asAccountDeletionCascade(fn) {
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec(`reset role;`);
  try { return await fn(); } finally { /* already default */ }
}

const uuid = () => crypto.randomUUID();

console.log('=== Loading live schema metadata (information_schema/pg_constraint) ===');
const TARGET_TABLES = [
  'assets','expense_items','fdh_approved_financial_summaries','fdh_classification_history',
  'fdh_csv_mapping_templates','fdh_data_provenance','fdh_data_quality_results','fdh_duplicate_candidates',
  'fdh_evidence_links','fdh_financial_accounts','fdh_ingestion_jobs','fdh_liability_statement_activities',
  'fdh_liability_statements','fdh_payroll_components','fdh_payroll_events','fdh_reconciliation_results',
  'fdh_recurring_transactions','fdh_review_items','fdh_statement_uploads','fdh_transaction_allocations',
  'fdh_transaction_corrections','fdh_transaction_links','fdh_transactions','fdh_upload_sessions',
  'fdh_user_classification_rules','fhip_import_applications','fhip_import_proposal_fields','fhip_import_proposals',
  'financial_dna_actions','financial_dna_drivers','financial_dna_profile_scores','financial_dna_profiles',
  'financial_health_component_scores','financial_health_recommendations','financial_health_scores',
  'financial_snapshots','financial_twin_runs','forecast_assumptions','forecast_explanations','forecast_profiles',
  'forecast_results','forecast_runs','forecast_scenarios','future_financial_commitments','goal_contributions',
  'goal_forecasts','goal_funding_sources','goal_milestones','goal_snapshots','health_check_ins',
  'household_members','households','ii_accounts','ii_document_parse_runs','ii_fhip_publications',
  'ii_goal_allocations','ii_insights','ii_portfolio_truth_status','ii_reconciliation_cases','ii_review_items',
  'ii_source_documents','ii_tax_profiles','ii_transaction_source_links','income_sources','insurance_policies',
  'investments','liabilities','professional_profiles','property_liability_links','resilience_actions',
  'resilience_component_scores','resilience_risks','resilience_scores','retirement_accounts','retirement_members',
  'smsf_fund_members','smsf_funds','smsf_holdings','user_financial_section_status','user_goals',
  'user_recommendation_matches','user_recommendation_runs',
  // bespoke owner-column + bespoke join tables (still part of the 85 total)
  'professional_notes','financial_twin_insights','financial_twin_metric_results',
];
check('Target table list has exactly 85 entries (82 generic + 1 bespoke owner-col + 2 bespoke join)', TARGET_TABLES.length === 85, `(${TARGET_TABLES.length})`);

const OWNER_COLUMN = { professional_notes: 'author_user_id' }; // default for everything else: user_id
const BESPOKE_JOIN = {
  financial_twin_insights: { fkColumn: 'financial_twin_run_id', parentTable: 'financial_twin_runs' },
  financial_twin_metric_results: { fkColumn: 'financial_twin_run_id', parentTable: 'financial_twin_runs' },
};

const { rows: colRows } = await db.query(`
  select table_name, column_name, data_type, is_nullable, column_default, character_maximum_length
  from information_schema.columns
  where table_schema='public' and table_name = any($1)
  order by table_name, ordinal_position
`, [TARGET_TABLES]);
const columnsByTable = {};
for (const c of colRows) (columnsByTable[c.table_name] ??= []).push(c);

const { rows: fkRows } = await db.query(`
  select tc.table_name, kcu.column_name, ccu.table_name as foreign_table, ccu.column_name as foreign_column
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on tc.constraint_name=kcu.constraint_name and tc.table_schema=kcu.table_schema
  join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
  join information_schema.constraint_column_usage ccu on ccu.constraint_name = rc.unique_constraint_name and ccu.table_schema = rc.unique_constraint_schema
  where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public' and tc.table_name = any($1)
`, [TARGET_TABLES]);
const fkByTableCol = {};
for (const f of fkRows) fkByTableCol[`${f.table_name}.${f.column_name}`] = { foreignTable: f.foreign_table, foreignColumn: f.foreign_column };

const { rows: checkRows } = await db.query(`
  select rel.relname as table_name, pg_get_constraintdef(con.oid) as def
  from pg_constraint con join pg_class rel on rel.oid = con.conrelid
  join pg_namespace ns on ns.oid = rel.relnamespace
  where ns.nspname='public' and con.contype='c' and rel.relname = any($1)
`, [TARGET_TABLES]);
// Extract simple single-column `col = ANY (ARRAY['a','b',...])` enum-style
// checks so the generic filler can pick a value that actually satisfies them.
const enumByTableCol = {};
for (const c of checkRows) {
  const m = c.def.match(/\(([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*ANY\s*\(ARRAY\[(.*?)\]\)\)/);
  if (!m) continue;
  const [, col, arrBody] = m;
  const vals = [...arrBody.matchAll(/'([^']*)'/g)].map((x) => x[1]);
  if (vals.length) enumByTableCol[`${c.table_name}.${col}`] = vals;
}

const { rows: pkRows } = await db.query(`
  select tc.table_name, kcu.column_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema='public' and tc.table_name = any($1)
  order by tc.table_name
`, [TARGET_TABLES]);
const pkByTable = {};
for (const r of pkRows) (pkByTable[r.table_name] ??= []).push(r.column_name);

console.log(`  loaded ${colRows.length} columns, ${fkRows.length} FKs, ${Object.keys(enumByTableCol).length} enum-style checks, ${Object.keys(pkByTable).length} tables' PKs\n`);

// External reference-table cache (tables OUTSIDE the 85-set) -- pick any
// existing pre-seeded row's key rather than fabricating new reference data.
const externalCache = new Map();
async function externalValue(foreignTable, foreignColumn) {
  const key = `${foreignTable}.${foreignColumn}`;
  if (externalCache.has(key)) return externalCache.get(key);
  const { rows } = await db.query(`select ${foreignColumn} as v from ${foreignTable} limit 1`);
  if (!rows.length) return undefined;
  externalCache.set(key, rows[0].v);
  return rows[0].v;
}

function genericValueForType(col) {
  switch (col.data_type) {
    case 'uuid': return uuid();
    case 'text':
    case 'character varying':
      return 'mcc14-test';
    case 'character': {
      const n = col.character_maximum_length || 3;
      return 'X'.repeat(Math.min(n, 3)).padEnd(Math.min(n, 3), 'X');
    }
    case 'integer': case 'smallint': case 'bigint': return 1;
    case 'numeric': case 'real': case 'double precision': return 1;
    case 'boolean': return false;
    case 'date': return '2026-01-01';
    case 'timestamp with time zone': case 'timestamp without time zone': return new Date().toISOString();
    case 'jsonb': case 'json': return '{}';
    default: return 'mcc14-test';
  }
}

// insertedMap: table -> { pkCol: value } for the ONE row seeded per table
// for a given fixture user. Built fresh per fixture (see seedAllTables()).
async function buildRow(table, testUserId, insertedMap, extraFkOverrides = {}) {
  const cols = columnsByTable[table] || [];
  const ownerCol = OWNER_COLUMN[table] || (cols.some((c) => c.column_name === 'user_id') ? 'user_id' : null);
  const row = {};
  for (const col of cols) {
    const name = col.column_name;
    if (extraFkOverrides[name] !== undefined) { row[name] = extraFkOverrides[name]; continue; }
    if (name === ownerCol) { row[name] = testUserId; continue; }
    const hasDefault = col.column_default !== null;
    const nullable = col.is_nullable === 'YES';
    if (hasDefault) continue; // let default apply
    if (nullable) continue; // omit, becomes NULL
    // NOT NULL, no default -- must supply.
    const fk = fkByTableCol[`${table}.${name}`];
    if (fk) {
      if (fk.foreignTable === 'users') { row[name] = testUserId; continue; } // auth.users FK (schema stripped by our probe query)
      if (insertedMap[fk.foreignTable]) { row[name] = insertedMap[fk.foreignTable]; continue; }
      const ext = await externalValue(fk.foreignTable, fk.foreignColumn);
      if (ext !== undefined) { row[name] = ext; continue; }
      return { __missingFk: { column: name, foreignTable: fk.foreignTable } };
    }
    const enumVals = enumByTableCol[`${table}.${name}`];
    if (enumVals && enumVals.length) { row[name] = enumVals[0]; continue; }
    row[name] = genericValueForType(col);
  }
  return row;
}

async function insertRow(table, row) {
  const cols = Object.keys(row);
  const pkCols = pkByTable[table] || ['id'];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
  const sql = `insert into ${table} (${cols.join(',')}) values (${placeholders}) returning ${pkCols.join(',')}`;
  const { rows } = await db.query(sql, cols.map((c) => row[c]));
  return rows[0];
}

// A handful of the 85 tables have shape/multi-column CHECK constraints (or,
// for smsf_funds, a bespoke validation TRIGGER) the generic column-by-column
// filler cannot satisfy on its own. Declared once, applied as extra
// overrides layered on top of buildRow()'s own result. `aux` holds one-time
// auxiliary values computed just before the seeding pass begins (never
// recreated per retry pass).
const TABLE_OVERRIDES = {
  fdh_csv_mapping_templates: () => ({ column_mapping: JSON.stringify({ transaction_date: 'Date', amount: 'Amount' }) }),
  fdh_user_classification_rules: () => ({
    match_definition: JSON.stringify({ match_kind: 'merchant_exact' }),
    action_definition: JSON.stringify({ action_kind: 'set_category' }),
  }),
  fdh_duplicate_candidates: (insertedMap, _u, aux) => (aux.fdhTransactionsSecondId
    ? { transaction_id_a: insertedMap['fdh_transactions'], transaction_id_b: aux.fdhTransactionsSecondId }
    : null),
  fdh_review_items: (insertedMap) => (insertedMap['fdh_statement_uploads']
    ? { statement_upload_id: insertedMap['fdh_statement_uploads'] }
    : null),
  fhip_import_proposals: () => ({ source_kind: 'bank_statement' }), // avoid the payslip-requires-payroll-event rule
  property_liability_links: (insertedMap) => (insertedMap['assets'] ? { linked_asset_id: insertedMap['assets'] } : null),
  smsf_funds: (_insertedMap, _u, aux) => (aux.smsfRetirementAccountId ? { retirement_account_id: aux.smsfRetirementAccountId } : null),
  // target_entity_id has no FK -- it's a polymorphic reference validated by
  // a bespoke trigger keyed on target_domain (FDH-9 currently implements
  // only the 'income' domain guard). Point it at a real income_sources row
  // for the same user, matching the only domain the trigger can validate.
  fhip_import_applications: (insertedMap) => (insertedMap['income_sources']
    ? { target_domain: 'income', target_entity_id: insertedMap['income_sources'] }
    : null),
};

// Seeds exactly one row, owned by testUserId, into every table in `only`
// (defaults to all 85 TARGET_TABLES), via service_role (bypasses RLS/the
// confirmation trigger entirely for setup -- consistent with the existing
// cert harness's asService() pattern for seeding pre-existing data).
// Multi-pass retry resolves in-set dependency ordering (e.g.
// property_liability_links needing assets already inserted; smsf_fund_members
// needing smsf_funds) without a hand-built topological sort. Continues an
// existing insertedMap in place rather than starting over, so calling this
// twice (once for everything, once for stragglers after an auxiliary
// support table appears) never double-inserts an already-succeeded table.
async function seedAllTables(testUserId, { insertedMap = {}, only = TARGET_TABLES, aux = {} } = {}) {
  const remaining = new Set(only.filter((t) => !insertedMap[t]));
  const lastError = {};
  let pass = 0;
  await asService(async () => {
    while (remaining.size && pass < 8) {
      pass++;
      for (const table of [...remaining]) {
        try {
          let overrides = {};
          const bespoke = BESPOKE_JOIN[table];
          if (bespoke) {
            if (!insertedMap[bespoke.parentTable]) continue; // wait for parent
            overrides[bespoke.fkColumn] = insertedMap[bespoke.parentTable];
          }
          if (TABLE_OVERRIDES[table]) {
            const extra = TABLE_OVERRIDES[table](insertedMap, testUserId, aux);
            if (extra === null) continue; // dependency not ready yet, retry next pass
            Object.assign(overrides, extra);
          }
          const row = await buildRow(table, testUserId, insertedMap, overrides);
          if (row.__missingFk) { lastError[table] = `missing FK target for ${row.__missingFk.column} -> ${row.__missingFk.foreignTable}`; continue; }
          const inserted = await insertRow(table, row);
          const pkCols = pkByTable[table] || ['id'];
          insertedMap[table] = pkCols.length === 1 ? inserted[pkCols[0]] : pkCols.map((c) => inserted[c]);
          remaining.delete(table);
        } catch (e) {
          lastError[table] = e.message.split('\n')[0];
        }
      }
    }
  });
  return { insertedMap, remaining: [...remaining], lastError };
}

// One-time auxiliary rows some of the TABLE_OVERRIDES above depend on.
// Created once per fixture user, before any seeding pass runs, never
// recreated on retry.
async function buildAuxRows(testUserId) {
  const aux = {};
  await asService(async () => {
    const { rows: cur } = await db.query(`select currency_code from currencies limit 1`);
    const { rows: retAcc } = await db.query(
      `insert into retirement_accounts (id, user_id, master_item_key, account_name, account_type, current_balance, currency_code)
       values ($1,$2,'smsf','MCC14 test SMSF','smsf',0,$3) returning id`,
      [uuid(), testUserId, cur[0].currency_code]
    );
    aux.smsfRetirementAccountId = retAcc[0].id;
  });
  return aux;
}

// One-off auxiliary rows for the 3 external (non-backstopped) tables that
// some of the 85 tables have a mandatory (NOT NULL) FK into, and which
// start out completely empty in a fresh replay (ii_transactions,
// ii_holding_snapshots, professional_relationships). Created explicitly,
// once, after ii_accounts exists for the fixture user.
async function seedExternalSupportRows(testUserId, insertedMap) {
  const secondaryProfessionalId = uuid();
  // auth.users is GoTrue-managed -- even service_role only has SELECT on it
  // in real Supabase (matches shim.sql's grants), so this insert runs as
  // the harness's default (superuser-equivalent) connection, same as every
  // other auth.users fixture insert in this script.
  await db.query(`insert into auth.users(id,email) values ($1,$2)`, [secondaryProfessionalId, `mcc14-prof-${secondaryProfessionalId.slice(0, 8)}@t.test`]);
  await asService(async () => {
    const { rows: instr } = await db.query(`select id from ii_instruments limit 1`);
    const { rows: cur } = await db.query(`select currency_code from currencies limit 1`);
    const accountId = insertedMap['ii_accounts'];
    if (accountId && instr.length && cur.length) {
      const tx = await insertRow('ii_transactions', {
        id: uuid(), user_id: testUserId, account_id: accountId, instrument_id: instr[0].id,
        currency_code: cur[0].currency_code, transaction_type: 'purchase', transaction_date: '2026-01-01', gross_amount: 100,
      });
      insertedMap['ii_transactions'] = tx.id;
      const hs = await insertRow('ii_holding_snapshots', {
        id: uuid(), user_id: testUserId, account_id: accountId, instrument_id: instr[0].id,
        currency_code: cur[0].currency_code, as_of_date: '2026-01-01', units: 1, value: 100,
      });
      insertedMap['ii_holding_snapshots'] = hs.id;
    }
    const rel = await insertRow('professional_relationships', {
      id: uuid(), client_user_id: testUserId, professional_user_id: secondaryProfessionalId,
      invited_by: 'client',
    });
    insertedMap['professional_relationships'] = rel.id;
    insertedMap.__secondaryProfessionalId = secondaryProfessionalId;
    // professional_notes deliberately authored by the SECONDARY professional,
    // never by testUserId -- see the PROFESSIONAL_NOTES_FK_GAP finding
    // below. This still proves the table participates correctly in the
    // fixture (RLS/shape), without conflating it with testUserId's own
    // account-deletion proof.
    const note = await insertRow('professional_notes', {
      id: uuid(), relationship_id: rel.id, author_user_id: secondaryProfessionalId,
      subject_type: 'general', note_text: 'mcc14 test note',
    });
    insertedMap['professional_notes'] = note.id;
  });
}

async function orphanScan(testUserId) {
  const orphans = [];
  for (const table of TARGET_TABLES) {
    const ownerCol = OWNER_COLUMN[table] || (columnsByTable[table] || []).some((c) => c.column_name === 'user_id') ? (OWNER_COLUMN[table] || 'user_id') : null;
    if (ownerCol && (columnsByTable[table] || []).some((c) => c.column_name === ownerCol)) {
      const { rows } = await db.query(`select count(*)::int as n from ${table} where ${ownerCol} = $1`, [testUserId]);
      if (rows[0].n > 0) orphans.push({ table, via: ownerCol, n: rows[0].n });
    } else if (BESPOKE_JOIN[table]) {
      const { rows } = await db.query(
        `select count(*)::int as n from ${table} t join ${BESPOKE_JOIN[table].parentTable} p on p.id = t.${BESPOKE_JOIN[table].fkColumn} where p.user_id = $1`,
        [testUserId]
      );
      if (rows[0].n > 0) orphans.push({ table, via: 'join:' + BESPOKE_JOIN[table].parentTable, n: rows[0].n });
    }
  }
  return orphans;
}

// ===========================================================================
console.log('\n=== Fixture setup ===');
const U_CONFIRMED = uuid();     // full 85-table sweep, genuinely CONFIRMED
const U_UNCONFIRMED = uuid();   // small-scope, onboarding_completed=true, never confirmed
const U_MISSING = uuid();       // small-scope, country_of_residence null
const U_DIRECT_A = uuid();      // direct-DELETE positive/negative control pair
const U_DIRECT_B = uuid();      // cross-tenant target

for (const [id, email] of [
  [U_CONFIRMED, 'confirmed@t.test'], [U_UNCONFIRMED, 'unconfirmed@t.test'], [U_MISSING, 'missing@t.test'],
  [U_DIRECT_A, 'directa@t.test'], [U_DIRECT_B, 'directb@t.test'],
]) {
  await db.exec(`insert into auth.users(id,email) values ('${id}','${email}');`);
}
await db.query(
  `update user_profiles set onboarding_completed = true, country_of_residence = 'AU', country_confirmed_at = now(), country_source = 'USER_CONFIRMED' where user_id = any($1)`,
  [[U_CONFIRMED, U_UNCONFIRMED, U_DIRECT_A, U_DIRECT_B]]
);
// Roll U_UNCONFIRMED back to unconfirmed (country set, but never confirmed) --
// realistic "onboarded, hasn't confirmed yet" state, not "never touched country".
await db.query(`update user_profiles set country_confirmed_at = null, country_source = null where user_id = $1`, [U_UNCONFIRMED]);
// U_MISSING: onboarding complete, country never even selected.
await db.query(`update user_profiles set onboarding_completed = true, country_of_residence = null, country_confirmed_at = null where user_id = $1`, [U_MISSING]);
check('Fixture setup: 5 auth.users + profiles created (CONFIRMED/UNCONFIRMED/MISSING/direct-A/direct-B)', true);

// ===========================================================================
console.log('\n=== Proof 7 + setup for Proof 1/8/10/11: seed all 85 tables for U_CONFIRMED ===');
// professional_notes is handled OUTSIDE the owner-based sweep -- see the
// PROFESSIONAL_NOTES_FK_GAP finding below. Every other table is seeded with
// U_CONFIRMED as its actual owner.
const OWNER_SWEEP_TABLES = TARGET_TABLES.filter((t) => t !== 'professional_notes');
const aux = await buildAuxRows(U_CONFIRMED);
let { insertedMap, remaining, lastError } = await seedAllTables(U_CONFIRMED, { only: OWNER_SWEEP_TABLES, aux });
if (remaining.length) {
  console.log(`  pass 1 left ${remaining.length} table(s) pending (expected -- some depend on support rows created next): ${remaining.join(', ')}`);
  await seedExternalSupportRows(U_CONFIRMED, insertedMap); // creates ii_transactions/ii_holding_snapshots/professional_relationships/professional_notes
  // fdh_duplicate_candidates needs a SECOND, distinct fdh_transactions row --
  // created once, now that the first one (owned by U_CONFIRMED) exists.
  if (insertedMap['fdh_transactions'] && !aux.fdhTransactionsSecondId) {
    await asService(async () => {
      const row2 = await buildRow('fdh_transactions', U_CONFIRMED, insertedMap, {});
      if (!row2.__missingFk) aux.fdhTransactionsSecondId = (await insertRow('fdh_transactions', row2)).id;
    });
  }
  ({ insertedMap, remaining, lastError } = await seedAllTables(U_CONFIRMED, { insertedMap, only: remaining, aux }));
}
check(
  `Proof 7 setup: seeded a real row for U_CONFIRMED in every one of the 84 owner-swept backstopped tables (professional_notes handled separately, see below)`,
  remaining.length === 0,
  remaining.length ? `MISSING: ${remaining.join(', ')} | errors: ${JSON.stringify(Object.fromEntries(remaining.map((t) => [t, lastError[t]])))}` : `(${OWNER_SWEEP_TABLES.length}/${OWNER_SWEEP_TABLES.length} seeded)`
);
check('Proof 7 setup: professional_notes also has a real row in the fixture (authored by a secondary user, not U_CONFIRMED)', !!insertedMap['professional_notes']);
const preDeleteOrphanCheck = await orphanScan(U_CONFIRMED);
check('Sanity: all seeded rows are actually visible for U_CONFIRMED before deletion', preDeleteOrphanCheck.length === OWNER_SWEEP_TABLES.length - remaining.length, `(${preDeleteOrphanCheck.length}/${OWNER_SWEEP_TABLES.length} tables report a row)`);

// ===========================================================================
console.log('\n=== DISCLOSED, OUT-OF-SCOPE FINDING found by this certification\'s full sweep ===');
console.log('  professional_notes.author_user_id references auth.users(id) with NO "on delete cascade"');
console.log('  (migration 0083, line 327) -- a professional whose OWN account is deleted while they');
console.log('  still have authored professional_notes rows would hit a bare Postgres FK violation,');
console.log('  completely unrelated to country confirmation (professional_notes carries no DELETE');
console.log('  trigger of any kind -- confirmed earlier this session it fires BEFORE INSERT only, so');
console.log('  MCC-14\'s trigger never even runs during that DELETE). Not fixed here: out of this');
console.log('  migration\'s scope (a schema-level FK cascade-policy gap, not a country-confirmation');
console.log('  defect), and fixing it is a product decision (should a professional\'s notes about a');
console.log('  client be deleted, reassigned, or anonymized on account deletion?) this session is not');
console.log('  authorised to make unilaterally. Disclosed here, and in the final report, for separate');
console.log('  Product Owner attention -- this fixture deliberately worked around it (secondary-user');
console.log('  author) rather than silently dropping professional_notes from the 85-table proof.');

// ===========================================================================
console.log('\n=== Proof 1: confirmed-user account deletion succeeds (full 84-table cascade) ===');
await expectOk('Proof 1: DELETE FROM auth.users for U_CONFIRMED succeeds with no exception, no JWT/role context (real Admin-API approximation)', () =>
  asAccountDeletionCascade(() => db.query(`delete from auth.users where id = $1`, [U_CONFIRMED]))
);
{
  const { rows } = await db.query(`select count(*)::int as n from auth.users where id = $1`, [U_CONFIRMED]);
  check('Proof 1: auth.users row for U_CONFIRMED is actually gone', rows[0].n === 0);
}
{
  const { rows } = await db.query(`select count(*)::int as n from user_profiles where user_id = $1`, [U_CONFIRMED]);
  check('Proof 1: user_profiles row cascaded away too', rows[0].n === 0);
}

console.log('\n=== Proof 8: no orphaned rows remain anywhere across all 84 owner-swept tables ===');
const postDeleteOrphans = await orphanScan(U_CONFIRMED);
check('Proof 8: zero orphaned rows across all 84 owner-swept backstopped tables after U_CONFIRMED deletion', postDeleteOrphans.length === 0, JSON.stringify(postDeleteOrphans));
{
  const { rows } = await db.query(`select count(*)::int as n from professional_relationships where client_user_id = $1`, [U_CONFIRMED]);
  check('Proof 8: the external professional_relationships support row also cascaded away', rows[0].n === 0);
}
{
  // professional_notes.relationship_id DOES cascade (unlike author_user_id)
  // -- deleting U_CONFIRMED, the CLIENT side of the relationship, correctly
  // removes professional_relationships (client_user_id cascades), which in
  // turn correctly cascades professional_notes via relationship_id. This is
  // expected and correct -- it does NOT contradict the FK-gap finding below,
  // which is specifically about deleting the PROFESSIONAL (author_user_id)
  // side instead, proven as its own dedicated case immediately after.
  const { rows } = await db.query(`select count(*)::int as n from professional_notes where id = $1`, [insertedMap['professional_notes']]);
  check('Proof 8 context: professional_notes row cascaded away too, via relationship_id (client-side deletion)', rows[0].n === 0);
}

// ===========================================================================
console.log('\n=== Dedicated proof of the disclosed professional_notes FK-gap finding ===');
console.log('  (the OTHER direction from the check above: deleting the PROFESSIONAL, not the client)');
{
  const profAuthor = uuid();
  const client2 = uuid();
  await db.exec(`insert into auth.users(id,email) values ('${profAuthor}','mcc14-gap-prof@t.test'),('${client2}','mcc14-gap-client@t.test');`);
  await db.query(`update user_profiles set onboarding_completed=true, country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id = any($1)`, [[profAuthor, client2]]);
  const rel2 = await asService(() => insertRow('professional_relationships', { id: uuid(), client_user_id: client2, professional_user_id: profAuthor, invited_by: 'professional' }));
  const note2 = await asService(() => insertRow('professional_notes', { id: uuid(), relationship_id: rel2.id, author_user_id: profAuthor, subject_type: 'general', note_text: 'gap-proof note' }));
  try {
    await asAccountDeletionCascade(() => db.query(`delete from auth.users where id = $1`, [profAuthor]));
    check('FK-gap finding: deleting the PROFESSIONAL (author_user_id) while their authored note still exists fails', false, '(expected rejection, but it succeeded)');
  } catch (e) {
    const isForeignKeyViolation = /foreign key constraint/i.test(e.message) && /professional_notes/i.test(e.message);
    const mentionsOurTrigger = /COUNTRY_CONFIRMATION_REQUIRED/.test(e.message);
    check('FK-gap finding: deleting the PROFESSIONAL fails with a bare FK violation on professional_notes_author_user_id_fkey', isForeignKeyViolation, `(${e.message.slice(0, 160)})`);
    check('FK-gap finding: the failure is genuinely NOT enforce_country_confirmed() -- no COUNTRY_CONFIRMATION_REQUIRED text anywhere in the error', !mentionsOurTrigger);
  }
  // Clean up this dedicated fixture properly (remove the note first, exactly
  // the workaround a real fix would need to automate).
  await asService(() => db.query(`delete from professional_notes where id = $1`, [note2.id]));
  await expectOk('FK-gap finding: once the authored note is removed first, the professional\'s account deletion succeeds normally', () =>
    asAccountDeletionCascade(() => db.query(`delete from auth.users where id = $1`, [profAuthor]))
  );
  await asAccountDeletionCascade(() => db.query(`delete from auth.users where id = $1`, [client2])); // fixture cleanup
}

// ===========================================================================
console.log('\n=== Proof 2: unconfirmed-user account deletion succeeds ===');
await asService(async () => {
  const row = await buildRow('assets', U_UNCONFIRMED, {});
  await insertRow('assets', row);
  const goalRow = await buildRow('user_goals', U_UNCONFIRMED, {});
  await insertRow('user_goals', goalRow);
});
await expectOk('Proof 2: DELETE FROM auth.users for U_UNCONFIRMED succeeds despite country_confirmed_at being null', () =>
  asAccountDeletionCascade(() => db.query(`delete from auth.users where id = $1`, [U_UNCONFIRMED]))
);
{
  const { rows } = await db.query(`select count(*)::int as n from assets where user_id = $1`, [U_UNCONFIRMED]);
  check('Proof 2: U_UNCONFIRMED\'s assets row cascaded away, no orphan', rows[0].n === 0);
}

// ===========================================================================
console.log('\n=== Proof 3: missing-country account deletion succeeds ===');
await asService(async () => {
  const row = await buildRow('expense_items', U_MISSING, {});
  await insertRow('expense_items', row);
});
await expectOk('Proof 3: DELETE FROM auth.users for U_MISSING succeeds despite country_of_residence being null', () =>
  asAccountDeletionCascade(() => db.query(`delete from auth.users where id = $1`, [U_MISSING]))
);
{
  const { rows } = await db.query(`select count(*)::int as n from expense_items where user_id = $1`, [U_MISSING]);
  check('Proof 3: U_MISSING\'s expense_items row cascaded away, no orphan', rows[0].n === 0);
}

// ===========================================================================
console.log('\n=== Proof 4: direct DELETE by an unconfirmed user remains BLOCKED (the core requirement) ===');
// U_DIRECT_A starts CONFIRMED (per initial fixture setup); roll it back to
// unconfirmed for this specific check, while its auth.users row still
// genuinely exists -- the exact case the Product Owner's rule requires to
// stay gated.
await db.query(`update user_profiles set country_confirmed_at = null, country_source = null where user_id = $1`, [U_DIRECT_A]);
const directARow = await asService(async () => insertRow('assets', await buildRow('assets', U_DIRECT_A, {})));
await expectReject('Proof 4: unconfirmed U_DIRECT_A cannot directly DELETE their own pre-existing row while their account still exists', () =>
  asTenant(U_DIRECT_A, () => db.query(`delete from assets where id = $1`, [directARow.id]))
);
{
  const { rows } = await db.query(`select count(*)::int as n from assets where id = $1`, [directARow.id]);
  check('Proof 4: the row was NOT deleted -- still present after the blocked attempt', rows[0].n === 1);
}

// ===========================================================================
console.log('\n=== Proof 5: direct DELETE by a confirmed owner remains allowed where RLS permits ===');
await db.query(
  `update user_profiles set country_of_residence='AU', country_confirmed_at = now(), country_source='USER_CONFIRMED' where user_id = $1`,
  [U_DIRECT_A]
);
await expectOk('Proof 5: now-confirmed U_DIRECT_A can directly DELETE the same pre-existing row', () =>
  asTenant(U_DIRECT_A, () => db.query(`delete from assets where id = $1`, [directARow.id]))
);
{
  const { rows } = await db.query(`select count(*)::int as n from assets where id = $1`, [directARow.id]);
  check('Proof 5: the row is genuinely gone', rows[0].n === 0);
}

// ===========================================================================
console.log('\n=== Proof 6: cross-tenant DELETE remains blocked (RLS, unaffected by this fix) ===');
const directBRow = await asService(async () => insertRow('assets', await buildRow('assets', U_DIRECT_B, {})));
await asTenant(U_DIRECT_A, async () => {
  const { rowCount } = await db.query(`delete from assets where id = $1`, [directBRow.id]);
  check('Proof 6: a different (confirmed) tenant\'s direct DELETE on U_DIRECT_B\'s row affects 0 rows (RLS, not the trigger, blocks it)', rowCount === 0, `(rowCount=${rowCount})`);
});
{
  const { rows } = await db.query(`select count(*)::int as n from assets where id = $1`, [directBRow.id]);
  check('Proof 6: U_DIRECT_B\'s row is untouched', rows[0].n === 1);
}

// ===========================================================================
console.log('\n=== Proof 10: a FAILED account deletion remains atomic (nothing half-deleted) ===');
const U_ATOMIC = uuid();
await db.exec(`insert into auth.users(id,email) values ('${U_ATOMIC}','atomic@t.test');`);
await db.query(`update user_profiles set onboarding_completed=true, country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id=$1`, [U_ATOMIC]);
const atomicAsset = await asService(async () => insertRow('assets', await buildRow('assets', U_ATOMIC, {})));
const atomicGoal = await asService(async () => insertRow('user_goals', await buildRow('user_goals', U_ATOMIC, {})));
// Force an independent mid-cascade failure (NOT related to country
// confirmation) via a temporary trigger on one participating table, to
// prove the overall statement -- now that 0111's triggers also participate
// in every cascade -- still rolls back completely when ANYTHING fails.
await db.exec(`
  create or replace function _mcc14_test_force_failure() returns trigger language plpgsql as $$
  begin raise exception 'MCC14_TEST_INJECTED_FAILURE'; end;
  $$;
  create trigger _mcc14_test_force_failure_trg before delete on user_goals
    for each row execute function _mcc14_test_force_failure();
`);
await expectReject('Proof 10: the injected mid-cascade failure aborts the whole DELETE FROM auth.users statement', () =>
  asAccountDeletionCascade(() => db.query(`delete from auth.users where id = $1`, [U_ATOMIC]))
);
await db.exec(`drop trigger _mcc14_test_force_failure_trg on user_goals; drop function _mcc14_test_force_failure();`);
{
  const { rows: u } = await db.query(`select count(*)::int as n from auth.users where id = $1`, [U_ATOMIC]);
  const { rows: a } = await db.query(`select count(*)::int as n from assets where id = $1`, [atomicAsset.id]);
  const { rows: g } = await db.query(`select count(*)::int as n from user_goals where id = $1`, [atomicGoal.id]);
  check('Proof 10: auth.users row for U_ATOMIC still exists (rollback was complete)', u[0].n === 1);
  check('Proof 10: the assets row that WOULD have cascaded is still present (not half-deleted)', a[0].n === 1);
  check('Proof 10: the user_goals row that triggered the failure is still present too', g[0].n === 1);
}
// Clean up the atomicity fixture for real, without the injected failure.
await expectOk('Proof 10 cleanup: U_ATOMIC deletes cleanly once the injected failure is removed', () =>
  asAccountDeletionCascade(() => db.query(`delete from auth.users where id = $1`, [U_ATOMIC]))
);

// ===========================================================================
console.log('\n=== Proof 11: repeated / already-deleted-account deletion is handled safely ===');
await expectOk('Proof 11: re-issuing DELETE FROM auth.users for the ALREADY-deleted U_CONFIRMED affects 0 rows, no crash, no error', async () => {
  const { rowCount } = await asAccountDeletionCascade(() => db.query(`delete from auth.users where id = $1`, [U_CONFIRMED]));
  if (rowCount !== 0) throw new Error(`expected 0 rows affected, got ${rowCount}`);
});
{
  // A second, independent scenario: an account whose backstopped-table rows
  // were ALREADY removed by something else (e.g. a partial manual cleanup)
  // before the account-level delete runs -- must not crash on "nothing left
  // to cascade".
  const U_PARTIAL = uuid();
  await db.exec(`insert into auth.users(id,email) values ('${U_PARTIAL}','partial@t.test');`);
  await db.query(`update user_profiles set onboarding_completed=true, country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id=$1`, [U_PARTIAL]);
  const row = await asService(async () => insertRow('assets', await buildRow('assets', U_PARTIAL, {})));
  await asService(() => db.query(`delete from assets where id = $1`, [row.id])); // pre-remove, simulating partial cleanup
  await expectOk('Proof 11: account deletion still succeeds cleanly when a backstopped row was already independently removed beforehand', () =>
    asAccountDeletionCascade(() => db.query(`delete from auth.users where id = $1`, [U_PARTIAL]))
  );
}

// ===========================================================================
console.log(`\n${'='.repeat(78)}\nMCC-14 CERTIFICATION: ${pass} PASS, ${fail} FAIL\n${'='.repeat(78)}`);
if (fail) { console.log('FAILED CHECKS:', failures.join(' | ')); process.exit(1); }
process.exit(0);
