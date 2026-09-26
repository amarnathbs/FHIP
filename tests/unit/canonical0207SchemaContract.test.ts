/**
 * Migration 0207 (canonical-upload schema foundation, WP-01) -- static
 * contract against the migration LEDGER.
 *
 * The PGlite script (scripts/canonical_0207_pglite_verification.mjs) proves the
 * runtime behaviour. This file proves the things that must hold of the SQL
 * TEXT, derived from the ledger rather than hardcoded:
 *   - the error_code CHECK chain (0046 -> 0071 -> 0170 -> 0179 -> 0207) never
 *     revokes, and 0207 adds exactly its own constant;
 *   - 0207's audit event_type delta is exactly its own constant (the chain
 *     test covers the whole history; this is the per-phase restatement);
 *   - the revocation-guard arrays inside 0207's DO blocks list exactly the
 *     same values as the constraints they guard (they cannot drift apart);
 *   - r7_block_authenticated_insert: 0207 is the latest definition, keeps the
 *     refusal, and only adds the GUC exemption;
 *   - the reclassify helper is revoked from public/anon/authenticated.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FDH_ALL_ERROR_CODES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_CANONICAL_UPLOAD_ADDED,
  FDH_ERROR_CODES_CANONICAL_UPLOAD_ADDED,
} from '@/lib/financial-data-hub/constants/enums';
import { auditEventDeltaFor, auditEventTypesIn } from './helpers/auditEventChain';

const ROOT = path.resolve(__dirname, '../..');
const MIG = path.join(ROOT, 'supabase/migrations');
const FILES = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(path.join(MIG, f), 'utf8');
const SQL_0207 = read(FILES.find((f) => f.startsWith('0207_'))!);

const values = (block: string) => [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);

/** The error_code CHECK as each migration defines it, base (0046, inline) first. */
function errorCodeChain(): { name: string; values: string[] }[] {
  const base = FILES.find((f) => f.startsWith('0046_'))!;
  const baseSql = read(base);
  const table = baseSql.slice(baseSql.indexOf('create table fdh_statement_uploads ('));
  const inline = /error_code text\s*\n\s*check \(error_code is null or error_code in \(([\s\S]*?)\)\),/.exec(table);
  if (!inline) throw new Error('0046 no longer defines error_code inline');
  const chain = [{ name: base, values: values(inline[1]) }];
  for (const f of FILES) {
    const m = /add constraint fdh_statement_uploads_error_code_check\s*\n\s*check \(error_code is null or error_code in \(([\s\S]*?)\)\);/.exec(read(f));
    if (m) chain.push({ name: f, values: values(m[1].replace(/--[^\n]*/g, '')) });
  }
  return chain;
}

describe('0207 error_code widening (derived from the ledger)', () => {
  const chain = errorCodeChain();

  it('the chain is 0046 -> 0071 -> 0170 -> 0179 -> 0207, and 0206 is NOT in it', () => {
    expect(chain.map((c) => c.name.slice(0, 4))).toEqual(['0046', '0071', '0170', '0179', '0207']);
    // Independent derivation: a plain substring search must agree.
    const bySubstring = FILES.filter((f) => read(f).includes('add constraint fdh_statement_uploads_error_code_check'));
    expect(bySubstring).toEqual(chain.slice(1).map((c) => c.name));
    expect(bySubstring.some((f) => f.startsWith('0206_'))).toBe(false);
  });

  it('no link revokes a value its predecessor granted, and every link widens', () => {
    for (let i = 1; i < chain.length; i += 1) {
      for (const v of chain[i - 1].values) {
        expect(chain[i].values, `${chain[i].name} revokes ${v}`).toContain(v);
      }
      expect(chain[i].values.length).toBeGreaterThan(chain[i - 1].values.length);
    }
  });

  it("0207's delta over its ledger-derived predecessor is exactly FDH_ERROR_CODES_CANONICAL_UPLOAD_ADDED", () => {
    const self = chain[chain.length - 1];
    const prev = chain[chain.length - 2];
    expect(prev.name.startsWith('0179_')).toBe(true);
    expect(self.values.filter((v) => !prev.values.includes(v))).toEqual([...FDH_ERROR_CODES_CANONICAL_UPLOAD_ADDED]);
    expect(prev.values.filter((v) => !self.values.includes(v))).toEqual([]);
  });

  it('the latest link equals the TypeScript FDH_ALL_ERROR_CODES exactly', () => {
    expect([...chain[chain.length - 1].values].sort()).toEqual([...FDH_ALL_ERROR_CODES].sort());
  });
});

describe('0207 audit event_type widening', () => {
  it("adds exactly FDH_DOCUMENT_AUDIT_EVENT_TYPES_CANONICAL_UPLOAD_ADDED over 0186 and revokes nothing", () => {
    const delta = auditEventDeltaFor('0207');
    expect(delta.predecessorName.startsWith('0186_')).toBe(true);
    expect(delta.revoked).toEqual([]);
    expect([...delta.added].sort()).toEqual([...FDH_DOCUMENT_AUDIT_EVENT_TYPES_CANONICAL_UPLOAD_ADDED].sort());
  });
});

describe("0207's revocation guards list exactly what the constraints list", () => {
  const guardArrays = [...SQL_0207.matchAll(/v_new text\[\] := array\[([\s\S]*?)\];/g)].map((m) => values(m[1]));

  it('there are exactly two guards (error_code, event_type)', () => {
    expect(guardArrays).toHaveLength(2);
  });

  it('the error_code guard array equals the error_code constraint list', () => {
    const constraint = /add constraint fdh_statement_uploads_error_code_check\s*\n\s*check \(error_code is null or error_code in \(([\s\S]*?)\)\);/.exec(SQL_0207)!;
    expect([...guardArrays[0]].sort()).toEqual([...values(constraint[1].replace(/--[^\n]*/g, ''))].sort());
  });

  it('the event_type guard array equals the event_type constraint list', () => {
    expect([...guardArrays[1]].sort()).toEqual([...auditEventTypesIn(SQL_0207)].sort());
  });

  it('each guard raises BEFORE its constraint is dropped', () => {
    const guardErr = SQL_0207.indexOf("would REVOKE fdh_statement_uploads.error_code");
    const dropErr = SQL_0207.indexOf('drop constraint if exists fdh_statement_uploads_error_code_check');
    const guardEvt = SQL_0207.indexOf('would REVOKE fdh_document_audit_events.event_type');
    const dropEvt = SQL_0207.indexOf('drop constraint if exists fdh_document_audit_events_event_type_check');
    expect(guardErr).toBeGreaterThan(0);
    expect(guardEvt).toBeGreaterThan(0);
    expect(guardErr).toBeLessThan(dropErr);
    expect(guardEvt).toBeLessThan(dropEvt);
  });
});

describe('r7_block_authenticated_insert after 0207', () => {
  const definers = FILES.filter((f) => read(f).includes('create or replace function r7_block_authenticated_insert()'));

  it('is defined by 0064 and 0207 only, so 0207 is the live definition', () => {
    expect(definers.map((f) => f.slice(0, 4))).toEqual(['0064', '0207']);
  });

  it('still raises for the authenticated role, and exempts ONLY the internal-write GUC', () => {
    const body = SQL_0207.slice(SQL_0207.indexOf('create or replace function r7_block_authenticated_insert()'));
    const fn = body.slice(0, body.indexOf('$$ language plpgsql'));
    expect(fn).toContain("auth.role() = 'authenticated'");
    expect(fn).toContain("coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') <> 'true'");
    expect(fn).toContain('is engine-authoritative');
    // No other bypass (no role, no user id, no other GUC).
    expect(fn.match(/current_setting\(/g)).toHaveLength(1);
  });
});

describe('fdh_internal_reclassify_corroborated_leg privileges', () => {
  it('is SECURITY DEFINER and revoked from public, anon and authenticated', () => {
    const sig = 'fdh_internal_reclassify_corroborated_leg(uuid, uuid, text, text, text, uuid)';
    expect(SQL_0207).toMatch(/create or replace function fdh_internal_reclassify_corroborated_leg\(/);
    const fnBody = SQL_0207.slice(SQL_0207.indexOf('create or replace function fdh_internal_reclassify_corroborated_leg('));
    expect(fnBody.slice(0, fnBody.indexOf('revoke all'))).toContain('security definer');
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(SQL_0207).toContain(`revoke all on function ${sig} from ${role};`);
    }
    expect(SQL_0207).not.toMatch(/grant execute on function fdh_internal_reclassify_corroborated_leg[^;]*to (authenticated|anon|public)/);
  });

  it('writes the correction row BEFORE the type update (the 0068 evidence order)', () => {
    const fnBody = SQL_0207.slice(SQL_0207.indexOf('create or replace function fdh_internal_reclassify_corroborated_leg('));
    expect(fnBody.indexOf('insert into fdh_transaction_corrections')).toBeGreaterThan(0);
    expect(fnBody.indexOf('insert into fdh_transaction_corrections')).toBeLessThan(fnBody.indexOf('update fdh_transactions'));
    expect(fnBody).toContain('if v_txn.user_override then');
  });
});

describe('0207 is additive and idempotent by construction', () => {
  it('every add column is guarded by if not exists, every index by if not exists', () => {
    const code = SQL_0207.replace(/--[^\n]*/g, '');
    const adds = [...code.matchAll(/add column (if not exists )?/g)];
    // owner_role, liability_id, ledger_transaction_id, gst_amount_raw,
    // 3 x extraction_warnings, income_owner, ledger_effects, summary.
    expect(adds.length).toBe(10);
    expect(adds.every((m) => m[1] === 'if not exists ')).toBe(true);
    const indexes = [...code.matchAll(/create (unique )?index (if not exists )?/g)];
    expect(indexes.length).toBe(2);
    expect(indexes.every((m) => m[2] === 'if not exists ')).toBe(true);
  });

  it('contains no UPDATE of existing rows and no DROP of a column or table', () => {
    const code = SQL_0207.replace(/--[^\n]*/g, '');
    // The only UPDATE statement is inside the helper body (one row, by id).
    // (`before insert or update of <cols>` in trigger DDL is not a statement.)
    const updates = [...code.matchAll(/\bupdate\s+(?!of\b)(\w+)/gi)].map((m) => m[1]);
    expect(updates).toEqual(['fdh_transactions']);
    expect(code).not.toMatch(/drop\s+(column|table)/i);
  });
});
