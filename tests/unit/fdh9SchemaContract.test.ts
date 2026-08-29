/**
 * FDH-9 — repeatable schema-verification test, mirroring
 * tests/unit/fdh7SchemaContract.test.ts's / fdh5SchemaContract.test.ts's
 * method: parse migration 0091 from disk and assert structural facts rather
 * than trust prose.
 *
 * Added during the FDH-9 live-DEV-cert + Income-tab pass (2026-08-26) after
 * finding the TS-side `FdhDocumentAuditEventType` enum had not been widened
 * to match 0091's own DB check-constraint widening (a real pre-existing gap,
 * fixed in the same pass — see `enums.ts`'s `FDH_DOCUMENT_AUDIT_EVENT_TYPES_
 * FDH9_ADDED` comment). This test is what would have caught it, and is what
 * stops the two drifting apart again.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES, FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH10_ADDED } from '@/lib/financial-data-hub/constants/enums';

// FDH-10 (migration 0096) has since widened this SAME constraint further —
// 0091 is no longer "the constraint's latest word" (see
// `fdh10SchemaContract.test.ts`, which now owns that claim for 0096).
// Mirrors `fdh7SchemaContract.test.ts`'s own `vocabularyAsOfFdh7` precedent
// exactly: this test still proves 0091 matches everything known UP TO AND
// INCLUDING FDH-9, filtering out only what a LATER migration added.
const VOCABULARY_AS_OF_FDH9 = FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES.filter(
  (t) => !(FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH10_ADDED as readonly string[]).includes(t),
);

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FILE = '0091_fdh9_payslip_income_intelligence.sql';
const RAW = fs.readFileSync(path.join(MIGRATION_DIR, FILE), 'utf8');
const SQL = RAW.split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

describe('FDH-9 migration 0091 exists', () => {
  it('the file exists', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
  });
});

describe('FDH-9 fdh_document_audit_events.event_type widened constraint matches the TypeScript vocabulary as of FDH-9', () => {
  it('0091 matches everything known up to and including FDH-9 (FDH-10 added its own further widening in 0096 — see fdh10SchemaContract.test.ts)', () => {
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 2400);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...VOCABULARY_AS_OF_FDH9].sort());
  });

  it('the six FDH-9 event types are all present', () => {
    for (const t of [
      'payslip_extraction_completed',
      'payslip_extraction_failed',
      'payroll_event_approved',
      'income_proposal_generated',
      'income_proposal_applied',
      'income_proposal_dismissed',
    ]) {
      expect(FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES as readonly string[]).toContain(t);
    }
  });
});
