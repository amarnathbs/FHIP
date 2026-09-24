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
import { FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES, FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH9_ADDED } from '@/lib/financial-data-hub/constants/enums';
import { auditEventDeltaFor } from './helpers/auditEventChain';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FILE = '0091_fdh9_payslip_income_intelligence.sql';
// This file no longer reads the migration text itself. Its one SQL-derived
// claim is the delta below, which `tests/unit/helpers/auditEventChain.ts`
// parses from the ledger — so the local copy of the read-and-strip-comments
// boilerplate every sibling contract test carries would be dead code here.

describe('FDH-9 migration 0091 exists', () => {
  it('the file exists', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
  });
});

describe('FDH-9 fdh_document_audit_events.event_type widened constraint adds exactly the FDH-9 event types', () => {
  it('0091 adds exactly FDH9_ADDED to its predecessor, and revokes nothing', () => {
    // THE CLAIM THIS FILE WAS CREATED FOR, PRESERVED. 0091's own widening had
    // reached the DB without the TypeScript enum being widened to match — a
    // real pre-existing gap this test was written to catch (see the header).
    // The claim then was "0091 == the enum MINUS everything later phases
    // added", which meant naming every later phase here and editing this file
    // on every future widening.
    //
    // This form is the same claim, stated only about 0091: what 0091 ADDS to
    // its predecessor is exactly FDH-9's own six event types. It still catches
    // the original defect — six values in the SQL with no constant to match
    // fails here — and it catches the case the whole-chain claims in
    // `fdhAuditEventChain.test.ts` cannot: 0091 OMITTING one of its own six is
    // still a superset of 0076, still strictly larger, and still leaves the
    // latest link matching the enum.
    const { added, revoked, predecessorName } = auditEventDeltaFor('0091');
    expect(revoked, `0091 revokes values granted by ${predecessorName}`).toEqual([]);
    expect([...added].sort()).toEqual([...FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH9_ADDED].sort());
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
