/**
 * WP-09 -- payslip -> Income guards on the TypeScript side (the database side
 * is proven by scripts/fdh9_0210_pglite_verification.mjs).
 *
 * NEGATIVE CONTROL. Run against the base branch
 * (feature/canonical-upload-foundation, f79374f) every `it` below fails:
 * generateIncomeProposal there ignores applications, owner, currency, the
 * user's frequency choice and the component lines; the approve route ignores
 * its body; the proposal and apply routes have no 409 for ALREADY_APPLIED /
 * CURRENCY_MISMATCH; lib/income/* and deriveGrossBasis do not exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import type { ImportProposalDraft } from '@/lib/import-bridge/types';

const USER = 'u-wp09';
const state: { tables: Record<string, Row[]>; missing?: Record<string, string[]>; drafts: ImportProposalDraft[] } = { tables: {}, drafts: [] };

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeFakeSupabase(state.tables, { missingColumns: state.missing }).client,
}));
vi.mock('@/lib/import-bridge/supabaseStore', async () => {
  const actual = await vi.importActual<typeof import('@/lib/import-bridge/supabaseStore')>('@/lib/import-bridge/supabaseStore');
  return {
    ...actual,
    persistProposal: async (_u: string, draft: ImportProposalDraft) => {
      state.drafts.push(draft);
      return `prop-${state.drafts.length}`;
    },
  };
});

import { deriveGrossBasis } from '@/lib/import-bridge/adapters/incomeAdapter';
import { generateIncomeProposal, IncomeProposalError } from '@/lib/import-bridge/incomeProposalService';

const event = (extra: Row = {}): Row => ({
  id: 'pe1', user_id: USER, statement_upload_id: 'doc1', employer_name: 'Acme Pty Ltd', employer_normalised: 'acme', currency_code: 'AUD',
  pay_frequency: 'monthly', pay_frequency_source: 'stated_on_payslip', pay_period_start: '2026-08-01', pay_period_end: '2026-08-31',
  gross_pay: 6500, net_pay: 5000, bonus_pay: null, overtime_pay: null, commission_pay: null, other_earnings: null, reimbursements_total: null,
  salary_sacrifice: null, reconciliation_status: 'reconciled', bank_match_status: 'no_match', approval_status: 'approved',
  superseded_by_payroll_event_id: null, payslip_fingerprint: 'fp1', created_at: '2026-09-01T00:00:00Z', income_owner: null, ...extra,
});
const incomeRow = (id: string, extra: Row = {}): Row => ({
  id, user_id: USER, source_name: 'Salary', income_type: 'salary', amount: 6000, net_amount: 4700, frequency: 'monthly', currency_code: 'AUD',
  owner: 'self', is_taxable: true, employer_name: 'Acme', notes: null, master_item_key: null, source_type: 'manual', updated_at: '2026-08-01T00:00:00Z', is_active: true, ...extra,
});
const field = (d: ImportProposalDraft, name: string) => d.fields.find((f) => f.fieldName === name);

beforeEach(() => {
  state.tables = {};
  state.missing = undefined;
  state.drafts = [];
});

describe('GAP-04: one Income application per payroll EVENT', () => {
  it('an already-applied payslip is refused (already_applied, naming the Income row) and no second proposal is created', async () => {
    state.tables = {
      fdh_payroll_events: [event({ employer_name: null, employer_normalised: null })],
      income_sources: [incomeRow('src-1', { employer_name: null })],
      fhip_import_applications: [{ id: 'app-1', user_id: USER, target_domain: 'income', source_payroll_event_id: 'pe1', target_entity_id: 'src-1', applied_at: '2026-09-02T00:00:00Z' }],
    };
    const err = await generateIncomeProposal(USER, 'pe1').catch((e) => e);
    expect(err).toBeInstanceOf(IncomeProposalError);
    expect((err as IncomeProposalError).code).toBe('already_applied');
    expect((err as IncomeProposalError).targetEntityId).toBe('src-1');
    expect(state.drafts).toHaveLength(0);
  });
});

describe('GAP-05: the spouse path', () => {
  it("a spouse payslip is matched to the SPOUSE's row for the same employer, never the user's own", async () => {
    state.tables = {
      fdh_payroll_events: [event({ employer_name: 'Globex', employer_normalised: 'globex', income_owner: 'spouse' })],
      income_sources: [incomeRow('self-globex', { employer_name: 'Globex', owner: 'self' }), incomeRow('spouse-globex', { employer_name: 'Globex', owner: 'spouse' })],
    };
    await generateIncomeProposal(USER, 'pe1');
    expect(state.drafts[0].targetEntityId).toBe('spouse-globex');
    expect(state.drafts[0].recommendedApplyMode).toBe('update_existing');
    expect(state.drafts[0].summary.lines.find((l) => l.label === 'Whose income')?.value).toBe('Your spouse');
  });

  it('a self payslip still never targets a spouse row (FDH15-DEF-001 stays closed)', async () => {
    state.tables = { fdh_payroll_events: [event({ employer_name: 'Globex', employer_normalised: 'globex', income_owner: 'self' })], income_sources: [incomeRow('spouse-globex', { employer_name: 'Globex', owner: 'spouse' })] };
    await generateIncomeProposal(USER, 'pe1');
    expect(state.drafts[0].targetEntityId).toBeNull();
    expect(state.drafts[0].recommendedApplyMode).toBe('add_new');
  });

  it('before 0207 (no income_owner column) the proposal is still generated, as self', async () => {
    state.tables = { fdh_payroll_events: [event()], income_sources: [incomeRow('self-acme')] };
    state.missing = { fdh_payroll_events: ['income_owner'] };
    await generateIncomeProposal(USER, 'pe1');
    expect(state.drafts[0].targetEntityId).toBe('self-acme');
  });
});

describe('GAP-03: currency', () => {
  it('an INR payslip is never proposed onto the AUD row for the same employer; the user is told why', async () => {
    state.tables = { fdh_payroll_events: [event({ currency_code: 'INR', gross_pay: 200000, net_pay: 150000 })], income_sources: [incomeRow('aud-acme')] };
    await generateIncomeProposal(USER, 'pe1');
    const d = state.drafts[0];
    expect(d.targetEntityId).toBeNull();
    expect(d.recommendedApplyMode).toBe('add_new');
    expect(field(d, 'currency_code')?.proposedValue).toBe('INR');
    expect(d.summary.reviewReasons).toContain('existing_income_in_other_currency');
  });
});

describe('GAP-12: a frequency the user chooses', () => {
  it('semimonthly gross 3,000 / net 2,400 recorded monthly -> 6,000 / 4,800, frequency monthly, confirmed', async () => {
    state.tables = { fdh_payroll_events: [event({ pay_frequency: 'semimonthly', gross_pay: 3000, net_pay: 2400 })], income_sources: [] };
    await generateIncomeProposal(USER, 'pe1', { frequency: 'monthly' });
    const d = state.drafts[0];
    expect(field(d, 'amount')?.proposedValue).toBe('6000.00');
    expect(field(d, 'net_amount')?.proposedValue).toBe('4800.00');
    expect(field(d, 'frequency')).toMatchObject({ proposedValue: 'monthly', requiresConfirmation: false, reasonCode: 'semimonthly_converted_to_chosen_frequency' });
  });

  it('an irregular payslip keeps its amounts; a payslip with its own frequency ignores the choice', async () => {
    state.tables = { fdh_payroll_events: [event({ pay_frequency: 'irregular' })], income_sources: [] };
    await generateIncomeProposal(USER, 'pe1', { frequency: 'fortnightly' });
    expect(field(state.drafts[0], 'amount')?.proposedValue).toBe('6500.00');
    expect(field(state.drafts[0], 'frequency')?.proposedValue).toBe('fortnightly');
    state.tables = { fdh_payroll_events: [event({ pay_frequency: 'monthly' })], income_sources: [] };
    await generateIncomeProposal(USER, 'pe1', { frequency: 'weekly' });
    expect(field(state.drafts[1], 'frequency')?.proposedValue).toBe('monthly');
  });
});

describe('GAP-16: the gross basis comes from the payslip itself', () => {
  it('reimbursement listed OUTSIDE the stated gross (lines = gross + reimbursement) is not subtracted: recurring gross stays 5,000', async () => {
    state.tables = {
      fdh_payroll_events: [event({ gross_pay: 5000, net_pay: 4200, reimbursements_total: 200 })],
      income_sources: [],
      fdh_payroll_components: [
        { user_id: USER, payroll_event_id: 'pe1', component_side: 'earning', component_type: 'base', amount: 5000, is_year_to_date: false },
        { user_id: USER, payroll_event_id: 'pe1', component_side: 'earning', component_type: 'reimbursement', amount: 200, is_year_to_date: false },
        { user_id: USER, payroll_event_id: 'pe1', component_side: 'earning', component_type: 'base', amount: 50000, is_year_to_date: true },
      ],
    };
    await generateIncomeProposal(USER, 'pe1');
    const d = state.drafts[0];
    expect(field(d, 'amount')?.proposedValue).toBe('5000.00');
    expect(d.summary.lines.find((l) => l.label === 'Reimbursements')?.value).toBe('Not part of gross');
  });

  it('with no proof the conservative rule stands and is RECORDED as an assumption', async () => {
    state.tables = { fdh_payroll_events: [event({ gross_pay: 5000, reimbursements_total: 200 })], income_sources: [], fdh_payroll_components: [] };
    await generateIncomeProposal(USER, 'pe1');
    expect(field(state.drafts[0], 'amount')?.proposedValue).toBe('4800.00');
    expect(state.drafts[0].summary.reviewReasons).toContain('reimbursement_inclusion_assumed');
  });

  it('deriveGrossBasis: lines equal gross -> included iff a reimbursement line is among them; sacrifice as a deduction -> pre-sacrifice', () => {
    const lines = [
      { side: 'earning', type: 'base', amount: 4800, isYearToDate: false },
      { side: 'earning', type: 'reimbursement', amount: 200, isYearToDate: false },
      { side: 'deduction', type: 'salary_sacrifice', amount: 300, isYearToDate: false },
    ];
    expect(deriveGrossBasis({ grossPay: 5000, reimbursementsTotal: 200, salarySacrifice: 300, components: lines }))
      .toEqual({ reimbursementsIncludedInGross: true, reimbursementBasis: 'component_identity', salarySacrificeBasis: 'pre_sacrifice' });
    expect(deriveGrossBasis({ grossPay: 5000, salarySacrifice: 300, components: [] }).salarySacrificeBasis).toBe('unknown');
    expect(deriveGrossBasis({ grossPay: 5000, components: [] }).reimbursementBasis).toBe('none');
  });
});

describe('master_item_key: a hand-entered Employment Salary is the same salary', () => {
  it('the ONE employment_salary row with no employer is proposed as the target (no second salary row)', async () => {
    state.tables = { fdh_payroll_events: [event()], income_sources: [incomeRow('catalogue', { employer_name: null, master_item_key: 'employment_salary', source_name: 'Employment Salary' })] };
    await generateIncomeProposal(USER, 'pe1');
    expect(state.drafts[0].targetEntityId).toBe('catalogue');
    expect(state.drafts[0].summary.reviewReasons).toContain('matched_catalogue_salary_without_employer');
  });
});

describe('every code the adapter / service emits has user words (GAP-07)', () => {
  it('review reasons and field reason codes', async () => {
    const { REVIEW_REASON_TEXT, FIELD_REASON_TEXT } = await import('@/lib/income/payslipProposalText');
    const src = ['lib/import-bridge/adapters/incomeAdapter.ts', 'lib/import-bridge/incomeProposalService.ts']
      .map((f) => fs.readFileSync(path.join(process.cwd(), f), 'utf8')).join('\n');
    const reasons = [...src.matchAll(/reviewReasons\.push\('([a-z_]+)'\)/g)].map((m) => m[1]);
    // Every quoted snake_case token on a line that sets a field's reasonCode.
    const fieldCodes = src.split('\n').filter((l) => /reasonCode[:=]/.test(l) && !/reasonCode: opts/.test(l))
      .flatMap((l) => [...l.slice(l.indexOf('reasonCode')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    expect(reasons.length).toBeGreaterThanOrEqual(12);
    expect(new Set(fieldCodes).size).toBeGreaterThanOrEqual(10);
    for (const r of reasons) expect(REVIEW_REASON_TEXT[r], r).toBeTruthy();
    for (const c of new Set(fieldCodes)) expect(FIELD_REASON_TEXT[c], c).toBeTruthy();
  });
});

describe('the correction form covers the full RPC vocabulary (GAP-07)', () => {
  it("PayslipImportPanel's CORRECTABLE_FIELDS == fdh9_correct_payroll_event's keys", async () => {
    const svc = await import('@/lib/financial-data-hub/services/payslipProcessingService');
    const rpcKeys = [...svc.PAYROLL_CORRECTABLE_TEXT_FIELDS, ...svc.PAYROLL_CORRECTABLE_DATE_FIELDS, ...svc.PAYROLL_CORRECTABLE_MONEY_FIELDS, 'pay_frequency'].sort();
    const panel = fs.readFileSync(path.join(process.cwd(), 'components/income/PayslipImportPanel.tsx'), 'utf8');
    const block = panel.slice(panel.indexOf('const CORRECTABLE_FIELDS = ['), panel.indexOf('] as const;', panel.indexOf('const CORRECTABLE_FIELDS = [')));
    const panelKeys = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(panelKeys).toEqual(rpcKeys);
  });
});
