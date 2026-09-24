/**
 * AIE payslip AI-fallback — schema contract: migration 0173 read from disk
 * and asserted against the TypeScript vocabulary it must mirror. Same
 * discipline as fdh9SchemaContract.test.ts / fdh10SchemaContract.test.ts /
 * fdh11SchemaContract.test.ts / fdh12SchemaContract.test.ts.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_PAYSLIP_ADDED,
} from '@/lib/financial-data-hub/constants/enums';
import { auditEventDeltaFor } from './helpers/auditEventChain';

const MIGRATION_DIR = path.resolve(__dirname, '..', '..', 'supabase', 'migrations');
const FILE = '0173_aie_payslip_ai_fallback_audit_events.sql';
const RAW = fs.readFileSync(path.join(MIGRATION_DIR, FILE), 'utf8');
const SQL = RAW.replace(/--.*$/gm, '');

describe('AIE payslip AI-fallback migration numbering governance', () => {
  it('is numbered 0173 and is the only 0173 in the chain', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
    const collisions = fs.readdirSync(MIGRATION_DIR).filter((f) => f.startsWith('0173'));
    expect(collisions).toEqual([FILE]);
  });

  it('every migration version in the chain is unique', () => {
    const versions = fs
      .readdirSync(MIGRATION_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, 4));
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('AIE payslip AI-fallback audit-event vocabulary parity', () => {
  // 0173 has not been the constraint's latest word since migration 0180 (the
  // AIE unified document fallback, which widened it for the four remaining
  // FDH-3 document types), and 0185 and 0186 have widened it again since.
  // Under the old "vocabulary AS OF THIS PHASE" form each of those three cost
  // an edit to this file — this test's subtrahend list grew from one entry to
  // three in two days. The delta form states the claim about 0173 alone, so
  // no later phase touches this file again.
  it('0173 adds exactly AIE_PAYSLIP_ADDED to its predecessor, and revokes nothing', () => {
    const { added, revoked, predecessorName } = auditEventDeltaFor('0173');
    expect(revoked, `0173 revokes values granted by ${predecessorName}`).toEqual([]);
    expect([...added].sort()).toEqual([...FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_PAYSLIP_ADDED].sort());
  });

  it('all seven new event types are present in the constraint and the TS union', () => {
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    const slice = SQL.slice(idx, idx + 6000);
    expect(FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_PAYSLIP_ADDED).toHaveLength(7);
    for (const t of FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_PAYSLIP_ADDED) {
      expect(slice).toContain(`'${t}'`);
      expect(FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES as readonly string[]).toContain(t);
    }
  });

  it('the widening retains every historical value (additive only)', () => {
    for (const t of ['document_upload_created', 'bank_csv_uploaded', 'payslip_extraction_completed', 'retirement_proposal_dismissed']) {
      expect(SQL).toContain(`'${t}'`);
    }
  });
});
