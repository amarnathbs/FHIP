/**
 * FHIP Input Data Import Bridge — Income proposal generation (spec sections
 * 4, 21, 29, 36-37).
 *
 * This is the ONLY place that turns approved payroll EVIDENCE into an inert
 * Income PROPOSAL. It performs no Income mutation of any kind — it reads the
 * payroll event, reads the user's existing Income sources, asks
 * `incomeAdapter.buildProposal()` for a draft, and persists it via
 * `persistProposal()`. Nothing here calls `fdh9_apply_income_proposal` or
 * writes to `income_sources` (spec section 4's "generating a proposal does
 * not change Income").
 *
 * GATED ON APPROVAL (spec section 4's journey: "...Approve payroll evidence
 * -> Generate Income proposal..."). A proposal is only generated for a
 * payroll event whose `approval_status` is `'approved'` — the one legitimate
 * way to reach that state is `fdh9_approve_payroll_event()`
 * (`applyIncomeProposalAtomic.ts`'s `approvePayrollEventAtomic`).
 */

import { createClient } from '@/lib/supabase/server';
import { deriveGrossBasis, findDuplicateIncome, incomeAdapter, type ExistingIncomeRow, type GrossBasisComponent, type IncomeEvidence } from './adapters/incomeAdapter';
import { isMissingColumn, persistProposal } from './supabaseStore';
import type { ImportProposalSummary } from './types';

/**
 * A deliberate, tiny DUPLICATE of `lib/financial-data-hub/payslip/frequency
 * .ts`'s `toCanonicalIncomeFrequency()`, not an import of it.
 * `tests/unit/fdh1Isolation.test.ts` mechanically forbids any file outside
 * `lib/financial-data-hub/` (other than the two already-named, hand-verified
 * exceptions) from importing that tree — see this file's own note at the call
 * site below and `FDH9_REUSE_AND_GAP_AUDIT.md` for the full rationale. The
 * function is six lines and has no dependency of its own, so duplicating it
 * here preserves the isolation boundary at essentially zero cost; a change to
 * the canonical Income frequency vocabulary would need to update both
 * (unlikely — the six-value enum is fixed by the `income_sources.frequency`
 * check constraint).
 */
function canonicalIncomeFrequencyFor(payFrequency: string): string | null {
  switch (payFrequency) {
    case 'weekly': return 'weekly';
    case 'fortnightly': return 'fortnightly';
    case 'monthly': return 'monthly';
    case 'quarterly': return 'quarterly';
    case 'annual': return 'annually';
    default: return null; // semimonthly / irregular / unknown have no canonical equivalent
  }
}

export class IncomeProposalError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_approved' | 'already_applied' | 'superseded' | 'invalid_frequency' | 'internal_error',
    message: string,
    /** For `already_applied`: the Income row this payslip is already in. */
    readonly targetEntityId: string | null = null,
  ) {
    super(message);
    this.name = 'IncomeProposalError';
  }
}

/** The Income frequencies a user may choose for a payslip whose own frequency
 * has none (GAP-12) -- the canonical `income_sources.frequency` vocabulary. */
export const CHOOSABLE_INCOME_FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually'] as const;
export type ChoosableIncomeFrequency = (typeof CHOOSABLE_INCOME_FREQUENCIES)[number];

const PAYS_PER_YEAR: Record<ChoosableIncomeFrequency, number> = { weekly: 52, fortnightly: 26, monthly: 12, quarterly: 4, annually: 1 };

/**
 * GAP-12. How one pay converts to the frequency the user chose. A
 * SEMIMONTHLY pay is paid 24 times a year, so it converts exactly
 * (x 24 / pays-per-year: monthly = x2). An irregular / unknown payslip carries
 * no cadence of its own: the user is telling us how often THIS amount is
 * paid, so it is taken as-is. A payslip that already has a canonical
 * frequency is never overridden here -- the proposal's own frequency stands.
 */
export function frequencyChoiceFor(payFrequency: string, chosen: ChoosableIncomeFrequency): { frequency: string; scale: number } | null {
  if (canonicalIncomeFrequencyFor(payFrequency) !== null) return null;
  if (payFrequency === 'semimonthly') return { frequency: chosen, scale: Number((24 / PAYS_PER_YEAR[chosen]).toFixed(6)) };
  return { frequency: chosen, scale: 1 };
}

interface PayrollEventRow {
  id: string;
  user_id: string;
  statement_upload_id: string | null;
  employer_name: string | null;
  employer_normalised?: string | null;
  currency_code: string;
  pay_frequency: string;
  pay_frequency_source: string;
  pay_period_start?: string | null;
  pay_period_end?: string | null;
  gross_pay: number | null;
  net_pay: number | null;
  bonus_pay: number | null;
  overtime_pay: number | null;
  commission_pay: number | null;
  other_earnings: number | null;
  reimbursements_total: number | null;
  salary_sacrifice?: number | null;
  reconciliation_status: string;
  bank_match_status: 'matched' | 'no_match' | 'multiple_candidates' | 'not_attempted';
  approval_status: string;
  superseded_by_payroll_event_id?: string | null;
  payslip_fingerprint?: string | null;
  created_at?: string | null;
  /** 0207. Null = never chosen (approved before 0210) = self. */
  income_owner?: string | null;
}

const EVENT_COLUMNS =
  'id, user_id, statement_upload_id, employer_name, employer_normalised, currency_code, pay_frequency, pay_frequency_source, pay_period_start, pay_period_end, gross_pay, net_pay, bonus_pay, overtime_pay, commission_pay, other_earnings, reimbursements_total, salary_sacrifice, reconciliation_status, bank_match_status, approval_status, superseded_by_payroll_event_id, payslip_fingerprint, created_at';

/** Builds the generic bridge's `IncomeEvidence` from one payroll event row.
 * See `incomeAdapter.ts`'s own header for the four financial-correctness
 * rules this shape exists to enforce (gross-never-net, variable-pay-excluded,
 * reimbursements-are-not-income, employer-contributions-are-not-cash-income). */
export function toIncomeEvidence(
  event: PayrollEventRow,
  extras: {
    components?: readonly GrossBasisComponent[];
    owner?: 'self' | 'spouse';
    frequencyChoice?: { frequency: string; scale: number } | null;
    excludedCurrencyCandidate?: { name: string; currency: string } | null;
    revises?: { payrollEventId: string; periodEnd: string | null } | null;
  } = {},
): IncomeEvidence {
  const reviewReasons: string[] = [];
  if (event.reconciliation_status === 'variance') reviewReasons.push('gross_to_net_variance');
  if (event.reconciliation_status === 'insufficient_data') reviewReasons.push('gross_to_net_insufficient_data');

  // GAP-16: decided from the payslip's own component lines when they add up.
  // Without that proof the conservative FDH-9 default stands (spec section
  // 38: reimbursements are not income -> subtract), but it is now RECORDED as
  // an assumption and shown, instead of silently applied.
  const grossBasis = deriveGrossBasis({
    grossPay: event.gross_pay ?? undefined,
    reimbursementsTotal: event.reimbursements_total ?? undefined,
    salarySacrifice: event.salary_sacrifice ?? undefined,
    components: extras.components ?? [],
  });

  return {
    payrollEventId: event.id,
    employerName: event.employer_name ?? undefined,
    currencyCode: event.currency_code,
    canonicalFrequency: canonicalIncomeFrequencyFor(event.pay_frequency),
    frequencyStated: event.pay_frequency_source === 'stated_on_payslip' || event.pay_frequency_source === 'user_confirmed',
    grossPay: event.gross_pay ?? undefined,
    netPay: event.net_pay ?? undefined,
    bonusPay: event.bonus_pay ?? undefined,
    overtimePay: event.overtime_pay ?? undefined,
    commissionPay: event.commission_pay ?? undefined,
    arrearsPay: event.other_earnings ?? undefined,
    reimbursementsTotal: event.reimbursements_total ?? undefined,
    reimbursementsIncludedInGross: grossBasis.reimbursementsIncludedInGross,
    salarySacrifice: event.salary_sacrifice ?? undefined,
    grossBasis,
    reviewReasons,
    bankMatchStatus: event.bank_match_status,
    owner: extras.owner,
    frequencyChoice: extras.frequencyChoice ?? null,
    excludedCurrencyCandidate: extras.excludedCurrencyCandidate ?? null,
    revises: extras.revises ?? null,
  };
}

/** The payroll event, with 0207's income_owner when that column exists. */
async function loadEvent(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, payrollEventId: string): Promise<PayrollEventRow | null> {
  const withOwner = await supabase.from('fdh_payroll_events').select(`${EVENT_COLUMNS}, income_owner`).eq('id', payrollEventId).eq('user_id', userId).maybeSingle();
  if (!withOwner.error) return (withOwner.data as PayrollEventRow | null) ?? null;
  if (!isMissingColumn(withOwner.error, 'income_owner')) return null;
  const without = await supabase.from('fdh_payroll_events').select(EVENT_COLUMNS).eq('id', payrollEventId).eq('user_id', userId).maybeSingle();
  return without.error ? null : ((without.data as PayrollEventRow | null) ?? null);
}

/** The Income application this payroll event already produced, if any (GAP-04). */
export async function findIncomeApplicationForEvent(userId: string, payrollEventId: string): Promise<{ id: string; target_entity_id: string } | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fhip_import_applications')
    .select('id, target_entity_id, applied_at')
    .eq('user_id', userId)
    .eq('target_domain', 'income')
    .eq('source_payroll_event_id', payrollEventId)
    .order('applied_at', { ascending: true })
    .limit(1);
  const row = ((data ?? []) as Array<{ id: string; target_entity_id: string }>)[0];
  return row ? { id: row.id, target_entity_id: row.target_entity_id } : null;
}

/** An earlier payslip this one revises: same employer, same period, same
 * currency, different content (mirrors the 0210 supersede RPC's own rule). */
async function findRevisedEvent(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, event: PayrollEventRow): Promise<PayrollEventRow | null> {
  if (!event.employer_normalised || !event.pay_period_end) return null;
  const { data } = await supabase
    .from('fdh_payroll_events')
    .select(EVENT_COLUMNS)
    .eq('user_id', userId)
    .eq('employer_normalised', event.employer_normalised)
    .eq('pay_period_end', event.pay_period_end)
    .neq('id', event.id)
    .order('created_at', { ascending: false })
    .limit(10);
  return ((data ?? []) as PayrollEventRow[]).find((e) =>
    e.superseded_by_payroll_event_id === event.id
    || (e.superseded_by_payroll_event_id == null
      && e.currency_code === event.currency_code
      && e.payslip_fingerprint !== event.payslip_fingerprint
      && (!e.pay_period_start || !event.pay_period_start || e.pay_period_start === event.pay_period_start)
      && (e.created_at ?? '') <= (event.created_at ?? ''))) ?? null;
}

export interface GenerateIncomeProposalOptions {
  /** GAP-12: the frequency the user chose for a semimonthly / irregular /
   * unknown payslip. Ignored (the payslip's own frequency stands) when the
   * payslip already has a canonical frequency. */
  frequency?: ChoosableIncomeFrequency;
}

/**
 * Generate (or regenerate) the Income proposal for one approved payroll
 * event. Regenerating supersedes any earlier 'ready' proposal for the same
 * event (see `persistProposal`'s own header) so at most one proposal is ever
 * live/applicable per payroll event at a time.
 *
 * WP-09: refuses (`already_applied`, with the Income row it is in) once the
 * event has an Income application -- idempotency per payroll EVENT, not per
 * proposal (GAP-04; the 0210 RPC and unique index are the backstop).
 */
export async function generateIncomeProposal(
  userId: string,
  payrollEventId: string,
  options: GenerateIncomeProposalOptions = {},
): Promise<{ proposalId: string; statementUploadId: string | null; recommendedApplyMode: string; summary: IncomeProposalSummary }> {
  const supabase = await createClient();

  const row = await loadEvent(supabase, userId, payrollEventId);
  if (!row) throw new IncomeProposalError('not_found', 'That payroll event could not be found.');
  if (row.approval_status !== 'approved') {
    throw new IncomeProposalError('not_approved', 'Approve this payroll evidence before generating an Income proposal.');
  }
  if (row.superseded_by_payroll_event_id) {
    throw new IncomeProposalError('superseded', 'A revised version of this payslip has replaced it.');
  }

  const existingApplication = await findIncomeApplicationForEvent(userId, payrollEventId);
  if (existingApplication) {
    throw new IncomeProposalError('already_applied', 'This payslip is already in your income.', existingApplication.target_entity_id);
  }

  let frequencyChoice: { frequency: string; scale: number } | null = null;
  if (options.frequency) {
    if (!(CHOOSABLE_INCOME_FREQUENCIES as readonly string[]).includes(options.frequency)) {
      throw new IncomeProposalError('invalid_frequency', 'Choose weekly, fortnightly, monthly, quarterly or annually.');
    }
    frequencyChoice = frequencyChoiceFor(row.pay_frequency, options.frequency);
  }

  // GAP-05. The candidate pool is the household member the payslip was
  // approved for (null = approved before 0210 = self). The 0210 RPC enforces
  // the same boundary (MEMBER_MISMATCH), so this is the UX half of a guard
  // that holds without it -- the FDH-15 DEF-001 fix, generalised to spouses.
  const owner: 'self' | 'spouse' = row.income_owner === 'spouse' ? 'spouse' : 'self';
  const { data: existingRows } = await supabase
    .from('income_sources')
    .select('id, source_name, income_type, amount, net_amount, frequency, currency_code, owner, is_taxable, employer_name, notes, master_item_key, source_type, updated_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .eq('owner', owner);
  const ownerRows = (existingRows ?? []) as ExistingIncomeRow[];

  // GAP-03. A row in another currency is never offered as the target: one
  // currency's figures are never written into another's row (the RPC refuses
  // it as CURRENCY_MISMATCH too). The user is told which row was skipped.
  const sameCurrency = ownerRows.filter((r) => r.currency_code === row.currency_code);
  const skipped = ownerRows.filter((r) => r.currency_code !== row.currency_code);
  const skippedRow = skipped.length > 0 ? findDuplicateIncome(toIncomeEvidence(row), skipped) : null;

  const { data: componentRows } = await supabase
    .from('fdh_payroll_components')
    .select('component_side, component_type, amount, is_year_to_date')
    .eq('user_id', userId)
    .eq('payroll_event_id', payrollEventId);
  const components: GrossBasisComponent[] = ((componentRows ?? []) as Array<{ component_side: string; component_type: string; amount: number; is_year_to_date: boolean }>)
    .map((c) => ({ side: c.component_side, type: c.component_type, amount: Number(c.amount), isYearToDate: Boolean(c.is_year_to_date) }));

  const revised = await findRevisedEvent(supabase, userId, row);

  const evidence = toIncomeEvidence(row, {
    components,
    owner,
    frequencyChoice,
    excludedCurrencyCandidate: skippedRow ? { name: skippedRow.source_name, currency: skippedRow.currency_code } : null,
    revises: revised ? { payrollEventId: revised.id, periodEnd: revised.pay_period_end ?? null } : null,
  });
  const draft = incomeAdapter.buildProposal(evidence, sameCurrency);
  const proposalId = await persistProposal(userId, draft, payrollEventId);

  // The FDH document-audit-event write ('income_proposal_generated') is
  // deliberately NOT done here — it lives in the API route caller
  // (app/api/financial-data-hub/payslip/[documentId]/proposal/route.ts),
  // which already sits inside the one approved FDH consumer surface, so this
  // generic bridge module never needs to import anything from
  // `lib/financial-data-hub/` (see `canonicalIncomeFrequencyFor` above for
  // the same discipline applied to frequency mapping).
  return { proposalId, statementUploadId: row.statement_upload_id, recommendedApplyMode: draft.recommendedApplyMode, summary: draft.summary };
}

export type IncomeProposalSummary = ImportProposalSummary;

/** Read-model for the compare screen (spec sections 37-38). No write. The
 * stored summary (0207) is returned when the column exists. */
export async function getIncomeProposalForReview(userId: string, proposalId: string) {
  const supabase = await createClient();
  const cols = 'id, target_domain, source_kind, source_payroll_event_id, target_entity_id, recommended_apply_mode, duplicate_of_entity_id, status, currency_code, generated_at';
  let { data: proposal, error } = await supabase
    .from('fhip_import_proposals')
    .select(`${cols}, summary`)
    .eq('id', proposalId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error && isMissingColumn(error, 'summary')) {
    ({ data: proposal, error } = await supabase.from('fhip_import_proposals').select(cols).eq('id', proposalId).eq('user_id', userId).maybeSingle());
  }
  if (error || !proposal) return null;

  const { data: fields } = await supabase
    .from('fhip_import_proposal_fields')
    .select('field_name, value_kind, proposed_value, existing_value, is_recommended, requires_confirmation, confidence, reason_code')
    .eq('proposal_id', proposalId)
    .eq('user_id', userId);

  return { proposal, fields: fields ?? [] };
}

/**
 * GAP-07: the payslip behind an imported Income row -- income_sources
 * .last_import_application_id -> fhip_import_applications
 * .source_payroll_event_id -> the payroll event and its component lines.
 * Read-only, user-scoped on every query. Null when the row was not imported
 * from a payslip (or the evidence is gone).
 */
export async function getPayslipDetailsForIncomeSource(userId: string, incomeSourceId: string) {
  const supabase = await createClient();
  const { data: source } = await supabase
    .from('income_sources')
    .select('id, source_name, source_type, last_import_application_id, last_imported_at')
    .eq('user_id', userId)
    .eq('id', incomeSourceId)
    .maybeSingle();
  const s = source as { id: string; source_name: string; source_type: string | null; last_import_application_id: string | null; last_imported_at: string | null } | null;
  if (!s || s.source_type !== 'payslip_import' || !s.last_import_application_id) return null;
  const { data: application } = await supabase
    .from('fhip_import_applications')
    .select('id, source_payroll_event_id, applied_at, apply_mode, applied_fields')
    .eq('user_id', userId)
    .eq('id', s.last_import_application_id)
    .maybeSingle();
  const a = application as { id: string; source_payroll_event_id: string | null; applied_at: string; apply_mode: string; applied_fields: unknown } | null;
  if (!a?.source_payroll_event_id) return null;
  const { data: event } = await supabase.from('fdh_payroll_events').select('*').eq('user_id', userId).eq('id', a.source_payroll_event_id).maybeSingle();
  if (!event) return null;
  const { data: components } = await supabase
    .from('fdh_payroll_components')
    .select('*')
    .eq('user_id', userId)
    .eq('payroll_event_id', a.source_payroll_event_id)
    .order('created_at', { ascending: true });
  return {
    income_source: { id: s.id, source_name: s.source_name, last_imported_at: s.last_imported_at },
    application: { id: a.id, applied_at: a.applied_at, apply_mode: a.apply_mode, applied_fields: Array.isArray(a.applied_fields) ? (a.applied_fields as string[]) : [] },
    payroll_event: event,
    components: components ?? [],
  };
}

/** All 'ready' proposals awaiting a decision, for the Income tab's
 * "you have a payslip proposal to review" banner. */
export async function listReadyIncomeProposals(userId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fhip_import_proposals')
    .select('id, source_payroll_event_id, recommended_apply_mode, generated_at')
    .eq('user_id', userId)
    .eq('target_domain', 'income')
    .eq('status', 'ready')
    .order('generated_at', { ascending: false });
  return data ?? [];
}

/**
 * The same 'ready' proposals, with the upload each came from and a short
 * summary of its payslip -- so the Income-tab panel can offer "continue" for
 * a proposal the user left (closed the panel, reloaded the page). Before
 * 2026-09-25 nothing on screen listed them, so a closed panel stranded its
 * proposal; a re-upload only reached the duplicate guard.
 */
export async function listReadyIncomeProposalsWithSource(userId: string) {
  const proposals = await listReadyIncomeProposals(userId);
  const eventIds = [...new Set(proposals.map((p) => p.source_payroll_event_id).filter(Boolean))] as string[];
  if (eventIds.length === 0) return [];
  const supabase = await createClient();
  const { data: events } = await supabase
    .from('fdh_payroll_events')
    .select('id, statement_upload_id, employer_name, gross_pay, net_pay, pay_frequency, payment_date, currency_code')
    .eq('user_id', userId)
    .in('id', eventIds);
  type Ev = { id: string; statement_upload_id: string | null; employer_name: string | null; gross_pay: number | null; net_pay: number | null; pay_frequency: string | null; payment_date: string | null; currency_code: string | null };
  const byId = new Map(((events ?? []) as Ev[]).map((e) => [e.id, e]));
  return proposals
    .map((p) => {
      const e = byId.get(p.source_payroll_event_id as string);
      if (!e?.statement_upload_id) return null;
      return {
        id: p.id as string, // kept: the list's original key
        proposal_id: p.id as string,
        source_payroll_event_id: p.source_payroll_event_id as string,
        document_id: e.statement_upload_id,
        recommended_apply_mode: p.recommended_apply_mode as string,
        generated_at: p.generated_at as string,
        employer_name: e.employer_name,
        gross_pay: e.gross_pay,
        net_pay: e.net_pay,
        pay_frequency: e.pay_frequency,
        payment_date: e.payment_date,
        currency_code: e.currency_code,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
