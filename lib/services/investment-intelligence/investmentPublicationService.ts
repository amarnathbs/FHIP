// Investment Intelligence R3 — InvestmentPublicationService. The single
// service every publishing API route/UI action goes through (spec section
// 62 — "centralize business logic in one service ... rather than
// duplicating logic across UI and API handlers"). Thin DB-touching
// orchestration around the pure decision functions in ./publicationLogic.ts.
//
// RLS discipline (R0_SECURITY_RLS_ARCHITECTURE.md, matching accounts.ts):
// every read/write that operates on the calling user's own data goes
// through the RLS-respecting createClient() — never the service-role
// client for a user-facing mutation. The service-role client is used only
// for ii_audit_events inserts (that table has no authenticated insert
// policy at all, by design — R0_AUDIT_REQUIREMENTS.md).
//
// Atomicity (spec section 46): this codebase has never used Postgres RPC /
// multi-statement transactions (verified: zero `.rpc(` call sites anywhere
// in lib/app before this file). Introducing a new stored-procedure
// architectural pattern for R3 alone was judged a bigger departure than the
// documented compensating-state workflow below — recorded as an explicit,
// bounded exception in R3_ARCHITECTURE_EXCEPTION.md, not a silent gap:
// the target FHIP row is written FIRST; the ii_fhip_publications row is
// written second and points at it; if the second write fails, the service
// explicitly compensates by reverting the first write and records a
// 'failed' terminal state — so no request can ever leave
// ii_fhip_publications=published while the target FHIP row was never
// written (or vice versa). See publishPosition() below.
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import { getFxRateAudInr } from '@/lib/services/dashboardData';
import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import {
  calculateFinancialImpact,
  classifyRegisterAction,
  computeBaseCurrencyPreview,
  computeIdempotencyKey,
  computePublicationTarget,
  decideRefreshSupersession,
  detectDuplicateCandidates,
  evaluateEligibility,
  isProductionCertifiedAssetClass,
  mapInstrumentClassToInvestmentType,
  mapInstrumentClassToMasterItemKey,
  mapRelationshipToOwner,
  resolveAnnualContribution,
  resolveCostBaseStatus,
  resolveCostBaseValue,
  resolveRiskBand,
  type ExistingManualInvestmentRow,
} from './publicationLogic';
import type {
  FhipOwner,
  HouseholdMemberRelationship,
  IiAccountType,
  IiDuplicateCandidate,
  IiEligibilityResult,
  IiFinancialImpact,
  IiInstrumentClass,
  IiRegisterAction,
} from './types';

// Supabase's default (schema-less) generic typing resolves untyped table
// rows to `never` on property access, matching this codebase's existing
// pattern of explicit row-shape casts right after each query (see
// lib/services/investment-intelligence/accountResolution.ts's
// `c.folio_number as string | null`) rather than a generated Database type.
interface HoldingSnapshotRow {
  id: string;
  account_id: string;
  instrument_id: string;
  as_of_date: string;
  value: number;
  currency_code: string;
  quality_status: string;
  created_at: string;
}
interface IiAccountRow {
  id: string;
  account_type: IiAccountType;
  institution_name: string;
  country_code: string;
  currency_code: string;
  owner_member_id: string | null;
}
interface IiInstrumentRow {
  id: string;
  instrument_class: IiInstrumentClass;
  instrument_name: string;
  amc_name: string | null;
}
interface PortfolioTruthRow {
  status: string;
  history_completeness: string | null;
}
interface HouseholdMemberRow {
  id: string;
  relationship: HouseholdMemberRelationship;
  full_name: string;
}
interface TaxLotRow {
  units_remaining: number;
  cost_per_unit: number;
  status: string;
}
interface ManualInvestmentQueryRow {
  id: string;
  owner: string;
  master_item_key: string | null;
  institution: string | null;
  country_code: string | null;
  currency_code: string;
  current_value: number;
  source_type: string;
}

function toExistingManualInvestmentRow(row: ManualInvestmentQueryRow): ExistingManualInvestmentRow {
  return {
    id: row.id,
    owner: row.owner,
    masterItemKey: row.master_item_key,
    institution: row.institution,
    countryCode: row.country_code,
    currencyCode: row.currency_code,
    currentValue: Number(row.current_value),
    sourceType: row.source_type,
  };
}

export interface PublicationPreview {
  positionId: string; // ii_holding_snapshots.id (canonical_position_id)
  accountId: string;
  instrumentId: string;
  eligibility: IiEligibilityResult;
  owner: { memberId: string | null; relationship: HouseholdMemberRelationship | null; resolvedOwner: FhipOwner | null; memberName: string | null };
  investmentCategory: string | null; // master_item_key
  institution: string | null;
  sourceCountry: string | null;
  sourceCurrency: string | null;
  valuationAsOfDate: string | null;
  certifiedValue: number | null;
  costBaseStatus: string;
  costBaseValue: number | null;
  annualContributionStatus: 'confirmed_user_plan' | 'none';
  annualContributionValue: number | null;
  riskBand: string;
  targetRegister: 'assets' | 'investments' | 'retirement_accounts';
  duplicateCandidates: IiDuplicateCandidate[];
  financialImpact: IiFinancialImpact | null;
  registerAction: IiRegisterAction;
  dataQualityStatus: string;
  baseCurrency: { currencyCode: string | null; amount: number | null; rateUsed: number | null; available: boolean; reason?: string };
  alreadyPublished: { publicationId: string; publishedRowId: string | null; status: string } | null;
}

interface PositionContext {
  snapshot: HoldingSnapshotRow;
  account: IiAccountRow;
  instrument: IiInstrumentRow;
  truth: PortfolioTruthRow | null;
  member: HouseholdMemberRow | null;
  openLots: TaxLotRow[];
  hasBlockingReconciliation: boolean;
}

async function loadPositionContext(supabase: SupabaseServerClient, userId: string, positionId: string): Promise<PositionContext | { error: string }> {
  const { data: snapshotRaw, error: snapErr } = await supabase
    .from('ii_holding_snapshots')
    .select('id, account_id, instrument_id, as_of_date, value, currency_code, quality_status, created_at')
    .eq('id', positionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (snapErr) return { error: snapErr.message };
  if (!snapshotRaw) return { error: 'Position not found' };
  const snapshot = snapshotRaw as unknown as HoldingSnapshotRow;

  const [{ data: accountRaw }, { data: instrumentRaw }, { data: truthRaw }] = await Promise.all([
    supabase.from('ii_accounts').select('id, account_type, institution_name, country_code, currency_code, owner_member_id').eq('id', snapshot.account_id).eq('user_id', userId).maybeSingle(),
    supabase.from('ii_instruments').select('id, instrument_class, instrument_name, amc_name').eq('id', snapshot.instrument_id).maybeSingle(),
    supabase
      .from('ii_portfolio_truth_status')
      .select('status, history_completeness')
      .eq('user_id', userId)
      .eq('account_id', snapshot.account_id)
      .eq('instrument_id', snapshot.instrument_id)
      .maybeSingle(),
  ]);
  if (!accountRaw) return { error: 'Position references a missing or inaccessible account' };
  if (!instrumentRaw) return { error: 'Position references a missing instrument' };
  const account = accountRaw as unknown as IiAccountRow;
  const instrument = instrumentRaw as unknown as IiInstrumentRow;
  const truth = (truthRaw as unknown as PortfolioTruthRow | null) ?? null;

  let member: HouseholdMemberRow | null = null;
  if (account.owner_member_id) {
    const { data } = await supabase.from('household_members').select('id, relationship, full_name').eq('id', account.owner_member_id).eq('user_id', userId).maybeSingle();
    member = (data as unknown as HouseholdMemberRow | null) ?? null;
  }

  const { data: openLotsRaw } = await supabase
    .from('ii_tax_lots')
    .select('units_remaining, cost_per_unit, status')
    .eq('user_id', userId)
    .eq('account_id', snapshot.account_id)
    .eq('instrument_id', snapshot.instrument_id)
    .neq('status', 'closed');

  const { data: blockingCase } = await supabase
    .from('ii_reconciliation_cases')
    .select('id')
    .eq('user_id', userId)
    .eq('subject_id', positionId)
    .in('status', ['open', 'user_reviewing'])
    .eq('severity', 'blocking')
    .maybeSingle();

  return { snapshot, account, instrument, truth, member, openLots: (openLotsRaw as unknown as TaxLotRow[]) ?? [], hasBlockingReconciliation: !!blockingCase };
}

// ---------------------------------------------------------------------------
// Eligibility (spec section 10) — read-only.
// ---------------------------------------------------------------------------
export async function checkEligibility(userId: string, positionId: string): Promise<{ eligibility: IiEligibilityResult | null; error: string | null }> {
  const supabase = await createClient();
  const ctx = await loadPositionContext(supabase, userId, positionId);
  if ('error' in ctx) return { eligibility: null, error: ctx.error };

  const eligibility = evaluateEligibility({
    ownerMemberId: ctx.member?.id ?? null,
    instrumentClass: ctx.instrument.instrument_class as IiInstrumentClass,
    accountType: ctx.account.account_type,
    portfolioTruthStatus: ctx.truth?.status ?? 'pending',
    hasBlockingReconciliation: ctx.hasBlockingReconciliation,
    currentValue: ctx.snapshot.value,
    countryCode: ctx.account.country_code,
    currencyCode: ctx.snapshot.currency_code,
  });
  return { eligibility, error: null };
}

// ---------------------------------------------------------------------------
// Preview (spec section 12) — read-only, computes everything a confirm
// action needs, writes NOTHING to the database except an audit event
// recording that a preview was generated (spec section 47's optional
// publication_previewed).
// ---------------------------------------------------------------------------
export async function buildPreview(userId: string, positionId: string): Promise<{ preview: PublicationPreview | null; error: string | null }> {
  const supabase = await createClient();
  const ctx = await loadPositionContext(supabase, userId, positionId);
  if ('error' in ctx) return { preview: null, error: ctx.error };
  const { snapshot, account, instrument, truth, member, openLots } = ctx;

  const instrumentClass = instrument.instrument_class as IiInstrumentClass;
  const eligibility = evaluateEligibility({
    ownerMemberId: member?.id ?? null,
    instrumentClass,
    accountType: account.account_type,
    portfolioTruthStatus: truth?.status ?? 'pending',
    hasBlockingReconciliation: ctx.hasBlockingReconciliation,
    currentValue: snapshot.value,
    countryCode: account.country_code,
    currencyCode: snapshot.currency_code,
  });

  const resolvedOwner = member ? mapRelationshipToOwner(member.relationship) : null;
  const masterItemKey = mapInstrumentClassToMasterItemKey(instrumentClass);
  const targetRegister = computePublicationTarget(instrumentClass, account.account_type);

  const hasOpenLots = (openLots?.length ?? 0) > 0;
  const historyCompleteness = truth?.history_completeness ?? null;
  const costBaseStatus = resolveCostBaseStatus(historyCompleteness, hasOpenLots);
  const aggregatedCostBase = hasOpenLots ? openLots!.reduce((sum, l) => sum + Number(l.units_remaining) * Number(l.cost_per_unit), 0) : null;
  const costBaseValue = resolveCostBaseValue(costBaseStatus, aggregatedCostBase);
  const annualContribution = resolveAnnualContribution(null); // no confirmed plan captured yet at preview time — user supplies at confirm
  const riskBand = resolveRiskBand(instrumentClass);

  // Existing publication for this exact economic position, if any (refresh
  // vs first-publish distinguishing signal for the UI).
  const { data: existingPub } = await supabase
    .from('ii_fhip_publications')
    .select('id, published_row_id, status')
    .eq('user_id', userId)
    .eq('account_id', account.id)
    .eq('instrument_id', instrument.id)
    .eq('status', 'published')
    .maybeSingle();

  // Duplicate-candidate detection against existing MANUAL investments rows.
  const { data: manualRows } = await supabase
    .from('investments')
    .select('id, owner, master_item_key, institution, country_code, currency_code, current_value, source_type')
    .eq('user_id', userId)
    .eq('is_active', true)
    .eq('source_type', 'manual');
  const duplicateCandidates =
    resolvedOwner && !existingPub
      ? detectDuplicateCandidates(
          {
            owner: resolvedOwner,
            masterItemKey,
            institution: account.institution_name,
            countryCode: account.country_code,
            currencyCode: snapshot.currency_code,
            currentValue: snapshot.value,
          },
          ((manualRows ?? []) as unknown as ManualInvestmentQueryRow[]).map(toExistingManualInvestmentRow)
        )
      : [];

  const registerAction = classifyRegisterAction({ eligibility, duplicateCandidates, userConfirmedLinkId: null });

  const fxRate = await getFxRateAudInr(supabase);
  const { data: profile } = await supabase.from('user_profiles').select('preferred_currency').eq('user_id', userId).maybeSingle();
  const householdCurrency = (profile?.preferred_currency as string) ?? 'AUD';
  const baseCurrency = computeBaseCurrencyPreview(snapshot.value, snapshot.currency_code, householdCurrency, fxRate);

  let financialImpact: IiFinancialImpact | null = null;
  if (eligibility.status !== 'NOT_ELIGIBLE') {
    const topCandidate = duplicateCandidates[0];
    financialImpact = calculateFinancialImpact({
      currentIncludedValue: existingPub ? snapshot.value : topCandidate ? 0 : 0,
      newPublishedValue: snapshot.value,
      manualValueBeingSuperseded: 0, // preview shows 0 until the user CONFIRMS a specific link — never assumed
      currency: snapshot.currency_code,
    });
  }

  await emitAuditEvent({
    userId,
    eventType: 'publication_previewed',
    subjectType: 'ii_holding_snapshots',
    subjectId: positionId,
    actorType: 'user',
    metadata: { accountId: account.id, instrumentId: instrument.id, eligibilityStatus: eligibility.status, duplicateCandidateCount: duplicateCandidates.length },
  });

  return {
    preview: {
      positionId,
      accountId: account.id,
      instrumentId: instrument.id,
      eligibility,
      owner: { memberId: member?.id ?? null, relationship: member?.relationship ?? null, resolvedOwner, memberName: member?.full_name ?? null },
      investmentCategory: masterItemKey,
      institution: account.institution_name,
      sourceCountry: account.country_code,
      sourceCurrency: snapshot.currency_code,
      valuationAsOfDate: snapshot.as_of_date,
      certifiedValue: snapshot.value,
      costBaseStatus,
      costBaseValue,
      annualContributionStatus: annualContribution.source,
      annualContributionValue: annualContribution.value,
      riskBand,
      targetRegister,
      duplicateCandidates,
      financialImpact,
      registerAction,
      dataQualityStatus: truth?.status ?? 'pending',
      baseCurrency: { currencyCode: householdCurrency, amount: baseCurrency.baseCurrencyAmount, rateUsed: baseCurrency.rateUsed, available: baseCurrency.available, reason: baseCurrency.reason },
      alreadyPublished: existingPub ? { publicationId: existingPub.id as string, publishedRowId: (existingPub.published_row_id as string) ?? null, status: existingPub.status as string } : null,
    },
    error: null,
  };
}

export interface PublishOptions {
  linkToExistingInvestmentId?: string | null; // user-confirmed: this position IS the same economic investment as this manual row
  acknowledgedNoDuplicate?: boolean; // user-confirmed: reviewed candidates, none apply — proceed as a new position
  confirmedAnnualContribution?: number | null; // user's confirmed forward-looking plan, never inferred
  correlationId?: string;
}

export interface PublishResult {
  publicationId: string | null;
  publishedRowId: string | null;
  action: IiRegisterAction | null;
  financialImpact: IiFinancialImpact | null;
  error: string | null;
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// Publish (spec sections 11, 43-46). The one write path that creates or
// updates a real FHIP register row plus its ii_fhip_publications record.
// ---------------------------------------------------------------------------
export async function publishPosition(userId: string, positionId: string, options: PublishOptions = {}): Promise<PublishResult> {
  const supabase = await createClient();
  const ctx = await loadPositionContext(supabase, userId, positionId);
  if ('error' in ctx) return { publicationId: null, publishedRowId: null, action: null, financialImpact: null, error: ctx.error };
  const { snapshot, account, instrument, truth, member, openLots } = ctx;

  const instrumentClass = instrument.instrument_class as IiInstrumentClass;
  const eligibility = evaluateEligibility({
    ownerMemberId: member?.id ?? null,
    instrumentClass,
    accountType: account.account_type,
    portfolioTruthStatus: truth?.status ?? 'pending',
    hasBlockingReconciliation: ctx.hasBlockingReconciliation,
    currentValue: snapshot.value,
    countryCode: account.country_code,
    currencyCode: snapshot.currency_code,
  });
  if (eligibility.status === 'NOT_ELIGIBLE') {
    return { publicationId: null, publishedRowId: null, action: 'LEAVE_UNCHANGED', financialImpact: null, error: eligibility.blockingReasons.map((r) => r.message).join(' '), errorCode: 'NOT_ELIGIBLE' };
  }
  if (!isProductionCertifiedAssetClass(instrumentClass)) {
    return { publicationId: null, publishedRowId: null, action: 'LEAVE_UNCHANGED', financialImpact: null, error: 'Only certified Indian mutual fund positions may be published in this release.', errorCode: 'NOT_ELIGIBLE' };
  }
  const target = computePublicationTarget(instrumentClass, account.account_type);
  if (target !== 'investments') {
    // Structural-only in R3 (spec: don't expand production beyond MF ->
    // Investments). Routing itself is correct and tested; production write
    // is intentionally not implemented for other targets yet.
    return { publicationId: null, publishedRowId: null, action: 'LEAVE_UNCHANGED', financialImpact: null, error: `Publication target '${target}' is not yet activated for production writes in R3 (structural routing only).`, errorCode: 'TARGET_NOT_ACTIVATED' };
  }

  // Idempotency: has this EXACT snapshot already been published? (double-
  // click / retry for the identical request)
  const idempotencyKey = computeIdempotencyKey({ accountId: account.id, instrumentId: instrument.id, canonicalPositionId: positionId, publicationTarget: target });
  const { data: existingSamePublish } = await supabase.from('ii_fhip_publications').select('id, published_row_id, status, published_value, source_currency').eq('idempotency_key', idempotencyKey).maybeSingle();
  if (existingSamePublish && existingSamePublish.status === 'published') {
    return {
      publicationId: existingSamePublish.id as string,
      publishedRowId: (existingSamePublish.published_row_id as string) ?? null,
      action: 'LEAVE_UNCHANGED',
      financialImpact: calculateFinancialImpact({ currentIncludedValue: Number(existingSamePublish.published_value ?? 0), newPublishedValue: Number(existingSamePublish.published_value ?? 0), manualValueBeingSuperseded: 0, currency: (existingSamePublish.source_currency as string) ?? snapshot.currency_code }),
      error: null,
    };
  }

  // Duplicate review gate (spec section 11 — controlled flow, never silent).
  const resolvedOwner = member ? mapRelationshipToOwner(member.relationship) : null;
  const masterItemKey = mapInstrumentClassToMasterItemKey(instrumentClass);
  let duplicateCandidates: IiDuplicateCandidate[] = [];
  if (!options.linkToExistingInvestmentId && resolvedOwner) {
    const { data: manualRows } = await supabase
      .from('investments')
      .select('id, owner, master_item_key, institution, country_code, currency_code, current_value, source_type')
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('source_type', 'manual');
    duplicateCandidates = detectDuplicateCandidates(
      { owner: resolvedOwner, masterItemKey, institution: account.institution_name, countryCode: account.country_code, currencyCode: snapshot.currency_code, currentValue: snapshot.value },
      ((manualRows ?? []) as unknown as ManualInvestmentQueryRow[]).map(toExistingManualInvestmentRow)
    );
  }
  if (duplicateCandidates.length > 0 && !options.linkToExistingInvestmentId && !options.acknowledgedNoDuplicate) {
    await emitAuditEvent({ userId, eventType: 'conflict_detected', subjectType: 'ii_holding_snapshots', subjectId: positionId, actorType: 'system', metadata: { candidateCount: duplicateCandidates.length, candidateIds: duplicateCandidates.map((c) => c.investmentId) } });
    return { publicationId: null, publishedRowId: null, action: 'REQUIRES_REVIEW', financialImpact: null, error: 'Possible duplicate manual investment(s) found — review required before publishing.', errorCode: 'REVIEW_REQUIRED' };
  }

  const hasOpenLots = (openLots?.length ?? 0) > 0;
  const historyCompleteness = truth?.history_completeness ?? null;
  const costBaseStatus = resolveCostBaseStatus(historyCompleteness, hasOpenLots);
  const aggregatedCostBase = hasOpenLots ? openLots!.reduce((sum, l) => sum + Number(l.units_remaining) * Number(l.cost_per_unit), 0) : null;
  const costBaseValue = resolveCostBaseValue(costBaseStatus, aggregatedCostBase);
  const annualContribution = resolveAnnualContribution(options.confirmedAnnualContribution ?? null);
  const riskBand = resolveRiskBand(instrumentClass);
  const investmentType = mapInstrumentClassToInvestmentType(instrumentClass);

  const fieldPayload = {
    investment_name: instrument.instrument_name,
    investment_type: investmentType,
    current_value: snapshot.value,
    currency_code: snapshot.currency_code,
    country_code: account.country_code,
    institution: instrument.amc_name ?? account.institution_name,
    cost_base: costBaseValue,
    annual_contribution: annualContribution.value,
    risk_profile: riskBand,
    owner: resolvedOwner ?? 'self',
    master_item_key: masterItemKey,
    source_type: 'investment_intelligence_published' as const,
    ii_canonical_account_id: account.id,
    ii_canonical_instrument_id: instrument.id,
    ii_source_quality_status: snapshot.quality_status,
    ii_last_refreshed_at: new Date().toISOString(),
  };

  let publishedRowId: string;
  let action: IiRegisterAction;
  let manualValueBeingSuperseded = 0;

  if (options.linkToExistingInvestmentId) {
    // REPLACE_LINK_EXISTING: convert the manual row IN PLACE, preserving its
    // id (so goal_funding_sources.linked_investment_id keeps working with
    // zero relinking) and capturing a pre-link snapshot for audit/unpublish
    // restore (spec sections 28, 36; R3_DUPLICATE_RESOLUTION_SPEC.md).
    const { data: manualRow, error: manualErr } = await supabase
      .from('investments')
      .select('*')
      .eq('id', options.linkToExistingInvestmentId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (manualErr || !manualRow) return { publicationId: null, publishedRowId: null, action: null, financialImpact: null, error: manualErr?.message ?? 'The manual investment row to link was not found.', errorCode: 'LINK_TARGET_NOT_FOUND' };
    if (manualRow.source_type !== 'manual') return { publicationId: null, publishedRowId: null, action: null, financialImpact: null, error: 'The selected row is not a manual investment and cannot be linked.', errorCode: 'LINK_TARGET_NOT_MANUAL' };

    manualValueBeingSuperseded = Number(manualRow.current_value);
    const preLinkSnapshot = {
      current_value: manualRow.current_value,
      cost_base: manualRow.cost_base,
      institution: manualRow.institution,
      owner: manualRow.owner,
      investment_type: manualRow.investment_type,
      master_item_key: manualRow.master_item_key,
      annual_contribution: manualRow.annual_contribution,
      risk_profile: manualRow.risk_profile,
      captured_at: new Date().toISOString(),
    };
    const { data: updated, error: updateErr } = await supabase
      .from('investments')
      .update({ ...fieldPayload, pre_publication_manual_snapshot: preLinkSnapshot, ii_linked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', manualRow.id)
      .eq('user_id', userId)
      .select('id')
      .single();
    if (updateErr || !updated) return { publicationId: null, publishedRowId: null, action: null, financialImpact: null, error: updateErr?.message ?? 'Failed to link the manual investment row.', errorCode: 'WRITE_FAILED' };
    publishedRowId = updated.id as string;
    action = 'REPLACE_LINK_EXISTING';

    await emitAuditEvent({ userId, eventType: 'manual_duplicate_linked', subjectType: 'investments', subjectId: publishedRowId, actorType: 'user', metadata: { positionId, previousValue: manualValueBeingSuperseded, newValue: snapshot.value } });
    await emitAuditEvent({ userId, eventType: 'manual_record_superseded', subjectType: 'investments', subjectId: publishedRowId, actorType: 'user', metadata: { positionId, preLinkValue: manualValueBeingSuperseded } });
  } else {
    // ADD_NEW: insert a fresh row. Safe under the relaxed
    // uidx_investments_user_master_manual partial index (source_type is
    // 'investment_intelligence_published', not 'manual', so this never
    // collides with the manual-entry uniqueness guarantee or with any other
    // II-published row for a DIFFERENT position under the same category).
    const { data: created, error: createErr } = await supabase.from('investments').insert({ ...fieldPayload, user_id: userId, is_active: true }).select('id').single();
    if (createErr || !created) return { publicationId: null, publishedRowId: null, action: null, financialImpact: null, error: createErr?.message ?? 'Failed to create the investment row.', errorCode: 'WRITE_FAILED' };
    publishedRowId = created.id as string;
    action = 'ADD_NEW';
  }

  // Second write: the ii_fhip_publications record. If this fails, COMPENSATE
  // by reverting the first write (spec section 46 — never leave a
  // half-published state).
  const nowIso = new Date().toISOString();
  const { data: pub, error: pubErr } = await supabase
    .from('ii_fhip_publications')
    .insert({
      user_id: userId,
      canonical_position_id: positionId,
      account_id: account.id,
      instrument_id: instrument.id,
      publication_target: target,
      published_row_id: publishedRowId,
      status: 'published',
      include_in_net_worth: true,
      owner_member_id: member?.id ?? null,
      published_owner: resolvedOwner,
      source_currency: snapshot.currency_code,
      source_country: account.country_code,
      published_value: snapshot.value,
      published_cost_base: costBaseValue,
      cost_base_status: costBaseStatus,
      published_annual_contribution: annualContribution.value,
      annual_contribution_source: annualContribution.source,
      risk_band: riskBand,
      target_master_item_key: masterItemKey,
      linkage_type: options.linkToExistingInvestmentId ? 'linked_manual_row' : 'new_position',
      linked_manual_investment_id: options.linkToExistingInvestmentId ?? null,
      correlation_id: options.correlationId ?? null,
      idempotency_key: idempotencyKey,
      published_at: nowIso,
    })
    .select('id')
    .single();

  if (pubErr || !pub) {
    // COMPENSATE: revert the target row.
    if (action === 'ADD_NEW') {
      await supabase.from('investments').update({ is_active: false }).eq('id', publishedRowId).eq('user_id', userId);
    } else {
      // Revert the manual row back to its pre-link state — do not leave it
      // stamped as investment_intelligence_published with no publication
      // record backing it.
      const { data: reverted } = await supabase.from('investments').select('pre_publication_manual_snapshot').eq('id', publishedRowId).eq('user_id', userId).maybeSingle();
      const snap = reverted?.pre_publication_manual_snapshot as Record<string, unknown> | null;
      if (snap) {
        await supabase.from('investments').update({ ...snap, source_type: 'manual', pre_publication_manual_snapshot: null, ii_linked_at: null }).eq('id', publishedRowId).eq('user_id', userId);
      }
    }
    await emitAuditEvent({ userId, eventType: 'publication_failed', subjectType: 'investments', subjectId: publishedRowId, actorType: 'system', metadata: { positionId, reason: pubErr?.message ?? 'unknown', compensated: true } });
    return { publicationId: null, publishedRowId: null, action: null, financialImpact: null, error: `Publication failed and was safely rolled back: ${pubErr?.message ?? 'unknown error'}`, errorCode: 'WRITE_FAILED' };
  }

  await emitAuditEvent({
    userId,
    eventType: 'publication_confirmed',
    subjectType: 'ii_fhip_publications',
    subjectId: pub.id as string,
    actorType: 'user',
    metadata: { positionId, publishedRowId, target, action, correlationId: options.correlationId ?? null },
  });

  const financialImpact = calculateFinancialImpact({ currentIncludedValue: action === 'REPLACE_LINK_EXISTING' ? manualValueBeingSuperseded : 0, newPublishedValue: snapshot.value, manualValueBeingSuperseded, currency: snapshot.currency_code });

  return { publicationId: pub.id as string, publishedRowId, action, financialImpact, error: null };
}

// ---------------------------------------------------------------------------
// Unpublish (spec section 36). Stops active economic inclusion, preserves
// all canonical II data. R3 explicit resolution of the R0-flagged open item:
// a linked/superseded manual row is RESTORED to its pre-link manual values
// and source_type on unpublish (documented in R3_DUPLICATE_RESOLUTION_SPEC.md).
// ---------------------------------------------------------------------------
export async function unpublishPosition(userId: string, publicationId: string): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: pub, error: pubErr } = await supabase.from('ii_fhip_publications').select('*').eq('id', publicationId).eq('user_id', userId).eq('status', 'published').maybeSingle();
  if (pubErr) return { error: pubErr.message };
  if (!pub) return { error: 'Active publication not found' };

  const { data: row } = await supabase.from('investments').select('pre_publication_manual_snapshot, source_type').eq('id', pub.published_row_id).eq('user_id', userId).maybeSingle();

  if (row?.source_type === 'investment_intelligence_published' && row.pre_publication_manual_snapshot) {
    // Was a linked manual row — restore it exactly as it was before linking.
    const snap = row.pre_publication_manual_snapshot as Record<string, unknown>;
    await supabase.from('investments').update({ ...snap, source_type: 'manual', pre_publication_manual_snapshot: null, ii_linked_at: null, ii_publication_id: null, is_active: true }).eq('id', pub.published_row_id).eq('user_id', userId);
  } else {
    // Was a brand-new II-created row — archiving is the correct exclusion
    // mechanism (matches R0_NET_WORTH_DEDUP_CONTRACT.md scenario 10; the
    // existing registry.archive() semantics: is_active=false already
    // excludes from computeDashboard() automatically, no engine changes).
    await supabase.from('investments').update({ is_active: false }).eq('id', pub.published_row_id).eq('user_id', userId);
  }

  const { error: updErr } = await supabase.from('ii_fhip_publications').update({ status: 'unpublished' }).eq('id', publicationId).eq('user_id', userId);
  if (updErr) return { error: updErr.message };

  await emitAuditEvent({ userId, eventType: 'publication_unpublished', subjectType: 'ii_fhip_publications', subjectId: publicationId, actorType: 'user', metadata: { publishedRowId: pub.published_row_id } });
  return { error: null };
}

// ---------------------------------------------------------------------------
// Republish (spec section 37). Deterministic — re-activates a previously
// unpublished publication for the SAME (account, instrument), never
// creating a second active row/publication.
// ---------------------------------------------------------------------------
export async function republishPosition(userId: string, publicationId: string): Promise<{ error: string | null; publicationId: string | null }> {
  const supabase = await createClient();
  const { data: pub, error: pubErr } = await supabase.from('ii_fhip_publications').select('*').eq('id', publicationId).eq('user_id', userId).eq('status', 'unpublished').maybeSingle();
  if (pubErr) return { error: pubErr.message, publicationId: null };
  if (!pub) return { error: 'Unpublished publication not found', publicationId: null };

  const { data: activeConflict } = await supabase.from('ii_fhip_publications').select('id').eq('user_id', userId).eq('account_id', pub.account_id).eq('instrument_id', pub.instrument_id).eq('status', 'published').maybeSingle();
  if (activeConflict) return { error: 'Another publication for this position is already active — republish refused to avoid a duplicate active row.', publicationId: null };

  await supabase
    .from('investments')
    .update({ source_type: 'investment_intelligence_published', current_value: pub.published_value, cost_base: pub.published_cost_base, owner: pub.published_owner, ii_publication_id: publicationId, is_active: true })
    .eq('id', pub.published_row_id)
    .eq('user_id', userId);

  const { error: updErr } = await supabase.from('ii_fhip_publications').update({ status: 'published', last_republished_at: new Date().toISOString() }).eq('id', publicationId).eq('user_id', userId);
  if (updErr) return { error: updErr.message, publicationId: null };

  await emitAuditEvent({ userId, eventType: 'publication_republished', subjectType: 'ii_fhip_publications', subjectId: publicationId, actorType: 'user', metadata: { publishedRowId: pub.published_row_id } });
  return { error: null, publicationId };
}

// ---------------------------------------------------------------------------
// Refresh (spec sections 33-35). A NEW certified snapshot has appeared for
// an economic position that already has an active publication. Decides
// ACTIVATE_NEW / REJECT_OLDER / ACTIVATE_NEW_SAME_DATE_CORRECTION and never
// leaves two 'published' rows active for the same position.
// ---------------------------------------------------------------------------
export async function refreshPosition(userId: string, newPositionId: string): Promise<{ error: string | null; publicationId: string | null; decision: string | null }> {
  const supabase = await createClient();
  const ctx = await loadPositionContext(supabase, userId, newPositionId);
  if ('error' in ctx) return { error: ctx.error, publicationId: null, decision: null };
  const { snapshot, account, instrument } = ctx;

  const { data: active } = await supabase
    .from('ii_fhip_publications')
    .select('*')
    .eq('user_id', userId)
    .eq('account_id', account.id)
    .eq('instrument_id', instrument.id)
    .eq('status', 'published')
    .maybeSingle();

  if (!active) {
    // No existing active publication for this position — this is a
    // first-time publish, not a refresh. Callers should use publishPosition().
    return { error: 'No active publication exists for this position — use publish, not refresh.', publicationId: null, decision: null };
  }
  if (active.canonical_position_id === newPositionId) {
    return { error: null, publicationId: active.id as string, decision: 'ALREADY_ACTIVE' };
  }

  const { data: activeSnapshot } = await supabase.from('ii_holding_snapshots').select('as_of_date, created_at').eq('id', active.canonical_position_id).maybeSingle();
  const decision = decideRefreshSupersession({
    activeAsOfDate: (activeSnapshot?.as_of_date as string) ?? '0000-01-01',
    activeCertifiedAt: (activeSnapshot?.created_at as string) ?? null,
    newAsOfDate: snapshot.as_of_date,
    newCertifiedAt: snapshot.created_at,
  });

  if (decision.action === 'REJECT_OLDER') {
    await emitAuditEvent({ userId, eventType: 'conflict_detected', subjectType: 'ii_fhip_publications', subjectId: active.id as string, actorType: 'system', metadata: { reason: decision.reason, rejectedPositionId: newPositionId } });
    return { error: decision.reason, publicationId: active.id as string, decision: decision.action };
  }

  // Activate the new snapshot: update the SAME published_row_id in place
  // (never a second investments row), mark the OLD publication superseded,
  // insert a NEW publication row for the new snapshot as the active one.
  await supabase
    .from('investments')
    .update({ current_value: snapshot.value, ii_last_refreshed_at: new Date().toISOString(), ii_source_quality_status: snapshot.quality_status })
    .eq('id', active.published_row_id)
    .eq('user_id', userId);

  const idempotencyKey = computeIdempotencyKey({ accountId: account.id, instrumentId: instrument.id, canonicalPositionId: newPositionId, publicationTarget: active.publication_target });
  const { data: newPub, error: newPubErr } = await supabase
    .from('ii_fhip_publications')
    .insert({
      user_id: userId,
      canonical_position_id: newPositionId,
      account_id: account.id,
      instrument_id: instrument.id,
      publication_target: active.publication_target,
      published_row_id: active.published_row_id,
      status: 'published',
      include_in_net_worth: true,
      owner_member_id: active.owner_member_id,
      published_owner: active.published_owner,
      source_currency: snapshot.currency_code,
      source_country: account.country_code,
      published_value: snapshot.value,
      published_cost_base: active.published_cost_base,
      cost_base_status: active.cost_base_status,
      published_annual_contribution: active.published_annual_contribution,
      annual_contribution_source: active.annual_contribution_source,
      risk_band: active.risk_band,
      target_master_item_key: active.target_master_item_key,
      linkage_type: active.linkage_type,
      linked_manual_investment_id: active.linked_manual_investment_id,
      supersedes_publication_id: active.id,
      idempotency_key: idempotencyKey,
      published_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (newPubErr || !newPub) {
    await emitAuditEvent({ userId, eventType: 'publication_failed', subjectType: 'ii_fhip_publications', subjectId: active.id as string, actorType: 'system', metadata: { reason: newPubErr?.message ?? 'unknown' } });
    return { error: newPubErr?.message ?? 'Refresh failed', publicationId: null, decision: null };
  }

  await supabase.from('ii_fhip_publications').update({ status: 'superseded', superseded_by_publication_id: newPub.id, supersession_reason: decision.reason }).eq('id', active.id as string).eq('user_id', userId);

  await emitAuditEvent({ userId, eventType: 'publication_refreshed', subjectType: 'ii_fhip_publications', subjectId: newPub.id as string, actorType: 'user', metadata: { previousPublicationId: active.id, decision: decision.action } });
  await emitAuditEvent({ userId, eventType: 'publication_superseded', subjectType: 'ii_fhip_publications', subjectId: active.id as string, actorType: 'system', metadata: { supersededBy: newPub.id } });

  return { error: null, publicationId: newPub.id as string, decision: decision.action };
}

// ---------------------------------------------------------------------------
// Admin/service-role variant for trusted server-side flows only (e.g. a
// future scheduled refresh job) — mirrors accounts.ts's
// findOrCreateIiAccountServiceRole precedent. Not exposed on any
// user-facing API route.
// ---------------------------------------------------------------------------
export function createAdminPublicationClient() {
  return createAdminClient();
}
