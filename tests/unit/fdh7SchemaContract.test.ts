/**
 * FDH-7 — repeatable schema-verification test, mirroring
 * tests/unit/fdh5SchemaContract.test.ts's method: parse migration 0076 from
 * disk and assert structural facts rather than trust prose.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH9_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH10_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH11_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED,
  FDH_TRANSACTION_APPROVAL_STATUSES,
} from '@/lib/financial-data-hub/constants/enums';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FILE = '0076_fdh7_review_approval_workflow.sql';
const RAW = fs.readFileSync(path.join(MIGRATION_DIR, FILE), 'utf8');
const SQL = RAW.split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

describe('FDH-7 migration 0076 exists and is additive-only', () => {
  it('the file exists', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
  });

  it('is additive only — no drop table, no drop column, no delete from', () => {
    expect(/drop table/i.test(SQL)).toBe(false);
    expect(/drop column/i.test(SQL)).toBe(false);
    expect(/delete from/i.test(SQL)).toBe(false);
    // The one sanctioned pattern: widening a check constraint (drop
    // constraint + add constraint), identical precedent to 0064/0068/0071.
    const drops = [...SQL.matchAll(/drop (\w+)/gi)].map((m) => m[1].toLowerCase());
    for (const d of drops) expect(['constraint']).toContain(d);
  });

  it('creates exactly one new table — fdh_approved_financial_summaries', () => {
    const created = [...SQL.matchAll(/create table (?:if not exists )?([a-z_]+)/gi)].map((m) => m[1]);
    expect(created).toEqual(['fdh_approved_financial_summaries']);
  });

  it('the new table has RLS enabled with an owner-scoped policy', () => {
    expect(SQL).toContain('alter table fdh_approved_financial_summaries enable row level security');
    expect(SQL).toMatch(/create policy "own rows - fdh_approved_financial_summaries" on fdh_approved_financial_summaries\s*\n\s*for all using \(auth\.uid\(\) = user_id\) with check \(auth\.uid\(\) = user_id\)/);
  });

  it('adds exactly the disclosed new columns on fdh_statement_uploads', () => {
    const idx = SQL.indexOf('alter table fdh_statement_uploads');
    const slice = SQL.slice(idx, SQL.indexOf(';', idx) + 1);
    const cols = [...slice.matchAll(/add column (\w+)/g)].map((m) => m[1]);
    expect(cols.sort()).toEqual(['approval_version', 'approved_by', 'reopen_reason', 'reopened_at', 'reopened_by'].sort());
  });

  it('adds exactly the disclosed new columns on fdh_transactions', () => {
    const idx = SQL.indexOf('alter table fdh_transactions');
    const slice = SQL.slice(idx, SQL.indexOf(';', idx) + 1);
    const cols = [...slice.matchAll(/add column (\w+)/g)].map((m) => m[1]);
    expect(cols.sort()).toEqual(['approval_status', 'approved_at', 'approved_by'].sort());
  });

  it('creates the transaction/statement/document-processing-status trigger functions', () => {
    for (const fn of [
      'fdh7_transaction_has_blocking_issue',
      'fdh7_statement_has_blocking_issue',
      'fdh7_guard_transaction_approval',
      'fdh7_guard_statement_approval',
      'fdh7_guard_document_processing_status',
    ]) {
      expect(SQL).toContain(`create or replace function ${fn}`);
    }
    for (const trg of [
      'trg_fdh7_guard_transaction_approval',
      'trg_fdh7_guard_statement_approval',
      'trg_fdh7_guard_document_processing_status',
    ]) {
      expect(SQL).toContain(trg);
    }
  });
});

describe('FDH-7 new-column check constraints match their TypeScript vocabularies', () => {
  it('fdh_transactions.approval_status', () => {
    const idx = SQL.indexOf('add column approval_status text not null default');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 200);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_TRANSACTION_APPROVAL_STATUSES].sort());
  });

  it('fdh_document_audit_events.event_type widened constraint, AS OF MIGRATION 0076, matches the (FDH-3 + R7 + R8 + FDH-5 + FDH-7) subset of the TypeScript vocabulary', () => {
    // NOTE (FDH-9, 2026-08-26): this constraint has been redefined by a
    // "drop constraint + add constraint (full cumulative list)" pattern by
    // every phase that widens it (0058 -> 0064 -> 0068 -> 0071 -> 0076 ->
    // 0091), so 0076's OWN literal text is necessarily a snapshot of the
    // vocabulary as it stood at FDH-7, not "the FULL" vocabulary once a later
    // phase (FDH-9) widens it again — the live DB constraint text has moved
    // on to 0091's version, which is what
    // `tests/unit/fdh9SchemaContract.test.ts` (added in the same pass that
    // found this) checks against `FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES`
    // instead. This assertion is retargeted at the FDH-3+R7+R8+FDH-5+FDH-7
    // subset specifically, so it keeps proving 0076 itself was written
    // correctly, without falsely asserting it is still the constraint's
    // final word.
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 2200);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const vocabularyAsOfFdh7 = FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES.filter(
      (t) =>
        !(FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH9_ADDED as readonly string[]).includes(t) &&
        !(FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH10_ADDED as readonly string[]).includes(t) &&
        !(FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH11_ADDED as readonly string[]).includes(t) &&
        !(FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED as readonly string[]).includes(t),
    );
    expect(values.sort()).toEqual([...vocabularyAsOfFdh7].sort());
  });
});

describe('FDH-7 processing_status DB trigger mirrors the certified TypeScript transition table exactly', () => {
  it('every edge in documentLifecycle.ts#DOCUMENT_STATUS_TRANSITIONS appears in the trigger function body', async () => {
    const { DOCUMENT_STATUS_TRANSITIONS } = await import('@/lib/financial-data-hub/domain/documentLifecycle');
    const idx = SQL.indexOf('create or replace function fdh7_guard_document_processing_status');
    const body = SQL.slice(idx, SQL.indexOf('$$;', idx));
    for (const [from, tos] of Object.entries(DOCUMENT_STATUS_TRANSITIONS)) {
      // Every 'from' state must be named as a `when '<from>'` branch.
      expect(body).toContain(`when '${from}'`);
      for (const to of tos) {
        // Every allowed target must appear in that same state's branch text.
        const fromIdx = body.indexOf(`when '${from}'`);
        const nextWhenIdx = body.indexOf('when ', fromIdx + 1);
        const branch = body.slice(fromIdx, nextWhenIdx === -1 ? undefined : nextWhenIdx);
        expect(branch).toContain(`'${to}'`);
      }
    }
  });
});
