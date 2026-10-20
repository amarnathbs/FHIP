/**
 * Retirement contribution ledger service (Document2 (4) F25 / F25b). Server only; every read and write runs as the signed-in
 * person through row level security, so nobody can read or change another person's rows.
 *
 *  - recordManualContribution : a typed contribution. It is NEVER a balance and never touches current_balance.
 *  - recordPayslipContribution: the employer super on an APPROVED payslip. Idempotent per payslip (a unique index), so the same
 *    payslip uploaded twice, or approved twice, cannot add a second row. Nothing here runs before the person approves the payslip.
 *  - chooseDestination        : the person picks where a waiting payslip contribution goes.
 *  - syncAccountRates         : writes the account's two contribution figures from the ledger so every existing consumer keeps
 *    reading one place and a contribution is counted exactly once (rules in runRate.ts).
 *
 * The SMSF side is the small SmsfDestinationProvider interface below. The default provider reads smsf_funds directly; the SMSF
 * module can supply its own without any change here. An SMSF destination is the fund's OWN retirement account row, whose two
 * contribution columns are what the existing SMSF contribution reconciliation already reads, so an SMSF contribution shows in the
 * SMSF tab and reports through the existing view.
 */
import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import { toMonthly, type Frequency } from '@/lib/engines/money';
import { resolveAccountRates } from './runRate';
import { routePayslipContribution, type DestinationCandidate, type RoutingResult } from './routing';
import { BUCKET_OF_TYPE, type ContributionFrequency, type ContributionType, type LedgerRow } from './types';

type Client = SupabaseServerClient;
type DbRow = Record<string, unknown>;

export interface SmsfDestinationProvider {
  /** The person's active SMSF funds as destinations (the fund's own retirement account row). */
  listSmsfDestinations(userId: string, client: Client): Promise<DestinationCandidate[]>;
}

export const defaultSmsfDestinationProvider: SmsfDestinationProvider = {
  async listSmsfDestinations(userId, client) {
    const { data: funds, error } = await client.from('smsf_funds').select('id, fund_name, retirement_account_id').eq('user_id', userId).eq('is_active', true);
    if (error) throw new Error(error.message);
    const ids = (funds ?? []).map((f: DbRow) => f.retirement_account_id as string);
    if (ids.length === 0) return [];
    const { data: accounts, error: accErr } = await client.from('retirement_accounts').select('id, owner, currency_code, retirement_member_id, is_active').eq('user_id', userId).in('id', ids);
    if (accErr) throw new Error(accErr.message);
    const byId = new Map((accounts ?? []).map((a: DbRow) => [a.id as string, a]));
    return (funds ?? []).flatMap((f: DbRow) => {
      const a = byId.get(f.retirement_account_id as string);
      if (!a || a.is_active === false) return [];
      return [{
        accountId: f.retirement_account_id as string,
        kind: 'smsf' as const,
        name: String(f.fund_name ?? ''),
        ownerRole: (a.owner as string | null) ?? null,
        memberId: (a.retirement_member_id as string | null) ?? null,
        currency: String(a.currency_code ?? 'AUD'),
        fundId: f.id as string,
      }];
    });
  },
};

export function mapLedgerRow(r: DbRow): LedgerRow {
  const meta = (r.metadata ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id),
    retirementAccountId: (r.retirement_account_id as string | null) ?? null,
    destinationKind: (r.destination_kind as LedgerRow['destinationKind']) ?? null,
    memberId: (r.retirement_member_id as string | null) ?? null,
    type: r.contribution_type as ContributionType,
    amount: Number(r.amount),
    currency: String(r.currency_code),
    frequency: (r.frequency as ContributionFrequency | null) ?? null,
    contributionDate: (r.contribution_date as string | null) ?? null,
    sourceType: r.source_type as LedgerRow['sourceType'],
    payrollEventId: (r.source_payroll_event_id as string | null) ?? null,
    employerNormalised: (r.employer_normalised as string | null) ?? null,
    status: r.status as LedgerRow['status'],
    createdAt: String(r.created_at ?? ''),
    isAdoptedLegacy: meta.adopted_legacy === true,
  };
}

const LEDGER_COLUMNS =
  'id, user_id, retirement_account_id, destination_kind, retirement_member_id, contribution_type, amount, currency_code, frequency, contribution_date, source_type, source_payroll_event_id, source_label, employer_name, employer_normalised, matched_by, status, notes, metadata, created_at, updated_at';

export async function listLedgerRows(userId: string, client: Client): Promise<DbRow[]> {
  const { data, error } = await client.from('retirement_contributions').select(LEDGER_COLUMNS).eq('user_id', userId).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as DbRow[];
}

export async function loadDestinationCandidates(userId: string, client: Client, smsf: SmsfDestinationProvider = defaultSmsfDestinationProvider): Promise<DestinationCandidate[]> {
  const { data, error } = await client
    .from('retirement_accounts')
    .select('id, account_name, owner, currency_code, retirement_member_id, master_item_key, is_active')
    .eq('user_id', userId)
    .eq('is_active', true);
  if (error) throw new Error(error.message);
  const plain: DestinationCandidate[] = (data ?? [])
    .filter((a: DbRow) => a.master_item_key !== 'smsf')
    .map((a: DbRow) => ({
      accountId: a.id as string,
      kind: 'retirement_account' as const,
      name: String(a.account_name ?? ''),
      ownerRole: (a.owner as string | null) ?? null,
      memberId: (a.retirement_member_id as string | null) ?? null,
      currency: String(a.currency_code ?? 'AUD'),
    }));
  return [...(await smsf.listSmsfDestinations(userId, client)), ...plain];
}

/**
 * Write the account's contribution figures from the ledger. A no-op for an account the ledger has never touched (its own
 * figures stay exactly as they are). Both figures are written as MONTHLY amounts with frequency 'monthly', because the account
 * holds one frequency for both.
 */
export async function syncAccountRates(userId: string, accountId: string, client: Client): Promise<{ employerMonthly: number; personalMonthly: number } | null> {
  const { data, error } = await client.from('retirement_contributions').select(LEDGER_COLUMNS).eq('user_id', userId).eq('retirement_account_id', accountId);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as DbRow[]).map(mapLedgerRow);
  if (rows.length === 0) return null;
  const rate = resolveAccountRates(rows).get(accountId);
  const employerMonthly = rate?.employerMonthly ?? 0;
  const personalMonthly = rate?.personalMonthly ?? 0;
  const { error: upErr } = await client
    .from('retirement_accounts')
    .update({ employer_contribution: employerMonthly, personal_contribution: personalMonthly, contribution_frequency: 'monthly' })
    .eq('id', accountId)
    .eq('user_id', userId);
  if (upErr) throw new Error(upErr.message);
  return { employerMonthly, personalMonthly };
}

/**
 * First contribution recorded for an account that already holds a figure of its own in the two contribution columns: keep that
 * figure as a placeholder ledger row (never lost, never doubled) before the ledger takes over the columns. Any real record for
 * the same flow replaces it (see isAdoptedLegacy in runRate.ts). `allowedExistingRows` is how many ledger rows the account may
 * already have for this to count as "first" (0 before a manual insert, 1 right after a payslip row was inserted).
 */
async function adoptLegacyFigures(userId: string, accountId: string, client: Client, allowedExistingRows: number): Promise<number> {
  const { data: account, error: accErr } = await client
    .from('retirement_accounts')
    .select('id, currency_code, retirement_member_id, master_item_key, employer_contribution, personal_contribution, contribution_frequency')
    .eq('id', accountId)
    .eq('user_id', userId)
    .maybeSingle();
  if (accErr) throw new Error(accErr.message);
  if (!account) return 0;
  const { count, error } = await client.from('retirement_contributions').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('retirement_account_id', accountId);
  if (error) throw new Error(error.message);
  if ((count ?? 0) > allowedExistingRows) return 0;
  const freq = (account.contribution_frequency as ContributionFrequency | null) ?? null;
  const rows: DbRow[] = [];
  for (const [col, type] of [['employer_contribution', 'employer'], ['personal_contribution', 'personal']] as const) {
    const amount = Number((account as DbRow)[col] ?? 0);
    if (!(amount > 0)) continue;
    rows.push({
      user_id: userId,
      retirement_account_id: accountId,
      destination_kind: account.master_item_key === 'smsf' ? 'smsf' : 'retirement_account',
      retirement_member_id: account.retirement_member_id ?? null,
      contribution_type: type,
      amount,
      currency_code: account.currency_code,
      frequency: freq,
      contribution_date: freq ? null : new Date().toISOString().slice(0, 10),
      source_type: 'manual',
      status: 'active',
      matched_by: 'manual',
      notes: 'Recorded on the account before contributions were tracked separately.',
      metadata: { adopted_legacy: true, original_frequency: freq },
    });
  }
  if (rows.length === 0) return 0;
  const { error: insErr } = await client.from('retirement_contributions').insert(rows);
  if (insErr) throw new Error(insErr.message);
  return rows.length;
}

export interface ManualContributionInput {
  accountId: string;
  type: ContributionType;
  amount: number;
  frequency: ContributionFrequency | null;
  /** yyyy-mm-dd; required when there is no frequency (or for a one-off). */
  contributionDate: string | null;
  notes?: string | null;
}

export type RecordResult =
  | { ok: true; id: string; adoptedLegacy: number }
  | { ok: false; code: 'ACCOUNT_NOT_FOUND' | 'WRITE_FAILED'; message: string };

export async function recordManualContribution(userId: string, input: ManualContributionInput, client: Client): Promise<RecordResult> {
  const { data: account, error } = await client
    .from('retirement_accounts')
    .select('id, account_name, owner, currency_code, retirement_member_id, master_item_key, employer_contribution, personal_contribution, contribution_frequency, is_active')
    .eq('id', input.accountId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { ok: false, code: 'WRITE_FAILED', message: error.message };
  if (!account || account.is_active === false) return { ok: false, code: 'ACCOUNT_NOT_FOUND', message: 'That retirement account was not found.' };

  const adoptedLegacy = await adoptLegacyFigures(userId, account.id as string, client, 0);
  const { data: inserted, error: insErr } = await client
    .from('retirement_contributions')
    .insert({
      user_id: userId,
      retirement_account_id: account.id,
      destination_kind: account.master_item_key === 'smsf' ? 'smsf' : 'retirement_account',
      retirement_member_id: account.retirement_member_id ?? null,
      contribution_type: input.type,
      amount: input.amount,
      currency_code: account.currency_code,
      frequency: input.frequency,
      contribution_date: input.contributionDate,
      source_type: 'manual',
      status: 'active',
      matched_by: 'manual',
      notes: input.notes ?? null,
    })
    .select('id')
    .single();
  if (insErr || !inserted) return { ok: false, code: 'WRITE_FAILED', message: insErr?.message ?? 'Could not save the contribution.' };
  await syncAccountRates(userId, account.id as string, client);
  return { ok: true, id: inserted.id as string, adoptedLegacy };
}

export interface PayslipContributionOutcome {
  /** none = the payslip shows no employer super; recorded = a ledger row exists (new or already there). */
  status: 'none' | 'recorded';
  contributionId?: string;
  /** active = went to a destination; needs_destination = waiting for the person to choose. */
  ledgerStatus?: 'active' | 'needs_destination' | 'superseded' | 'removed';
  alreadyRecorded?: boolean;
  amount?: number;
  currency?: string;
  destinationName?: string | null;
  destinationKind?: 'smsf' | 'retirement_account' | null;
  routing?: RoutingResult['kind'];
  askReason?: string;
}

const PAY_FREQ_TO_LEDGER: Record<string, ContributionFrequency | undefined> = {
  weekly: 'weekly', fortnightly: 'fortnightly', monthly: 'monthly', quarterly: 'quarterly', annual: 'annually',
};

/**
 * The employer super on a payslip the person has just APPROVED. Never call this before approval. Exactly once per payslip.
 */
export async function recordPayslipContribution(
  userId: string,
  payrollEventId: string,
  client: Client,
  smsf: SmsfDestinationProvider = defaultSmsfDestinationProvider,
): Promise<PayslipContributionOutcome> {
  const { data: event, error } = await client
    .from('fdh_payroll_events')
    .select('id, employer_name, employer_normalised, payment_date, pay_period_end, pay_frequency, currency_code, employer_retirement_contribution, income_owner, approval_status, superseded_by_payroll_event_id')
    .eq('id', payrollEventId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!event || event.approval_status !== 'approved' || event.superseded_by_payroll_event_id) return { status: 'none' };
  const amount = Number(event.employer_retirement_contribution ?? 0);
  if (!(amount > 0)) return { status: 'none' };

  // Exactly once per payslip: an existing row (any status) is the answer; a second call never adds another.
  const existing = await client.from('retirement_contributions').select('id, status, amount, currency_code, retirement_account_id, destination_kind').eq('user_id', userId).eq('source_payroll_event_id', payrollEventId).eq('contribution_type', 'employer').maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) {
    return { status: 'recorded', contributionId: existing.data.id as string, ledgerStatus: existing.data.status as 'active', alreadyRecorded: true, amount: Number(existing.data.amount), currency: String(existing.data.currency_code) };
  }

  const owner: 'self' | 'spouse' = event.income_owner === 'spouse' ? 'spouse' : 'self';
  const currency = String(event.currency_code ?? 'AUD');

  const comps = await client.from('fdh_payroll_components').select('label_raw, component_type, is_year_to_date').eq('user_id', userId).eq('payroll_event_id', payrollEventId).eq('component_type', 'employer_retirement');
  if (comps.error) throw new Error(comps.error.message);
  const labels = (comps.data ?? []).filter((c: DbRow) => c.is_year_to_date !== true).map((c: DbRow) => String(c.label_raw ?? '')).filter(Boolean);

  const all = await loadDestinationCandidates(userId, client, smsf);
  const sameCurrency = all.filter((c) => c.currency === currency);
  const route = routePayslipContribution({ contributionLabels: labels, employerName: (event.employer_name as string | null) ?? null, payslipOwner: owner, candidates: sameCurrency });

  const members = await client.from('retirement_members').select('id, member_type').eq('user_id', userId).eq('member_type', owner).eq('is_active', true).maybeSingle();
  const memberId = (members.data?.id as string | undefined) ?? null;

  const freq = PAY_FREQ_TO_LEDGER[String(event.pay_frequency ?? 'unknown')] ?? null;
  const date = (event.payment_date as string | null) ?? (event.pay_period_end as string | null) ?? new Date().toISOString().slice(0, 10);
  const matched = route.kind === 'matched' ? route.candidate : null;
  const row = {
    user_id: userId,
    retirement_account_id: matched?.accountId ?? null,
    destination_kind: matched?.kind ?? null,
    retirement_member_id: matched?.memberId ?? memberId,
    contribution_type: 'employer',
    amount,
    currency_code: currency,
    frequency: freq ?? null,
    contribution_date: date,
    source_type: 'payslip',
    source_payroll_event_id: payrollEventId,
    source_label: labels.join(' | ').slice(0, 300) || null,
    employer_name: (event.employer_name as string | null) ?? null,
    // The payslip evidence already carries the normalised employer name; the plain lower-case name is only a fallback for the series key.
    employer_normalised: (event.employer_normalised as string | null) ?? ((event.employer_name as string | null)?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || null),
    matched_by: matched ? 'fund_name' : null,
    status: matched ? 'active' : 'needs_destination',
    metadata: matched ? { matched_words: route.kind === 'matched' ? route.matchedWords : [] } : { ask_reason: route.kind === 'ask' ? route.reason : null },
  };
  const inserted = await client.from('retirement_contributions').insert(row).select('id').single();
  if (inserted.error) {
    if ((inserted.error as { code?: string }).code === '23505') {
      // A concurrent approval inserted it first. That row is the one row for this payslip.
      const again = await client.from('retirement_contributions').select('id, status, amount, currency_code').eq('user_id', userId).eq('source_payroll_event_id', payrollEventId).eq('contribution_type', 'employer').maybeSingle();
      return { status: 'recorded', contributionId: again.data?.id as string, ledgerStatus: again.data?.status as 'active', alreadyRecorded: true, amount, currency };
    }
    throw new Error(inserted.error.message);
  }
  if (matched) {
    await adoptLegacyFigures(userId, matched.accountId, client, 1);
    await syncAccountRates(userId, matched.accountId, client);
  }
  return {
    status: 'recorded',
    contributionId: inserted.data.id as string,
    ledgerStatus: matched ? 'active' : 'needs_destination',
    alreadyRecorded: false,
    amount,
    currency,
    destinationName: matched?.name ?? null,
    destinationKind: matched?.kind ?? null,
    routing: route.kind,
    askReason: route.kind === 'ask' ? route.reason : undefined,
  };
}

export type ChooseResult = { ok: true } | { ok: false; code: 'NOT_FOUND' | 'ACCOUNT_NOT_FOUND' | 'CURRENCY_MISMATCH' | 'WRITE_FAILED'; message: string };

/** The person chooses where a payslip contribution goes (a waiting one, or a change to an active one). */
export async function chooseDestination(userId: string, contributionId: string, accountId: string, client: Client): Promise<ChooseResult> {
  const { data: row, error } = await client.from('retirement_contributions').select(LEDGER_COLUMNS).eq('id', contributionId).eq('user_id', userId).maybeSingle();
  if (error) return { ok: false, code: 'WRITE_FAILED', message: error.message };
  if (!row || row.status === 'removed' || row.status === 'superseded') return { ok: false, code: 'NOT_FOUND', message: 'That contribution was not found.' };
  const { data: account } = await client.from('retirement_accounts').select('id, owner, currency_code, retirement_member_id, master_item_key, is_active').eq('id', accountId).eq('user_id', userId).maybeSingle();
  if (!account || account.is_active === false) return { ok: false, code: 'ACCOUNT_NOT_FOUND', message: 'That retirement account was not found.' };
  if (String(account.currency_code) !== String(row.currency_code)) {
    return { ok: false, code: 'CURRENCY_MISMATCH', message: `This contribution is in ${row.currency_code} and that account is in ${account.currency_code}. Choose an account in the same currency.` };
  }
  const previousAccountId = (row.retirement_account_id as string | null) ?? null;
  const { error: upErr } = await client
    .from('retirement_contributions')
    .update({
      retirement_account_id: accountId,
      destination_kind: account.master_item_key === 'smsf' ? 'smsf' : 'retirement_account',
      retirement_member_id: account.retirement_member_id ?? row.retirement_member_id ?? null,
      matched_by: 'user_choice',
      status: 'active',
    })
    .eq('id', contributionId)
    .eq('user_id', userId);
  if (upErr) return { ok: false, code: 'WRITE_FAILED', message: upErr.message };
  await adoptLegacyFigures(userId, accountId, client, 1);
  await syncAccountRates(userId, accountId, client);
  if (previousAccountId && previousAccountId !== accountId) await syncAccountRates(userId, previousAccountId, client);
  return { ok: true };
}

/** The person removes a recorded contribution. The row stays (status removed) so history is kept; the rate is recomputed. */
export async function removeContribution(userId: string, contributionId: string, client: Client): Promise<{ ok: boolean }> {
  const { data: row } = await client.from('retirement_contributions').select('id, retirement_account_id, status').eq('id', contributionId).eq('user_id', userId).maybeSingle();
  if (!row || row.status === 'removed') return { ok: false };
  const { error } = await client.from('retirement_contributions').update({ status: 'removed' }).eq('id', contributionId).eq('user_id', userId);
  if (error) return { ok: false };
  if (row.retirement_account_id) await syncAccountRates(userId, row.retirement_account_id as string, client);
  return { ok: true };
}

/** A revised payslip replaced an earlier one: the earlier one's contribution stops counting (kept as history). */
export async function supersedePayslipContribution(userId: string, supersededPayrollEventId: string, client: Client): Promise<void> {
  const { data: rows } = await client.from('retirement_contributions').select('id, retirement_account_id').eq('user_id', userId).eq('source_payroll_event_id', supersededPayrollEventId).in('status', ['active', 'needs_destination']);
  for (const r of (rows ?? []) as DbRow[]) {
    await client.from('retirement_contributions').update({ status: 'superseded' }).eq('id', r.id as string).eq('user_id', userId);
    if (r.retirement_account_id) await syncAccountRates(userId, r.retirement_account_id as string, client);
  }
}

export interface HistoryItem {
  id: string;
  kind: 'ledger' | 'account_figure';
  typeLabelKey: ContributionType;
  amount: number;
  currency: string;
  frequency: ContributionFrequency | null;
  contributionDate: string | null;
  accountId: string | null;
  accountName: string | null;
  destinationKind: 'smsf' | 'retirement_account' | null;
  memberType: 'self' | 'spouse' | null;
  source: 'manual' | 'payslip' | 'account';
  employerName: string | null;
  status: LedgerRow['status'];
  /** Why this row is not part of the current rate, when it is not (plain words, no internal keys). */
  notCountedBecause: string | null;
  monthlyEquivalent: number | null;
}

const EXCLUSION_TEXT: Record<string, string> = {
  not_active: 'Not counted',
  one_off_history: 'A one-off payment: shown in history, not projected as a regular amount',
  unknown_frequency: 'No frequency, so it is not counted as a regular amount',
  older_in_series: 'Replaced by a newer record of the same contribution',
  same_flow_as_payslip: 'The same contribution is already counted from a payslip',
  same_flow_as_manual: 'The same contribution is already counted from a record you entered',
};

/**
 * The contribution history for the Retirement page: every ledger row with its provenance, plus the figures an account already
 * holds that the ledger has not taken over (shown, labelled "recorded on the account", never hidden).
 */
export async function loadContributionHistory(userId: string, client: Client): Promise<{ items: HistoryItem[]; waiting: HistoryItem[]; destinations: DestinationCandidate[] }> {
  const [ledgerRaw, accountsRes, membersRes, destinations] = await Promise.all([
    listLedgerRows(userId, client),
    client.from('retirement_accounts').select('id, account_name, owner, currency_code, retirement_member_id, master_item_key, employer_contribution, personal_contribution, contribution_frequency, is_active').eq('user_id', userId).eq('is_active', true),
    client.from('retirement_members').select('id, member_type').eq('user_id', userId),
    loadDestinationCandidates(userId, client),
  ]);
  if (accountsRes.error) throw new Error(accountsRes.error.message);
  const accounts = new Map(((accountsRes.data ?? []) as DbRow[]).map((a) => [a.id as string, a]));
  const memberType = new Map(((membersRes.data ?? []) as DbRow[]).map((m) => [m.id as string, m.member_type as 'self' | 'spouse']));
  const ledger = ledgerRaw.map(mapLedgerRow);
  const rates = resolveAccountRates(ledger);
  const excludedReason = new Map<string, string>();
  for (const rate of rates.values()) for (const e of rate.excluded) excludedReason.set(e.row.id, EXCLUSION_TEXT[e.reason] ?? 'Not counted');

  const toItem = (l: LedgerRow, raw: DbRow): HistoryItem => {
    const acct = l.retirementAccountId ? accounts.get(l.retirementAccountId) : null;
    return {
      id: l.id, kind: 'ledger', typeLabelKey: l.type, amount: l.amount, currency: l.currency, frequency: l.frequency, contributionDate: l.contributionDate,
      accountId: l.retirementAccountId, accountName: acct ? String(acct.account_name) : null, destinationKind: l.destinationKind,
      memberType: l.memberId ? memberType.get(l.memberId) ?? null : null,
      source: l.sourceType, employerName: (raw.employer_name as string | null) ?? null, status: l.status,
      notCountedBecause: l.status === 'active' ? excludedReason.get(l.id) ?? null : l.status === 'needs_destination' ? 'Waiting for you to choose where it goes' : l.status === 'superseded' ? 'Replaced by a revised payslip' : 'Removed',
      monthlyEquivalent: l.status === 'active' && l.frequency && l.frequency !== 'one_off' && !excludedReason.has(l.id) ? Math.round(toMonthly(l.amount, l.frequency as Frequency) * 100) / 100 : null,
    };
  };
  const items: HistoryItem[] = [];
  const waiting: HistoryItem[] = [];
  ledger.forEach((l, i) => {
    const item = toItem(l, ledgerRaw[i]);
    if (l.status === 'needs_destination') waiting.push(item);
    if (l.status !== 'removed') items.push(item);
  });

  const touched = new Set(ledger.map((l) => l.retirementAccountId).filter(Boolean) as string[]);
  for (const a of accounts.values()) {
    if (touched.has(a.id as string)) continue;
    const freq = (a.contribution_frequency as ContributionFrequency | null) ?? null;
    for (const [col, type] of [['employer_contribution', 'employer'], ['personal_contribution', 'personal']] as const) {
      const amount = Number(a[col] ?? 0);
      if (!(amount > 0)) continue;
      items.push({
        id: `account:${a.id}:${type}`, kind: 'account_figure', typeLabelKey: type, amount, currency: String(a.currency_code), frequency: freq, contributionDate: null,
        accountId: a.id as string, accountName: String(a.account_name), destinationKind: a.master_item_key === 'smsf' ? 'smsf' : 'retirement_account',
        memberType: a.retirement_member_id ? memberType.get(a.retirement_member_id as string) ?? null : null,
        source: 'account', employerName: null, status: 'active',
        notCountedBecause: freq ? null : 'No frequency, so it is not counted as a regular amount',
        monthlyEquivalent: freq && freq !== 'one_off' ? Math.round(toMonthly(amount, freq as Frequency) * 100) / 100 : null,
      });
    }
  }
  return { items, waiting, destinations };
}

export { BUCKET_OF_TYPE };
