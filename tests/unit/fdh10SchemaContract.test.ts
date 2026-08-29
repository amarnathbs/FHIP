/**
 * FDH-10 — repeatable schema-verification test, mirroring
 * `tests/unit/fdh9SchemaContract.test.ts`'s method exactly: parse migration
 * 0096 from disk and assert structural facts rather than trust prose.
 *
 * Added during this round's own independent Phase A/B verification, after
 * `npx tsc --noEmit` caught the SAME class of gap `fdh9SchemaContract.test
 * .ts`'s own header documents finding on the FDH-9 pass: the TS-side
 * `FdhDocumentAuditEventType` enum had not been widened to match 0096's own
 * DB check-constraint widening (fixed in the same pass — see `enums.ts`'s
 * `FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH10_ADDED` comment). This test is what
 * would have caught it, and is what stops the two drifting apart again; it
 * now owns the "matches the FULL current vocabulary" claim that
 * `fdh9SchemaContract.test.ts` no longer can, since 0096 widens the same
 * constraint further.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES } from '@/lib/financial-data-hub/constants/enums';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FILE = '0096_fdh10_credit_cards_loans_intelligence.sql';
const RAW = fs.readFileSync(path.join(MIGRATION_DIR, FILE), 'utf8');
const SQL = RAW.split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

describe('FDH-10 migration 0096 exists', () => {
  it('the file exists', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
  });
});

describe('FDH-10 fdh_document_audit_events.event_type widened constraint matches the FULL current TypeScript vocabulary', () => {
  it("0096 is the constraint's latest word, and it matches FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES exactly", () => {
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 3200);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES].sort());
  });

  it('the seven FDH-10 event types are all present', () => {
    for (const t of [
      'liability_statement_extraction_completed',
      'liability_statement_extraction_failed',
      'liability_statement_approved',
      'liability_bank_match_completed',
      'liability_proposal_generated',
      'liability_proposal_applied',
      'liability_proposal_dismissed',
    ]) {
      expect(FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES as readonly string[]).toContain(t);
    }
  });
});
