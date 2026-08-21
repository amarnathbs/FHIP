/**
 * FDH-1 — repeatable schema-verification test.
 *
 * This is the "schema verification script" the FDH-1 specification requires,
 * expressed as a test so it runs in CI on every change rather than relying on
 * somebody remembering to inspect SQL by hand.
 *
 * It reads the four FDH migration files from disk and asserts structural
 * facts: which tables exist, that RLS is enabled on every one, that every
 * user-owned table has an owner-only policy, that critical foreign keys and
 * check constraints are present, and that the TypeScript enums and the SQL
 * check constraints have not drifted apart.
 *
 * It deliberately does NOT talk to a database: the FDH tables do not exist in
 * DEV yet (migrations 0045-0048 are unapplied), and a test that silently
 * passes when it cannot connect is worse than no test. Live verification is
 * `scripts/fdh1_live_dev_verification.mjs`.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FDH_ACCOUNT_TYPES,
  FDH_DATA_QUALITY_CHECKS,
  FDH_DOCUMENT_TYPES,
  FDH_ECONOMIC_TRANSACTION_TYPES,
  FDH_ERROR_CODES,
  FDH_INSTITUTION_TYPES,
  FDH_JOB_TYPES,
  FDH_PROCESSING_STATUSES,
  FDH_PURGE_STATUSES,
  FDH_REVIEW_TYPES,
  FDH_SOURCE_TYPES,
  FDH_TRANSACTION_LINK_TYPES,
} from '@/lib/financial-data-hub/constants/enums';
import {
  FDH_MASTER_DATA_TABLES,
  FDH_TABLES,
  FDH_USER_OWNED_TABLES,
} from '@/lib/financial-data-hub/constants/tables';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FDH_MIGRATIONS = [
  '0045_fdh_reference_foundation.sql',
  '0046_fdh_accounts_documents_jobs.sql',
  '0047_fdh_transactions_and_classification.sql',
  '0048_fdh_review_quality_provenance.sql',
];

function readMigration(file: string): string {
  return fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8');
}

const ALL_SQL = FDH_MIGRATIONS.map(readMigration).join('\n');

/** Strip `--` line comments so prose about a rule cannot satisfy a test for it. */
const SQL = ALL_SQL.split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

function createdTables(sql: string): string[] {
  return [...sql.matchAll(/create table (?:if not exists )?([a-z_]+)/g)].map((m) => m[1]);
}

/** The body of one `create table` statement, up to its closing `);`. */
function tableBody(table: string): string {
  const start = SQL.indexOf(`create table ${table} (`);
  expect(start, `create table ${table} not found`).toBeGreaterThan(-1);
  const end = SQL.indexOf('\n);', start);
  expect(end, `unterminated create table ${table}`).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

/** Every `in (...)` list appearing inside one table body, flattened. */
function checkValues(table: string, column: string): string[] {
  const body = tableBody(table);
  const columnIndex = body.indexOf(`\n  ${column} `);
  expect(columnIndex, `column ${table}.${column} not found`).toBeGreaterThan(-1);
  const slice = body.slice(columnIndex);
  const match = slice.match(/in \(([^)]*)\)/);
  expect(match, `no check(... in (...)) on ${table}.${column}`).not.toBeNull();
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('FDH-1 migration files exist and are additive only', () => {
  it('all four FDH migrations are present', () => {
    for (const file of FDH_MIGRATIONS) {
      expect(fs.existsSync(path.join(MIGRATION_DIR, file)), file).toBe(true);
    }
  });

  it('the FDH migration numbers do not collide with any other stream', () => {
    // 0031-0044 are occupied by Investment Intelligence and Resources (see
    // docs/architecture/MIGRATION_REGISTRY.md section 3). FDH must start at
    // 0045 or later.
    for (const file of FDH_MIGRATIONS) {
      expect(Number(file.slice(0, 4))).toBeGreaterThanOrEqual(45);
    }
    const numbers = FDH_MIGRATIONS.map((f) => Number(f.slice(0, 4)));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('alters no pre-existing table and drops nothing', () => {
    // The only `alter table` permitted is `enable row level security` on a
    // table this migration set itself created.
    const alters = [...SQL.matchAll(/alter table ([a-z_]+)([^;]*);/g)];
    for (const [, table, rest] of alters) {
      expect(table.startsWith('fdh_'), `alter on non-FDH table: ${table}`).toBe(true);
      expect(rest.trim()).toBe('enable row level security');
    }
    expect(/\bdrop\s+(table|column|policy|constraint)\b/i.test(SQL)).toBe(false);
    // No mutation of existing data.
    expect(/\bupdate\s+(?!.*fdh_)/i.test(SQL.replace(/\n/g, ' '))).toBe(false);
    expect(/\bdelete\s+from\b/i.test(SQL)).toBe(false);
  });

  it('creates exactly the declared FDH table set and nothing else', () => {
    const created = createdTables(SQL).sort();
    expect(created).toEqual([...FDH_TABLES].sort());
  });

  it('touches none of the seven protected FHIP Input Data tables', () => {
    for (const table of [
      'income_sources',
      'expense_items',
      'assets',
      'liabilities',
      'investments',
      'retirement_accounts',
      'insurance_policies',
    ]) {
      // A bare `references households(id)` is fine; a write is not.
      expect(new RegExp(`(insert into|update|delete from|alter table)\\s+${table}\\b`, 'i').test(SQL))
        .toBe(false);
    }
  });
});

describe('FDH-1 row level security', () => {
  it('enables RLS on every FDH table without exception', () => {
    for (const table of FDH_TABLES) {
      expect(
        SQL.includes(`alter table ${table} enable row level security`),
        `RLS not enabled on ${table}`,
      ).toBe(true);
    }
  });

  it('gives every user-owned table the standard owner-only policy', () => {
    // fdh_classification_history is the one deliberate exception: it is
    // append-only, so it splits SELECT and INSERT and grants no UPDATE/DELETE.
    for (const table of FDH_USER_OWNED_TABLES) {
      if (table === 'fdh_classification_history') continue;
      const policy = new RegExp(
        `create policy "own rows - ${table}" on ${table}\\s+for all using \\(auth\\.uid\\(\\) = user_id\\) with check \\(auth\\.uid\\(\\) = user_id\\)`,
      );
      expect(policy.test(SQL), `owner-only policy missing or non-standard on ${table}`).toBe(true);
    }
  });

  it('makes classification history append-only: select + insert, no update, no delete', () => {
    expect(SQL).toContain(
      'create policy "own rows read - fdh_classification_history" on fdh_classification_history',
    );
    expect(SQL).toContain(
      'create policy "own rows append - fdh_classification_history" on fdh_classification_history',
    );
    const historyPolicies = [...SQL.matchAll(/create policy "[^"]*fdh_classification_history"[^;]*;/g)]
      .map((m) => m[0]);
    expect(historyPolicies).toHaveLength(2);
    expect(historyPolicies.some((p) => /for update/.test(p))).toBe(false);
    expect(historyPolicies.some((p) => /for delete/.test(p))).toBe(false);
  });

  it('carries user_id explicitly on every user-owned table (no join-based ownership)', () => {
    for (const table of FDH_USER_OWNED_TABLES) {
      expect(
        /user_id uuid not null references auth\.users\(id\) on delete cascade/.test(tableBody(table)),
        `${table} does not carry its own user_id`,
      ).toBe(true);
    }
  });

  it('gives master-data tables read-only RLS and no write policy at all', () => {
    for (const table of FDH_MASTER_DATA_TABLES) {
      expect(SQL).toContain(`create policy "read ${table}" on ${table}`);
      const policies = [...SQL.matchAll(new RegExp(`create policy "[^"]*" on ${table}[^;]*;`, 'g'))]
        .map((m) => m[0]);
      expect(policies, `${table} should have exactly one read policy`).toHaveLength(1);
      expect(/for select/.test(policies[0])).toBe(true);
    }
  });

  it('never grants a cross-user or admin bypass in any policy', () => {
    // No FDH policy may reference admin_users, a service role, or `true` on a
    // user-owned table.
    const userOwnedPolicies = FDH_USER_OWNED_TABLES.flatMap((t) =>
      [...SQL.matchAll(new RegExp(`create policy "[^"]*" on ${t}[^;]*;`, 'g'))].map((m) => m[0]),
    );
    for (const policy of userOwnedPolicies) {
      expect(/admin_users/.test(policy), `admin bypass in: ${policy}`).toBe(false);
      expect(/service_role/.test(policy), `service role in: ${policy}`).toBe(false);
      expect(/using \(true\)/.test(policy), `blanket read in: ${policy}`).toBe(false);
      expect(/auth\.uid\(\) = user_id/.test(policy), `not owner-scoped: ${policy}`).toBe(true);
    }
  });
});

describe('FDH-1 monetary and precision guarantees', () => {
  it('stores no money as a floating-point type anywhere', () => {
    expect(/\b(float|float4|float8|real|double precision|money)\b/i.test(SQL)).toBe(false);
  });

  it('uses numeric(20,4) for every persisted money column', () => {
    const moneyColumns = [
      ['fdh_transactions', 'amount_original'],
      ['fdh_transactions', 'amount_reporting_currency'],
      ['fdh_transaction_allocations', 'amount'],
      ['fdh_reconciliation_results', 'opening_balance'],
      ['fdh_reconciliation_results', 'variance'],
      ['fdh_reconciliation_results', 'variance_tolerance'],
      ['fdh_recurring_transactions', 'expected_amount'],
    ] as const;
    for (const [table, column] of moneyColumns) {
      expect(
        new RegExp(`${column} numeric\\(20,4\\)`).test(tableBody(table)),
        `${table}.${column} is not numeric(20,4)`,
      ).toBe(true);
    }
  });

  it('uses numeric(5,4) with a [0,1] check for every confidence column', () => {
    const confidenceColumns = [
      ['fdh_transactions', 'classification_confidence'],
      ['fdh_transactions', 'extraction_confidence'],
      ['fdh_transaction_links', 'confidence'],
      ['fdh_duplicate_candidates', 'confidence'],
      ['fdh_data_quality_results', 'score'],
      ['fdh_data_provenance', 'evidence_completeness'],
      ['fdh_evidence_links', 'evidence_weight'],
      ['fdh_recurring_transactions', 'confidence'],
    ] as const;
    for (const [table, column] of confidenceColumns) {
      const body = tableBody(table);
      expect(new RegExp(`${column} numeric\\(5,4\\)`).test(body), `${table}.${column}`).toBe(true);
      expect(
        new RegExp(`${column} >= 0 and ${column} <= 1`).test(body),
        `${table}.${column} lacks a [0,1] check`,
      ).toBe(true);
    }
  });

  it('uses DATE for business dates and timestamptz for events', () => {
    const txn = tableBody('fdh_transactions');
    expect(/transaction_date date not null/.test(txn)).toBe(true);
    expect(/posting_date date/.test(txn)).toBe(true);
    expect(/created_at timestamptz not null default now\(\)/.test(txn)).toBe(true);
  });
});

describe('FDH-1 SQL check constraints match the TypeScript vocabularies', () => {
  const cases: [string, string, readonly string[]][] = [
    ['fdh_financial_institutions', 'institution_type', FDH_INSTITUTION_TYPES],
    ['fdh_source_types', 'source_type_key', FDH_SOURCE_TYPES],
    ['fdh_financial_accounts', 'account_type', FDH_ACCOUNT_TYPES],
    ['fdh_statement_uploads', 'processing_status', FDH_PROCESSING_STATUSES],
    ['fdh_statement_uploads', 'document_type', FDH_DOCUMENT_TYPES],
    ['fdh_statement_uploads', 'error_code', FDH_ERROR_CODES],
    ['fdh_statement_uploads', 'raw_document_purge_status', FDH_PURGE_STATUSES],
    ['fdh_ingestion_jobs', 'job_type', FDH_JOB_TYPES],
    ['fdh_transactions', 'economic_transaction_type', FDH_ECONOMIC_TRANSACTION_TYPES],
    ['fdh_transaction_links', 'link_type', FDH_TRANSACTION_LINK_TYPES],
    ['fdh_review_items', 'review_type', FDH_REVIEW_TYPES],
    ['fdh_data_quality_results', 'check_code', FDH_DATA_QUALITY_CHECKS],
  ];

  for (const [table, column, expected] of cases) {
    it(`${table}.${column}`, () => {
      expect(checkValues(table, column).sort()).toEqual([...expected].sort());
    });
  }

  it('every enum value in the schema is lowercase snake_case', () => {
    const values = [...SQL.matchAll(/in \(([^)]*)\)/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((v) => v[1]));
    expect(values.length).toBeGreaterThan(50);
    for (const value of values) {
      // Country and currency codes are legitimately uppercase.
      if (/^[A-Z]{2,3}$/.test(value)) continue;
      expect(value, `non-snake_case enum value: ${value}`).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });
});

describe('FDH-1 critical constraints', () => {
  it('forbids a persisted full account number', () => {
    const body = tableBody('fdh_financial_accounts');
    expect(/full_account_number|account_number|\biban\b|\bifsc\b|\bbsb\b/.test(body)).toBe(false);
    expect(body).toContain("masked_identifier !~ '[0-9]{7,}'");
  });

  it('makes a transaction amount a strictly positive magnitude', () => {
    expect(tableBody('fdh_transactions')).toContain('amount_original > 0');
    expect(tableBody('fdh_transaction_allocations')).toContain('amount > 0');
  });

  it('keeps direction and economic meaning as two independent columns', () => {
    const body = tableBody('fdh_transactions');
    expect(/credit_debit text not null check \(credit_debit in \('credit', 'debit'\)\)/.test(body))
      .toBe(true);
    expect(/economic_transaction_type text not null/.test(body)).toBe(true);
    // No constraint may tie one to the other.
    expect(/credit_debit[^,]*economic_transaction_type/.test(body)).toBe(false);
    expect(/economic_transaction_type[^,]*credit_debit/.test(body)).toBe(false);
  });

  it('refuses to record a reconciliation as successful outside its tolerance', () => {
    expect(tableBody('fdh_reconciliation_results')).toContain(
      "status <> 'reconciled'\n           or (variance is not null and abs(variance) <= variance_tolerance)",
    );
  });

  it('forces the storage reference to be cleared when a document is purged', () => {
    expect(tableBody('fdh_statement_uploads')).toContain(
      "raw_document_purge_status <> 'purged' or raw_document_storage_reference is null",
    );
  });

  it('requires structured, non-executable rule definitions', () => {
    for (const table of ['fdh_classification_rules', 'fdh_user_classification_rules']) {
      const body = tableBody(table);
      expect(body).toContain("jsonb_typeof(match_definition) = 'object'");
      expect(body).toContain("match_definition ? 'match_kind'");
      expect(body).toContain("action_definition ? 'action_kind'");
    }
  });

  it('declares an explicit ON DELETE behaviour for every foreign key', () => {
    const fks = [...SQL.matchAll(/references [a-z_.]+\(([a-z_]+)\)([^,\n]*)/g)];
    expect(fks.length).toBeGreaterThan(40);
    for (const [whole, , tail] of fks) {
      // A primary-key self-reference in a unique index is not a column FK.
      expect(
        /on delete (cascade|set null|restrict)/.test(tail),
        `foreign key without explicit ON DELETE: ${whole.trim()}`,
      ).toBe(true);
    }
  });

  it('indexes the ownership column on every user-owned table', () => {
    for (const table of FDH_USER_OWNED_TABLES) {
      expect(
        new RegExp(`create (unique )?index [a-z_]+\\n?\\s*on ${table}\\(user_id`).test(SQL)
          || new RegExp(`on ${table}\\(user_id`).test(SQL),
        `${table} has no index on user_id`,
      ).toBe(true);
    }
  });
});

describe('FDH-1 privacy lifecycle is not blocked by the schema', () => {
  const purgeable: [string, string][] = [
    ['fdh_statement_uploads', 'raw_document_storage_reference'],
    ['fdh_statement_uploads', 'original_filename_sanitised'],
    ['fdh_transactions', 'description_raw'],
    ['fdh_transactions', 'merchant_raw'],
  ];

  for (const [table, column] of purgeable) {
    it(`${table}.${column} is nullable so it can be purged`, () => {
      const body = tableBody(table);
      const line = body.split('\n').find((l) => l.trim().startsWith(`${column} `));
      expect(line, `${table}.${column} not found`).toBeDefined();
      expect(line!.includes('not null'), `${table}.${column} is NOT NULL — purge impossible`)
        .toBe(false);
    });
  }
});
