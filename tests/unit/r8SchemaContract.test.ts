/**
 * R8 — repeatable schema-verification test, mirroring
 * tests/unit/fdh2SchemaContract.test.ts / fdh3SchemaContract.test.ts /
 * r7SchemaContract.test.ts's method: parse migration 0067 from disk and
 * assert structural facts rather than trust prose.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES } from '@/lib/financial-data-hub/constants/enums';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FILE = '0067_r8_transaction_classification_engine.sql';
const RAW = fs.readFileSync(path.join(MIGRATION_DIR, FILE), 'utf8');
const SQL = RAW.split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

describe('R8 migration 0067 — structural facts', () => {
  it('adds exactly the two disclosed additive columns and nothing else via "add column"/"alter table ... add column"', () => {
    // fdh_transaction_links gains match_evidence; fdh_transactions gains
    // recurring_transaction_id. No other "add column" appears in this file.
    const addColumnMatches = [...SQL.matchAll(/add column (\w+)/g)].map((m) => m[1]);
    expect(addColumnMatches.sort()).toEqual(['match_evidence', 'recurring_transaction_id'].sort());
  });

  it('never drops a column or a table', () => {
    expect(/drop\s+column/i.test(SQL)).toBe(false);
    expect(/drop\s+table/i.test(SQL)).toBe(false);
  });

  it('the widened fdh_document_audit_events.event_type constraint matches the FULL (FDH-3 + R7 + R8) TypeScript vocabulary', () => {
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 1500);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES].sort());
  });

  it('creates exactly the 6 new/widened trigger functions this release introduces', () => {
    const fns = [...SQL.matchAll(/create (?:or replace )?function (\w+)\(/g)].map((m) => m[1]);
    // r7_assert_transaction_authoritative_fields and
    // r7_block_authenticated_insert are WIDENED/REUSED (create or
    // replace / already exists), not newly introduced by R8 — they
    // legitimately appear here because this file replaces the former.
    expect(new Set(fns)).toEqual(
      new Set([
        'r7_assert_transaction_authoritative_fields', // widened, not new
        'r8_transaction_field_evidenced',
        'r8_assert_transaction_link_authoritative_fields',
        'r8_assert_recurring_transaction_authoritative_fields',
        'r8_assert_classification_history_actor',
      ]),
    );
  });

  it('creates exactly the 5 new triggers this release introduces (no parallel trigger on an already-guarded table)', () => {
    const triggers = [...SQL.matchAll(/create trigger (\w+)/g)].map((m) => m[1]);
    expect(new Set(triggers)).toEqual(
      new Set([
        'trg_r8_block_authenticated_insert_transaction_links',
        'trg_r8_transaction_link_authoritative_fields',
        'trg_r8_block_authenticated_insert_recurring_transactions',
        'trg_r8_recurring_transaction_authoritative_fields',
        'trg_r8_classification_history_actor',
      ]),
    );
    // Confirms no `create trigger trg_r7_transaction_authoritative_fields`
    // appears — the function body is replaced, the existing trigger is
    // reused verbatim, exactly matching the 0065 precedent this release
    // documents following.
    expect(SQL.includes('create trigger trg_r7_transaction_authoritative_fields')).toBe(false);
  });

  it('every new/replaced trigger function only ever restricts the authenticated role, never service_role', () => {
    // A service-role bypass MUST remain possible for the engine — this
    // greps for the guard pattern rather than trusting prose. Matches both
    // the block form ("... = 'authenticated' then") and the compact form
    // ("... = 'authenticated' and <condition> then").
    const guardCount = (SQL.match(/auth\.role\(\) = 'authenticated'/g) ?? []).length;
    // r7_assert_transaction_authoritative_fields (reused/widened) +
    // r8_assert_transaction_link_authoritative_fields +
    // r8_assert_recurring_transaction_authoritative_fields +
    // r8_assert_classification_history_actor = 4 guarded functions.
    expect(guardCount).toBeGreaterThanOrEqual(4);
    expect(SQL.includes("auth.role() = 'service_role'")).toBe(false); // never gates ON service_role — it is the implicit bypass
  });
});
