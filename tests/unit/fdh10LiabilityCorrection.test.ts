/**
 * FDH-10 — liability statement review/correction surface (2026-09-24).
 *
 * THE DEFECT THIS FILE STANDS AGAINST. `components/liabilities/
 * LiabilityImportPanel.tsx` rendered a "Review / Correct" button whose entire
 * handler was `loadReview(documentId!)` — a re-fetch that set `phase` to the
 * value the surrounding block was ALREADY rendered under. It re-rendered
 * identical content: a visual no-op, with no correction UI behind it
 * anywhere. It was a copy of the identical control on the payslip panel,
 * which became real first (migration 0185,
 * `tests/unit/fdh9PayslipCorrection.test.ts`). Between the two changes the
 * liability button was removed in favour of honest copy saying the figures
 * could not be edited here; this file covers the change that makes the offer
 * real instead.
 *
 * Every assertion here is a SOURCE-LEVEL or CROSS-LAYER check, which is what
 * this repo's test environment supports for a client component (vitest runs
 * in `node`, with no React renderer available — see `vitest.config.ts`). The
 * same precedent is used by `tests/unit/fdh9PayslipCorrection.test.ts`,
 * `tests/unit/adminAnalyticsPhaseAMeRoute.test.ts` and
 * `tests/unit/fdh1Isolation.test.ts`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LIABILITY_CORRECTABLE_TEXT_FIELDS,
  LIABILITY_CORRECTABLE_DATE_FIELDS,
  LIABILITY_CORRECTABLE_CREDIT_CARD_FIELDS,
  LIABILITY_CORRECTABLE_LOAN_FIELDS,
  LIABILITY_CORRECTABLE_SHARED_MONEY_FIELDS,
  LIABILITY_CORRECTABLE_RATE_FIELDS,
  LIABILITY_RECONCILIATION_INPUT_FIELDS,
  liabilityCorrectableFieldsFor,
} from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';
import {
  FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_LIABILITY_CORRECTION_ADDED,
} from '@/lib/financial-data-hub/constants/enums';
import {
  auditEventDeltaFor,
  auditEventTypesIn,
  predecessorAuditEventMigration,
} from './helpers/auditEventChain';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const PANEL = read('components/liabilities/LiabilityImportPanel.tsx');
const ROUTE = read('app/api/financial-data-hub/liability-statement/[documentId]/correct/route.ts');
const SERVICE = read('lib/financial-data-hub/services/liabilityStatementProcessingService.ts');
const MIGRATION_0186 = read('supabase/migrations/0186_fdh10_liability_statement_user_correction.sql');
const MIGRATION_0096 = read('supabase/migrations/0096_fdh10_credit_cards_loans_intelligence.sql');

// The chain helpers this file used to define privately now live in
// `tests/unit/helpers/auditEventChain.ts`, shared with every phase's schema
// contract test and with `fdh9PayslipCorrection.test.ts`. The reasoning that
// was in their doc comments — why the chain starts at 0058 and not 0064, why
// the constraint NAME is the only safe anchor, and why two independent
// derivations of the named set are kept — moved with them.

/** Every `new.<col> is distinct from old.<col>` guard in the liability
 * statements authoritative-write trigger. */
function protectedColumnsIn(sql: string): string[] {
  const fn = /create or replace function fdh10_liability_statements_assert_authoritative_write\(\)[\s\S]*?\$\$ language plpgsql/.exec(sql);
  if (!fn) throw new Error('authoritative-write trigger function not found');
  return [...fn[0].matchAll(/new\.([a-z0-9_]+) is distinct from old\./g)].map((m) => m[1]);
}

/** The correction RPC's body alone. */
function correctionRpc(sql: string): string {
  const fn = /create or replace function fdh10_correct_liability_statement[\s\S]*?\$\$ language plpgsql/.exec(sql);
  if (!fn) throw new Error('fdh10_correct_liability_statement not found');
  return fn[0];
}

const ALL_FIELDS = [
  ...LIABILITY_CORRECTABLE_TEXT_FIELDS,
  ...LIABILITY_CORRECTABLE_DATE_FIELDS,
  ...LIABILITY_CORRECTABLE_CREDIT_CARD_FIELDS,
  ...LIABILITY_CORRECTABLE_LOAN_FIELDS,
  ...LIABILITY_CORRECTABLE_SHARED_MONEY_FIELDS,
  ...LIABILITY_CORRECTABLE_RATE_FIELDS,
];

describe('FDH-10 liability correction — the dead "Review / Correct" control', () => {
  it('no button in the liability panel re-enters the phase it is already rendered in', () => {
    // The literal defect: `onClick={() => loadReview(documentId!)}` inside
    // the block guarded by `phase === 'review' || phase === 'duplicate'`,
    // where `loadReview` ends with `setPhase('review')`.
    expect(PANEL).not.toContain('onClick={() => loadReview(documentId!)}');
    expect(PANEL).not.toContain('Review / Correct');
  });

  it('the interim "we cannot edit these yet" copy is gone, because it is no longer true', () => {
    expect(PANEL).not.toContain("We can&apos;t edit them here yet");
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
    for (const field of ['institution_name', 'closing_balance', 'closing_principal', 'payments_total', 'interest_total']) {
      expect(PANEL, `${field} is not offered for correction`).toContain(`'${field}'`);
    }
    // Each input carries a matching id and <label htmlFor>, built from the
    // field name so they cannot drift apart.
    expect(PANEL).toContain('id={`liability-correct-${field}`}');
    expect(PANEL).toContain('htmlFor={`liability-correct-${field}`}');
  });

  it('offers the credit-card and loan figures separately, never one statement type the other’s fields', () => {
    expect(PANEL).toContain('CREDIT_CARD_CORRECTABLE_FIELDS');
    expect(PANEL).toContain('LOAN_CORRECTABLE_FIELDS');
    expect(PANEL).toContain("current.statement_type === 'credit_card' ? CREDIT_CARD_CORRECTABLE_FIELDS : LOAN_CORRECTABLE_FIELDS");
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
    expect(PANEL).toContain('corrected by you, not read from the statement');
  });
});

describe('FDH-10 liability correction — the write path', () => {
  it('reuses the certified reconciliation functions rather than re-deriving either identity', () => {
    expect(SERVICE).toContain('reconcileCreditCardStatement');
    expect(SERVICE).toContain('reconcileLoanStatement');
    // ...and there is no second copy of either formula in SQL.
    const rpc = correctionRpc(MIGRATION_0186);
    expect(rpc).not.toMatch(/closing_balance\s*[-+]\s*opening_balance/);
    expect(rpc).not.toMatch(/opening_principal\s*[-+]\s*principal_repayments_total/);
  });

  it('picks the formula from the statement type, so a loan is never checked as a card', () => {
    expect(SERVICE).toContain("statementType === 'credit_card'");
    expect(SERVICE).toContain('openingPrincipal: after(\'opening_principal\')');
    expect(SERVICE).toContain('openingBalance: after(\'opening_balance\')');
  });

  it('recomputes from the stored totals, never by re-summing the activity rows', () => {
    // Re-summing `fdh_liability_statement_activities` would discard the
    // correction and return the pre-correction answer.
    const fn = /export async function correctLiabilityStatement[\s\S]*?\n}\n/.exec(SERVICE)![0];
    expect(fn).not.toContain('fdh_liability_statement_activities');
    expect(fn).toContain('after(');
  });

  it('writes through the narrowly-scoped RPC, not a direct UPDATE on the authoritative table', () => {
    expect(SERVICE).toContain("rpc('fdh10_correct_liability_statement'");
    expect(MIGRATION_0186).toContain('create or replace function fdh10_correct_liability_statement');
    // The service never PATCHes fdh_liability_statements' authoritative columns.
    expect(SERVICE).not.toMatch(/from\('fdh_liability_statements'\)\s*\n?\s*\.update\(/);
  });

  it('does not widen migration 0096’s trigger allowance for the figures themselves', () => {
    // The ONLY columns added to the protected set are the new provenance
    // ones; no column becomes directly writable by the authenticated role.
    const before = protectedColumnsIn(MIGRATION_0096);
    const after = protectedColumnsIn(MIGRATION_0186);
    const added = after.filter((c) => !before.includes(c));
    expect([...added].sort()).toEqual(['last_corrected_at', 'last_corrected_by', 'user_corrected_fields']);
  });

  it('refuses to correct an already-approved statement', () => {
    expect(MIGRATION_0186).toContain("'ALREADY_APPROVED'");
    expect(SERVICE).toContain('already been approved and can no longer be corrected');
  });

  it('re-stamps the reconciliation status rather than dropping it', () => {
    expect(MIGRATION_0186).toContain('reconciliation_status = case when v_recon_changed then p_reconciliation_status');
    expect(MIGRATION_0186).toContain('p_reconciliation_status not in (\'reconciled\', \'variance\', \'insufficient_data\')');
  });

  it('never moves a corrected statement back to review_status = not_required', () => {
    expect(MIGRATION_0186).toContain("review_status = case when review_status = 'not_required' then 'in_review' else review_status end");
  });

  it('leaves the parser provenance and the decided duplicate relationship alone', () => {
    const rpc = correctionRpc(MIGRATION_0186);
    expect(rpc).not.toMatch(/\bextraction_confidence\s*=/);
    expect(rpc).not.toMatch(/\bparser_name\s*=/);
    expect(rpc).not.toMatch(/\bparser_version\s*=/);
    expect(rpc).not.toMatch(/\bduplicate_of_statement_id\s*=/);
  });

  it('attributes the correction on the same document audit trail every other liability event uses', () => {
    expect(SERVICE).toContain("eventType: 'liability_statement_corrected'");
    expect(SERVICE).toContain("actorType: 'user'");
    expect(SERVICE).toContain('actorId: userId');
    expect(MIGRATION_0186).toContain('last_corrected_by');
  });

  it('puts field NAMES, never figures, into the audit metadata', () => {
    const call = /eventType: 'liability_statement_corrected'[\s\S]*?\}\);/.exec(SERVICE)![0];
    expect(call).toContain('corrected_fields');
    for (const field of ALL_FIELDS) {
      expect(call, `${field}'s VALUE must not be copied into audit metadata`).not.toContain(`after('${field}')`);
    }
  });
});

describe('FDH-10 liability correction — one closed field vocabulary across all three layers', () => {
  it('the RPC accepts exactly the fields the service declares', () => {
    const allowlist = /if v_key not in \(([\s\S]*?)\) then/.exec(MIGRATION_0186);
    expect(allowlist, 'the RPC has no explicit key allowlist').not.toBeNull();
    const sqlFields = [...allowlist![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect([...sqlFields].sort()).toEqual([...ALL_FIELDS].sort());
  });

  it('the HTTP route accepts exactly the fields the service declares, and rejects anything else', () => {
    const schema = /const bodySchema = z\s*\n?\s*\.object\(\{([\s\S]*?)\n  \}\)/.exec(ROUTE);
    expect(schema, 'the route has no zod object schema').not.toBeNull();
    const routeFields = [...schema![1].matchAll(/^\s{4}([a-z0-9_]+):/gm)].map((m) => m[1]);
    expect([...routeFields].sort()).toEqual([...ALL_FIELDS].sort());
    // `.strict()` is what makes an unlisted key a 422 rather than a silent drop.
    expect(ROUTE).toContain('.strict()');
  });

  it('the RPC scopes the vocabulary by statement type exactly as the service does', () => {
    const rpc = correctionRpc(MIGRATION_0186);
    const cardOnlyRefusal = /if v_is_credit_card and v_key in \(([\s\S]*?)\) then/.exec(rpc);
    const loanOnlyRefusal = /if not v_is_credit_card and v_key in \(([\s\S]*?)\) then/.exec(rpc);
    expect(cardOnlyRefusal, 'the RPC does not refuse loan-only fields on a card').not.toBeNull();
    expect(loanOnlyRefusal, 'the RPC does not refuse card-only fields on a loan').not.toBeNull();
    // On a CREDIT CARD the RPC refuses exactly the loan-only fields...
    expect([...cardOnlyRefusal![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort())
      .toEqual([...LIABILITY_CORRECTABLE_LOAN_FIELDS].sort());
    // ...and on a LOAN exactly the credit-card-only ones.
    expect([...loanOnlyRefusal![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort())
      .toEqual([...LIABILITY_CORRECTABLE_CREDIT_CARD_FIELDS].sort());
  });

  it('the service’s per-type field list is the same partition, with no field lost or duplicated', () => {
    const card = liabilityCorrectableFieldsFor('credit_card');
    const loan = liabilityCorrectableFieldsFor('loan');
    expect(new Set([...card, ...loan]).size).toBe(ALL_FIELDS.length);
    for (const field of LIABILITY_CORRECTABLE_CREDIT_CARD_FIELDS) {
      expect(card).toContain(field);
      expect(loan).not.toContain(field);
    }
    for (const field of LIABILITY_CORRECTABLE_LOAN_FIELDS) {
      expect(loan).toContain(field);
      expect(card).not.toContain(field);
    }
    // Neither list has a duplicate.
    expect(new Set(card).size).toBe(card.length);
    expect(new Set(loan).size).toBe(loan.length);
  });

  it('the panel offers exactly the fields the service allows for that statement type', () => {
    const listOf = (name: string) => {
      const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(PANEL);
      expect(block, `${name} not found in the panel`).not.toBeNull();
      return [...block![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    };
    expect(listOf('CREDIT_CARD_CORRECTABLE_FIELDS').sort())
      .toEqual([...liabilityCorrectableFieldsFor('credit_card')].sort());
    expect(listOf('LOAN_CORRECTABLE_FIELDS').sort())
      .toEqual([...liabilityCorrectableFieldsFor('loan')].sort());
  });

  it('the reconciliation-input set is the same in the service and in the RPC', () => {
    // This is what decides whether a correction re-stamps the statement
    // check. If the two lists disagree, a correction can leave a stale
    // variance on the row (or overwrite a real one for no reason).
    const rpc = correctionRpc(MIGRATION_0186);
    const guard = /if v_key in \(([\s\S]*?)\) then\s*\n\s*v_recon_changed := true;/.exec(rpc);
    expect(guard, 'the RPC has no reconciliation-input guard').not.toBeNull();
    expect([...guard![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort())
      .toEqual([...LIABILITY_RECONCILIATION_INPUT_FIELDS].sort());
  });

  it('the reconciliation-input set is exactly the two formulas’ own inputs, no more and no less', () => {
    // Read from the certified module itself, so a future formula change that
    // adds or drops an input cannot leave this set quietly wrong.
    const reconciliation = read('lib/financial-data-hub/liability/statementReconciliation.ts');
    const inputsOf = (iface: string) => {
      const block = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(reconciliation);
      expect(block, `${iface} not found`).not.toBeNull();
      return [...block![1].matchAll(/^\s*([A-Za-z]+):/gm)]
        .map((m) => m[1])
        // camelCase -> snake_case, and currencyCode is not a correctable
        // figure (it is authoritative and stays so).
        .map((n) => n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
        .filter((n) => n !== 'currency_code');
    };
    const formulaInputs = new Set([
      ...inputsOf('CreditCardReconciliationInput'),
      ...inputsOf('LoanReconciliationInput'),
    ]);
    expect([...formulaInputs].sort()).toEqual([...LIABILITY_RECONCILIATION_INPUT_FIELDS].sort());
  });

  it('refuses a negative figure at the route boundary except where a negative is real', () => {
    // A balance may be negative (an account in credit); an activity TOTAL may
    // not, because the formula applies its own sign.
    expect(ROUTE).toContain('const money = z.number().finite().min(0)');
    expect(ROUTE).toContain('const signedMoney = z.number().finite().min(-1_000_000_000)');
    for (const field of ['purchases_total', 'cash_advances_total', 'interest_total', 'fees_total', 'payments_total', 'credit_limit', 'minimum_payment']) {
      expect(ROUTE, `${field} should be bounded at zero`).toMatch(new RegExp(`${field}: money\\.optional\\(\\)`));
    }
    for (const field of ['opening_balance', 'closing_balance', 'opening_principal', 'closing_principal', 'adjustments_total']) {
      expect(ROUTE, `${field} must allow a negative`).toMatch(new RegExp(`${field}: signedMoney\\.optional\\(\\)`));
    }
  });

  it('the panel enforces the same sign rule it will be held to by the route', () => {
    expect(PANEL).toContain('SIGNED_CORRECTION_FIELDS');
    expect(PANEL).toContain('cannot be negative');
  });
});

describe('migration 0186 is additive against what it replaces', () => {
  it('its audit-event list is a STRICT SUPERSET of the constraint it replaces', () => {
    const predecessor = predecessorAuditEventMigration(186);
    const before = auditEventTypesIn(predecessor.sql);
    const after = auditEventTypesIn(MIGRATION_0186);
    expect(before.length).toBeGreaterThan(0);
    for (const value of before) {
      expect(after, `0186 drops ${value}, which ${predecessor.name} grants`).toContain(value);
    }
    expect(after.length).toBe(before.length + FDH_DOCUMENT_AUDIT_EVENT_TYPES_LIABILITY_CORRECTION_ADDED.length);
    for (const added of FDH_DOCUMENT_AUDIT_EVENT_TYPES_LIABILITY_CORRECTION_ADDED) {
      expect(before).not.toContain(added);
      expect(after).toContain(added);
    }
  });

  it('every value 0186 grants is reachable from the TypeScript enum', () => {
    // DELIBERATELY NOT AN EXACT MATCH, for the same reason the equivalent
    // assertion in `fdh9PayslipCorrection.test.ts` is not one. 0186 happens to
    // be the newest constraint-defining migration TODAY, so an exact match
    // would pass — and would then fail the moment 0187 lands, sending the next
    // reader to edit this file. The exact-match claim belongs to whichever
    // migration the ledger says is newest, and is asserted once, below.
    // (An earlier draft of this file had both, which a simulated-0187 control
    // caught.) What is left here is the half that stays true forever.
    const granted = auditEventTypesIn(MIGRATION_0186);
    expect(granted.length).toBeGreaterThan(0);
    for (const value of granted) {
      expect(FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES as readonly string[]).toContain(value);
    }
  });
});

// ---------------------------------------------------------------------------
// What migration 0186 itself does to the ledger
// ---------------------------------------------------------------------------
//
// The CHAIN-WIDE claims that used to sit here — the two independent
// traversals agreeing, the base being 0058, the latest link equalling the
// enum, every link a strict superset, no revocation anywhere in history, and
// every link's delta equalling its own phase constants — were never specific
// to the liability phase. They now live in `tests/unit/fdhAuditEventChain
// .test.ts`, so the next correction migration inherits them instead of
// restating them. What stays here is 0186.

describe('migration 0186 — its own contribution to the event_type ledger', () => {
  it('adds exactly LIABILITY_CORRECTION_ADDED to its predecessor, revoking nothing', () => {
    // The delta claim in the form every phase contract test now takes. It
    // replaces an "exact match against the enum, minus
    // LIABILITY_CORRECTION_ADDED" assertion that was about to grow a
    // subtrahend for every future document type.
    const { added, revoked, predecessorName } = auditEventDeltaFor('0186');
    expect(revoked, `0186 revokes values granted by ${predecessorName}`).toEqual([]);
    expect([...added].sort())
      .toEqual([...FDH_DOCUMENT_AUDIT_EVENT_TYPES_LIABILITY_CORRECTION_ADDED].sort());
  });

  it('its authoritative-write trigger protects a STRICT SUPERSET of migration 0096’s columns', () => {
    const before = protectedColumnsIn(MIGRATION_0096);
    const after = protectedColumnsIn(MIGRATION_0186);
    expect(before.length).toBeGreaterThan(25);
    for (const column of before) {
      expect(after, `0186 stopped protecting ${column}`).toContain(column);
    }
    for (const column of ['user_corrected_fields', 'last_corrected_at', 'last_corrected_by']) {
      expect(before).not.toContain(column);
      expect(after).toContain(column);
    }
  });

  it('adds no DROP of a table, column, index or policy', () => {
    expect(MIGRATION_0186).not.toMatch(/drop\s+(table|column|index|policy)/i);
  });

  it('adds every new column idempotently, so a partial apply can be re-run', () => {
    for (const column of ['user_corrected_fields', 'last_corrected_at', 'last_corrected_by']) {
      expect(MIGRATION_0186).toContain(`add column if not exists ${column}`);
    }
  });

  it('grants the RPC to the roles that need it and nobody else', () => {
    expect(MIGRATION_0186).toContain('revoke all on function fdh10_correct_liability_statement(uuid, jsonb, text, numeric) from public');
    expect(MIGRATION_0186).toContain('grant execute on function fdh10_correct_liability_statement(uuid, jsonb, text, numeric) to authenticated, service_role');
  });

  it('does not revoke migration 0180’s 28 AI-fallback event types', () => {
    // THE SPECIFIC MISTAKE THIS GUARDS. This file's first draft was written
    // against a copy of 0185 that predated 0180, so its list held 81 values
    // and omitted every one of these. Because the constraint is DROPped and
    // recreated, applying that draft after 0180 would have revoked all 28 —
    // no error, no warning, just 28 event types that stop being writable.
    const m0180 = read('supabase/migrations/0180_aie_unified_document_fallback_audit_events.sql');
    const unifiedFallback = auditEventTypesIn(m0180).filter((t) => t.includes('_ai_fallback_'));
    const after = auditEventTypesIn(MIGRATION_0186);
    expect(unifiedFallback.length).toBeGreaterThanOrEqual(28);
    for (const value of unifiedFallback) {
      expect(after, `0186 revokes ${value}, which migration 0180 grants`).toContain(value);
    }
  });

  it('claims a migration number above every number claimed anywhere at the time of writing', () => {
    // 0185 (the payslip correction precedent) was the highest claimed on any
    // ref or in any worktree; 0181-0184 stay reserved as 0185 left them, and
    // the unified-fallback work landed on `main` as 0180.
    expect(MIGRATION_0186).toContain('0186');
    expect(MIGRATION_0186).toContain('0185');
    expect(MIGRATION_0186).toContain('0180');
  });

  it('records what it deliberately did NOT do, rather than leaving the gaps silent', () => {
    // Each of these is a real boundary this change chose; a reader who does
    // not find them documented will assume they were overlooked.
    expect(MIGRATION_0186).toContain('masked_identifier` IS NOT CORRECTABLE');
    expect(MIGRATION_0186).toContain('repayment_frequency` IS NOT CORRECTABLE');
    expect(MIGRATION_0186).toContain('review_status` IS NOT ADDED TO THE TRIGGER');
  });
});

describe('the same dead-control pattern in the sibling import panels', () => {
  const PANELS: Record<string, string> = {
    'components/expenses/BankStatementImportPanel.tsx': read('components/expenses/BankStatementImportPanel.tsx'),
    'components/investments/AuInvestmentStatementImportPanel.tsx': read('components/investments/AuInvestmentStatementImportPanel.tsx'),
    'components/income/PayslipImportPanel.tsx': read('components/income/PayslipImportPanel.tsx'),
    'components/liabilities/LiabilityImportPanel.tsx': PANEL,
    'components/retirement/RetirementStatementImportPanel.tsx': read('components/retirement/RetirementStatementImportPanel.tsx'),
  };

  it('none of them offers a button whose only handler re-reads the phase it already shows', () => {
    for (const [file, source] of Object.entries(PANELS)) {
      expect(source, `${file} still has the dead Review / Correct control`)
        .not.toContain('onClick={() => loadReview(documentId!)}');
    }
  });

  it('the two panels that DO offer a correction path both reach a real write, not a re-read', () => {
    for (const file of ['components/income/PayslipImportPanel.tsx', 'components/liabilities/LiabilityImportPanel.tsx']) {
      expect(PANELS[file], `${file} has no correction phase`).toContain("setPhase('correcting')");
      expect(PANELS[file], `${file} does not POST a correction`).toContain('/correct`');
    }
  });

  it('the three panels with no correction path yet still claim none', () => {
    // Bank statement, investment statement and retirement statement have no
    // correction RPC of their own. Whatever they say about editing extracted
    // figures, none of them may offer a control that only re-reads — which is
    // what the first assertion in this block guards. This one records the
    // remaining scope explicitly so it is not mistaken for finished work.
    for (const file of [
      'components/expenses/BankStatementImportPanel.tsx',
      'components/investments/AuInvestmentStatementImportPanel.tsx',
      'components/retirement/RetirementStatementImportPanel.tsx',
    ]) {
      expect(PANELS[file], `${file} claims a correction phase with no write path behind it`)
        .not.toContain("setPhase('correcting')");
    }
  });
});
