/**
 * FDH-12 — boundary enforcement, read from the REAL source tree.
 *
 * These are the mechanical guarantees behind FDH-12's four hard rules:
 *
 *   1. FDH-12 is not a second Retirement engine (spec sections 2, 62-63).
 *   2. FDH-12 never writes canonical Retirement except through
 *      `fdh12_apply_retirement_proposal()` (spec sections 56, 103).
 *   3. FDH-12 respects the SMSF boundary (spec sections 10-11, 72-73).
 *   4. FDH-12 respects the Investment Intelligence boundary (spec sections
 *      12-13, 40, 71).
 *
 * If a future change quietly adds a projection, writes a register, creates an
 * SMSF row or restates a retirement holding as an ordinary investment, one of
 * these fails.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HUB_RETIREMENT = path.join(REPO_ROOT, 'lib', 'financial-data-hub', 'retirement');
const MIGRATION_PATH = path.join(
  REPO_ROOT, 'supabase', 'migrations', '0111_fdh12_retirement_statement_intelligence.sql',
);
const MIGRATION = fs.readFileSync(MIGRATION_PATH, 'utf8');
/**
 * Migration SQL with EVERY `--` comment removed — whole-line and trailing —
 * so prose can never satisfy a test. A trailing-comment-only strip would let
 * `-- update it` be read as an `update` statement, which is exactly the false
 * positive this stricter form avoids.
 */
const MIGRATION_SQL = MIGRATION.replace(/--.*$/gm, '');

/**
 * Migration SQL with single-quoted STRING LITERALS blanked as well as
 * comments, for the tests that look for SQL *statements*.
 *
 * Without this, the user-facing message `'... Update it in the SMSF section
 * ...'` is read by a naive `/update\s+(\w+)/` as an `update` of a table
 * called `it`. Blanking literals keeps those tests measuring code rather than
 * copy. Tests that deliberately assert on message text use `MIGRATION_SQL`.
 */
const MIGRATION_STATEMENTS = MIGRATION_SQL.replace(/'(?:[^']|'')*'/g, "''");

/** One `create or replace function` body, bounded by its own `$$ language`
 * terminator rather than by a comment marker. */
function functionBody(name: string): string {
  const start = MIGRATION_STATEMENTS.indexOf(`create or replace function ${name}`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const end = MIGRATION_STATEMENTS.indexOf('$$ language plpgsql', start);
  if (end === -1) throw new Error(`unterminated function ${name}`);
  return MIGRATION_STATEMENTS.slice(start, end);
}

/**
 * The body of one `create table` statement, taken from the RAW migration by
 * bracket matching rather than by slicing between `-- PART x` markers: the
 * markers are comments, so they do not survive `MIGRATION_SQL`, and slicing on
 * a missing marker silently returns most of the file (a test that then passes
 * or fails for entirely the wrong reason).
 */
function createTableBody(table: string): string {
  const start = MIGRATION_SQL.indexOf(`create table ${table} (`);
  if (start === -1) throw new Error(`create table ${table} not found`);
  const end = MIGRATION_SQL.indexOf(`${'\n'});`, start);
  if (end === -1) throw new Error(`unterminated create table ${table}`);
  return MIGRATION_SQL.slice(start, end);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Source with comments removed. */
function strip(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => { const i = l.indexOf('//'); return i === -1 ? l : l.slice(0, i); })
    .join('\n');
}

const FDH12_FILES: string[] = [
  ...walk(HUB_RETIREMENT),
  path.join(REPO_ROOT, 'lib', 'financial-data-hub', 'services', 'retirementStatementProcessingService.ts'),
  ...walk(path.join(REPO_ROOT, 'lib', 'retirement-import-bridge')),
  path.join(REPO_ROOT, 'lib', 'import-bridge', 'adapters', 'retirementAdapter.ts'),
  path.join(REPO_ROOT, 'lib', 'import-bridge', 'applyRetirementProposalAtomic.ts'),
  ...walk(path.join(REPO_ROOT, 'app', 'api', 'financial-data-hub', 'retirement-statement')),
  path.join(REPO_ROOT, 'components', 'retirement', 'RetirementStatementImportPanel.tsx'),
];
const FDH12_CODE = FDH12_FILES.map((f) => strip(fs.readFileSync(f, 'utf8')));

/** The Hub's own pure evidence layer, which is held to the strictest rules. */
const HUB_FILES = walk(HUB_RETIREMENT);
const HUB_CODE = HUB_FILES.map((f) => strip(fs.readFileSync(f, 'utf8')));

describe('FDH-12 module shape', () => {
  it('the module is non-empty and every file is TypeScript', () => {
    expect(FDH12_FILES.length).toBeGreaterThan(15);
    for (const f of FDH12_FILES) expect(/\.tsx?$/.test(f), f).toBe(true);
  });
});

// ===========================================================================
// RULE 1 — no second Retirement engine (spec sections 2, 62-63)
// ===========================================================================

describe('FDH-12 rule 1 — no second Retirement engine', () => {
  it('imports no FHIP calculation engine', () => {
    FDH12_CODE.forEach((code, i) => {
      expect(/from '@\/lib\/engines/.test(code), `${FDH12_FILES[i]} imports a calculation engine`).toBe(false);
    });
  });

  it('builds no retirement projection, readiness or adequacy calculation', () => {
    const FORBIDDEN = [
      'retirementCalculator', 'projectRetirement', 'readinessScore',
      'requiredCorpus', 'withdrawalRate', 'decumulation', 'forecast_results',
      'forecast_profiles', 'forecast_assumptions',
    ];
    FDH12_CODE.forEach((code, i) => {
      for (const token of FORBIDDEN) {
        expect(code.includes(token), `${FDH12_FILES[i]} reimplements retirement forecasting (${token})`).toBe(false);
      }
    });
  });

  it('creates no retirement projection or assumption table', () => {
    expect(/create table[\s\S]{0,80}(forecast|projection|assumption)/i.test(MIGRATION_SQL)).toBe(false);
  });

  it('creates exactly the three FDH-12 evidence tables and no others', () => {
    const created = [...MIGRATION_SQL.matchAll(/create table (?:if not exists )?(\w+)/g)].map((m) => m[1]);
    expect(created.sort()).toEqual([
      'fdh_retirement_statement_activities',
      'fdh_retirement_statement_positions',
      'fdh_retirement_statements',
    ]);
  });

  it('drops no table and no column — the migration is additive only', () => {
    expect(/drop table/i.test(MIGRATION_SQL)).toBe(false);
    expect(/drop column/i.test(MIGRATION_SQL)).toBe(false);
  });
});

// ===========================================================================
// RULE 2 — canonical Retirement is written only by the apply RPC
// ===========================================================================

describe('FDH-12 rule 2 — canonical Retirement writes', () => {
  it('the HUB never names a protected Input Data register (FDH-1 contract)', () => {
    // `retirement_accounts` is one of FHIP_PROTECTED_INPUT_TABLES. Nothing
    // under lib/financial-data-hub/ may name it — which is precisely WHY
    // lib/retirement-import-bridge/ exists.
    const PROTECTED = [
      'income_sources', 'expense_items', 'assets', 'liabilities',
      'investments', 'retirement_accounts', 'insurance_policies',
    ];
    HUB_CODE.forEach((code, i) => {
      for (const t of PROTECTED) {
        expect(new RegExp(`['"\`]${t}['"\`]`).test(code),
          `${HUB_FILES[i]} names the protected register ${t}`).toBe(false);
      }
    });
  });

  it('NO FDH-12 file writes retirement_accounts or retirement_members directly', () => {
    // The bridge READS them; nothing writes them. The only canonical write in
    // the whole module is the RPC call.
    const WRITE = /\.from\(\s*['"`](retirement_accounts|retirement_members)['"`]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/;
    FDH12_CODE.forEach((code, i) => {
      expect(WRITE.test(code), `${FDH12_FILES[i]} writes canonical Retirement directly`).toBe(false);
    });
  });

  it('the only canonical mutation path is fdh12_apply_retirement_proposal', () => {
    const rpcCallers = FDH12_FILES.filter((_, i) =>
      /\.rpc\(\s*['"`]fdh12_apply_retirement_proposal['"`]/.test(FDH12_CODE[i]));
    expect(rpcCallers).toHaveLength(1);
    expect(path.basename(rpcCallers[0])).toBe('applyRetirementProposalAtomic.ts');
  });

  it('never uses the generic registry write path', () => {
    FDH12_CODE.forEach((code, i) => {
      expect(/makeRegistry/.test(code), FDH12_FILES[i]).toBe(false);
    });
  });

  it('the apply RPC writes exactly one canonical table', () => {
    const rpc = functionBody('fdh12_apply_retirement_proposal');
    expect(rpc.length).toBeGreaterThan(1000);
    // The only canonical target is retirement_accounts.
    const writes = [...rpc.matchAll(/(?:insert into|update)\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
    const canonicalWrites = writes.filter((t) => !t.startsWith('fdh_') && !t.startsWith('fhip_'));
    expect([...new Set(canonicalWrites)]).toEqual(['retirement_accounts']);
  });

  it('the apply allow-list cannot reach target_retirement_age (spec 61, 113)', () => {
    const match = MIGRATION_SQL.match(/v_allowed constant text\[\] := array\[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    const allowed = [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(allowed).not.toContain('target_retirement_age');
    expect(allowed).not.toContain('master_item_key');
    expect(allowed).not.toContain('is_active');
    expect(allowed).not.toContain('user_id');
    expect(allowed).toEqual([
      'account_name', 'account_type', 'current_balance', 'currency_code',
      'country_code', 'owner', 'employer_contribution', 'personal_contribution',
      'contribution_frequency',
    ]);
  });

  it('the TypeScript allow-list matches the SQL allow-list exactly', async () => {
    const { RETIREMENT_APPLICABLE_FIELDS } = await import('@/lib/import-bridge/adapters/retirementAdapter');
    const match = MIGRATION_SQL.match(/v_allowed constant text\[\] := array\[([\s\S]*?)\];/);
    const allowed = [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...RETIREMENT_APPLICABLE_FIELDS].sort()).toEqual(allowed.sort());
  });

  it('never writes retirement_members at all — target age is untouchable', () => {
    expect(/(insert into|update)\s+retirement_members/i.test(MIGRATION_SQL)).toBe(false);
  });
});

// ===========================================================================
// RULE 3 — the SMSF boundary
// ===========================================================================

describe('FDH-12 rule 3 — SMSF boundary', () => {
  it('creates no SMSF table and writes no SMSF row', () => {
    expect(/create table[\s\S]{0,60}smsf/i.test(MIGRATION_SQL)).toBe(false);
    expect(/insert into\s+smsf_/i.test(MIGRATION_SQL)).toBe(false);
    expect(/update\s+smsf_/i.test(MIGRATION_SQL)).toBe(false);
  });

  it('calls no SMSF RPC', () => {
    FDH12_CODE.forEach((code, i) => {
      expect(/smsf_create_fund|smsf_switch_to_detailed|smsf_switch_to_summary|smsf_recompute_fund/.test(code),
        `${FDH12_FILES[i]} calls an SMSF RPC`).toBe(false);
    });
  });

  it('no FDH-12 file writes an SMSF table', () => {
    const WRITE = /\.from\(\s*['"`]smsf_\w+['"`]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/;
    FDH12_CODE.forEach((code, i) => {
      expect(WRITE.test(code), `${FDH12_FILES[i]} writes an SMSF table`).toBe(false);
    });
  });

  it('the apply RPC refuses an SMSF target outright', () => {
    expect(MIGRATION_SQL).toMatch(/SMSF_ACCOUNT_NOT_IMPORTABLE/);
    expect(MIGRATION_SQL).toMatch(/master_item_key = 'smsf'/);
    expect(MIGRATION_SQL).toMatch(/exists \(select 1 from smsf_funds sf where sf\.retirement_account_id = v_account\.id\)/);
  });

  it('ADD NEW cannot create an SMSF row, because master_item_key is never set', () => {
    // SMSF is identified SOLELY by master_item_key = 'smsf'. The insert's
    // column list is built from v_allowed (which excludes it) plus a fixed
    // prefix (which does not include it), so a NULL key is structural.
    const insertPrefix = MIGRATION_SQL.match(/v_cols := array_cat\(array\[([^\]]*)\]/);
    expect(insertPrefix).not.toBeNull();
    expect(insertPrefix![1]).not.toContain('master_item_key');
  });

  it('approval refuses anything not classified not_smsf', () => {
    expect(MIGRATION_SQL).toMatch(/ROUTED_TO_SMSF/);
    expect(MIGRATION_SQL).toMatch(/SMSF_REVIEW_REQUIRED/);
  });
});

// ===========================================================================
// RULE 4 — the Investment Intelligence boundary
// ===========================================================================

describe('FDH-12 rule 4 — Investment Intelligence boundary', () => {
  it('references no ii_ table anywhere in the migration', () => {
    expect(/\bii_\w+/.test(MIGRATION_SQL)).toBe(false);
  });

  it('references no Investment Intelligence table or service in code', () => {
    FDH12_CODE.forEach((code, i) => {
      expect(/\bii_(instruments|accounts|transactions|holding_snapshots|instrument_identifiers)\b/.test(code),
        `${FDH12_FILES[i]} references an Investment Intelligence table`).toBe(false);
      expect(/from '@\/lib\/services\/investment-intelligence/.test(code),
        `${FDH12_FILES[i]} imports Investment Intelligence`).toBe(false);
    });
  });

  it('the positions table has no apply path and no canonical destination', () => {
    const block = createTableBody('fdh_retirement_statement_positions');
    expect(block.length).toBeGreaterThan(200);
    // Sanity: the block really is the positions table and nothing else.
    expect(block).toContain('option_name_raw');
    expect(block).not.toContain('create table fdh_retirement_statements ');
    for (const forbidden of ['apply_status', 'canonical_', 'applied_at', 'applied_by', 'matched_instrument_id']) {
      expect(block.includes(forbidden), `positions table carries ${forbidden}`).toBe(false);
    }
  });

  it('no function accepts a position row for application', () => {
    const applyRpc = functionBody('fdh12_apply_retirement_proposal');
    expect(applyRpc.length).toBeGreaterThan(1000);
    expect(/fdh_retirement_statement_positions/.test(applyRpc)).toBe(false);
    // Nor does the approval RPC.
    const approveRpc = functionBody('fdh12_approve_retirement_statement');
    expect(approveRpc.length).toBeGreaterThan(500);
    expect(/fdh_retirement_statement_positions/.test(approveRpc)).toBe(false);
  });
});

// ===========================================================================
// Cross-cutting: no economic classification, no statutory rates
// ===========================================================================

describe('FDH-12 cross-cutting boundaries', () => {
  it('assigns no economic transaction type — FDH-6 owns classification', () => {
    FDH12_CODE.forEach((code, i) => {
      expect(/economic_transaction_type/.test(code), `${FDH12_FILES[i]} classifies economically`).toBe(false);
    });
  });

  it('embeds no statutory tax or contribution rate (spec sections 44-45)', () => {
    FDH12_CODE.forEach((code, i) => {
      expect(/superRate|sgRate|contributionsTaxRate|CONTRIBUTIONS_TAX_RATE/.test(code),
        `${FDH12_FILES[i]} embeds a statutory rate`).toBe(false);
    });
  });

  it('persists no full TFN, PAN or unmasked member number (spec sections 87-89)', () => {
    for (const forbidden of ['tfn', 'tax_file_number', 'pan_number', 'beneficiary', 'date_of_birth']) {
      expect(new RegExp(`\\b${forbidden}\\b`, 'i').test(MIGRATION_SQL),
        `the schema persists ${forbidden}`).toBe(false);
    }
  });

  it('the masked-identifier CHECK mechanically blocks a long digit run', () => {
    expect(MIGRATION_SQL).toMatch(
      /chk_fdh_retirement_statements_masked_identifier[\s\S]*?masked_account_identifier !~ '\[0-9\]\{7,\}'/,
    );
  });

  it('every FDH-12 table has RLS enabled with owner-scoped policies', () => {
    for (const table of [
      'fdh_retirement_statements',
      'fdh_retirement_statement_activities',
      'fdh_retirement_statement_positions',
    ]) {
      expect(MIGRATION_SQL).toContain(`alter table ${table} enable row level security`);
      expect(MIGRATION_SQL).toContain(`create policy "read own ${table}" on ${table}`);
      expect(MIGRATION_SQL).toContain(`create policy "insert own ${table}" on ${table}`);
      expect(MIGRATION_SQL).toContain(`create policy "update own ${table}" on ${table}`);
      // No DELETE policy, deliberately — evidence is purged through the FDH-3
      // lifecycle, not deleted ad hoc by the client (the 0106 shape).
      expect(MIGRATION_SQL).not.toContain(`create policy "delete own ${table}"`);
    }
  });

  it('uses paginated reads everywhere it reads a potentially large set', () => {
    // spec sections 138-139: PostgREST truncates at 1000 rows silently.
    const readers = FDH12_FILES.filter((f) =>
      /retirementAccountResolution|retirementStatementProcessingService/.test(f)
      || /retirement-statement.*route\.ts$/.test(f.replace(/\\/g, '/')));
    expect(readers.length).toBeGreaterThan(2);
    for (const f of readers) {
      const code = strip(fs.readFileSync(f, 'utf8'));
      // Any file that reads a collection must import the pagination helper.
      if (/\.select\(/.test(code) && /\.eq\('user_id'/.test(code)) {
        const usesPagination = /fetchAllRows/.test(code);
        const onlySingleRowReads = !/\.order\(/.test(code);
        expect(usesPagination || onlySingleRowReads,
          `${f} reads a collection without fetchAllRows`).toBe(true);
      }
    }
  });
});
