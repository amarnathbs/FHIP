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

import { readdirSync, readFileSync } from 'node:fs';
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
  FDH_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_LIABILITY_CORRECTION_ADDED,
} from '@/lib/financial-data-hub/constants/enums';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const PANEL = read('components/liabilities/LiabilityImportPanel.tsx');
const ROUTE = read('app/api/financial-data-hub/liability-statement/[documentId]/correct/route.ts');
const SERVICE = read('lib/financial-data-hub/services/liabilityStatementProcessingService.ts');
const MIGRATION_0186 = read('supabase/migrations/0186_fdh10_liability_statement_user_correction.sql');
const MIGRATION_0096 = read('supabase/migrations/0096_fdh10_credit_cards_loans_intelligence.sql');

/**
 * The migration whose event_type constraint 0186 actually replaces.
 *
 * Derived, never hardcoded — the same helper, for the same reason, as
 * `tests/unit/fdh9PayslipCorrection.test.ts`. 0186 was first drafted against a
 * copy of 0185 that predated 0180 (the unified AI-fallback widening, which
 * landed on `main` in between and added 28 values). Because this constraint is
 * DROPped and recreated, a stale hardcoded predecessor would have let 0186
 * silently REVOKE all 28 while this suite still passed. That draft really was
 * written; resolving the predecessor from the ledger is what makes the next
 * such collision fail loudly here instead of shipping.
 */
function predecessorAuditEventMigration(selfNumber: number): { name: string; sql: string } {
  const chain = auditEventMigrationChain().filter((m) => Number(m.name.slice(0, 4)) < selfNumber);
  const previous = chain[chain.length - 1];
  if (!previous) throw new Error('no prior migration defines fdh_document_audit_events_event_type_check');
  return previous;
}

/** Every migration filename in the ledger, oldest first. */
function migrationFilenames(): string[] {
  return readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}

/**
 * Link 0 of the chain: the migration that FIRST constrains `event_type`.
 *
 * WHY THIS NEEDS ITS OWN LOOKUP. 0058 creates the table with an UNNAMED,
 * column-level `event_type text not null check (event_type in (...))`. Postgres
 * auto-names a column check `<table>_<column>_check`, which is literally
 * `fdh_document_audit_events_event_type_check` — the same constraint object
 * every later migration DROPs and recreates by that name. So 0058 is genuinely
 * the first link, but it can never be found by searching for the name, because
 * it never writes it.
 *
 * The proof that the implicit name really does match is NOT that 0064's
 * `drop constraint if exists` succeeds — `if exists` passes silently whether or
 * not it matched anything, so DDL exit status cannot establish constraint
 * identity. The proof is runtime: two CHECKs on the same column are ANDed, so
 * had that drop missed, the effective vocabulary would be the INTERSECTION of
 * 0058's 9 values and 0064's 19 — i.e. still 9 — and every one of R7's ten new
 * event types would be rejected in production. They are not.
 *
 * Starting the chain at 0064 instead (an earlier version of this file did)
 * makes 0064 look like a 19-value base that needs TWO named constants to
 * explain, when it is really a +10 delta that is exactly `R7_ADDED`.
 */
function auditEventBaseMigration(): { name: string; values: string[] } {
  const name = migrationFilenames().find((n) => n.startsWith('0058_'));
  if (!name) throw new Error('the base migration 0058 is missing from the ledger');
  const sql = readFileSync(path.join(ROOT, 'supabase/migrations', name), 'utf8');
  const table = sql.slice(sql.indexOf('create table fdh_document_audit_events ('));
  const inline = /event_type text not null check \(event_type in \(([\s\S]*?)\)\),/.exec(table);
  if (!inline) throw new Error(`${name} no longer constrains event_type inline`);
  return { name, values: [...inline[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]) };
}

/**
 * Every migration that RE-DEFINES the event_type constraint by name, oldest
 * first, identified by PARSING each one's value list. Excludes the base, which
 * has no name to match — see `auditEventBaseMigration`.
 */
function namedAuditEventMigrations(): { name: string; sql: string }[] {
  const dir = path.join(ROOT, 'supabase/migrations');
  return migrationFilenames()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }))
    .filter((m) => {
      try {
        return auditEventTypesIn(m.sql).length > 0;
      } catch {
        return false;
      }
    });
}

/** The WHOLE chain, base first: what the constraint has held over time. */
function auditEventChainValues(): { name: string; values: string[] }[] {
  const base = auditEventBaseMigration();
  return [
    base,
    ...namedAuditEventMigrations().map((m) => ({ name: m.name, values: auditEventTypesIn(m.sql) })),
  ];
}

/** Kept for the callers that only care about the NAMED links. */
function auditEventMigrationChain(): { name: string; sql: string }[] {
  return namedAuditEventMigrations();
}

/**
 * The same set, found a DIFFERENT way: a plain substring search for the
 * `add constraint` statement, with no parsing at all.
 *
 * Deliberately independent of `auditEventMigrationChain`. The chain claims
 * below compare a parsed list against the TypeScript enum; if the traversal
 * itself were wrong — a truncated list, or the wrong last element — a
 * `toEqual` against one end of it could still pass. Two derivations that share
 * no code cannot both be wrong in the same direction by accident.
 */
function auditEventMigrationNamesBySubstring(): string[] {
  const dir = path.join(ROOT, 'supabase/migrations');
  return migrationFilenames().filter((name) =>
    readFileSync(path.join(dir, name), 'utf8')
      .includes('add constraint fdh_document_audit_events_event_type_check'));
}

/** Every value inside a `check (event_type in ( ... ))` block. */
function auditEventTypesIn(sql: string): string[] {
  const block = /fdh_document_audit_events_event_type_check\s*\n?\s*check \(event_type in \(([\s\S]*?)\)\);/.exec(sql);
  if (!block) throw new Error('no event_type check constraint found');
  return [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

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
// The repo-wide invariant, asserted ONCE and pointed at the ledger
// ---------------------------------------------------------------------------
//
// WHY THIS BLOCK IS NOT SIX MORE SUBTRACTION CLAUSES. Six
// `*SchemaContract.test.ts` files each prove their own migration matches "the
// enum minus everything later phases added", so every new widening costs one
// edit per file — and both correction migrations have now paid that tax. Worse,
// the same shape was about to spread into the correction tests themselves: an
// "exact match, minus LIABILITY_CORRECTION_ADDED" assertion in
// `fdh9PayslipCorrection.test.ts` would need another subtrahend for expenses,
// another for insurance, until it asserts nothing but which migrations exist.
//
// The claims below are the durable form. They are derived entirely from the
// migration ledger, so a new widening needs NO edit here: add the migration and
// the enum value, and these keep meaning exactly what they mean today. That
// claim is load-bearing, so it is kept literally true — an earlier draft of
// this block pinned `latest.name` to '0186_...sql', which would have failed on
// 0187 and sent the next reader to edit a hardcoded filename: the exact thing
// this block exists to remove. The anti-vacuity weight that pin was carrying is
// now carried by a second, independent derivation instead. The only numbers
// here are floors, which never need raising.
describe('the fdh_document_audit_events event_type chain, as a whole', () => {
  it('the traversal finds every constraint-defining migration, and only those', () => {
    // The anti-vacuity guard for everything below. Two independent
    // derivations — parsing each value list, and a plain substring search for
    // the `add constraint` statement — must agree exactly. A traversal that
    // silently truncated, or picked up a migration that only MENTIONS the
    // constraint in a comment, fails here rather than quietly weakening the
    // claims that consume it.
    const parsed = namedAuditEventMigrations().map((m) => m.name);
    expect(parsed).toEqual(auditEventMigrationNamesBySubstring());
    // A floor, not a pin: this only ever grows.
    expect(parsed.length).toBeGreaterThanOrEqual(12);
    // ...and the ASYMMETRY is asserted rather than left implicit: the base is
    // deliberately absent from both NAMED derivations, because it never writes
    // the constraint name. A future reader who finds 0058 missing here should
    // find this line before concluding the traversal is broken.
    expect(parsed).not.toContain(auditEventBaseMigration().name);
  });

  it('the LATEST constraint-defining migration matches the TypeScript enum exactly', () => {
    // The "nothing in the enum is unreachable in SQL, and nothing in SQL is
    // missing from the enum" guarantee, which the per-phase subtraction form
    // slowly loses. Whichever migration is newest owns this claim, derived
    // from the ledger — NO filename is pinned here, so the next widening needs
    // no edit to this file.
    const chain = auditEventMigrationChain();
    const latest = chain[chain.length - 1];
    // ...and "latest" really is the highest-numbered one, established without
    // relying on the traversal that produced it.
    const highest = auditEventMigrationNamesBySubstring().slice(-1)[0];
    expect(latest.name).toBe(highest);
    expect([...auditEventTypesIn(latest.sql)].sort())
      .toEqual([...FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES].sort());
  });

  it('the base is 0058, and its values are exactly the BASE TypeScript constant', () => {
    // 0058 never writes the constraint NAME (it is an unnamed inline column
    // check that Postgres names implicitly), so it is located separately and
    // is easy to leave out of the chain by accident — which makes 0064 look
    // like a 19-value base needing two named constants to explain.
    const base = auditEventBaseMigration();
    expect(base.name).toMatch(/^0058_/);
    expect([...base.values].sort()).toEqual([...FDH_DOCUMENT_AUDIT_EVENT_TYPES].sort());
  });

  it('the first NAMED migration adds exactly R7_ADDED to the base, revoking nothing', () => {
    // The base's payoff, and a worked example of the delta property the whole
    // chain has: every link's addition is exactly one phase's own named
    // constant(s). Asserted here for the one link where getting the base wrong
    // silently changes the answer from "+10, one constant" to "19, two".
    const chain = auditEventChainValues();
    const [base, first] = chain;
    expect(first.name).toMatch(/^0064_/);
    const added = first.values.filter((v) => !base.values.includes(v));
    const revoked = base.values.filter((v) => !first.values.includes(v));
    expect(revoked).toEqual([]);
    expect([...added].sort()).toEqual([...FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED].sort());
  });

  it('every link in the chain is a strict superset of the one before it', () => {
    // This is the assertion that would have caught 0185-drafted-against-0173
    // at any point in the two days it sat unmerged, and it will catch the next
    // one without being edited. Runs over the WHOLE chain, base included, so
    // the 0058 -> 0064 link is covered like every other.
    const chain = auditEventChainValues();
    expect(chain.length).toBeGreaterThanOrEqual(13);
    for (let i = 1; i < chain.length; i += 1) {
      const { values: before } = chain[i - 1];
      const { values: after } = chain[i];
      for (const value of before) {
        expect(after, `${chain[i].name} revokes ${value}, which ${chain[i - 1].name} grants`)
          .toContain(value);
      }
      expect(after.length, `${chain[i].name} widens nothing`).toBeGreaterThan(before.length);
    }
  });

  it('no two migrations in the chain claim the same version number', () => {
    const numbers = auditEventMigrationChain().map((m) => m.name.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
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
