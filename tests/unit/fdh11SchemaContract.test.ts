/**
 * FDH-11 — repeatable schema-verification test, mirroring
 * `tests/unit/fdh10SchemaContract.test.ts`'s method exactly: parse migration
 * 0106 from disk and assert structural facts rather than trust prose.
 *
 * Owns the "matches the FULL current vocabulary" claim for
 * `fdh_document_audit_events.event_type` as of this pass — the same chain
 * `fdh7SchemaContract.test.ts` -> `fdh9SchemaContract.test.ts` ->
 * `fdh10SchemaContract.test.ts` established, one more link.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES, FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED } from '@/lib/financial-data-hub/constants/enums';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FILE = '0106_fdh11_au_investment_statement_intelligence.sql';
const RAW = fs.readFileSync(path.join(MIGRATION_DIR, FILE), 'utf8');
const SQL = RAW.split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

describe('FDH-11 migration 0106 exists', () => {
  it('the file exists', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
  });
});

describe('FDH-11 fdh_document_audit_events.event_type widened constraint matches the TypeScript vocabulary as of FDH-11', () => {
  // FDH-12 (migration 0112) is now the constraint's latest word, so 0106 is no
  // longer expected to carry the FULL current vocabulary — exactly the shape
  // FDH-7/FDH-9/FDH-10's own contract tests already take, each comparing its
  // migration to the vocabulary AS OF that phase. `0112` is asserted against
  // the full set by `tests/unit/fdh12SchemaContract.test.ts`.
  it("0106 matches everything known up to and including FDH-11", () => {
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 3800);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const vocabularyAsOfFdh11 = FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES.filter(
      (t) => !(FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED as readonly string[]).includes(t),
    );
    expect(values.sort()).toEqual([...vocabularyAsOfFdh11].sort());
  });

  it('the nine FDH-11 event types are all present', () => {
    for (const t of [
      'investment_statement_extraction_completed',
      'investment_statement_extraction_failed',
      'investment_statement_account_matched',
      'investment_statement_security_matched',
      'investment_statement_reconciled',
      'investment_statement_bank_match_completed',
      'investment_statement_approved',
      'investment_statement_applied',
      'investment_statement_apply_rejected_stale',
    ]) {
      expect(FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES as readonly string[]).toContain(t);
    }
  });
});

describe('FDH-11 migration 0106 is additive-only', () => {
  it('drops no column and no table', () => {
    expect(/drop\s+column/i.test(RAW)).toBe(false);
    expect(/drop\s+table/i.test(RAW)).toBe(false);
  });

  it('creates the three FDH-11 evidence tables', () => {
    for (const t of ['fdh_investment_statements', 'fdh_investment_statement_positions', 'fdh_investment_statement_activities']) {
      expect(SQL).toContain(`create table ${t}`);
    }
  });

  it('every new table enables RLS', () => {
    for (const t of ['fdh_investment_statements', 'fdh_investment_statement_positions', 'fdh_investment_statement_activities']) {
      expect(SQL).toContain(`alter table ${t} enable row level security`);
    }
  });
});
