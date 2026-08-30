/**
 * FDH-12 — schema contract: migration 0111 read from disk and asserted
 * against the TypeScript vocabulary it must mirror.
 *
 * The discipline every prior phase established: a DB CHECK constraint and its
 * TypeScript twin drift silently unless something compares them mechanically.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED,
} from '@/lib/financial-data-hub/constants/enums';
import {
  RETIREMENT_ACTIVITY_TYPES,
  RETIREMENT_STATEMENT_TYPES,
  RETIREMENT_ACCOUNT_TYPES,
  RETIREMENT_EXTRACTION_STATUSES,
  RETIREMENT_RECONCILIATION_STATUSES,
  RETIREMENT_ACCOUNT_MATCH_STATUSES,
  RETIREMENT_SMSF_CLASSIFICATIONS,
} from '@/lib/financial-data-hub/retirement/types';

const MIGRATION_DIR = path.resolve(__dirname, '..', '..', 'supabase', 'migrations');
const FILE = '0111_fdh12_retirement_statement_intelligence.sql';
const RAW = fs.readFileSync(path.join(MIGRATION_DIR, FILE), 'utf8');
const SQL = RAW.replace(/--.*$/gm, '');

/**
 * Pull the value list out of a `check (<column> in (...))` clause.
 *
 * The clause frequently sits on the line AFTER the column declaration
 * (`extraction_status text not null default 'pending'\n  check (...)`), so the
 * match must span newlines. Anchoring on `check (<column> in (` alone is
 * enough to be unambiguous — the column name appears inside the clause itself.
 */
function checkValues(column: string): string[] {
  const re = new RegExp(`check \\(${column} in \\(([\\s\\S]*?)\\)\\)`);
  const m = SQL.match(re);
  if (!m) throw new Error(`no CHECK found for ${column}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('FDH-12 migration numbering governance (spec section 164)', () => {
  it('is numbered 0111 — above every number claimed by any branch or worktree', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
    // 0107-0110 are claimed by unmerged sibling branches; 0107 is itself a
    // pre-existing double-claim. The header records the full scan.
    expect(RAW).toMatch(/MIGRATION NUMBER GOVERNANCE/);
    expect(RAW).toMatch(/0110\s+module11_ai_foundation/);
  });

  it('is the only 0111 in the chain', () => {
    const collisions = fs.readdirSync(MIGRATION_DIR).filter((f) => f.startsWith('0111'));
    expect(collisions).toEqual([FILE]);
  });

  it('every migration version in the chain is unique', () => {
    const versions = fs.readdirSync(MIGRATION_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, 4));
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('FDH-12 audit-event vocabulary parity', () => {
  it('0111 is the constraint\'s latest word and matches the FULL TypeScript vocabulary', () => {
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 5000);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES].sort());
  });

  it('all eleven FDH-12 event types are present in the constraint', () => {
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    const slice = SQL.slice(idx, idx + 5000);
    expect(FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED).toHaveLength(11);
    for (const t of FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED) {
      expect(slice).toContain(`'${t}'`);
      expect(FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES as readonly string[]).toContain(t);
    }
  });

  it('the widening retains every historical value (additive only)', () => {
    // A regression here would mean an older phase's events became invalid.
    for (const t of ['document_upload_created', 'bank_csv_uploaded', 'payslip_extraction_completed',
      'liability_proposal_applied', 'investment_statement_applied']) {
      expect(SQL).toContain(`'${t}'`);
    }
  });
});

describe('FDH-12 CHECK constraints mirror the TypeScript vocabulary', () => {
  const cases: [string, readonly string[]][] = [
    ['activity_type', RETIREMENT_ACTIVITY_TYPES],
    ['statement_type', RETIREMENT_STATEMENT_TYPES],
    ['account_type', RETIREMENT_ACCOUNT_TYPES],
    ['extraction_status', RETIREMENT_EXTRACTION_STATUSES],
    ['reconciliation_status', RETIREMENT_RECONCILIATION_STATUSES],
    ['account_match_status', RETIREMENT_ACCOUNT_MATCH_STATUSES],
    ['smsf_classification', RETIREMENT_SMSF_CLASSIFICATIONS],
  ];
  for (const [column, ts] of cases) {
    it(`${column} matches exactly`, () => {
      expect(checkValues(column).sort()).toEqual([...ts].sort());
    });
  }
});

describe('FDH-12 schema shape', () => {
  it('creates the three evidence tables', () => {
    for (const t of [
      'fdh_retirement_statements',
      'fdh_retirement_statement_activities',
      'fdh_retirement_statement_positions',
    ]) {
      expect(SQL).toContain(`create table ${t} (`);
      expect(SQL).toContain(`alter table ${t} enable row level security`);
    }
  });

  it('every money column is numeric(20,4) — exact decimal, never float', () => {
    // spec section 142. A `double precision`/`real`/`float` column anywhere
    // would make the $0.01 control meaningless.
    expect(/double precision|\breal\b|\bfloat\b/i.test(SQL)).toBe(false);
    for (const col of ['opening_balance', 'closing_balance', 'employer_contributions', 'amount']) {
      expect(SQL).toMatch(new RegExp(`${col} numeric\\(20,4\\)`));
    }
  });

  it('creates the three ownership-guard triggers (spec sections 97-102)', () => {
    for (const trg of [
      'trg_fdh_retirement_statements_owner',
      'trg_fdh_retirement_activities_owner',
      'trg_fdh_retirement_positions_owner',
    ]) {
      expect(SQL).toContain(`create trigger ${trg}`);
    }
  });

  it('creates the three authoritative-write triggers (spec section 96)', () => {
    for (const trg of [
      'trg_fdh_retirement_statements_authoritative_write',
      'trg_fdh_retirement_activities_authoritative_write',
      'trg_fdh_retirement_positions_authoritative_write',
    ]) {
      expect(SQL).toContain(`create trigger ${trg}`);
    }
  });

  it('every guard function is SECURITY DEFINER with a pinned search_path', () => {
    const fns = [...SQL.matchAll(/create or replace function (fdh12_\w+)\(/g)].map((m) => m[1]);
    expect(fns.length).toBeGreaterThanOrEqual(6);
    for (const fn of fns) {
      const body = SQL.slice(SQL.indexOf(`create or replace function ${fn}(`));
      const end = body.indexOf('$$ language plpgsql');
      const decl = body.slice(end, end + 120);
      expect(decl, fn).toContain('security definer');
      expect(decl, fn).toContain('set search_path = public');
    }
  });

  it('creates the three deduplication / one-to-one unique indexes', () => {
    for (const idx of [
      'uq_fdh_retirement_activities_fingerprint',
      'uq_fdh_retirement_activities_payroll_event',
      'uq_fdh_retirement_activities_bank_txn',
    ]) {
      expect(SQL).toContain(`create unique index ${idx}`);
    }
  });

  it('extends the generic bridge additively', () => {
    expect(SQL).toMatch(/alter table fhip_import_proposals\s*\n\s*add column if not exists source_retirement_statement_id uuid/);
    expect(SQL).toMatch(/alter table fhip_import_applications\s*\n\s*add column if not exists source_retirement_statement_id uuid/);
    expect(SQL).toMatch(/alter table retirement_accounts\s*\n\s*add column if not exists last_import_application_id uuid/);
    expect(SQL).toMatch(/alter table retirement_accounts\s*\n\s*add column if not exists last_imported_at timestamptz/);
  });

  it('widens retirement_accounts.source_type without losing existing values', () => {
    const m = SQL.match(/add constraint retirement_accounts_source_type_check\s*\n?\s*check \(source_type in \(([\s\S]*?)\)\)/);
    expect(m).not.toBeNull();
    const values = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(values).toEqual(['investment_intelligence_published', 'manual', 'retirement_statement_import']);
  });

  it('the two RPCs exist with the expected signatures', () => {
    expect(SQL).toMatch(/create or replace function fdh12_approve_retirement_statement\(p_statement_id uuid\)/);
    expect(SQL).toMatch(/create or replace function fdh12_apply_retirement_proposal\(\s*p_proposal_id uuid,\s*p_decision text,\s*p_selected_fields text\[\] default null\s*\)/);
  });

  it('documents the boundaries durably as table comments', () => {
    expect(RAW).toMatch(/comment on table fdh_retirement_statements is/);
    expect(RAW).toMatch(/comment on table fdh_retirement_statement_activities is/);
    expect(RAW).toMatch(/comment on table fdh_retirement_statement_positions is/);
    expect(RAW).toMatch(/comment on function fdh12_apply_retirement_proposal/);
  });
});
