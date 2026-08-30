/**
 * FDH-12 — the Retirement domain adapter and the apply contract
 * (spec sections 55-61, 103-113).
 *
 * The FDH-11 audit flagged that its own bridge shipped WITHOUT a unit test
 * (`fdh11InvestmentImportBridge.test.ts` is referenced in a source comment but
 * does not exist). FDH-12's ships with one.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  retirementAdapter,
  findDuplicateRetirementAccount,
  newRetirementRowDefaults,
  RETIREMENT_APPLICABLE_FIELDS,
  EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE,
  CANONICAL_RETIREMENT_ACCOUNT_TYPES,
  type ExistingRetirementRow,
  type RetirementEvidence,
} from '@/lib/import-bridge/adapters/retirementAdapter';
import { RETIREMENT_ACCOUNT_TYPES } from '@/lib/financial-data-hub/retirement/types';

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', '..', 'supabase', 'migrations', '0111_fdh12_retirement_statement_intelligence.sql'),
  'utf8',
);

function existing(overrides: Partial<ExistingRetirementRow> & { id: string }): ExistingRetirementRow {
  return {
    account_name: 'Hostplus Super',
    account_type: 'super',
    current_balance: '220000.00',
    currency_code: 'AUD',
    country_code: 'AU',
    owner: 'self',
    master_item_key: null,
    retirement_member_id: null,
    employer_contribution: null,
    personal_contribution: null,
    contribution_frequency: null,
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function evidence(overrides: Partial<RetirementEvidence> = {}): RetirementEvidence {
  return {
    statementId: 'stmt-1',
    jurisdiction: 'AU',
    accountType: 'industry_super',
    fundName: 'Hostplus',
    currencyCode: 'AUD',
    countryCode: 'AU',
    closingBalance: '225000.00',
    memberType: 'self',
    reviewReasons: [],
    ...overrides,
  };
}

const fieldsOf = (d: ReturnType<typeof retirementAdapter.buildProposal>) =>
  Object.fromEntries(d.fields.map((f) => [f.fieldName, f]));

// ===========================================================================
// The allow-list (spec sections 61, 104, 113)
// ===========================================================================

describe('FDH-12 spec 104 — the apply allow-list', () => {
  it('is exactly nine canonical columns', () => {
    expect([...RETIREMENT_APPLICABLE_FIELDS]).toEqual([
      'account_name', 'account_type', 'current_balance', 'currency_code',
      'country_code', 'owner', 'employer_contribution', 'personal_contribution',
      'contribution_frequency',
    ]);
  });

  it('CANNOT reach target_retirement_age in either of its two homes', () => {
    // spec sections 61 and 113. `retirement_members.target_retirement_age` is
    // the canonical one; `retirement_accounts.target_retirement_age` is the
    // legacy per-account column. Neither is reachable.
    expect(RETIREMENT_APPLICABLE_FIELDS).not.toContain('target_retirement_age');
    expect(retirementAdapter.applicableFields).not.toContain('target_retirement_age');
  });

  it('cannot reach structural or provenance columns', () => {
    for (const forbidden of [
      'master_item_key', 'is_active', 'user_id', 'retirement_member_id',
      'source_type', 'ii_publication_id', 'last_import_application_id', 'notes',
    ]) {
      expect(RETIREMENT_APPLICABLE_FIELDS as readonly string[]).not.toContain(forbidden);
    }
  });

  it('proposes no field outside the allow-list, for any evidence shape', () => {
    const shapes: RetirementEvidence[] = [
      evidence(),
      evidence({ memberType: undefined }),
      evidence({ closingBalance: undefined }),
      evidence({ employerContributions: '8000.00', personalContributions: '2000.00', contributionFrequency: 'monthly' }),
      evidence({ jurisdiction: 'IN', accountType: 'epf', currencyCode: 'INR', countryCode: 'IN' }),
    ];
    for (const ev of shapes) {
      for (const target of [[], [existing({ id: 'acc-1' })]]) {
        const draft = retirementAdapter.buildProposal(ev, target);
        for (const f of draft.fields) {
          expect(RETIREMENT_APPLICABLE_FIELDS as readonly string[]).toContain(f.fieldName);
        }
      }
    }
  });
});

// ===========================================================================
// UPDATE EXISTING vs ADD NEW (spec sections 55, 111)
// ===========================================================================

describe('FDH-12 — proposal shape', () => {
  it('recommends UPDATE when it matches an existing account', () => {
    const draft = retirementAdapter.buildProposal(evidence(), [existing({ id: 'acc-1' })]);
    expect(draft.recommendedApplyMode).toBe('update_existing');
    expect(draft.targetEntityId).toBe('acc-1');
    expect(draft.targetDomain).toBe('retirement');
    expect(draft.sourceKind).toBe('retirement_statement');
  });

  it('recommends ADD NEW when nothing matches', () => {
    const draft = retirementAdapter.buildProposal(evidence({ fundName: 'A Fund Nobody Has' }), [existing({ id: 'acc-1' })]);
    expect(draft.recommendedApplyMode).toBe('add_new');
    expect(draft.targetEntityId).toBeNull();
  });

  it('carries the CURRENT value as existingValue for the staleness oracle', () => {
    const draft = retirementAdapter.buildProposal(evidence(), [existing({ id: 'acc-1', current_balance: '220000.00' })]);
    const f = fieldsOf(draft);
    expect(f.current_balance.existingValue).toBe('220000.00');
    expect(f.current_balance.proposedValue).toBe('225000.00');
  });

  it('proposes identity fields ONLY on ADD NEW — never renames an existing account', () => {
    const update = fieldsOf(retirementAdapter.buildProposal(evidence(), [existing({ id: 'acc-1' })]));
    expect(update.account_name).toBeUndefined();
    expect(update.account_type).toBeUndefined();
    expect(update.currency_code).toBeUndefined();
    expect(update.owner).toBeUndefined();

    const add = fieldsOf(retirementAdapter.buildProposal(evidence({ fundName: 'Brand New Fund' }), []));
    expect(add.account_name.proposedValue).toBe('Brand New Fund');
    expect(add.account_type.proposedValue).toBe('super');
    expect(add.currency_code.proposedValue).toBe('AUD');
    expect(add.owner.proposedValue).toBe('self');
  });

  it('proposes NO balance at all when the statement showed none (spec section 94)', () => {
    const draft = retirementAdapter.buildProposal(evidence({ closingBalance: undefined }), [existing({ id: 'acc-1' })]);
    expect(fieldsOf(draft).current_balance).toBeUndefined();
    expect(draft.summary.reviewReasons).toContain('no_closing_balance_on_statement');
  });

  it('never proposes a fabricated 0.00 balance', () => {
    const draft = retirementAdapter.buildProposal(evidence({ closingBalance: undefined }), []);
    for (const f of draft.fields) {
      if (f.fieldName === 'current_balance') expect(f.proposedValue).not.toBe('0');
    }
  });
});

// ===========================================================================
// Contribution rates require confirmation (spec section 58)
// ===========================================================================

describe('FDH-12 — contribution rates are confirmation-gated', () => {
  const withContribs = evidence({
    employerContributions: '8000.00',
    personalContributions: '2000.00',
    contributionFrequency: 'monthly',
  });

  it('proposes them but never ticks them by default', () => {
    const f = fieldsOf(retirementAdapter.buildProposal(withContribs, [existing({ id: 'acc-1' })]));
    for (const name of ['employer_contribution', 'personal_contribution', 'contribution_frequency']) {
      expect(f[name], name).toBeDefined();
      expect(f[name].isRecommended, name).toBe(false);
      expect(f[name].requiresConfirmation, name).toBe(true);
    }
  });

  it('the balance IS recommended by default', () => {
    const f = fieldsOf(retirementAdapter.buildProposal(withContribs, [existing({ id: 'acc-1' })]));
    expect(f.current_balance.isRecommended).toBe(true);
    expect(f.current_balance.requiresConfirmation).toBe(false);
  });
});

// ===========================================================================
// Member ownership (spec sections 15, 112)
// ===========================================================================

describe('FDH-12 spec 112 — member association on ADD NEW', () => {
  it('takes owner from the resolved member', () => {
    const f = fieldsOf(retirementAdapter.buildProposal(evidence({ fundName: 'New Fund', memberType: 'spouse' }), []));
    expect(f.owner.proposedValue).toBe('spouse');
    expect(f.owner.requiresConfirmation).toBe(false);
  });

  it('REQUIRES CONFIRMATION when the member was not determined', () => {
    // Never silently defaults to "self" — that would be inference from
    // nothing, which spec section 15 rules out.
    const draft = retirementAdapter.buildProposal(evidence({ fundName: 'New Fund', memberType: undefined }), []);
    const f = fieldsOf(draft);
    expect(f.owner.requiresConfirmation).toBe(true);
    expect(draft.summary.reviewReasons).toContain('confirm_which_household_member_this_account_belongs_to');
  });
});

// ===========================================================================
// Matching (spec sections 16-18, 72)
// ===========================================================================

describe('FDH-12 — the bridge adapter never matches on balance', () => {
  it('the balance column is not consulted for matching', () => {
    // Two accounts identical apart from name; identical balances. If balance
    // were an input, this would resolve. It must not.
    const a = existing({ id: 'acc-a', account_name: 'Super Fund One', current_balance: '225000.00' });
    const b = existing({ id: 'acc-b', account_name: 'Super Fund Two', current_balance: '225000.00' });
    const r = findDuplicateRetirementAccount(evidence({ fundName: 'Super Fund' }), [a, b]);
    expect(r.outcome).toBe('ambiguous');
    expect(r.accountId).toBeNull();
  });

  it('NEVER matches an SMSF account (spec sections 10, 72)', () => {
    const smsf = existing({ id: 'acc-smsf', master_item_key: 'smsf', account_name: 'Hostplus' });
    const r = findDuplicateRetirementAccount(evidence(), [smsf]);
    expect(r.accountId).toBeNull();
    expect(r.outcome).toBe('no_match');
  });

  it('never crosses currencies', () => {
    const inr = existing({ id: 'acc-inr', currency_code: 'INR', country_code: 'IN', account_name: 'EPF' });
    const r = findDuplicateRetirementAccount(evidence({ fundName: 'EPF' }), [inr]);
    expect(r.outcome).toBe('no_match');
  });

  it('narrows by member so Self cannot match Spouse (spec section 17)', () => {
    const self = existing({ id: 'acc-self', owner: 'self', account_name: 'Hostplus Super' });
    const spouse = existing({ id: 'acc-spouse', owner: 'spouse', account_name: 'Hostplus Super' });
    expect(findDuplicateRetirementAccount(evidence({ memberType: 'self' }), [self, spouse]).accountId).toBe('acc-self');
    expect(findDuplicateRetirementAccount(evidence({ memberType: 'spouse' }), [self, spouse]).accountId).toBe('acc-spouse');
  });

  it('a NAMED fund matching nothing does not fall back to an unrelated account', () => {
    const unrelated = existing({ id: 'acc-x', account_name: 'Aware Super' });
    const r = findDuplicateRetirementAccount(evidence({ fundName: 'Hostplus' }), [unrelated]);
    expect(r.outcome).toBe('no_match');
  });

  it('AMBIGUOUS never resolves to the first candidate', () => {
    const a = existing({ id: 'acc-a', account_name: 'Super Fund One' });
    const b = existing({ id: 'acc-b', account_name: 'Super Fund Two' });
    const draft = retirementAdapter.buildProposal(evidence({ fundName: 'Super Fund' }), [a, b]);
    expect(draft.targetEntityId).toBeNull();
    expect(draft.summary.reviewReasons).toContain('ambiguous_account_match_review_required');
  });

  it('flags loudly if an SMSF statement somehow reaches the bridge', () => {
    const draft = retirementAdapter.buildProposal(evidence({ isSmsf: true }), []);
    expect(draft.summary.reviewReasons).toContain('smsf_statement_must_be_managed_in_the_smsf_section');
  });
});

// ===========================================================================
// Validation (spec sections 109, 111)
// ===========================================================================

describe('FDH-12 — validateApply', () => {
  const draft = () => retirementAdapter.buildProposal(evidence({ fundName: 'New Fund' }), []);

  it('rejects an empty selection', () => {
    expect(retirementAdapter.validateApply('add_new', draft().fields, [])).toEqual({
      ok: false, error: 'No fields were selected to apply.',
    });
  });

  it('requires name, balance and currency for ADD NEW', () => {
    const d = draft();
    expect(retirementAdapter.validateApply('add_new', d.fields, ['current_balance']).ok).toBe(false);
    expect(retirementAdapter.validateApply('add_new', d.fields, ['account_name', 'current_balance']).ok).toBe(false);
    expect(retirementAdapter.validateApply('add_new', d.fields, ['account_name', 'current_balance', 'currency_code']).ok).toBe(true);
  });

  it('rejects a field that is not part of the proposal', () => {
    const d = draft();
    const result = retirementAdapter.validateApply('apply_selected_fields', d.fields, ['target_retirement_age']);
    expect(result.ok).toBe(false);
  });

  it('allows a single-field selective apply on UPDATE', () => {
    const d = retirementAdapter.buildProposal(evidence(), [existing({ id: 'acc-1' })]);
    expect(retirementAdapter.validateApply('apply_selected_fields', d.fields, ['current_balance']).ok).toBe(true);
  });
});

// ===========================================================================
// New-row defaults (spec sections 14, 19)
// ===========================================================================

describe('FDH-12 — new retirement row defaults', () => {
  it('sets is_active and NOTHING else — master_item_key stays NULL', () => {
    expect(newRetirementRowDefaults()).toEqual({ is_active: true });
  });

  it('a NULL master_item_key is what lets Self and Spouse each hold a fund', () => {
    // `uq_retirement_accounts_user_master unique (user_id, master_item_key)`
    // would otherwise allow only ONE catalogue-keyed account per household.
    // Postgres never matches NULL to NULL, so custom rows are unconstrained.
    expect('master_item_key' in newRetirementRowDefaults()).toBe(false);
  });

  it('does NOT default owner — a retirement account belongs to a member', () => {
    // Unlike income/liability, which default owner to 'self' because their
    // evidence carries no member signal.
    expect('owner' in newRetirementRowDefaults()).toBe(false);
  });
});

// ===========================================================================
// Account-type mapping
// ===========================================================================

describe('FDH-12 — evidence-to-canonical account type mapping', () => {
  it('maps every FDH-12 evidence type to a valid canonical type', () => {
    for (const t of RETIREMENT_ACCOUNT_TYPES) {
      const mapped = EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE[t];
      expect(mapped, t).toBeDefined();
      expect(CANONICAL_RETIREMENT_ACCOUNT_TYPES as readonly string[]).toContain(mapped);
    }
  });

  it('maps AU super flavours to "super" and India ones to their own codes', () => {
    expect(EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE.industry_super).toBe('super');
    expect(EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE.retail_super).toBe('super');
    expect(EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE.account_based_pension).toBe('super');
    expect(EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE.epf).toBe('EPF');
    expect(EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE.ppf).toBe('PPF');
    expect(EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE.nps).toBe('NPS');
  });

  it('falls back to "other" rather than guessing', () => {
    expect(EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE.unknown).toBe('other');
  });
});

// ===========================================================================
// Apply semantics asserted against the RPC (spec sections 106-110)
// ===========================================================================

describe('FDH-12 spec 106-110 — apply semantics in the RPC', () => {
  const sql = MIGRATION.replace(/--.*$/gm, '');

  it('spec 106: duplicate apply returns ALREADY_APPLIED via compare-and-swap', () => {
    expect(sql).toMatch(/update fhip_import_proposals set status = 'applied', applied_at = now\(\)\s*\n\s*where id = p_proposal_id and status = 'ready';/);
    expect(sql).toMatch(/ALREADY_APPLIED/);
  });

  it('spec 107: the proposal row is locked FOR UPDATE before anything else', () => {
    expect(sql).toMatch(/select \* into v_proposal from fhip_import_proposals where id = p_proposal_id for update;/);
  });

  it('spec 108: staleness re-reads the live row and refuses on any change', () => {
    expect(sql).toMatch(/STALE_PROPOSAL/);
    expect(sql).toMatch(/if v_live_text is distinct from v_field\.existing_value then/);
  });

  it('spec 110: KEEP EXISTING writes nothing canonical', () => {
    // Bounded by the block's own RETURN, not by the next `if v_proposal.status
    // <> 'ready'` — that guard also appears INSIDE this block, so slicing on it
    // would cut the block short and test almost nothing.
    const start = sql.indexOf("if p_decision = 'keep_existing' then");
    const end = sql.indexOf("'outcome', 'kept_existing');", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const keepBlock = sql.slice(start, end);
    expect(keepBlock).toMatch(/status = 'dismissed'/);
    expect(/retirement_accounts/.test(keepBlock)).toBe(false);
    expect(/insert into|update retirement/.test(keepBlock)).toBe(false);
  });

  it('spec 56: refuses to apply unapproved evidence', () => {
    expect(sql).toMatch(/EVIDENCE_NOT_APPROVED/);
    expect(sql).toMatch(/and approval_status = 'approved'/);
  });

  it('spec 105: is a FUNCTION, so any exception aborts the whole transaction', () => {
    expect(sql).toMatch(/create or replace function fdh12_apply_retirement_proposal[\s\S]*?returns jsonb/);
    expect(sql).not.toMatch(/create or replace procedure fdh12_apply_retirement_proposal/);
    // No COMMIT of its own — that is what makes the abort total.
    const body = sql.slice(sql.indexOf('create or replace function fdh12_apply_retirement_proposal'));
    expect(/\bcommit\b/i.test(body.slice(0, body.indexOf('$$ language plpgsql')))).toBe(false);
  });

  it('is granted to authenticated and service_role only, never public', () => {
    expect(sql).toMatch(/revoke all on function fdh12_apply_retirement_proposal\(uuid, text, text\[\]\) from public;/);
    expect(sql).toMatch(/grant execute on function fdh12_apply_retirement_proposal\(uuid, text, text\[\]\) to authenticated, service_role;/);
  });

  it('the approve RPC is likewise locked down', () => {
    expect(sql).toMatch(/revoke all on function fdh12_approve_retirement_statement\(uuid\) from public;/);
    expect(sql).toMatch(/grant execute on function fdh12_approve_retirement_statement\(uuid\) to authenticated, service_role;/);
  });
});
