import { describe, it, expect } from 'vitest';
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
} from '@/lib/services/investment-intelligence/publicationLogic';

// R3 — FHIP Publishing Integration & No-Double-Counting Certification.
// Every function under test here is pure/DB-free by design specifically so
// the central no-double-count invariant can be proven with real,
// deterministic unit tests independent of the sandbox's DB-migration
// constraint (see R3_TESTING_AND_VERIFICATION.md).

describe('R3 production scope gate', () => {
  it('only mutual_fund is production-certified in R3 (R2 only certifies Indian MFs)', () => {
    expect(isProductionCertifiedAssetClass('mutual_fund')).toBe(true);
    expect(isProductionCertifiedAssetClass('equity')).toBe(false);
    expect(isProductionCertifiedAssetClass('etf')).toBe(false);
    expect(isProductionCertifiedAssetClass('bond')).toBe(false);
    expect(isProductionCertifiedAssetClass('fixed_deposit')).toBe(false);
    expect(isProductionCertifiedAssetClass('gold')).toBe(false);
    expect(isProductionCertifiedAssetClass('crypto')).toBe(false);
    expect(isProductionCertifiedAssetClass('cash')).toBe(false);
    expect(isProductionCertifiedAssetClass('other')).toBe(false);
  });
});

describe('ITEM mapping (mutual_fund -> managed_funds)', () => {
  it('maps mutual_fund to the managed_funds master item key', () => {
    expect(mapInstrumentClassToMasterItemKey('mutual_fund')).toBe('managed_funds');
  });
  it('returns null for every non-yet-supported instrument class (generic router, no hardcoded MF-only architecture)', () => {
    expect(mapInstrumentClassToMasterItemKey('equity')).toBeNull();
    expect(mapInstrumentClassToMasterItemKey('etf')).toBeNull();
    expect(mapInstrumentClassToMasterItemKey('bond')).toBeNull();
  });
  it('maps mutual_fund to the singular Zod-validated investment_type enum value', () => {
    expect(mapInstrumentClassToInvestmentType('mutual_fund')).toBe('managed_fund');
  });
  it('falls back to other for unmapped classes rather than guessing', () => {
    expect(mapInstrumentClassToInvestmentType('gold')).toBe('other');
  });
});

describe('OWNER mapping (household_members.relationship -> investments.owner role enum)', () => {
  it('maps self to self', () => {
    expect(mapRelationshipToOwner('self')).toBe('self');
  });
  it('maps spouse to spouse', () => {
    expect(mapRelationshipToOwner('spouse')).toBe('spouse');
  });
  it('maps partner to spouse (closest existing FHIP owner enum value)', () => {
    expect(mapRelationshipToOwner('partner')).toBe('spouse');
  });
  it('maps child to child', () => {
    expect(mapRelationshipToOwner('child')).toBe('child');
  });
  it('maps parent/other_dependant/other to other (no closer FHIP owner-enum equivalent exists)', () => {
    expect(mapRelationshipToOwner('parent')).toBe('other');
    expect(mapRelationshipToOwner('other_dependant')).toBe('other');
    expect(mapRelationshipToOwner('other')).toBe('other');
  });
});

describe('COST BASE status/value (never fabricated)', () => {
  it('is not_available when there are no open lots', () => {
    expect(resolveCostBaseStatus('complete_from_inception', false)).toBe('not_available');
  });
  it('is certified when lots exist and history is complete', () => {
    expect(resolveCostBaseStatus('complete_from_inception', true)).toBe('certified');
    expect(resolveCostBaseStatus('complete_from_known_opening_balance', true)).toBe('certified');
  });
  it('is partial when lots exist but history is truncated', () => {
    expect(resolveCostBaseStatus('partial_history', true)).toBe('partial');
    expect(resolveCostBaseStatus('holdings_only', true)).toBe('partial');
  });
  it('is unknown when completeness is unrecorded', () => {
    expect(resolveCostBaseStatus(null, true)).toBe('unknown');
  });
  it('publishes null cost_base whenever status is unknown or not_available — never a guessed number', () => {
    expect(resolveCostBaseValue('unknown', 12345)).toBeNull();
    expect(resolveCostBaseValue('not_available', 12345)).toBeNull();
  });
  it('publishes the aggregated figure only when certified or partial', () => {
    expect(resolveCostBaseValue('certified', 50000)).toBe(50000);
    expect(resolveCostBaseValue('partial', 30000)).toBe(30000);
  });
});

describe('RISK BAND (investment risk, never personal risk tolerance)', () => {
  it('resolves unknown for every instrument class in R3 (no certified volatility reference data exists yet)', () => {
    expect(resolveRiskBand('mutual_fund')).toBe('unknown');
    expect(resolveRiskBand('equity')).toBe('unknown');
  });
});

describe('ANNUAL CONTRIBUTION — critical rule: never inferred from history', () => {
  it('publishes null/none when no confirmed plan is supplied', () => {
    expect(resolveAnnualContribution(null)).toEqual({ value: null, source: 'none' });
    expect(resolveAnnualContribution(undefined)).toEqual({ value: null, source: 'none' });
  });
  it('publishes the confirmed plan value with source confirmed_user_plan', () => {
    expect(resolveAnnualContribution(60000)).toEqual({ value: 60000, source: 'confirmed_user_plan' });
  });
  it('treats a negative supplied value as not confirmed (defensive)', () => {
    expect(resolveAnnualContribution(-100)).toEqual({ value: null, source: 'none' });
  });
});

describe('Publication eligibility gate (spec section 10)', () => {
  const baseEligible = {
    ownerMemberId: 'member-1',
    instrumentClass: 'mutual_fund' as const,
    accountType: 'mf_folio' as const,
    portfolioTruthStatus: 'certified',
    hasBlockingReconciliation: false,
    currentValue: 65200,
    countryCode: 'IN',
    currencyCode: 'INR',
  };

  it('is ELIGIBLE for a fully certified, owner-resolved mutual fund position', () => {
    const result = evaluateEligibility(baseEligible);
    expect(result.status).toBe('ELIGIBLE');
    expect(result.blockingReasons).toEqual([]);
  });

  it('is REVIEW_REQUIRED (not ELIGIBLE, not blocked) for certified_with_warnings', () => {
    const result = evaluateEligibility({ ...baseEligible, portfolioTruthStatus: 'certified_with_warnings' });
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.blockingReasons).toEqual([]);
    expect(result.warningReasons.map((w) => w.code)).toContain('CERTIFIED_WITH_WARNINGS');
  });

  it('is NOT_ELIGIBLE with OWNER_UNRESOLVED when no household member is mapped', () => {
    const result = evaluateEligibility({ ...baseEligible, ownerMemberId: null });
    expect(result.status).toBe('NOT_ELIGIBLE');
    expect(result.blockingReasons.map((r) => r.code)).toContain('OWNER_UNRESOLVED');
  });

  it('is NOT_ELIGIBLE for an uncertified Portfolio Truth status', () => {
    for (const status of ['pending', 'parsed', 'reconciliation_required', 'failed', 'superseded', 'archived']) {
      const result = evaluateEligibility({ ...baseEligible, portfolioTruthStatus: status });
      expect(result.status).toBe('NOT_ELIGIBLE');
      expect(result.blockingReasons.map((r) => r.code)).toContain('NOT_CERTIFIED');
    }
  });

  it('is NOT_ELIGIBLE when a blocking reconciliation case is open', () => {
    const result = evaluateEligibility({ ...baseEligible, hasBlockingReconciliation: true });
    expect(result.status).toBe('NOT_ELIGIBLE');
    expect(result.blockingReasons.map((r) => r.code)).toContain('BLOCKING_RECONCILIATION_OPEN');
  });

  it('is NOT_ELIGIBLE when there is no usable valuation', () => {
    expect(evaluateEligibility({ ...baseEligible, currentValue: null }).blockingReasons.map((r) => r.code)).toContain('NO_USABLE_VALUATION');
    expect(evaluateEligibility({ ...baseEligible, currentValue: -1 }).blockingReasons.map((r) => r.code)).toContain('NO_USABLE_VALUATION');
    expect(evaluateEligibility({ ...baseEligible, currentValue: NaN }).blockingReasons.map((r) => r.code)).toContain('NO_USABLE_VALUATION');
  });

  it('is NOT_ELIGIBLE when country or currency is unknown', () => {
    expect(evaluateEligibility({ ...baseEligible, countryCode: null }).blockingReasons.map((r) => r.code)).toContain('COUNTRY_UNKNOWN');
    expect(evaluateEligibility({ ...baseEligible, currencyCode: null }).blockingReasons.map((r) => r.code)).toContain('CURRENCY_UNKNOWN');
  });

  it('is NOT_ELIGIBLE for an instrument class R2 does not yet certify (uncertified/blocking asset types never reach production)', () => {
    const result = evaluateEligibility({ ...baseEligible, instrumentClass: 'equity' });
    expect(result.status).toBe('NOT_ELIGIBLE');
    expect(result.blockingReasons.map((r) => r.code)).toContain('ASSET_CLASS_NOT_YET_CERTIFIED');
  });

  it('accumulates every applicable blocking reason simultaneously, not just the first', () => {
    const result = evaluateEligibility({ ...baseEligible, ownerMemberId: null, portfolioTruthStatus: 'pending', currentValue: null });
    const codes = result.blockingReasons.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['OWNER_UNRESOLVED', 'NOT_CERTIFIED', 'NO_USABLE_VALUATION']));
  });
});

describe('Duplicate-candidate detection (spec section 27, DD-005 critical scenario)', () => {
  it('DD-005: detects the classic manual Managed Funds (500,000) vs imported CAS (520,000) same-owner duplicate', () => {
    const candidates = detectDuplicateCandidates(
      { owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 520000 },
      [{ id: 'manual-row-1', owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 500000, sourceType: 'manual' }]
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].investmentId).toBe('manual-row-1');
    expect(candidates[0].matchedOn).toEqual(expect.arrayContaining(['owner', 'category', 'institution', 'country', 'currency', 'approximate_value']));
    expect(candidates[0].existingValue).toBe(500000);
  });

  it('DD-032 genuine separate investment (spec section 32 exact numbers): different institution, even with CLOSE values (500,000 vs 520,000), is NOT proposed as a duplicate — institution is the decisive signal, not value proximity', () => {
    const candidates = detectDuplicateCandidates(
      { owner: 'self', masterItemKey: 'managed_funds', institution: 'Institution B', countryCode: 'IN', currencyCode: 'INR', currentValue: 520000 },
      [{ id: 'manual-row-2', owner: 'self', masterItemKey: 'managed_funds', institution: 'Institution A', countryCode: 'IN', currencyCode: 'INR', currentValue: 500000, sourceType: 'manual' }]
    );
    expect(candidates).toHaveLength(0);
  });

  it('same institution, same owner, same category, close value (the section-31 shape) IS proposed as a duplicate even when the institution string has minor formatting differences', () => {
    const candidates = detectDuplicateCandidates(
      { owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund Ltd', countryCode: 'IN', currencyCode: 'INR', currentValue: 520000 },
      [{ id: 'manual-row-3', owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 500000, sourceType: 'manual' }]
    );
    expect(candidates).toHaveLength(1);
  });

  it('when institution is unknown on the existing manual row, falls back to owner+category+approximate_value as the structural gate', () => {
    const matched = detectDuplicateCandidates(
      { owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 520000 },
      [{ id: 'no-institution-row', owner: 'self', masterItemKey: 'managed_funds', institution: null, countryCode: 'IN', currencyCode: 'INR', currentValue: 500000, sourceType: 'manual' }]
    );
    expect(matched).toHaveLength(1);

    const notMatched = detectDuplicateCandidates(
      { owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 999999 },
      [{ id: 'no-institution-row-2', owner: 'self', masterItemKey: 'managed_funds', institution: null, countryCode: 'IN', currencyCode: 'INR', currentValue: 500000, sourceType: 'manual' }]
    );
    expect(notMatched).toHaveLength(0);
  });

  it('never proposes a duplicate against a row that is already investment_intelligence_published', () => {
    const candidates = detectDuplicateCandidates(
      { owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 520000 },
      [{ id: 'already-published', owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 500000, sourceType: 'investment_intelligence_published' }]
    );
    expect(candidates).toHaveLength(0);
  });

  it('different owners, same scheme/value are NOT duplicates without a matching owner (PUB-DEDUP-010)', () => {
    const candidates = detectDuplicateCandidates(
      { owner: 'spouse', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 520000 },
      [{ id: 'manual-row-self', owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 500000, sourceType: 'manual' }]
    );
    expect(candidates).toHaveLength(0);
  });

  it('never auto-merges on value-alone (same value, different owner AND different category both absent)', () => {
    const candidates = detectDuplicateCandidates(
      { owner: 'spouse', masterItemKey: 'etfs', institution: null, countryCode: 'IN', currencyCode: 'INR', currentValue: 500000 },
      [{ id: 'unrelated-row', owner: 'self', masterItemKey: 'managed_funds', institution: null, countryCode: 'IN', currencyCode: 'INR', currentValue: 500000, sourceType: 'manual' }]
    );
    expect(candidates).toHaveLength(0);
  });

  it('sorts multiple candidates by descending match score', () => {
    const candidates = detectDuplicateCandidates(
      { owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 520000 },
      [
        { id: 'weak-match', owner: 'self', masterItemKey: 'managed_funds', institution: null, countryCode: null, currencyCode: 'INR', currentValue: 520000, sourceType: 'manual' },
        { id: 'strong-match', owner: 'self', masterItemKey: 'managed_funds', institution: 'ABC Mutual Fund', countryCode: 'IN', currencyCode: 'INR', currentValue: 500000, sourceType: 'manual' },
      ]
    );
    expect(candidates[0].investmentId).toBe('strong-match');
  });
});

describe('Financial impact — exact arithmetic (spec section 42, NW test pack)', () => {
  it('NW-001: new certified MF with no duplicate — net change equals the full new value', () => {
    const impact = calculateFinancialImpact({ currentIncludedValue: 0, newPublishedValue: 65200, manualValueBeingSuperseded: 0, currency: 'INR' });
    expect(impact.netChange).toBe(65200);
    expect(impact.newPublishedValue).toBe(65200);
    expect(impact.manualValueBeingSuperseded).toBe(0);
  });

  it('NW-002: existing manual duplicate (500,000) + certified II value (520,000) — net change is +20,000, NEVER the full +520,000', () => {
    const impact = calculateFinancialImpact({ currentIncludedValue: 500000, newPublishedValue: 520000, manualValueBeingSuperseded: 500000, currency: 'INR' });
    expect(impact.netChange).toBe(20000);
    expect(impact.netChange).not.toBe(520000);
  });

  it('exact example from spec section 42: existing manual 500,000 + new II 520,000 + manual superseded -500,000 = net change +20,000', () => {
    const impact = calculateFinancialImpact({ currentIncludedValue: 500000, newPublishedValue: 520000, manualValueBeingSuperseded: 500000, currency: 'INR' });
    expect(impact.newPublishedValue - impact.manualValueBeingSuperseded).toBe(20000);
    expect(impact.netChange).toBe(20000);
  });

  it('rounds to 2 decimal places without floating-point drift', () => {
    const impact = calculateFinancialImpact({ currentIncludedValue: 0, newPublishedValue: 65200.335, manualValueBeingSuperseded: 0, currency: 'INR' });
    expect(impact.newPublishedValue).toBe(65200.34);
  });

  it('DD-032 genuine separate investment: net-worth increase equals exactly the new investment amount, no over-deduplication', () => {
    const impact = calculateFinancialImpact({ currentIncludedValue: 0, newPublishedValue: 520000, manualValueBeingSuperseded: 0, currency: 'INR' });
    expect(impact.netChange).toBe(520000);
  });
});

describe('Register action classification (spec section 12)', () => {
  it('classifies ADD_NEW when eligible with no duplicate candidates', () => {
    const action = classifyRegisterAction({ eligibility: { status: 'ELIGIBLE', blockingReasons: [], warningReasons: [] }, duplicateCandidates: [], userConfirmedLinkId: null });
    expect(action).toBe('ADD_NEW');
  });
  it('classifies REQUIRES_REVIEW when candidates exist and none is confirmed', () => {
    const action = classifyRegisterAction({
      eligibility: { status: 'ELIGIBLE', blockingReasons: [], warningReasons: [] },
      duplicateCandidates: [{ investmentId: 'x', matchScore: 0.9, matchedOn: [], existingValue: 1, existingCurrency: 'INR', existingInstitution: null, existingOwner: 'self' }],
      userConfirmedLinkId: null,
    });
    expect(action).toBe('REQUIRES_REVIEW');
  });
  it('classifies REPLACE_LINK_EXISTING once the user confirms a link, regardless of other candidates', () => {
    const action = classifyRegisterAction({
      eligibility: { status: 'ELIGIBLE', blockingReasons: [], warningReasons: [] },
      duplicateCandidates: [{ investmentId: 'x', matchScore: 0.9, matchedOn: [], existingValue: 1, existingCurrency: 'INR', existingInstitution: null, existingOwner: 'self' }],
      userConfirmedLinkId: 'x',
    });
    expect(action).toBe('REPLACE_LINK_EXISTING');
  });
  it('classifies LEAVE_UNCHANGED when not eligible, even with candidates', () => {
    const action = classifyRegisterAction({ eligibility: { status: 'NOT_ELIGIBLE', blockingReasons: [{ code: 'X', message: 'x' }], warningReasons: [] }, duplicateCandidates: [], userConfirmedLinkId: null });
    expect(action).toBe('LEAVE_UNCHANGED');
  });
});

describe('Refresh/republish ordering (spec sections 33-35, PUB-DEDUP-006/007)', () => {
  it('activates a genuinely newer snapshot', () => {
    const decision = decideRefreshSupersession({ activeAsOfDate: '2025-03-31', activeCertifiedAt: '2025-04-05T00:00:00Z', newAsOfDate: '2025-06-30', newCertifiedAt: '2025-07-02T00:00:00Z' });
    expect(decision.action).toBe('ACTIVATE_NEW');
  });

  it('PUB-DEDUP-006: rejects an older statement uploaded after a newer one — must NOT replace the active newer publication', () => {
    const decision = decideRefreshSupersession({ activeAsOfDate: '2025-06-30', activeCertifiedAt: '2025-07-02T00:00:00Z', newAsOfDate: '2025-03-31', newCertifiedAt: '2025-07-10T00:00:00Z' });
    expect(decision.action).toBe('REJECT_OLDER');
  });

  it('PUB-DEDUP-007: a same-date corrected statement with a later certification timestamp is treated as a correction', () => {
    const decision = decideRefreshSupersession({ activeAsOfDate: '2025-06-30', activeCertifiedAt: '2025-07-02T00:00:00Z', newAsOfDate: '2025-06-30', newCertifiedAt: '2025-07-05T00:00:00Z' });
    expect(decision.action).toBe('ACTIVATE_NEW_SAME_DATE_CORRECTION');
  });

  it('a same-date statement with an EARLIER or equal certification timestamp is rejected, never silently rewritten', () => {
    const decision = decideRefreshSupersession({ activeAsOfDate: '2025-06-30', activeCertifiedAt: '2025-07-05T00:00:00Z', newAsOfDate: '2025-06-30', newCertifiedAt: '2025-07-02T00:00:00Z' });
    expect(decision.action).toBe('REJECT_OLDER');
  });

  it('every decision carries a human-readable, distinguishable reason', () => {
    const d1 = decideRefreshSupersession({ activeAsOfDate: '2025-01-01', activeCertifiedAt: null, newAsOfDate: '2025-02-01', newCertifiedAt: null });
    expect(d1.reason.length).toBeGreaterThan(10);
  });
});

describe('Cross-border currency (spec section 22, CUR test pack) — CRITICAL FINANCIAL GATE', () => {
  it('CUR-001: INR household + INR investment needs no conversion (identity, rate=1)', () => {
    const result = computeBaseCurrencyPreview(65200, 'INR', 'INR', 56);
    expect(result.available).toBe(true);
    expect(result.baseCurrencyAmount).toBe(65200);
    expect(result.rateUsed).toBe(1);
  });

  it('CUR-002: AUD household + INR investment converts using the household FX architecture (fx_rate_aud_inr)', () => {
    const result = computeBaseCurrencyPreview(500000, 'INR', 'AUD', 56);
    expect(result.available).toBe(true);
    expect(result.baseCurrencyAmount).toBeCloseTo(500000 / 56, 2);
    // Exact: 500000 / 56 = 8928.5714... rounds to 8928.57
    expect(result.baseCurrencyAmount).toBe(8928.57);
  });

  it('CUR-003: missing/invalid FX rate is reported unavailable — the raw INR number is NEVER treated as AUD by fallback', () => {
    const missingRate = computeBaseCurrencyPreview(500000, 'INR', 'AUD', null);
    expect(missingRate.available).toBe(false);
    expect(missingRate.baseCurrencyAmount).toBeNull();

    const zeroRate = computeBaseCurrencyPreview(500000, 'INR', 'AUD', 0);
    expect(zeroRate.available).toBe(false);

    const negativeRate = computeBaseCurrencyPreview(500000, 'INR', 'AUD', -5);
    expect(negativeRate.available).toBe(false);
  });

  it('CUR-006: an unsupported currency pair is refused rather than silently treated as 1:1', () => {
    const result = computeBaseCurrencyPreview(1000, 'USD', 'AUD', 56);
    expect(result.available).toBe(false);
    expect(result.baseCurrencyAmount).toBeNull();
  });

  it('DD-009: 1,000,000 INR position is never inserted raw into an AUD total — the derived AUD figure is always the converted amount, never the source number', () => {
    const result = computeBaseCurrencyPreview(1000000, 'INR', 'AUD', 56);
    expect(result.baseCurrencyAmount).not.toBe(1000000);
    expect(result.baseCurrencyAmount).toBeCloseTo(17857.14, 2);
  });
});

describe('Idempotency key (spec sections 45-46)', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeIdempotencyKey({ accountId: 'acc-1', instrumentId: 'ins-1', canonicalPositionId: 'pos-1', publicationTarget: 'investments' });
    const b = computeIdempotencyKey({ accountId: 'acc-1', instrumentId: 'ins-1', canonicalPositionId: 'pos-1', publicationTarget: 'investments' });
    expect(a).toBe(b);
  });
  it('differs when the canonical position (snapshot) differs — a refresh gets a different key', () => {
    const a = computeIdempotencyKey({ accountId: 'acc-1', instrumentId: 'ins-1', canonicalPositionId: 'pos-1', publicationTarget: 'investments' });
    const b = computeIdempotencyKey({ accountId: 'acc-1', instrumentId: 'ins-1', canonicalPositionId: 'pos-2', publicationTarget: 'investments' });
    expect(a).not.toBe(b);
  });
});

describe('Routing (re-exported, spec section 43) — sanity check the R1-frozen function is unchanged', () => {
  it('still routes mutual funds to investments and retirement-account holdings to retirement_accounts', () => {
    expect(computePublicationTarget('mutual_fund', 'mf_folio')).toBe('investments');
    expect(computePublicationTarget('mutual_fund', 'retirement')).toBe('retirement_accounts');
    expect(computePublicationTarget('fixed_deposit', 'bank_linked')).toBe('assets');
  });
});
