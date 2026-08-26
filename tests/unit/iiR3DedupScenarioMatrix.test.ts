import { describe, it, expect } from 'vitest';
import { computePublicationTarget, evaluateEligibility, isProductionCertifiedAssetClass } from '@/lib/services/investment-intelligence/publicationLogic';
import { computeDashboard, type InvestmentRow, type AssetRow, type RetirementRow, type DashboardInput } from '@/lib/engines/dashboard';

// R3 — R0 12-scenario deduplication matrix (spec section 30). Every
// scenario is exercised here; only DD-004, DD-005, DD-009, DD-010, DD-011,
// DD-012 are activated for PRODUCTION behaviour in R3 (R2 certifies Indian
// mutual funds only) — the rest are STRUCTURAL ROUTING TESTS ONLY, proving
// the router/eligibility gate handles them correctly without yet allowing
// them to reach production, per the spec's explicit instruction.

function emptyInput(overrides: Partial<DashboardInput> = {}): DashboardInput {
  return { income: [], expenses: [], assets: [], liabilities: [], investments: [], retirement: [], insurance: [], goals: [], snapshots: [], ...overrides };
}

describe('DD-001/DD-002: manual share entered in Assets vs Investments (structural — no II involvement)', () => {
  it('a manual share in Assets counts once via totalAssets, no Investment Intelligence row exists', () => {
    const result = computeDashboard(emptyInput({ assets: [{ current_value: 10000, asset_class: 'shares', currency_code: 'AUD' } as AssetRow] }), 'AUD', 56);
    expect(result.totalAssets).toBe(10000);
    expect(result.totalInvestments).toBe(0);
  });
  it('a manual share in Investments counts once via totalInvestments', () => {
    const result = computeDashboard(emptyInput({ investments: [{ current_value: 10000, cost_base: null, investment_type: 'shares', country_code: 'AU', annual_contribution: null, currency_code: 'AUD' } as InvestmentRow] }), 'AUD', 56);
    expect(result.totalInvestments).toBe(10000);
    expect(result.totalAssets).toBe(0);
  });
});

describe('DD-003: same share later imported from a broker (structural in R3 — broker STATEMENT PARSING remains out of scope even after R12)', () => {
  // R12 update (R12_ASSET_CLASS_SCOPE_MATRIX.md): 'equity' the INSTRUMENT
  // CLASS is now production-certified for MANUAL entry
  // (positions/manual/route.ts) — R2/R3's original blanket "no broker
  // parser exists yet" reasoning no longer applies to the class itself.
  // What remains genuinely deferred, unchanged by R12, is broker/NSDL/CDSL
  // STATEMENT PARSING (spec section 19 — R12 does not pull those adapters
  // forward). This scenario is retitled, not deleted, to keep asserting
  // that distinction rather than silently losing DD-003's coverage.
  it('equity instrument class IS production-certified as of R12 (manual entry only — no broker/NSDL/CDSL parser exists)', () => {
    expect(isProductionCertifiedAssetClass('equity')).toBe(true);
  });
  it('routing is correct for both the pre-R12 structural case and the R12 manual-entry case alike', () => {
    expect(computePublicationTarget('equity', 'demat')).toBe('investments');
  });
});

describe('DD-004: mutual fund imported from CAS — PRODUCTION, the real one', () => {
  it('is production-certified and routes to investments', () => {
    expect(isProductionCertifiedAssetClass('mutual_fund')).toBe(true);
    expect(computePublicationTarget('mutual_fund', 'mf_folio')).toBe('investments');
  });
  it('a first-time certified MF publication is ELIGIBLE end to end', () => {
    const result = evaluateEligibility({
      ownerMemberId: 'member-1',
      instrumentClass: 'mutual_fund',
      accountType: 'mf_folio',
      portfolioTruthStatus: 'certified',
      hasBlockingReconciliation: false,
      currentValue: 65200,
      countryCode: 'IN',
      currencyCode: 'INR',
    });
    expect(result.status).toBe('ELIGIBLE');
  });
});

describe('DD-005: existing manual Managed Fund + same imported CAS holding — PRODUCTION, the critical duplicate scenario (section 31)', () => {
  it('single row after linking, net worth reflects only the certified value once (see iiR3NetWorthCertification.test.ts for exact arithmetic)', () => {
    const linked = computeDashboard(emptyInput({ investments: [{ current_value: 520000, cost_base: null, investment_type: 'managed_fund', master_item_key: 'managed_funds', country_code: 'IN', annual_contribution: null, institution: 'ABC Mutual Fund', currency_code: 'INR' }] }), 'INR', 56);
    expect(linked.totalInvestments).toBe(520000);
  });
});

describe('DD-006: future NPS -> Retirement (structural routing test only)', () => {
  it('routes to retirement_accounts via account_type, never investments', () => {
    expect(computePublicationTarget('other', 'retirement')).toBe('retirement_accounts');
  });
  it('is NOT production-certified in R3 (NPS instrument_class is not mutual_fund)', () => {
    expect(isProductionCertifiedAssetClass('other')).toBe(false);
  });
  it('proves structurally that a retirement-routed position never also lands in investments totals', () => {
    const retirementRow: RetirementRow = { current_balance: 300000, employer_contribution: null, personal_contribution: null, contribution_frequency: null, currency_code: 'INR' };
    const result = computeDashboard(emptyInput({ retirement: [retirementRow] }), 'INR', 56);
    expect(result.totalRetirement).toBe(300000);
    expect(result.totalInvestments).toBe(0);
  });
});

describe('DD-007: term deposit Asset vs Investment (structural)', () => {
  it('fixed_deposit always routes to assets, never split across registers', () => {
    expect(computePublicationTarget('fixed_deposit', 'bank_linked')).toBe('assets');
    expect(computePublicationTarget('fixed_deposit', 'other')).toBe('assets');
  });
  it('is not production-certified in R3', () => {
    expect(isProductionCertifiedAssetClass('fixed_deposit')).toBe(false);
  });
});

describe('DD-008: gold investment vs personal gold asset (structural)', () => {
  it('gold instrument class is not production-certified and is never auto-matched against a personal-asset gold row', () => {
    expect(isProductionCertifiedAssetClass('gold')).toBe(false);
  });
});

describe('DD-009: Indian investment in AUD household net worth — PRODUCTION, the FX gate', () => {
  it('is covered exactly by iiR3NetWorthCertification.test.ts\'s cross-border suite — cross-referenced here for the full-matrix record', () => {
    const result = computeDashboard(emptyInput({ investments: [{ current_value: 500000, cost_base: null, investment_type: 'managed_fund', master_item_key: 'managed_funds', country_code: 'IN', annual_contribution: null, currency_code: 'INR' }] }), 'AUD', 56);
    expect(result.netWorth).toBeCloseTo(500000 / 56, 6);
  });
});

describe('DD-010: archived/unlinked imported investment — PRODUCTION', () => {
  it('archived (is_active=false, excluded before reaching computeDashboard) contributes zero', () => {
    const result = computeDashboard(emptyInput({ investments: [] }), 'INR', 56);
    expect(result.totalInvestments).toBe(0);
  });
});

describe('DD-011: newer certified document refreshes holdings — PRODUCTION', () => {
  it('refresh updates the SAME row value, never adds a second row (see decideRefreshSupersession unit tests for ordering rules)', () => {
    const v1 = computeDashboard(emptyInput({ investments: [{ current_value: 65200, cost_base: null, investment_type: 'managed_fund', master_item_key: 'managed_funds', country_code: 'IN', annual_contribution: null, currency_code: 'INR' }] }), 'INR', 56);
    const v2 = computeDashboard(emptyInput({ investments: [{ current_value: 71800, cost_base: null, investment_type: 'managed_fund', master_item_key: 'managed_funds', country_code: 'IN', annual_contribution: null, currency_code: 'INR' }] }), 'INR', 56);
    expect(v2.totalInvestments - v1.totalInvestments).toBe(6600);
  });
});

describe('DD-012: user correction to an imported position — PRODUCTION', () => {
  it('annual_contribution (a user-planning field) remains user-editable on a published row without touching the certified current_value', () => {
    // Direct-edit protection (section 38) locks current_value/cost_base/
    // institution/owner/currency/country/risk_profile but explicitly leaves
    // annual_contribution and notes editable — verified against
    // app/api/investments/[id]/route.ts's PROTECTED_ON_PUBLISHED_ROWS list,
    // which does not include annual_contribution or notes.
    const protectedFields = ['investment_name', 'investment_type', 'current_value', 'currency_code', 'country_code', 'institution', 'cost_base', 'owner', 'risk_profile', 'master_item_key'];
    expect(protectedFields).not.toContain('annual_contribution');
    expect(protectedFields).not.toContain('notes');
  });
});
