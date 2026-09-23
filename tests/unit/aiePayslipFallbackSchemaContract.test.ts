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
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_UNIFIED_FALLBACK_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_PAYSLIP_CORRECTION_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_LIABILITY_CORRECTION_ADDED,
} from '@/lib/financial-data-hub/constants/enums';

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
  // 2026-09-23: 0173 is NO LONGER the constraint's latest word — migration
  // 0180 (the AIE unified document fallback) widened it again for the four
  // remaining FDH-3 document types. This test therefore joins the same
  // "vocabulary AS OF THIS PHASE" chain every earlier phase's contract test
  // already uses, rather than continuing to claim 0173 matches everything.
  // The title was changed with it: leaving "it is the constraint's latest
  // word" in place while subtracting a later phase would be a test whose name
  // contradicts its own assertion.
  // Migration 0185 (payslip review/correction) has since widened this SAME
  // constraint again, so 0173 is no longer "the constraint's latest word" —
  // `fdh9PayslipCorrection.test.ts` now owns that claim for 0185, and proves
  // 0185's list is a STRICT SUPERSET of this one. This test keeps its own
  // claim, filtering out only what LATER migrations added (0180 and 0185),
  // exactly as fdh7/fdh9/fdh10/fdh11/fdh12SchemaContract.test.ts each do.
  it('0173 matches the TypeScript vocabulary as of the payslip phase (0180 and 0185 widen it further)', () => {
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 6000);
    const match = slice.match(/in \(([\s\S]*?)\)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const vocabularyAsOfPayslip = FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES.filter(
      (t) =>
        !(FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_UNIFIED_FALLBACK_ADDED as readonly string[]).includes(t) &&
        !(FDH_DOCUMENT_AUDIT_EVENT_TYPES_PAYSLIP_CORRECTION_ADDED as readonly string[]).includes(t) &&
        !(FDH_DOCUMENT_AUDIT_EVENT_TYPES_LIABILITY_CORRECTION_ADDED as readonly string[]).includes(t),
    );
    expect(values.sort()).toEqual([...vocabularyAsOfPayslip].sort());
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
