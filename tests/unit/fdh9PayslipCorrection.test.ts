/**
 * FDH-9 — payslip review/correction surface (2026-09-24).
 *
 * THE DEFECT THIS FILE STANDS AGAINST. `components/income/PayslipImportPanel
 * .tsx` rendered a "Review / Correct" button whose entire handler was
 * `loadReview(documentId!)` — a re-fetch that set `phase` to the value the
 * surrounding block was ALREADY rendered under. It re-rendered identical
 * content: a visual no-op, with no correction UI behind it anywhere. It was
 * also the only offered way to fix a figure the app itself had flagged as
 * needing review.
 *
 * Every assertion here is a SOURCE-LEVEL or CROSS-LAYER check, which is what
 * this repo's test environment supports for a client component (vitest runs
 * in `node`, with no React renderer available — see `vitest.config.ts`). The
 * same precedent is used by `tests/unit/adminAnalyticsPhaseAMeRoute.test.ts`
 * ("holds no route-local Supabase query: the route module imports only the
 * shared helper") and by `tests/unit/fdh1Isolation.test.ts`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYROLL_CORRECTABLE_TEXT_FIELDS,
  PAYROLL_CORRECTABLE_DATE_FIELDS,
  PAYROLL_CORRECTABLE_MONEY_FIELDS,
} from '@/lib/financial-data-hub/services/payslipProcessingService';
import {
  FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_PAYSLIP_CORRECTION_ADDED,
} from '@/lib/financial-data-hub/constants/enums';
import { auditEventDeltaFor, auditEventTypesIn } from './helpers/auditEventChain';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const PANEL = read('components/income/PayslipImportPanel.tsx');
const ROUTE = read('app/api/financial-data-hub/payslip/[documentId]/correct/route.ts');
const SERVICE = read('lib/financial-data-hub/services/payslipProcessingService.ts');
const MIGRATION_0185 = read('supabase/migrations/0185_fdh9_payroll_event_user_correction.sql');
const MIGRATION_0091 = read('supabase/migrations/0091_fdh9_payslip_income_intelligence.sql');

// `predecessorAuditEventMigration` and `auditEventTypesIn` used to be defined
// privately here and, nearly identically, in
// `tests/unit/fdh10LiabilityCorrection.test.ts`. They are shared now, in
// `tests/unit/helpers/auditEventChain.ts`, along with the reasoning for
// resolving the predecessor from the ledger rather than hardcoding it: 0185
// was first drafted against 0173, but 0180 (the unified AI-fallback widening)
// landed on `main` in between and added 28 values. Because this constraint is
// DROPped and recreated, a stale hardcoded predecessor would have let 0185
// silently REVOKE those 28 while this suite still passed.

/** Every `new.<col> is distinct from old.<col>` guard in an authoritative-write trigger. */
function protectedColumnsIn(sql: string): string[] {
  const fn = /create or replace function fdh9_payroll_events_assert_authoritative_write\(\)[\s\S]*?\$\$ language plpgsql/.exec(sql);
  if (!fn) throw new Error('authoritative-write trigger function not found');
  return [...fn[0].matchAll(/new\.([a-z0-9_]+) is distinct from old\./g)].map((m) => m[1]);
}

describe('FDH-9 payslip correction — the dead "Review / Correct" control', () => {
  it('no button in the payslip panel re-enters the phase it is already rendered in', () => {
    // The literal defect: `onClick={() => loadReview(documentId!)}` inside
    // the block guarded by `phase === 'review' || phase === 'duplicate'`,
    // where `loadReview` ends with `setPhase('review')`.
    expect(PANEL).not.toContain('onClick={() => loadReview(documentId!)}');
  });

  it('the panel has a real correction phase, and it is not the phase it was launched from', () => {
    expect(PANEL).toContain("| 'correcting'");
    expect(PANEL).toContain("setPhase('correcting')");
    expect(PANEL).toContain("phase === 'correcting'");
  });

  it('the correction form posts to the correction route, not to a re-read', () => {
    expect(PANEL).toContain('/correct`');
    expect(PANEL).toContain("method: 'POST'");
  });

  it('every field the form offers is editable and labelled', () => {
    for (const field of ['employer_name', 'gross_pay', 'base_pay', 'tax_withheld', 'net_pay']) {
      expect(PANEL, `${field} is not offered for correction`).toContain(`'${field}'`);
    }
    // Each input carries a matching id and <label htmlFor>, built from the
    // field name so they cannot drift apart.
    expect(PANEL).toContain('id={`payslip-correct-${field}`}');
    expect(PANEL).toContain('htmlFor={`payslip-correct-${field}`}');
  });

  it('announces a saved correction and an error with the right live-region roles', () => {
    // A prior audit found exactly this gap on a sibling panel: a status the
    // user is not looking at, rendered with no live region.
    expect(PANEL).toContain('role="status" aria-live="polite"');
    expect(PANEL).toContain('role="alert"');
  });

  it('tells the user plainly that an empty box means "not stated", never zero', () => {
    expect(PANEL).toMatch(/not\s*&ldquo;stated&rdquo;|not\s+stated/i);
    expect(PANEL).toContain('not zero');
  });

  it('distinguishes a user-corrected value from a machine-extracted one on screen', () => {
    expect(PANEL).toContain('user_corrected_fields');
    expect(PANEL).toContain('corrected by you, not read from the payslip');
  });
});

describe('FDH-9 payslip correction — the write path', () => {
  it('reuses the certified reconciliation function rather than re-deriving the identity', () => {
    expect(SERVICE).toContain('reconcileGrossToNet');
    // ...and there is no second copy of the gross-to-net arithmetic in SQL.
    expect(MIGRATION_0185).not.toMatch(/net_pay\s*[-+]\s*tax_withheld/);
  });

  it('writes through the narrowly-scoped RPC, not a direct UPDATE on the authoritative table', () => {
    expect(SERVICE).toContain("rpc('fdh9_correct_payroll_event'");
    expect(MIGRATION_0185).toContain('create or replace function fdh9_correct_payroll_event');
    // The service never PATCHes fdh_payroll_events' authoritative columns.
    expect(SERVICE).not.toMatch(/from\('fdh_payroll_events'\)\s*\n?\s*\.update\(/);
  });

  it('refuses to correct an already-approved payroll event', () => {
    expect(MIGRATION_0185).toContain("'ALREADY_APPROVED'");
    expect(SERVICE).toContain('already been approved and can no longer be corrected');
  });

  it('re-stamps the reconciliation status rather than dropping it', () => {
    expect(MIGRATION_0185).toContain('reconciliation_status = case when v_money_changed then p_reconciliation_status');
    expect(MIGRATION_0185).toContain('p_reconciliation_status not in (\'reconciled\', \'variance\', \'insufficient_data\')');
  });

  it('never moves a corrected event back to review_status = not_required', () => {
    expect(MIGRATION_0185).toContain("review_status = case when review_status = 'not_required' then 'in_review' else review_status end");
  });

  it('leaves the duplicate-detection fingerprint alone, so a re-upload is still a duplicate', () => {
    const rpc = /create or replace function fdh9_correct_payroll_event[\s\S]*?\$\$ language plpgsql/.exec(MIGRATION_0185)![0];
    expect(rpc).not.toMatch(/payslip_fingerprint\s*=/);
  });

  it('attributes the correction on the same document audit trail every other payslip event uses', () => {
    expect(SERVICE).toContain("eventType: 'payroll_event_corrected'");
    expect(SERVICE).toContain("actorType: 'user'");
    expect(SERVICE).toContain('actorId: userId');
    expect(MIGRATION_0185).toContain('last_corrected_by');
  });

  it('puts field NAMES, never figures, into the audit metadata', () => {
    const call = /eventType: 'payroll_event_corrected'[\s\S]*?\}\);/.exec(SERVICE)![0];
    expect(call).toContain('corrected_fields');
    for (const field of PAYROLL_CORRECTABLE_MONEY_FIELDS) {
      expect(call, `${field}'s VALUE must not be copied into audit metadata`).not.toContain(`after('${field}')`);
    }
  });
});

describe('the variance safety net is strengthened, never quieted', () => {
  it('layout uncertainty forces review in addition to the two original triggers', () => {
    const block = /review_status:[\s\S]*?'not_required',/.exec(SERVICE)![0];
    // The two original triggers must survive verbatim.
    expect(block).toContain("bankMatchStatus === 'multiple_candidates'");
    expect(block).toContain("reconciliation.status === 'variance'");
    // ...plus the new ones.
    expect(block).toContain('column_mapping_ambiguous');
    expect(block).toContain('column_orientation_corrected');
    expect(block).toContain('column_orientation_unresolved');
  });

  it('records where a gross figure came from on every insert', () => {
    expect(SERVICE).toContain('gross_pay_source: extraction.grossPaySource ?? null');
  });
});

describe('FDH-9 payslip correction — one closed field vocabulary across all three layers', () => {
  const all = [
    ...PAYROLL_CORRECTABLE_TEXT_FIELDS,
    ...PAYROLL_CORRECTABLE_DATE_FIELDS,
    ...PAYROLL_CORRECTABLE_MONEY_FIELDS,
    'pay_frequency',
  ];

  it('the RPC accepts exactly the fields the service declares', () => {
    const allowlist = /if v_key not in \(([\s\S]*?)\) then/.exec(MIGRATION_0185);
    expect(allowlist, 'the RPC has no explicit key allowlist').not.toBeNull();
    const sqlFields = [...allowlist![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect([...sqlFields].sort()).toEqual([...all].sort());
  });

  it('the HTTP route accepts exactly the fields the service declares, and rejects anything else', () => {
    const schema = /const bodySchema = z\s*\n?\s*\.object\(\{([\s\S]*?)\n  \}\)/.exec(ROUTE);
    expect(schema, 'the route has no zod object schema').not.toBeNull();
    const routeFields = [...schema![1].matchAll(/^\s{4}([a-z0-9_]+):/gm)].map((m) => m[1]);
    expect([...routeFields].sort()).toEqual([...all].sort());
    // `.strict()` is what makes an unlisted key a 422 rather than a silent drop.
    expect(ROUTE).toContain('.strict()');
  });

  it('every money field is refused below zero at the route boundary', () => {
    expect(ROUTE).toContain('z.number().finite().min(0)');
  });
});

describe('migration 0185 is additive against what it replaces', () => {
  it('adds exactly PAYSLIP_CORRECTION_ADDED to its predecessor, revoking nothing', () => {
    // The delta claim, in the shared form every phase contract test now
    // takes. It says the same thing the longhand superset check said — 0185
    // grants everything its predecessor granted, plus exactly its own value —
    // without this file having to resolve the predecessor itself.
    const { added, revoked, predecessorName } = auditEventDeltaFor('0185');
    expect(revoked, `0185 revokes values granted by ${predecessorName}`).toEqual([]);
    expect([...added].sort())
      .toEqual([...FDH_DOCUMENT_AUDIT_EVENT_TYPES_PAYSLIP_CORRECTION_ADDED].sort());
  });

  it('every value 0185 grants is reachable from the TypeScript enum', () => {
    // DELIBERATELY NOT AN EXACT MATCH ANY MORE. 0186 (the liability correction
    // counterpart) has since widened this SAME constraint one value further,
    // so 0185 is no longer the constraint's latest word. The obvious repair —
    // subtracting `LIABILITY_CORRECTION_ADDED` here — is the shape that made
    // the six `*SchemaContract.test.ts` files a maintenance tax: each new
    // correction surface adds another subtrahend until the assertion is
    // bookkeeping about which migrations exist rather than a real check.
    //
    // The "nothing in the enum is unreachable in SQL" guarantee is instead
    // asserted ONCE, against whichever migration the ledger says is latest, by
    // `tests/unit/fdh10LiabilityCorrection.test.ts`. What is left here is the
    // half that stays true forever no matter how many later widenings land.
    const granted = auditEventTypesIn(MIGRATION_0185);
    expect(granted.length).toBeGreaterThan(0);
    for (const value of granted) {
      expect(FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES as readonly string[]).toContain(value);
    }
  });

  it('its authoritative-write trigger protects a STRICT SUPERSET of migration 0091’s columns', () => {
    const before = protectedColumnsIn(MIGRATION_0091);
    const after = protectedColumnsIn(MIGRATION_0185);
    expect(before.length).toBeGreaterThan(30);
    for (const column of before) {
      expect(after, `0185 stopped protecting ${column}`).toContain(column);
    }
    for (const column of ['gross_pay_source', 'user_corrected_fields', 'last_corrected_at', 'last_corrected_by']) {
      expect(before).not.toContain(column);
      expect(after).toContain(column);
    }
  });

  it('adds no DROP of a table, column, index or policy', () => {
    expect(MIGRATION_0185).not.toMatch(/drop\s+(table|column|index|policy)/i);
  });

  it('claims a migration number above every number claimed anywhere at the time of writing', () => {
    // 0180 was claimed by the concurrent unified-document-fallback branch;
    // 0181-0184 are left free as headroom for it.
    expect(MIGRATION_0185).toContain('0185');
    expect(MIGRATION_0185).toContain('0180');
  });
});

describe('the same dead-control pattern in the sibling import panels', () => {
  const PANELS: Record<string, string> = {
    'components/expenses/BankStatementImportPanel.tsx': read('components/expenses/BankStatementImportPanel.tsx'),
    'components/investments/AuInvestmentStatementImportPanel.tsx': read('components/investments/AuInvestmentStatementImportPanel.tsx'),
    'components/liabilities/LiabilityImportPanel.tsx': read('components/liabilities/LiabilityImportPanel.tsx'),
    'components/retirement/RetirementStatementImportPanel.tsx': read('components/retirement/RetirementStatementImportPanel.tsx'),
  };

  it('none of them offers a button whose only handler re-reads the phase it already shows', () => {
    for (const [file, source] of Object.entries(PANELS)) {
      expect(source, `${file} still has the dead Review / Correct control`)
        .not.toContain('onClick={() => loadReview(documentId!)}');
    }
  });

  it('the liability panel now has a real correction path, not the dead control and not an apology for it', () => {
    // HISTORY, so the next reader does not mistake this for a weakened
    // assertion. This panel shared the payslip panel's exact dead control.
    // When that control was made real (migration 0185), the liability button
    // was REMOVED and replaced with honest copy ("We can't edit them here
    // yet"), because the liability write path needed its own narrowly-scoped
    // RPC against migration 0096's equally-authoritative statement columns
    // and that was out of scope. That RPC now exists (migration 0186), so the
    // interim copy is gone too: what this asserts is that neither the dead
    // control NOR the apology for it came back, and that the real path is
    // what is there instead. `tests/unit/fdh10LiabilityCorrection.test.ts`
    // holds the full cross-layer proof.
    const source = PANELS['components/liabilities/LiabilityImportPanel.tsx'];
    expect(source).not.toContain('Review / Correct');
    expect(source).not.toContain("We can&apos;t edit them here yet");
    expect(source).toContain("setPhase('correcting')");
    expect(source).toContain('/correct`');
  });
});
