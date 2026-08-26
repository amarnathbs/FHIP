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
import { fetchAllRows } from './pagination';
import {
  buildPreLinkManualSnapshot,
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
  restorableFieldsFromManualSnapshot,
  type ExistingManualInvestmentRow,
  type ManualInvestmentSnapshotSource,
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

// restorableFieldsFromManualSnapshot() (imported from ./publicationLogic,
// where every pure/DB-free decision function lives) replaced this file's
// former local restorableFieldsFromSnapshot() during the R3 provenance-
// preservation closure pass (docs/investment-intelligence/R3_CLOSURE_REPORT.md).
// The original local helper already fixed a real live-testing-discovered
// defect — spreading the raw snapshot (which carries a `captured_at`
// metadata key that is NOT an `investments` column) straight into an
// `.update()` payload sent PostgREST an unknown column and silently failed
// the whole update. The closure pass found the ALLOW-LIST itself was
// incomplete: `investment_name`, `currency_code`, and `country_code` are all
// overwritten by publishPosition()'s fieldPayload (see below) but were never
// in the list, so unpublishPosition() could never restore them — see
// buildPreLinkManualSnapshot()'s doc comment for the full field-matrix
// writeup and the backward-compatibility behaviour for pre-fix snapshots.
//
// Every unpublish/compensation restore also explicitly nulls the four
// `ii_*` tracking columns below (ii_canonical_account_id,
// ii_canonical_instrument_id, ii_source_quality_status,
// ii_last_refreshed_at) alongside the pre-existing ii_linked_at/
// ii_publication_id nulling — these are never part of the manual snapshot
// (a manual row's ORIGINAL value for all four is deterministically null,
// there is nothing to "capture") but fieldPayload sets all four during
// link, so a restored row must have them cleared too or a row back at
// source_type='manual' is left pointing at a certified II position it is no
// longer connected to.
const II_TRACKING_FIELDS_TO_CLEAR_ON_RESTORE = {
  ii_canonical_account_id: null,
  ii_canonical_instrument_id: null,
  ii_source_quality_status: null,
  ii_last_refreshed_at: null,
} as const;

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

  // R6-P0: unbounded before. Open tax lots for ONE position drive the
  // published COST BASIS, and a daily/weekly SIP held for a few years opens
  // well over 1000 lots in a single scheme. Silent truncation understates cost
  // basis with no error surfaced — a wrong number on the user's net worth.
  // (Also flagged forward to R6-P1: the tax engine's lot-matching reads must
  // page for the same reason, at far higher row counts.)
  const openLotsRaw = await fetchAllRows<{ units_remaining: number; cost_per_unit: number; status: string }>(() =>
    supabase
      .from('ii_tax_lots')
      .select('units_remaining, cost_per_unit, status')
      .eq('user_id', userId)
      .eq('account_id', snapshot.account_id)
      .eq('instrument_id', snapshot.instrument_id)
      .neq('status', 'closed')
      .order('id', { ascending: true })
  );

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
  const masterItemKey = mapInstrumentClassToMasterItemKey(instrumentClass, account.country_code);
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
  if ('error' in ctx) return { publicationId: null, publishedRowId: null, action: null, financialImpact: null, error: ctx.error, errorCode: 'NOT_FOUND' };
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
  const masterItemKey = mapInstrumentClassToMasterItemKey(instrumentClass, account.country_code);
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
    // Fresh capture on EVERY call that reaches this branch (spec's
    // "idempotent link" and "re-publish lifecycle" rules) — the manualRow
    // query above always re-reads the row's CURRENT state, and the guard at
    // line ~512 (`source_type !== 'manual'`) means this branch is
    // structurally unreachable for an already-linked row, so an idempotent
    // retry is caught earlier by the existingSamePublish short-circuit
    // before ever reaching here, and a genuine second link cycle (after a
    // real unpublish put the row back to source_type='manual', possibly
    // with a user-edited name in between) correctly captures THAT edited
    // state as the new pre-link snapshot rather than reusing a stale one.
    const preLinkSnapshot = buildPreLinkManualSnapshot(manualRow as unknown as ManualInvestmentSnapshotSource, new Date().toISOString());
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
        const { error: revertErr } = await supabase
          .from('investments')
          .update({ ...restorableFieldsFromManualSnapshot(snap), ...II_TRACKING_FIELDS_TO_CLEAR_ON_RESTORE, source_type: 'manual', pre_publication_manual_snapshot: null, ii_linked_at: null, ii_publication_id: null })
          .eq('id', publishedRowId)
          .eq('user_id', userId);
        if (revertErr) {
          // The compensation write itself failed — this is now a genuinely
          // inconsistent row (stamped published, no backing publication) and
          // must be surfaced loudly, not swallowed, per spec section 46.
          await emitAuditEvent({ userId, eventType: 'publication_failed', subjectType: 'investments', subjectId: publishedRowId, actorType: 'system', metadata: { positionId, reason: `compensation write failed: ${revertErr.message}`, compensated: false } });
        }
      }
    }
    await emitAuditEvent({ userId, eventType: 'publication_failed', subjectType: 'investments', subjectId: publishedRowId, actorType: 'system', metadata: { positionId, reason: pubErr?.message ?? 'unknown', compensated: true } });
    return { publicationId: null, publishedRowId: null, action: null, financialImpact: null, error: `Publication failed and was safely rolled back: ${pubErr?.message ?? 'unknown error'}`, errorCode: 'WRITE_FAILED' };
  }

  // Back-link the target row to its now-created publication. A genuine
  // live-testing-discovered gap (R3 closure pass): the initial fieldPayload
  // is built before the publication row exists, so ii_publication_id must
  // be set in a follow-up write, exactly as republishPosition() already
  // does for the republish case. Never touches current_value/ownership/
  // any economically-significant field — purely the provenance pointer the
  // UI's "Review in Investment Intelligence" link and future consistency
  // checks rely on.
  await supabase.from('investments').update({ ii_publication_id: pub.id }).eq('id', publishedRowId).eq('user_id', userId);

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
    const { error: restoreErr } = await supabase
      .from('investments')
      .update({ ...restorableFieldsFromManualSnapshot(snap), ...II_TRACKING_FIELDS_TO_CLEAR_ON_RESTORE, source_type: 'manual', pre_publication_manual_snapshot: null, ii_linked_at: null, ii_publication_id: null, is_active: true })
      .eq('id', pub.published_row_id)
      .eq('user_id', userId);
    if (restoreErr) return { error: `Unpublish restore failed: ${restoreErr.message}` };
  } else {
    // Was a brand-new II-created row — archiving is the correct exclusion
    // mechanism (matches R0_NET_WORTH_DEDUP_CONTRACT.md scenario 10; the
    // existing registry.archive() semantics: is_active=false already
    // excludes from computeDashboard() automatically, no engine changes).
    const { error: archiveErr } = await supabase.from('investments').update({ is_active: false, ii_publication_id: null }).eq('id', pub.published_row_id).eq('user_id', userId);
    if (archiveErr) return { error: `Unpublish archive failed: ${archiveErr.message}` };
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

  // Re-derive the FULL certified field set (matching publishPosition()'s
  // fieldPayload), not just the 3 economically-significant fields the
  // original implementation wrote. Live-DEV reproduction (R3 closure pass)
  // confirmed the gap directly: after unpublish -> republish, current_value
  // correctly read 520000 but investment_name stayed "Original Manual
  // Investment" and ii_canonical_account_id stayed null, even though
  // source_type read 'investment_intelligence_published' — a provenance/
  // display-consistency bug, not a financial-integrity one (value/cost_base/
  // owner were already correct). account_id/instrument_id live on the
  // publication row itself; the rest (name/institution/instrument class/
  // quality status) isn't persisted on ii_fhip_publications, so it's
  // re-fetched fresh here rather than trusted from whatever the investments
  // row happened to hold pre-unpublish.
  const [{ data: accountRaw }, { data: instrumentRaw }, { data: snapshotRaw }] = await Promise.all([
    supabase.from('ii_accounts').select('id, institution_name').eq('id', pub.account_id).eq('user_id', userId).maybeSingle(),
    supabase.from('ii_instruments').select('id, instrument_class, instrument_name, amc_name').eq('id', pub.instrument_id).maybeSingle(),
    supabase.from('ii_holding_snapshots').select('quality_status').eq('id', pub.canonical_position_id).eq('user_id', userId).maybeSingle(),
  ]);
  if (!accountRaw || !instrumentRaw) return { error: 'Republish failed: the account or instrument backing this publication is missing or inaccessible.', publicationId: null };
  const account = accountRaw as { id: string; institution_name: string };
  const instrument = instrumentRaw as { id: string; instrument_class: IiInstrumentClass; instrument_name: string; amc_name: string | null };
  const qualityStatus = ((snapshotRaw as { quality_status: string } | null)?.quality_status) ?? 'unknown';

  // Live-testing-discovered defect (found independently, second closure
  // pass): the row's pre_publication_manual_snapshot is already null at this
  // point for a previously-linked row — the preceding unpublish() consumed
  // it to restore the row to manual state, then cleared it (correctly, so a
  // stale snapshot is never reused — see unpublishPosition()'s own
  // discipline). But that means the row sitting here RIGHT NOW, if its
  // source_type still reads 'manual', genuinely IS the user's live manual
  // data (it was just correctly restored) — and republish is about to
  // overwrite it with certified values again. Without re-capturing a FRESH
  // snapshot of exactly this state first, a SUBSEQUENT unpublish would find
  // pre_publication_manual_snapshot=null and incorrectly take the
  // brand-new-position ARCHIVE branch instead of the RESTORE branch —
  // silently removing the investment from net worth entirely while leaving
  // it permanently stamped with the certified name/value/currency. Live-DEV
  // reproduced exactly this: link -> unpublish (correct restore) -> republish
  // (silently dropped the manual snapshot) -> unpublish again ->
  // is_active=false, investment_name/current_value/currency_code left at the
  // certified values, never restored. If the row's source_type is already
  // 'investment_intelligence_published' here (the "brand-new position,
  // never linked to manual data" case — unpublish only archived it, never
  // restored anything), there is no manual state to protect and no snapshot
  // is captured, matching the existing archive-then-reactivate semantics.
  const { data: preRepublishRow } = await supabase
    .from('investments')
    .select('source_type, investment_name, investment_type, current_value, currency_code, country_code, institution, cost_base, owner, master_item_key, annual_contribution, risk_profile')
    .eq('id', pub.published_row_id)
    .eq('user_id', userId)
    .maybeSingle();
  const freshManualSnapshot =
    preRepublishRow && preRepublishRow.source_type === 'manual'
      ? buildPreLinkManualSnapshot(preRepublishRow as unknown as ManualInvestmentSnapshotSource, new Date().toISOString())
      : null;

  const { error: investUpdateErr } = await supabase
    .from('investments')
    .update({
      source_type: 'investment_intelligence_published',
      investment_name: instrument.instrument_name,
      investment_type: mapInstrumentClassToInvestmentType(instrument.instrument_class),
      current_value: pub.published_value,
      currency_code: pub.source_currency,
      country_code: pub.source_country,
      institution: instrument.amc_name ?? account.institution_name,
      cost_base: pub.published_cost_base,
      annual_contribution: pub.published_annual_contribution,
      risk_profile: pub.risk_band,
      owner: pub.published_owner,
      master_item_key: pub.target_master_item_key,
      ii_canonical_account_id: account.id,
      ii_canonical_instrument_id: instrument.id,
      ii_source_quality_status: qualityStatus,
      ii_publication_id: publicationId,
      ii_last_refreshed_at: new Date().toISOString(),
      is_active: true,
      ...(freshManualSnapshot ? { pre_publication_manual_snapshot: freshManualSnapshot, ii_linked_at: new Date().toISOString() } : {}),
    })
    .eq('id', pub.published_row_id)
    .eq('user_id', userId);
  if (investUpdateErr) return { error: `Republish failed: could not restore the certified field set: ${investUpdateErr.message}`, publicationId: null };

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

  // Activate the new snapshot. Corrected ordering (live-testing-discovered
  // defect, R3 closure pass — the original ordering inserted the new
  // 'published' row BEFORE marking the old one 'superseded', which
  // unconditionally violated uidx_ii_fhip_publications_one_active_position
  // — a refresh could never succeed in production). The safe order:
  //   1. Mark the OLD publication 'superseded' FIRST (frees the unique
  //      partial-index slot for this economic position).
  //   2. Insert the NEW publication row with status='published'. If this
  //      fails, COMPENSATE by reverting the old row back to 'published'
  //      (undoing step 1) — never leave the position with zero active
  //      publications.
  //   3. Only once the new publication row exists does the target
  //      investments row get updated to the new value + back-linked to the
  //      new publication id — so investments.current_value is NEVER
  //      observable as ahead of the publication record that is supposed to
  //      back it (the exact half-written state this ordering bug produced
  //      live: current_value=561000 while the only 'published' row still
  //      said published_value=520000).
  const { error: supersedeErr } = await supabase
    .from('ii_fhip_publications')
    .update({ status: 'superseded', supersession_reason: decision.reason })
    .eq('id', active.id as string)
    .eq('user_id', userId);
  if (supersedeErr) {
    return { error: `Refresh failed at step 1 (supersede old publication): ${supersedeErr.message}`, publicationId: null, decision: null };
  }

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
    // COMPENSATE: revert the old publication back to 'published' — the
    // position must never be left with zero active publications.
    await supabase.from('ii_fhip_publications').update({ status: 'published', supersession_reason: null }).eq('id', active.id as string).eq('user_id', userId);
    await emitAuditEvent({ userId, eventType: 'publication_failed', subjectType: 'ii_fhip_publications', subjectId: active.id as string, actorType: 'system', metadata: { reason: newPubErr?.message ?? 'unknown', compensated: true } });
    return { error: newPubErr?.message ?? 'Refresh failed', publicationId: null, decision: null };
  }

  // Link the old row's forward pointer now that the new row's id is known.
  await supabase.from('ii_fhip_publications').update({ superseded_by_publication_id: newPub.id }).eq('id', active.id as string).eq('user_id', userId);

  // Only now does the target row change — after a real, backing, active
  // publication exists, never before.
  const { error: investUpdateErr } = await supabase
    .from('investments')
    .update({ current_value: snapshot.value, ii_last_refreshed_at: new Date().toISOString(), ii_source_quality_status: snapshot.quality_status, ii_publication_id: newPub.id })
    .eq('id', active.published_row_id)
    .eq('user_id', userId);
  if (investUpdateErr) {
    await emitAuditEvent({ userId, eventType: 'publication_failed', subjectType: 'investments', subjectId: active.published_row_id as string, actorType: 'system', metadata: { reason: `investments row update failed after publication row was already created: ${investUpdateErr.message}`, publicationId: newPub.id } });
    return { error: `Refresh partially completed — the publication record was created (id=${newPub.id}) but the investments row could not be updated: ${investUpdateErr.message}. Manual reconciliation required.`, publicationId: newPub.id as string, decision: decision.action };
  }

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
