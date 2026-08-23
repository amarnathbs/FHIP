/**
 * R7 — repeatable schema-verification test, mirroring
 * tests/unit/fdh2SchemaContract.test.ts / fdh3SchemaContract.test.ts's
 * method: parse migration 0064 from disk and assert structural facts rather
 * than trust prose.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FDH_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED,
  FDH_CSV_AMOUNT_CONVENTIONS,
  FDH_CSV_CERTIFICATION_STATUSES,
  FDH_CSV_DETECTION_STATUSES,
  FDH_CSV_MAPPING_TEMPLATE_STATUSES,
  FDH_TRANSACTION_CORRECTION_FIELDS,
  FDH_TRANSACTION_DEDUP_STATUSES,
  FDH_TRANSACTION_TYPE_HINTS,
} from '@/lib/financial-data-hub/constants/enums';
import { R7_USER_OWNED_TABLES_ADDED } from '@/lib/financial-data-hub/constants/tables';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FILE = '0064_r7_bank_csv_engine_foundation.sql';
const RAW = fs.readFileSync(path.join(MIGRATION_DIR, FILE), 'utf8');
const SQL = RAW.split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

function tableBody(table: string): string {
  const start = SQL.indexOf(`create table ${table} (`);
  expect(start, `create table ${table} not found`).toBeGreaterThan(-1);
  const end = SQL.indexOf('\n);', start);
  expect(end, `unterminated create table ${table}`).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

function checkValues(body: string, column: string): string[] {
  const columnIndex = body.indexOf(`\n  ${column} `);
  expect(columnIndex, `column ${column} not found`).toBeGreaterThan(-1);
  const slice = body.slice(columnIndex);
  const match = slice.match(/in \(([^)]*)\)/);
  expect(match, `no check(... in (...)) on ${column}`).not.toBeNull();
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('R7 migration 0064 exists and creates exactly the declared new tables', () => {
  it('the file exists', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
  });

  it('creates fdh_csv_mapping_templates and fdh_transaction_corrections, and no other new table', () => {
    const created = [...SQL.matchAll(/create table (?:if not exists )?([a-z_]+)/g)].map((m) => m[1]);
    expect(created.sort()).toEqual([...R7_USER_OWNED_TABLES_ADDED].sort());
  });

  it('is additive only — no drop table, no drop column, no delete from, no destructive update to existing rows', () => {
    expect(/drop table/i.test(SQL)).toBe(false);
    expect(/drop column/i.test(SQL)).toBe(false);
    expect(/delete from/i.test(SQL)).toBe(false);
    // The one sanctioned pattern: widening a check constraint (drop
    // constraint + add constraint), identical precedent to 0051/0052.
    const drops = [...SQL.matchAll(/drop (\w+)/gi)].map((m) => m[1].toLowerCase());
    for (const d of drops) expect(['constraint', 'index']).toContain(d);
  });
});

describe('R7 new-column check constraints match their TypeScript vocabularies', () => {
  it('fdh_statement_uploads.detection_status (added via ALTER)', () => {
    const idx = SQL.indexOf('add column detection_status text');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 400);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_CSV_DETECTION_STATUSES].sort());
  });

  it('fdh_statement_uploads.certification_status (added via ALTER)', () => {
    const idx = SQL.indexOf('add column certification_status text');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 400);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_CSV_CERTIFICATION_STATUSES].sort());
  });

  it('fdh_transactions.dedup_status (added via ALTER)', () => {
    const idx = SQL.indexOf('add column dedup_status text');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 400);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_TRANSACTION_DEDUP_STATUSES].sort());
  });

  it('fdh_transactions.transaction_type_hint (added via ALTER)', () => {
    const idx = SQL.indexOf('add column transaction_type_hint text');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 500);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_TRANSACTION_TYPE_HINTS].sort());
  });

  it('fdh_csv_mapping_templates.amount_convention', () => {
    expect(checkValues(tableBody('fdh_csv_mapping_templates'), 'amount_convention').sort()).toEqual(
      [...FDH_CSV_AMOUNT_CONVENTIONS].sort(),
    );
  });

  it('fdh_csv_mapping_templates.status', () => {
    expect(checkValues(tableBody('fdh_csv_mapping_templates'), 'status').sort()).toEqual(
      [...FDH_CSV_MAPPING_TEMPLATE_STATUSES].sort(),
    );
  });

  it('fdh_transaction_corrections.field_name', () => {
    expect(checkValues(tableBody('fdh_transaction_corrections'), 'field_name').sort()).toEqual(
      [...FDH_TRANSACTION_CORRECTION_FIELDS].sort(),
    );
  });

  it('fdh_document_audit_events.event_type widened constraint matches the FULL combined (FDH-3 + R7) TypeScript vocabulary', () => {
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 1200);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // Scoped to migration 0064's OWN frozen SQL text — FDH-3 + R7 only.
    // R8 (migration 0067) widens this same constraint again with its own
    // 4 additional event types; that widening is verified separately by
    // tests/unit/r8SchemaContract.test.ts against migration 0067's SQL,
    // never against this frozen 0064-scoped assertion.
    expect(values.sort()).toEqual([...FDH_DOCUMENT_AUDIT_EVENT_TYPES, ...FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED].sort());
  });
});

describe('R7 RLS is enabled with an owner-scoped policy on both new tables', () => {
  it('fdh_csv_mapping_templates: RLS enabled, owner-scoped for-all policy', () => {
    expect(/alter table fdh_csv_mapping_templates enable row level security/.test(SQL)).toBe(true);
    expect(
      /create policy "own rows - fdh_csv_mapping_templates" on fdh_csv_mapping_templates\s+for all using \(auth\.uid\(\) = user_id\) with check \(auth\.uid\(\) = user_id\)/.test(
        SQL,
      ),
    ).toBe(true);
  });

  it('fdh_transaction_corrections: RLS enabled, owner-scoped for-all policy', () => {
    expect(/alter table fdh_transaction_corrections enable row level security/.test(SQL)).toBe(true);
    expect(
      /create policy "own rows - fdh_transaction_corrections" on fdh_transaction_corrections\s+for all using \(auth\.uid\(\) = user_id\) with check \(auth\.uid\(\) = user_id\)/.test(
        SQL,
      ),
    ).toBe(true);
  });
});

describe('R7 canonical-ownership boundary: no parallel ii_* bank ledger table is created (spec section 3)', () => {
  it('no created table name starts with ii_', () => {
    const created = [...SQL.matchAll(/create table (?:if not exists )?([a-z_]+)/g)].map((m) => m[1]);
    for (const t of created) expect(t.startsWith('ii_')).toBe(false);
  });
  it('no forbidden investment-ledger table-name fragment appears in any created table name', () => {
    const created = [...SQL.matchAll(/create table (?:if not exists )?([a-z_]+)/g)].map((m) => m[1]);
    const forbidden = ['holding', 'security_master', 'securities', 'valuation', 'portfolio', 'nav', 'folio', 'instrument'];
    for (const t of created) {
      for (const f of forbidden) expect(t.includes(f)).toBe(false);
    }
  });
});
