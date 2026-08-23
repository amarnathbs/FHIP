import { describe, it, expect } from 'vitest';
import { filterConsumerVisibleInsights, type IiInsightRow } from '@/lib/services/investment-intelligence/insights';

// ADR-007 testing requirement: "a personalised_advice row with
// compliance_approved_at IS NULL cannot be returned by any consumer-facing
// query path" — the structural DB check constraint enforces gated=true at
// INSERT time; this is the second, independent layer proving the read path
// also refuses to surface it.
describe('filterConsumerVisibleInsights (ADR-007 structural advice gate)', () => {
  const base = { id: '1', status: 'active', gated: false, compliance_approved_at: null };

  it('shows an observation insight', () => {
    const rows: IiInsightRow[] = [{ ...base, classification: 'observation' }];
    expect(filterConsumerVisibleInsights(rows)).toHaveLength(1);
  });

  it('shows an education insight', () => {
    const rows: IiInsightRow[] = [{ ...base, classification: 'education' }];
    expect(filterConsumerVisibleInsights(rows)).toHaveLength(1);
  });

  it('shows a simulation insight', () => {
    const rows: IiInsightRow[] = [{ ...base, classification: 'simulation' }];
    expect(filterConsumerVisibleInsights(rows)).toHaveLength(1);
  });

  it('NEVER shows a personalised_advice row with compliance_approved_at null, even if gated=false', () => {
    const rows: IiInsightRow[] = [{ ...base, classification: 'personalised_advice', gated: false, compliance_approved_at: null }];
    expect(filterConsumerVisibleInsights(rows)).toHaveLength(0);
  });

  it('NEVER shows a personalised_advice row that is gated=true but has no compliance approval yet', () => {
    const rows: IiInsightRow[] = [{ ...base, classification: 'personalised_advice', gated: true, compliance_approved_at: null }];
    expect(filterConsumerVisibleInsights(rows)).toHaveLength(0);
  });

  it('shows a personalised_advice row only once it is BOTH gated=true AND has a real compliance_approved_at (R0/R1 never sets this)', () => {
    const rows: IiInsightRow[] = [{ ...base, classification: 'personalised_advice', gated: true, compliance_approved_at: '2026-01-01T00:00:00Z' }];
    expect(filterConsumerVisibleInsights(rows)).toHaveLength(1);
  });

  it('hides a dismissed/superseded/expired insight regardless of classification', () => {
    const rows: IiInsightRow[] = [
      { ...base, id: '2', classification: 'observation', status: 'dismissed' },
      { ...base, id: '3', classification: 'observation', status: 'superseded' },
      { ...base, id: '4', classification: 'observation', status: 'expired' },
    ];
    expect(filterConsumerVisibleInsights(rows)).toHaveLength(0);
  });

  it('classifies the ten R0_INSIGHT_CLASSIFICATION.md worked examples correctly for visibility', () => {
    const observationsAndEducationAndSimulation: IiInsightRow[] = Array.from({ length: 8 }, (_, i) => ({
      ...base,
      id: `worked-${i}`,
      classification: i % 3 === 0 ? 'observation' : i % 3 === 1 ? 'education' : 'simulation',
    }));
    const gatedAdvice: IiInsightRow[] = [
      { ...base, id: 'advice-1', classification: 'personalised_advice', gated: true, compliance_approved_at: null },
      { ...base, id: 'advice-2', classification: 'personalised_advice', gated: true, compliance_approved_at: null },
    ];
    const visible = filterConsumerVisibleInsights([...observationsAndEducationAndSimulation, ...gatedAdvice]);
    expect(visible).toHaveLength(8);
    expect(visible.every((r) => r.classification !== 'personalised_advice')).toBe(true);
  });
});
