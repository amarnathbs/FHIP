import { describe, it, expect } from 'vitest';
import { resolveDomainsForMode, domainIncluded } from '@/lib/ai/context/contextSize';

describe('Module 11.0 context-size budget contract (spec section 54)', () => {
  it('MINIMAL mode includes no domains', () => {
    expect(resolveDomainsForMode('MINIMAL')).toEqual([]);
  });

  it('FULL mode includes every domain', () => {
    const domains = resolveDomainsForMode('FULL');
    expect(domains).toContain('cash_flow');
    expect(domains).toContain('cross_border');
    expect(domains.length).toBeGreaterThanOrEqual(13);
  });

  it('DOMAIN mode with a known intent narrows to the relevant domains only (e.g. emergency fund -> resilience + cash flow)', () => {
    const domains = resolveDomainsForMode('DOMAIN', 'emergency_fund_question');
    expect(domains).toEqual(['resilience', 'cash_flow']);
    expect(domains).not.toContain('financial_twin');
  });

  it('DOMAIN mode with an unknown intent fails safe to FULL rather than an empty, misleadingly-confident context', () => {
    const domains = resolveDomainsForMode('DOMAIN', 'some_future_intent_not_yet_mapped');
    expect(domains.length).toBeGreaterThan(1);
  });

  it('domainIncluded correctly reports membership', () => {
    const domains = resolveDomainsForMode('DOMAIN', 'score_summary');
    expect(domainIncluded('score', domains)).toBe(true);
    expect(domainIncluded('financial_twin', domains)).toBe(false);
  });
});
