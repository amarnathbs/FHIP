import { describe, it, expect } from 'vitest';
import {
  certifyCashFlow,
  certifyBalanceSheet,
  certifyScore,
  certifyDna,
  certifyResilience,
  certifyInvestments,
  certifyInsurance,
  certifyGoals,
  certifyForecast,
  certifyTwin,
  certifyCrossBorder,
  rollUpCertification,
  isStale,
  STALE_THRESHOLD_DAYS,
} from '@/lib/ai/certification/certificationService';

const TODAY = new Date().toISOString().slice(0, 10);
const OLD_DATE = new Date(Date.now() - (STALE_THRESHOLD_DAYS + 10) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe('Module 11.0 certification service — the 10 certification-gate scenarios (spec section 51 cert tests)', () => {
  it('1. all domains certified when every source is complete and fresh', () => {
    expect(certifyCashFlow({ hasIncome: true, hasExpenses: true, dataAsOf: TODAY }).status).toBe('CERTIFIED');
    expect(certifyBalanceSheet({ hasAssets: true, hasLiabilities: true, dataAsOf: TODAY }).status).toBe('CERTIFIED');
    expect(certifyScore({ eligibilityState: 'full', modelVersion: 'fhs-2.0.0', calculationDate: TODAY }).status).toBe('CERTIFIED');
    expect(certifyForecast({ hasRun: true, runStatus: 'completed', modelVersion: 'forecast-1.0.0', calculationDate: TODAY }).status).toBe('CERTIFIED');
  });

  it('2. insurance partial when coverage has not been fully reviewed', () => {
    const result = certifyInsurance({ hasInsurance: true, missingCategoryCount: 2, dataAsOf: TODAY });
    expect(result.status).toBe('PARTIAL');
    expect(result.reason).toMatch(/missing or unknown/);
  });

  it('3. forecast unavailable when no run exists', () => {
    const result = certifyForecast({ hasRun: false, runStatus: null, modelVersion: null, calculationDate: null });
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.model_versions).toEqual([]);
  });

  it('4. financial twin unavailable when no run exists', () => {
    const result = certifyTwin({ hasRun: false, status: null, modelVersion: null, calculationDate: null });
    expect(result.status).toBe('UNAVAILABLE');
  });

  it('5. balance sheet partial (not certified) when only one side of the ledger is entered — never invalid-by-default', () => {
    const result = certifyBalanceSheet({ hasAssets: true, hasLiabilities: false, dataAsOf: TODAY });
    expect(result.status).toBe('PARTIAL');
  });

  it('5b. balance sheet unavailable when nothing at all is entered — missing data is never treated as zero/certified', () => {
    const result = certifyBalanceSheet({ hasAssets: false, hasLiabilities: false, dataAsOf: null });
    expect(result.status).toBe('UNAVAILABLE');
  });

  it('6. currency integrity invalid fails cross-border closed, regardless of country count', () => {
    const result = certifyCrossBorder({ countriesInUse: ['AU', 'IN'], currencyIntegrityOk: false, dataAsOf: TODAY });
    expect(result.status).toBe('INVALID');
    expect(result.reason).toMatch(/[Cc]urrency integrity/);
  });

  it('7. stale valuation is surfaced, not silently treated as fresh', () => {
    const cashFlow = certifyCashFlow({ hasIncome: true, hasExpenses: true, dataAsOf: OLD_DATE });
    expect(cashFlow.status).toBe('STALE');
    expect(isStale(OLD_DATE)).toBe(true);
    expect(isStale(TODAY)).toBe(false);
  });

  it('8. missing data (DNA insufficient_data) is UNAVAILABLE, never a fabricated classification', () => {
    const result = certifyDna({ status: 'insufficient_data', modelVersion: 'dna-1.0.0', classificationDate: null });
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.model_versions).toEqual([]);
  });

  it('9. confirmed zero goals is a real UNAVAILABLE state (no goals created), distinguishable from an error', () => {
    const result = certifyGoals({ goalCount: 0, dataAsOf: null });
    expect(result.status).toBe('UNAVAILABLE');
  });

  it('10. cross-border certified when currency integrity holds and multiple countries are present', () => {
    const result = certifyCrossBorder({ countriesInUse: ['AU', 'IN'], currencyIntegrityOk: true, dataAsOf: TODAY });
    expect(result.status).toBe('CERTIFIED');
  });
});

describe('Domain-level certification independence (spec section 24)', () => {
  it('one UNAVAILABLE domain does not force other domains to UNAVAILABLE', () => {
    const cashFlow = certifyCashFlow({ hasIncome: true, hasExpenses: true, dataAsOf: TODAY });
    const twin = certifyTwin({ hasRun: false, status: null, modelVersion: null, calculationDate: null });
    expect(cashFlow.status).toBe('CERTIFIED');
    expect(twin.status).toBe('UNAVAILABLE');
  });

  it('resilience PARTIAL for preliminary eligibility, CERTIFIED for full', () => {
    expect(certifyResilience({ eligibilityState: 'preliminary', modelVersion: 'resilience-1.0.0', calculationDate: TODAY }).status).toBe('PARTIAL');
    expect(certifyResilience({ eligibilityState: 'full', modelVersion: 'resilience-1.0.0', calculationDate: TODAY }).status).toBe('CERTIFIED');
    expect(certifyResilience({ eligibilityState: 'not_yet_available', modelVersion: null, calculationDate: null }).status).toBe('UNAVAILABLE');
  });

  it('investments UNAVAILABLE (not zero) when no investment data exists', () => {
    const result = certifyInvestments({ hasInvestments: false, dataAsOf: null });
    expect(result.status).toBe('UNAVAILABLE');
  });
});

describe('rollUpCertification', () => {
  it('is CERTIFIED only when every meaningful domain is CERTIFIED', () => {
    expect(rollUpCertification(['CERTIFIED', 'CERTIFIED', 'UNAVAILABLE'])).toBe('CERTIFIED');
    expect(rollUpCertification(['CERTIFIED', 'PARTIAL'])).toBe('PARTIAL');
    expect(rollUpCertification(['CERTIFIED', 'STALE'])).toBe('STALE');
    expect(rollUpCertification(['CERTIFIED', 'INVALID'])).toBe('INVALID');
    expect(rollUpCertification(['UNAVAILABLE', 'UNAVAILABLE'])).toBe('UNAVAILABLE');
  });

  it('INVALID always wins over PARTIAL/STALE (fail closed takes priority)', () => {
    expect(rollUpCertification(['PARTIAL', 'STALE', 'INVALID', 'CERTIFIED'])).toBe('INVALID');
  });
});
