import { requireUser, ok } from '@/lib/api';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  return ok({
    modelVersion: 'twin-1.0.0',
    benchmarkVersion: 'fhip-planning-1.0.0',
    disclaimer:
      'Your Financial Twin is a synthetic peer comparison, not an actual household. Early benchmarks are indicative and have not yet been statistically validated at scale. It is intended for general information and education, and does not constitute personal financial, credit, tax or legal advice, or a recommendation to acquire, dispose of or change a financial product.',
    benchmarkClasses: [
      { code: 'observed_market', label: 'Observed market benchmark', meaning: 'Derived from an official or licensed statistical dataset.' },
      { code: 'regulatory_statutory', label: 'Regulatory or statutory benchmark', meaning: 'A legislated, regulatory or policy threshold.' },
      { code: 'fhip_planning', label: 'FHIP planning benchmark', meaning: 'A research-informed target range established for educational comparison.' },
      { code: 'platform_peer', label: 'Platform peer benchmark', meaning: 'Aggregated statistics from sufficiently large anonymised FHIP user cohorts.' },
    ],
  });
}
