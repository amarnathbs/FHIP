/**
 * FDH-12 — the SMSF boundary (spec sections 10-11, 72-73, 137, 173).
 *
 * "FHIP already has an AU-only SMSF capability. FDH-12 must not duplicate it."
 *
 * Before FDH-12 there was NO SMSF detection anywhere in the repository — SMSF
 * was identified solely by exact equality on `master_item_key = 'smsf'`. The
 * detector this file certifies is therefore a genuinely new FDH-12 capability,
 * and it is deliberately scoped to ROUTING: it classifies and hands off. It
 * contains no SMSF business logic and patches nothing inside the SMSF module
 * (spec section 173).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectSmsf,
  smsfClassificationAllowsImport,
} from '@/lib/financial-data-hub/retirement/smsfDetection';

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', '..', 'supabase', 'migrations', '0112_fdh12_retirement_statement_intelligence.sql'),
  'utf8',
).replace(/--.*$/gm, '');

// ===========================================================================
// spec 11 — confident SMSF routes; ambiguous reviews; never silent
// ===========================================================================

describe('FDH-12 spec 11 — SMSF detection outcomes', () => {
  const routes = [
    'Smith Family Self-Managed Super Fund',
    'The Jones SMSF',
    'Acme Self Managed Superannuation Fund',
    'Brown Family Self-Managed Superannuation Fund',
  ];
  for (const name of routes) {
    it(`routes "${name}" to SMSF`, () => {
      const r = detectSmsf(name);
      expect(r.classification).toBe('routed_to_smsf');
      expect(smsfClassificationAllowsImport(r.classification)).toBe(false);
      expect(r.evidence.length).toBeGreaterThan(0);
    });
  }

  const ordinary = [
    'AustralianSuper', 'Hostplus', 'Aware Super', 'REST Super', 'UniSuper',
    'HESTA', 'CBUS Super', 'Australian Retirement Trust',
    'Colonial First State FirstChoice Super', 'AMP Signature Super',
  ];
  for (const name of ordinary) {
    it(`does NOT flag the ordinary fund "${name}"`, () => {
      const r = detectSmsf(name);
      expect(r.classification).toBe('not_smsf');
      expect(smsfClassificationAllowsImport(r.classification)).toBe(true);
    });
  }

  it('"trustee" ALONE is never enough — every super fund has a trustee', () => {
    // The single most important false-positive control: an ordinary member
    // statement names its APRA-regulated trustee constantly.
    const r = detectSmsf('Hostplus', 'Hostplus Pty Ltd is the trustee of the Hostplus Superannuation Fund.');
    expect(r.classification).toBe('not_smsf');
  });

  it('ONE strong marker in body text is REVIEW, not a silent route', () => {
    // An ordinary fund's statement could mention SMSFs in a disclosure
    // paragraph. Ambiguity resolves to review, never to "probably ordinary".
    const r = detectSmsf('Aware Super', 'You may transfer to a self-managed super fund at any time.');
    expect(r.classification).toBe('possible_smsf');
    expect(smsfClassificationAllowsImport(r.classification)).toBe(false);
  });

  it('TWO DISTINCT strong markers in body text is decisive', () => {
    const r = detectSmsf('Some Fund', 'Annual return for this SMSF. Your self-managed superannuation fund balance.');
    expect(r.classification).toBe('routed_to_smsf');
  });

  it('but REPEATING one phrase is still only ONE piece of evidence', () => {
    // Distinct phrases, not distinct occurrences. A statement that says
    // "self-managed super fund" twice has told us one thing twice, and
    // treating that as two independent markers would route ordinary funds
    // whose disclosure text happens to mention SMSFs more than once.
    const r = detectSmsf('Some Fund', 'A self-managed super fund may apply. Ask about a self-managed super fund.');
    expect(r.classification).toBe('possible_smsf');
  });

  it('two WEAK markers raise REVIEW but never route on their own', () => {
    const r = detectSmsf('Some Fund', 'Corporate trustee. Trust deed dated 2019.');
    expect(r.classification).toBe('possible_smsf');
  });

  it('one weak marker alone is not enough', () => {
    const r = detectSmsf('Some Fund', 'Corporate trustee arrangements apply.');
    expect(r.classification).toBe('not_smsf');
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(detectSmsf('SMITH FAMILY   SELF-MANAGED    SUPER FUND').classification).toBe('routed_to_smsf');
    expect(detectSmsf('smith family smsf').classification).toBe('routed_to_smsf');
  });

  it('handles absent input without throwing or guessing', () => {
    for (const v of [null, undefined, '']) {
      const r = detectSmsf(v as string | null | undefined);
      expect(r.classification).toBe('not_smsf');
    }
  });

  it('always explains itself for the review UI', () => {
    for (const input of ['Smith Family SMSF', 'Hostplus']) {
      expect(detectSmsf(input).reason.length).toBeGreaterThan(10);
    }
  });

  it('records WHICH marker fired and where, for auditability', () => {
    const r = detectSmsf('Smith Family SMSF');
    expect(r.evidence[0].field).toBe('fund_name');
    expect(r.evidence[0].weight).toBe('strong');
    expect(r.evidence[0].term).toBe('smsf');
  });

  it('there is no confidence threshold that lets an ambiguous case through', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'financial-data-hub', 'retirement', 'smsfDetection.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/threshold|confidence\s*>/.test(src)).toBe(false);
  });
});

// ===========================================================================
// spec 10 / 72 — the DB-level refusals
// ===========================================================================

describe('FDH-12 spec 10/72 — SMSF can never be imported as ordinary super', () => {
  it('approval refuses a routed or possible SMSF statement', () => {
    const approve = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function fdh12_approve_retirement_statement'),
      MIGRATION.indexOf('create or replace function fdh12_apply_retirement_proposal'),
    );
    expect(approve).toMatch(/smsf_classification = 'routed_to_smsf'/);
    expect(approve).toMatch(/smsf_classification = 'possible_smsf'/);
    expect(approve).toMatch(/ROUTED_TO_SMSF/);
    expect(approve).toMatch(/SMSF_REVIEW_REQUIRED/);
  });

  it('an unapproved statement can never be applied, so routing is terminal', () => {
    const apply = MIGRATION.slice(MIGRATION.indexOf('create or replace function fdh12_apply_retirement_proposal'));
    expect(apply).toMatch(/EVIDENCE_NOT_APPROVED/);
  });

  it('apply refuses an SMSF target even if one were somehow reached', () => {
    const apply = MIGRATION.slice(MIGRATION.indexOf('create or replace function fdh12_apply_retirement_proposal'));
    expect(apply).toMatch(/SMSF_ACCOUNT_NOT_IMPORTABLE/);
    // Two independent tests: the catalogue key AND an actual smsf_funds row.
    expect(apply).toMatch(/v_account\.master_item_key = 'smsf'/);
    expect(apply).toMatch(/exists \(select 1 from smsf_funds sf where sf\.retirement_account_id = v_account\.id\)/);
  });

  it('the SMSF check runs BEFORE the staleness comparison', () => {
    // So the user gets a routing message rather than a confusing STALE result.
    const apply = MIGRATION.slice(MIGRATION.indexOf('create or replace function fdh12_apply_retirement_proposal'));
    expect(apply.indexOf('SMSF_ACCOUNT_NOT_IMPORTABLE')).toBeLessThan(apply.indexOf('STALE_PROPOSAL'));
  });

  it('FDH-12 never opens migration 0090\'s SMSF balance-write window', () => {
    // 0090's guard raises 42501 on any `current_balance` write to an SMSF row
    // outside a `fhip.smsf_balance_write='certified'` window. FDH-12 never sets
    // that GUC, so even a bypass of both checks above would still be refused
    // by the database.
    expect(/smsf_balance_write/.test(MIGRATION)).toBe(false);
  });

  it('creates zero SMSF rows — duplicate SMSF accounts is structurally 0', () => {
    expect(/insert into\s+smsf_/i.test(MIGRATION)).toBe(false);
    expect(/insert into\s+retirement_accounts[\s\S]{0,400}master_item_key/i.test(MIGRATION)).toBe(false);
  });
});

// ===========================================================================
// spec 173 — SMSF issues are not patched inside FDH-12
// ===========================================================================

describe('FDH-12 spec 173 — no SMSF business logic inside FDH-12', () => {
  it('implements no SMSF valuation, mode switch or holdings logic', () => {
    // Comments stripped: the module header legitimately NAMES the SMSF tables
    // in prose, to explain what FDH-12 deliberately does not duplicate. The
    // rule is about code, not about what the documentation may mention.
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'financial-data-hub', 'retirement', 'smsfDetection.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const token of ['summary_balance', 'detailed_net_value', 'smsf_holdings', 'smsf_funds']) {
      expect(src.includes(token), `smsfDetection.ts implements SMSF logic (${token})`).toBe(false);
    }
  });

  it('the detector is pure — no I/O, no database, no imports at all', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'financial-data-hub', 'retirement', 'smsfDetection.ts'),
      'utf8',
    );
    expect(/^import /m.test(src)).toBe(false);
    expect(/createClient|supabase/.test(src)).toBe(false);
  });
});
