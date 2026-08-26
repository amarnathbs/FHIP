// Investment Intelligence R12 — Wider India Assets. Unit tests for every
// new pure function this round introduced, plus one integration-style test
// that feeds a synthesized direct-security "self disclosure" through the
// REAL, UNMODIFIED R5 look-through engine to prove correct attribution
// with no double counting (spec sections 47-52).

import { describe, it, expect } from 'vitest';
import { classifyDirectListedSecurity } from '@/lib/engines/investment-intelligence/tax/schemeClassification';
import { computeDisposalTax } from '@/lib/engines/investment-intelligence/tax/capitalGainsEngine';
import { computeHoldingPeriod } from '@/lib/engines/investment-intelligence/tax/holdingPeriod';
import type { LotConsumption } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';
import { calculatePortfolioLookThrough, type FundHoldingsSnapshot, type PortfolioFundPosition } from '@/lib/engines/investment-intelligence/xray/lookThrough';
import { unitDeltaForTransaction } from '@/lib/services/investment-intelligence/reconciliation';
import { isProductionCertifiedAssetClass, mapInstrumentClassToMasterItemKey } from '@/lib/services/investment-intelligence/publicationLogic';

describe('R12 — classifyDirectListedSecurity (direct equity / equity-oriented ETF tax classification)', () => {
  it('classifies a direct listed equity as equity_oriented by statute, not by allocation', () => {
    const result = classifyDirectListedSecurity({ instrumentKey: 'RELIANCE-ISIN', instrumentClass: 'equity' });
    expect(result.classification).toBe('equity_oriented');
    expect(result.basis).toBe('direct_listed_security_rule');
    expect(result.domesticEquityPct).toBe(100);
  });

  it('classifies a declared equity-oriented ETF as equity_oriented', () => {
    const result = classifyDirectListedSecurity({ instrumentKey: 'NIFTYBEES-ISIN', instrumentClass: 'etf', isEquityOriented: true });
    expect(result.classification).toBe('equity_oriented');
    expect(result.basis).toBe('direct_listed_security_rule');
  });

  it('refuses to classify an ETF not explicitly declared equity-oriented — never infers from instrument_class alone (spec section 57)', () => {
    const result = classifyDirectListedSecurity({ instrumentKey: 'GOLDBEES-ISIN', instrumentClass: 'etf', isEquityOriented: false });
    expect(result.classification).toBe('unresolved');
    const resultUndeclared = classifyDirectListedSecurity({ instrumentKey: 'GOLDBEES-ISIN', instrumentClass: 'etf' });
    expect(resultUndeclared.classification).toBe('unresolved');
  });

  it('feeds directly into the UNMODIFIED computeDisposalTax() — no new tax calculator (spec section 53)', () => {
    const classification = classifyDirectListedSecurity({ instrumentKey: 'RELIANCE-ISIN', instrumentClass: 'equity' });
    const consumption: LotConsumption = {
      disposalEventId: 'disp-1',
      lotId: 'lot-1',
      instrumentKey: 'RELIANCE-ISIN',
      acquisitionDate: '2020-06-15',
      kind: 'purchase',
      disposalDate: '2025-06-16', // >12 months after acquisition -> LTCG under Section 112A
      unitsConsumed: 10,
      costPerUnit: 200,
      costBasis: 2000, // Rs 200/unit acquired
      saleValueApportioned: 5000,
    };
    const result = computeDisposalTax({
      consumption,
      saleValuePerUnit: 500,
      classification,
      fmv31Jan2018PerUnit: null,
    });
    expect(result.gainType).toBe('ltcg');
    expect(result.saleValue).toBe(5000);
    expect(result.taxableGain).not.toBeNull();
    // Sanity: engine computed a real holding period > the 12-month equity threshold.
    const holding = computeHoldingPeriod(consumption.acquisitionDate, consumption.disposalDate, 12);
    expect(holding.isLongTerm).toBe(true);
  });

  it('a sub-12-month direct equity holding is STCG (Section 111A), same engine, same threshold as equity-oriented MF', () => {
    const classification = classifyDirectListedSecurity({ instrumentKey: 'TCS-ISIN', instrumentClass: 'equity' });
    const consumption: LotConsumption = {
      disposalEventId: 'disp-2',
      lotId: 'lot-2',
      instrumentKey: 'TCS-ISIN',
      acquisitionDate: '2025-01-01',
      kind: 'purchase',
      disposalDate: '2025-06-01', // 5 months
      unitsConsumed: 5,
      costPerUnit: 3000,
      costBasis: 15000,
      saleValueApportioned: 17500,
    };
    const result = computeDisposalTax({ consumption, saleValuePerUnit: 3500, classification, fmv31Jan2018PerUnit: null });
    expect(result.gainType).toBe('stcg');
  });
});

describe('R12 — publication scope (equity/etf certified, everything else still deferred)', () => {
  it('only R12-frozen classes are certified', () => {
    expect(isProductionCertifiedAssetClass('equity')).toBe(true);
    expect(isProductionCertifiedAssetClass('etf')).toBe(true);
    expect(isProductionCertifiedAssetClass('bond')).toBe(false);
    expect(isProductionCertifiedAssetClass('mutual_fund')).toBe(true); // pre-R12, unchanged
  });

  it('equity routes to international_shares for an India-domiciled account, reusing the shipped 0073 rule', () => {
    expect(mapInstrumentClassToMasterItemKey('equity', 'IN')).toBe('international_shares');
  });
});

describe('R12 — reconciliation direction table (bonus/split/sale)', () => {
  it('sale reduces units like a redemption', () => {
    expect(unitDeltaForTransaction({ canonicalType: 'sale', unitsScaled: 100n })).toBe(-100n);
    expect(unitDeltaForTransaction({ canonicalType: 'redemption', unitsScaled: 100n })).toBe(-100n);
  });
  it('bonus increases units like a purchase', () => {
    expect(unitDeltaForTransaction({ canonicalType: 'bonus', unitsScaled: 50n })).toBe(50n);
  });
});

describe('R12 — direct equity contributes to X-Ray without fund-style look-through or double counting (spec sections 48, 52)', () => {
  it('a synthesized 100%-weight self-disclosure attributes the FULL position value to the security itself, once', () => {
    const positions: PortfolioFundPosition[] = [
      { fundInstrumentId: 'mf-1', fundName: 'Some Equity Fund', value: 60000, currencyCode: 'INR' },
      { fundInstrumentId: 'equity-1', fundName: 'Reliance Industries', value: 40000, currencyCode: 'INR' },
    ];
    const snapshotsByFund = new Map<string, FundHoldingsSnapshot[]>();
    // The mutual fund itself holds 50% Reliance (same canonical id as the
    // direct equity position) — proving the security-concentration test
    // correctly SUMS both paths into one issuer bucket, never double, and
    // never treats them as two unrelated Rs amounts.
    snapshotsByFund.set('mf-1', [
      {
        snapshotId: 'snap-mf-1',
        fundInstrumentId: 'mf-1',
        holdingsAsOfDate: '2026-08-01',
        sourceKey: 'test',
        sourceDataVersion: null,
        classificationVersion: 'v1',
        holdings: [{ canonicalId: 'equity-1', displayName: 'Reliance Industries', weightPct: 50, assetKind: 'security' }],
      },
    ]);
    snapshotsByFund.set('equity-1', [
      {
        snapshotId: 'direct-security-self:equity-1:2026-08-01',
        fundInstrumentId: 'equity-1',
        holdingsAsOfDate: '2026-08-01',
        sourceKey: 'direct_security_self_disclosure',
        sourceDataVersion: null,
        classificationVersion: 'v1',
        holdings: [{ canonicalId: 'equity-1', displayName: 'Reliance Industries', weightPct: 100, assetKind: 'security' }],
      },
    ]);

    const result = calculatePortfolioLookThrough(positions, snapshotsByFund, '2026-08-01', '2026-08-01');
    expect(result.status).toBe('ok');
    // Total portfolio value must equal the sum of the two POSITIONS exactly
    // (100000) — look-through is attribution, never additional wealth
    // (spec section 62's no-double-count invariant, verbatim from the
    // pre-existing R5 module header).
    expect(result.totalPortfolioValue).toBe(100000);

    const reliance = result.exposures.find((e) => e.canonicalId === 'equity-1');
    expect(reliance).toBeDefined();
    // Effective exposure = (60000/100000 * 50%) + (40000/100000 * 100%) = 30% + 40% = 70%
    expect(reliance!.effectiveWeight).toBeCloseTo(0.7, 6);
    expect(reliance!.effectiveValue).toBeCloseTo(70000, 2);
    // Two contributing paths (the fund's look-through AND the direct
    // holding), correctly attributed, never summed into a fabricated
    // Rs 100,000+ third figure.
    expect(reliance!.contributingFunds).toHaveLength(2);
  });

  it('a direct equity position with NO real disclosure elsewhere still contributes its own value once (not "missing")', () => {
    const positions: PortfolioFundPosition[] = [{ fundInstrumentId: 'equity-2', fundName: 'Infosys', value: 25000, currencyCode: 'INR' }];
    const snapshotsByFund = new Map<string, FundHoldingsSnapshot[]>();
    snapshotsByFund.set('equity-2', [
      {
        snapshotId: 'direct-security-self:equity-2:2026-08-01',
        fundInstrumentId: 'equity-2',
        holdingsAsOfDate: '2026-08-01',
        sourceKey: 'direct_security_self_disclosure',
        sourceDataVersion: null,
        classificationVersion: null,
        holdings: [{ canonicalId: 'equity-2', displayName: 'Infosys', weightPct: 100, assetKind: 'security' }],
      },
    ]);
    const result = calculatePortfolioLookThrough(positions, snapshotsByFund, '2026-08-01', '2026-08-01');
    expect(result.status).toBe('ok');
    expect(result.noSnapshotWeight).toBe(0); // NOT missing, unlike an un-synthesized direct position would be
    expect(result.exposures).toHaveLength(1);
    expect(result.exposures[0].effectiveWeight).toBeCloseTo(1.0, 6);
    expect(result.exposures[0].effectiveValue).toBeCloseTo(25000, 2);
  });
});
