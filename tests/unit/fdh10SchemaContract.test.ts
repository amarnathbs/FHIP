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
 * owned the "matches the FULL current vocabulary" claim that
 * `fdh9SchemaContract.test.ts` no longer could, since 0096 widened the same
 * constraint further — FDH-11 (migration 0106) has since widened it again,
 * so that claim now belongs to `fdh11SchemaContract.test.ts`; this test is
 * scoped to `VOCABULARY_AS_OF_FDH10` accordingly (same chain, one more link).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES, FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH10_ADDED } from '@/lib/financial-data-hub/constants/enums';
import { auditEventDeltaFor } from './helpers/auditEventChain';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FILE = '0096_fdh10_credit_cards_loans_intelligence.sql';
// This file no longer reads the migration text itself. Its one SQL-derived
// claim is the delta below, which `tests/unit/helpers/auditEventChain.ts`
// parses from the ledger — so the local copy of the read-and-strip-comments
// boilerplate every sibling contract test carries would be dead code here.

describe('FDH-10 migration 0096 exists', () => {
  it('the file exists', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
  });
});

describe('FDH-10 fdh_document_audit_events.event_type widened constraint adds exactly the FDH-10 event types', () => {
  it('0096 adds exactly FDH10_ADDED to its predecessor, and revokes nothing', () => {
    // Same replacement as every other phase contract test in this chain: the
    // old form compared 0096 against "the enum minus FDH-11, FDH-12, the AIE
    // payslip phase, the AIE unified fallback phase, the payslip correction
    // and the liability correction" — a list that had to be extended in this
    // file every time any later phase widened the constraint.
    //
    // The delta form names only FDH-10. It keeps the guarantee the whole-chain
    // claims in `fdhAuditEventChain.test.ts` do not carry: a value missing
    // from 0096 that FDH-10 should have granted leaves every chain-wide claim
    // satisfied and only fails here.
    const { added, revoked, predecessorName } = auditEventDeltaFor('0096');
    expect(revoked, `0096 revokes values granted by ${predecessorName}`).toEqual([]);
    expect([...added].sort()).toEqual([...FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH10_ADDED].sort());
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
