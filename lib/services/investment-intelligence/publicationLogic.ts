// Investment Intelligence R3 — FHIP Publishing Integration & No-Double-
// Counting Certification. Pure, DB-free decision logic. Every function here
// takes plain data and returns a plain decision — no Supabase client, no
// I/O — so the single most important invariant in this release (one
// economic position contributes to net worth exactly once) can be proven
// with real, fast, deterministic unit tests independent of the sandbox's
// DB-migration-application constraint.
//
// lib/services/investment-intelligence/investmentPublicationService.ts is
// the thin DB-touching orchestration layer that calls these functions.
//
// Governing docs: R0_FHIP_PUBLISHING_CONTRACT.md, R0_NET_WORTH_DEDUP_CONTRACT.md,
// R0_CROSS_BORDER_CONTRACT.md, R3_FHIP_MAPPING_SPEC.md, R3_DUPLICATE_RESOLUTION_SPEC.md,
// R3_NO_DOUBLE_COUNT_CERTIFICATION.md.

import { convertToReportingCurrency, type SupportedCurrency } from '@/lib/engines/fx';
import type {
  FhipOwner,
  HouseholdMemberRelationship,
  IiAccountType,
  IiCostBaseStatus,
  IiDuplicateCandidate,
  IiEligibilityReason,
  IiEligibilityResult,
  IiFinancialImpact,
  IiInstrumentClass,
  IiPublicationTarget,
  IiRiskBand,
} from './types';

// ---------------------------------------------------------------------------
// Routing (spec section 43). Re-exported from the R1 publishing module —
// this is the SAME function R1 froze and R1's own tests already exercise
// (tests/unit/iiPublishing.test.ts); R3 does not fork or duplicate it.
// ---------------------------------------------------------------------------
export { computePublicationTarget } from './publishing';

// R3 production scope gate (spec "R3 initial asset scope" — R2 only
// certifies Indian Mutual Funds). Every other instrument class routes
// structurally (the router/target logic is exercised and correct) but is
// blocked from actually publishing in R3, per the spec's explicit
// instruction not to "expand into stocks/bonds/NPS/etc unless R2 already
// certifies them (it doesn't)".
export function isProductionCertifiedAssetClass(instrumentClass: IiInstrumentClass): boolean {
  return instrumentClass === 'mutual_fund';
}

// ---------------------------------------------------------------------------
// ITEM mapping (spec section 13 / R0_FHIP_PUBLISHING_CONTRACT.md ITEM).
// Only the R2-certified instrument class needs a real target in R3;
// everything else maps to null (no master item key — REVIEW_REQUIRED gate
// blocks these from reaching production, but the mapping table is written
// generically so a future release adds a row, not a rewrite).
// ---------------------------------------------------------------------------
const INSTRUMENT_CLASS_TO_MASTER_ITEM_KEY: Partial<Record<IiInstrumentClass, string>> = {
  mutual_fund: 'managed_funds',
  // Future releases (not R3 production): equity -> 'australian_shares' |
  // 'international_shares' (country-dependent, needs its own resolution
  // rule), etf -> 'etfs', bond -> 'bonds', fixed_deposit -> handled via the
  // 'assets' target instead (term_deposits), gold -> 'gold'.
};

export function mapInstrumentClassToMasterItemKey(instrumentClass: IiInstrumentClass): string | null {
  return INSTRUMENT_CLASS_TO_MASTER_ITEM_KEY[instrumentClass] ?? null;
}

// investment_type is the Zod-validated FHIP column (lib/validation/investment.ts,
// singular enum values) — kept in lockstep with master_item_key so
// dashboard.ts's bucketInvestmentType()/investmentCalculator.ts's
// resolveAssetClass() both classify correctly even in the (R3-unused, but
// tested) case master_item_key is unset.
const INSTRUMENT_CLASS_TO_INVESTMENT_TYPE: Partial<Record<IiInstrumentClass, string>> = {
  mutual_fund: 'managed_fund',
  equity: 'shares',
  etf: 'etf',
  crypto: 'crypto',
};

export function mapInstrumentClassToInvestmentType(instrumentClass: IiInstrumentClass): string {
  return INSTRUMENT_CLASS_TO_INVESTMENT_TYPE[instrumentClass] ?? 'other';
}

// ---------------------------------------------------------------------------
// OWNER mapping (spec section 14 / R0_FHIP_PUBLISHING_CONTRACT.md OWNER).
// investments.owner is a ROLE ENUM (migration 0004), not a household_members
// FK — this function is the exact, documented correction of the R0
// contract's imprecise phrasing against the real schema.
// ---------------------------------------------------------------------------
const RELATIONSHIP_TO_OWNER: Record<HouseholdMemberRelationship, FhipOwner> = {
  self: 'self',
  spouse: 'spouse',
  partner: 'spouse', // closest existing FHIP owner-enum value; documented decision, not inferred silently
  child: 'child',
  parent: 'other',
  other_dependant: 'other',
  other: 'other',
};

export function mapRelationshipToOwner(relationship: HouseholdMemberRelationship): FhipOwner {
  return RELATIONSHIP_TO_OWNER[relationship];
}

// ---------------------------------------------------------------------------
// COST BASE status (spec section 16). Never fabricate or back-solve a
// number. 'certified' only when open-lot history is complete back to the
// account's true opening; 'partial' when some lots exist but history is
// truncated; 'not_available'/'unknown' otherwise -> publish current_value's
// cost_base column as null (matches the existing, already-tested
// dashboard.ts fallback: cost_base ?? current_value => zero unrealised gain).
// ---------------------------------------------------------------------------
export function resolveCostBaseStatus(historyCompleteness: string | null, hasOpenLots: boolean): IiCostBaseStatus {
  if (!hasOpenLots) return 'not_available';
  if (historyCompleteness === 'complete_from_inception' || historyCompleteness === 'complete_from_known_opening_balance') return 'certified';
  if (historyCompleteness === 'partial_history' || historyCompleteness === 'holdings_only') return 'partial';
  return 'unknown';
}

export function resolveCostBaseValue(status: IiCostBaseStatus, aggregatedCostBase: number | null): number | null {
  return status === 'certified' || status === 'partial' ? aggregatedCostBase : null;
}

// ---------------------------------------------------------------------------
// RISK BAND (spec section 17). Investment risk, never behavioural risk
// tolerance (no such concept exists in FHIP — R0 discovery). 'unknown' is
// correct whenever no certified reference data resolves the band; R3 does
// not build a risk-scoring engine — this is a narrow, explicit lookup only.
// ---------------------------------------------------------------------------
export function resolveRiskBand(instrumentClass: IiInstrumentClass): IiRiskBand {
  // No certified per-instrument volatility reference data exists in R1/R2
  // (ii_analytics_results is schema-only, unpopulated — R0_CANONICAL_DATA_CONTRACT.md).
  // Every instrument class therefore resolves to 'unknown' in R3, deliberately
  // — never guessed. This function exists (rather than a hardcoded literal
  // at every call site) so a future release wiring real reference data
  // changes exactly one place.
  void instrumentClass;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// ANNUAL CONTRIBUTION (spec section 19 — the CRITICAL rule). Never inferred
// from historical transactions/SIP amounts. Only a user-CONFIRMED forward
// plan may populate this field.
// ---------------------------------------------------------------------------
export function resolveAnnualContribution(confirmedAnnualPlan: number | null | undefined): { value: number | null; source: 'confirmed_user_plan' | 'none' } {
  if (confirmedAnnualPlan != null && confirmedAnnualPlan >= 0) return { value: confirmedAnnualPlan, source: 'confirmed_user_plan' };
  return { value: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// Publication eligibility gate (spec section 10). Deterministic — every
// blocking condition is named and testable independently.
// ---------------------------------------------------------------------------
export interface EligibilityInput {
  ownerMemberId: string | null; // resolved household_members.id, or null if unresolved
  instrumentClass: IiInstrumentClass;
  accountType: IiAccountType;
  portfolioTruthStatus: string; // ii_portfolio_truth_status.status
  hasBlockingReconciliation: boolean;
  currentValue: number | null;
  countryCode: string | null;
  currencyCode: string | null;
}

const ACCEPTABLE_PORTFOLIO_TRUTH_STATUSES = new Set(['certified', 'certified_with_warnings']);

export function evaluateEligibility(input: EligibilityInput): IiEligibilityResult {
  const blocking: IiEligibilityReason[] = [];
  const warning: IiEligibilityReason[] = [];

  if (!input.ownerMemberId) {
    blocking.push({ code: 'OWNER_UNRESOLVED', message: 'The statement holder could not be safely mapped to an existing household member.' });
  }
  if (!isProductionCertifiedAssetClass(input.instrumentClass)) {
    blocking.push({ code: 'ASSET_CLASS_NOT_YET_CERTIFIED', message: `R3 only publishes certified Indian mutual fund positions; instrument class '${input.instrumentClass}' is not yet a supported publication target.` });
  }
  if (!ACCEPTABLE_PORTFOLIO_TRUTH_STATUSES.has(input.portfolioTruthStatus)) {
    blocking.push({ code: 'NOT_CERTIFIED', message: `Portfolio Truth status '${input.portfolioTruthStatus}' is not an acceptable certification state for publication.` });
  }
  if (input.hasBlockingReconciliation) {
    blocking.push({ code: 'BLOCKING_RECONCILIATION_OPEN', message: 'An unresolved blocking reconciliation case exists for this position.' });
  }
  if (input.currentValue == null || !Number.isFinite(input.currentValue) || input.currentValue < 0) {
    blocking.push({ code: 'NO_USABLE_VALUATION', message: 'No usable certified valuation is available for this position.' });
  }
  if (!input.countryCode) {
    blocking.push({ code: 'COUNTRY_UNKNOWN', message: 'The position\'s country could not be determined.' });
  }
  if (!input.currencyCode) {
    blocking.push({ code: 'CURRENCY_UNKNOWN', message: 'The position\'s currency could not be determined.' });
  }
  const target = mapInstrumentClassToMasterItemKey(input.instrumentClass);
  if (isProductionCertifiedAssetClass(input.instrumentClass) && !target) {
    blocking.push({ code: 'NO_VALID_PUBLICATION_TARGET', message: 'No approved FHIP publication target exists for this instrument classification.' });
  }
  if (input.portfolioTruthStatus === 'certified_with_warnings') {
    warning.push({ code: 'CERTIFIED_WITH_WARNINGS', message: 'This position is certified with warnings — it may still publish, but the value should be treated as approximate until fully reconciled.' });
  }

  if (blocking.length > 0) return { status: 'NOT_ELIGIBLE', blockingReasons: blocking, warningReasons: warning };
  if (warning.length > 0) return { status: 'REVIEW_REQUIRED', blockingReasons: [], warningReasons: warning };
  return { status: 'ELIGIBLE', blockingReasons: [], warningReasons: [] };
}

// ---------------------------------------------------------------------------
// Duplicate-candidate detection (spec section 27, DD-005). Deterministic
// signal matching only — NEVER auto-merges on value-alone or text-
// similarity-alone. Returns every candidate above a minimum signal
// threshold; the caller always surfaces these as a user-reviewable
// decision, never an automatic action.
// ---------------------------------------------------------------------------
export interface ExistingManualInvestmentRow {
  id: string;
  owner: string;
  masterItemKey: string | null;
  institution: string | null;
  countryCode: string | null;
  currencyCode: string;
  currentValue: number;
  sourceType: string;
}

export interface NewPositionForDuplicateCheck {
  owner: FhipOwner;
  masterItemKey: string | null;
  institution: string | null;
  countryCode: string | null;
  currencyCode: string;
  currentValue: number;
}

const APPROX_VALUE_TOLERANCE_PCT = 0.15; // 15% — a signal, not a hard match; never used alone to auto-merge

export function detectDuplicateCandidates(newPosition: NewPositionForDuplicateCheck, existingManualRows: ExistingManualInvestmentRow[]): IiDuplicateCandidate[] {
  const candidates: IiDuplicateCandidate[] = [];
  for (const row of existingManualRows) {
    if (row.sourceType !== 'manual') continue; // never propose a duplicate against an already-published row
    const matchedOn: string[] = [];
    let score = 0;

    if (row.owner === newPosition.owner) {
      matchedOn.push('owner');
      score += 0.25;
    }
    if (row.masterItemKey && newPosition.masterItemKey && row.masterItemKey === newPosition.masterItemKey) {
      matchedOn.push('category');
      score += 0.2;
    }
    if (row.countryCode && newPosition.countryCode && row.countryCode === newPosition.countryCode) {
      matchedOn.push('country');
      score += 0.1;
    }
    if (row.currencyCode === newPosition.currencyCode) {
      matchedOn.push('currency');
      score += 0.1;
    }
    if (row.institution && newPosition.institution && normaliseInstitutionName(row.institution) === normaliseInstitutionName(newPosition.institution)) {
      matchedOn.push('institution');
      score += 0.2;
    }
    if (row.currentValue > 0 && Math.abs(row.currentValue - newPosition.currentValue) / row.currentValue <= APPROX_VALUE_TOLERANCE_PCT) {
      matchedOn.push('approximate_value');
      score += 0.15;
    }

    // Structural gate — owner + category are always required. INSTITUTION
    // is the decisive signal distinguishing spec section 31 (SAME fund,
    // same institution, close value -> genuine duplicate) from section 32
    // (DIFFERENT institution, similarly close value -> genuinely separate
    // investments): when both sides carry a known institution, it MUST also
    // match, regardless of how close the values are — value proximity alone
    // must never imply "same investment" (this is the concrete rule that
    // makes DD-005 and the section-32 "genuine separate investment" case
    // distinguishable; both scenarios' example values are deliberately
    // close, 500,000 vs 520,000, precisely to test this). When either side's
    // institution is unknown, fall back to owner+category+approximate_value
    // as the structural gate instead.
    const bothInstitutionsKnown = !!row.institution && !!newPosition.institution;
    const hasStructuralMatch = bothInstitutionsKnown
      ? matchedOn.includes('owner') && matchedOn.includes('category') && matchedOn.includes('institution')
      : matchedOn.includes('owner') && matchedOn.includes('category') && matchedOn.includes('approximate_value');
    if (hasStructuralMatch && score >= 0.5) {
      candidates.push({
        investmentId: row.id,
        matchScore: Math.min(1, score),
        matchedOn,
        existingValue: row.currentValue,
        existingCurrency: row.currencyCode,
        existingInstitution: row.institution,
        existingOwner: row.owner,
      });
    }
  }
  return candidates.sort((a, b) => b.matchScore - a.matchScore);
}

function normaliseInstitutionName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\bmutual fund\b/g, '').replace(/\blimited\b|\bltd\b/g, '').trim();
}

// ---------------------------------------------------------------------------
// Financial impact preview (spec section 42, NW test pack). EXACT
// arithmetic — never approximate. netChange must equal newPublishedValue
// when there is no duplicate, and (newPublishedValue - manualValueBeingSuperseded)
// on a confirmed duplicate link — never the full new value in that case.
// ---------------------------------------------------------------------------
export function calculateFinancialImpact(input: {
  currentIncludedValue: number; // 0 if this is a brand-new position with nothing currently counted
  newPublishedValue: number;
  manualValueBeingSuperseded: number; // 0 unless linking to an existing manual row
  currency: string;
}): IiFinancialImpact {
  const netChange = round2(input.newPublishedValue - input.manualValueBeingSuperseded);
  return {
    currentIncludedValue: round2(input.currentIncludedValue),
    newPublishedValue: round2(input.newPublishedValue),
    manualValueBeingSuperseded: round2(input.manualValueBeingSuperseded),
    netChange,
    currency: input.currency,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Register action classification (spec section 12's "make explicit whether
// the action adds new / replaces-links existing / leaves existing unchanged
// / requires review").
// ---------------------------------------------------------------------------
export function classifyRegisterAction(input: { eligibility: IiEligibilityResult; duplicateCandidates: IiDuplicateCandidate[]; userConfirmedLinkId: string | null }): 'ADD_NEW' | 'REPLACE_LINK_EXISTING' | 'LEAVE_UNCHANGED' | 'REQUIRES_REVIEW' {
  if (input.eligibility.status === 'NOT_ELIGIBLE') return 'LEAVE_UNCHANGED';
  if (input.userConfirmedLinkId) return 'REPLACE_LINK_EXISTING';
  if (input.duplicateCandidates.length > 0) return 'REQUIRES_REVIEW';
  return 'ADD_NEW';
}

// ---------------------------------------------------------------------------
// Refresh / republish ordering (spec sections 33-35, PUB-DEDUP-005/006/007).
// Decides what a NEW certified snapshot should do to an EXISTING active
// publication for the SAME economic position (account_id, instrument_id).
// ---------------------------------------------------------------------------
export interface RefreshDecisionInput {
  activeAsOfDate: string; // the currently active publication's snapshot as_of_date
  activeCertifiedAt: string | null;
  newAsOfDate: string;
  newCertifiedAt: string | null;
}

export type RefreshDecision =
  | { action: 'ACTIVATE_NEW'; reason: string }
  | { action: 'REJECT_OLDER'; reason: string }
  | { action: 'ACTIVATE_NEW_SAME_DATE_CORRECTION'; reason: string };

export function decideRefreshSupersession(input: RefreshDecisionInput): RefreshDecision {
  if (input.newAsOfDate > input.activeAsOfDate) {
    return { action: 'ACTIVATE_NEW', reason: `New snapshot as_of_date (${input.newAsOfDate}) is newer than the active publication's (${input.activeAsOfDate}).` };
  }
  if (input.newAsOfDate < input.activeAsOfDate) {
    return { action: 'REJECT_OLDER', reason: `New snapshot as_of_date (${input.newAsOfDate}) is older than the active publication's (${input.activeAsOfDate}) — an older statement must never overwrite a newer active value.` };
  }
  // Same as_of_date: a corrected same-date statement. Deterministic tiebreak
  // — the newer certification timestamp wins (a later certification of the
  // same date is presumed to be the correction), never silently rewritten
  // without a distinguishable reason recorded by the caller.
  const activeCert = input.activeCertifiedAt ?? '';
  const newCert = input.newCertifiedAt ?? '';
  if (newCert > activeCert) {
    return { action: 'ACTIVATE_NEW_SAME_DATE_CORRECTION', reason: `Same as_of_date (${input.newAsOfDate}); new certification timestamp (${newCert}) is later than the active publication's (${activeCert}) — treated as a correction.` };
  }
  return { action: 'REJECT_OLDER', reason: `Same as_of_date (${input.newAsOfDate}); new certification timestamp is not later than the active publication's — not treated as a correction.` };
}

// ---------------------------------------------------------------------------
// Cross-border currency (spec section 22, CUR test pack). Source-currency
// value is NEVER modified by this function — it only computes a DISPLAY-ONLY
// derived base-currency figure, or reports that conversion is unavailable.
// ---------------------------------------------------------------------------
const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(['AUD', 'INR']);

export interface BaseCurrencyConversionResult {
  available: boolean;
  baseCurrencyAmount: number | null;
  rateUsed: number | null;
  reason?: string;
}

export function computeBaseCurrencyPreview(sourceAmount: number, sourceCurrency: string, householdCurrency: string, fxRateAudInr: number | null | undefined): BaseCurrencyConversionResult {
  if (!SUPPORTED_CURRENCIES.has(sourceCurrency) || !SUPPORTED_CURRENCIES.has(householdCurrency)) {
    return { available: false, baseCurrencyAmount: null, rateUsed: null, reason: `Currency conversion is only supported between AUD and INR (got source='${sourceCurrency}', household='${householdCurrency}').` };
  }
  if (fxRateAudInr == null || !Number.isFinite(fxRateAudInr) || fxRateAudInr <= 0) {
    return { available: false, baseCurrencyAmount: null, rateUsed: null, reason: 'No valid FX rate is currently configured.' };
  }
  if (sourceCurrency === householdCurrency) {
    return { available: true, baseCurrencyAmount: round2(sourceAmount), rateUsed: 1 };
  }
  const converted = convertToReportingCurrency(sourceAmount, sourceCurrency as SupportedCurrency, householdCurrency as SupportedCurrency, fxRateAudInr);
  return { available: true, baseCurrencyAmount: round2(converted), rateUsed: fxRateAudInr };
}

// ---------------------------------------------------------------------------
// Idempotency key (spec sections 45/46). Deterministic function of the
// economic position + target + the exact snapshot being published — a
// double-click/retry for the SAME snapshot computes the SAME key, letting
// the service layer recognise and short-circuit a duplicate request before
// ever attempting a second write.
// ---------------------------------------------------------------------------
export function computeIdempotencyKey(input: { accountId: string; instrumentId: string; canonicalPositionId: string; publicationTarget: IiPublicationTarget }): string {
  return `${input.accountId}:${input.instrumentId}:${input.canonicalPositionId}:${input.publicationTarget}`;
}

// ---------------------------------------------------------------------------
// Pre-link manual snapshot (R3 closure pass — provenance-preservation fix,
// docs/investment-intelligence/R3_CLOSURE_REPORT.md). The orchestrating
// session's live-DEV testing found `investment_name` was overwritten by
// publishPosition()'s REPLACE_LINK_EXISTING path but never captured in
// `pre_publication_manual_snapshot`, so unpublishPosition() could never
// restore it — the original manual name was silently, permanently lost.
// Inspecting the FULL fieldPayload publishPosition() writes (not just
// investment_name) found two more of the same class of bug: currency_code
// and country_code are also overwritten and were also never captured/
// restored — meaning a restored current_value could end up mis-tagged with
// the WRONG currency after unpublish (500,000 originally denominated AUD
// silently re-tagged INR), a latent value-integrity bug riding on the same
// root cause. These two pure functions are now the SINGLE place that
// decides what "the manual row's reversible state" means, used by both the
// capture site (publishPosition) and every restore site (unpublishPosition,
// and the publish-failure compensation path) — so the two can never drift
// out of sync again the way the ad-hoc inline object literals did.
//
// Deliberately built as an allow-list keyed by field name, not a spread of
// the whole row: this is what makes it BACKWARD COMPATIBLE for free. A
// snapshot captured before this fix shipped simply has no `investment_name`/
// `currency_code`/`country_code` key at all; reading a missing key here
// yields `undefined`, and `JSON.stringify` (which every supabase-js
// `.update()` call goes through before hitting PostgREST) drops object
// properties whose value is `undefined` — so an old snapshot's restore
// payload omits those three columns entirely rather than sending a bad
// value, and PostgREST leaves whatever is currently in those columns
// untouched. No historical value is ever fabricated for pre-fix rows.
// ---------------------------------------------------------------------------
export interface ManualInvestmentSnapshotSource {
  investment_name: string;
  investment_type: string;
  current_value: number;
  currency_code: string;
  country_code: string | null;
  institution: string | null;
  cost_base: number | null;
  owner: string;
  master_item_key: string | null;
  annual_contribution: number | null;
  risk_profile: string | null;
}

// Ordered, single source of truth for exactly which `investments` columns
// are reversible manual state. Add a field here (and to
// ManualInvestmentSnapshotSource above) the moment a future change makes
// publishPosition()'s fieldPayload overwrite one more manual column.
const MANUAL_SNAPSHOT_FIELDS = [
  'investment_name',
  'current_value',
  'currency_code',
  'country_code',
  'cost_base',
  'institution',
  'owner',
  'investment_type',
  'master_item_key',
  'annual_contribution',
  'risk_profile',
] as const;

export function buildPreLinkManualSnapshot(row: ManualInvestmentSnapshotSource, capturedAt: string): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { captured_at: capturedAt };
  for (const field of MANUAL_SNAPSHOT_FIELDS) {
    snapshot[field] = row[field];
  }
  return snapshot;
}

// Extracts ONLY real `investments` columns from a stored snapshot — drops
// `captured_at` (not a column; spreading it raw into `.update()` was R3's
// original closure-pass defect, see the `restorableFieldsFromSnapshot`
// history this function replaces) and, for a pre-fix snapshot missing the
// newer keys, naturally omits them (see the backward-compatibility note
// above) rather than restoring `undefined`/fabricated values.
export function restorableFieldsFromManualSnapshot(snap: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of MANUAL_SNAPSHOT_FIELDS) {
    out[field] = snap[field];
  }
  return out;
}

export type { IiDuplicateCandidate, IiEligibilityResult, IiFinancialImpact };
