import { formatMetricValue } from '@/lib/engines/twin/formatMetricValue';
import { METRIC_CATALOGUE, getMetricDefinition } from '@/lib/engines/twin/metricCatalogue';
import { METRIC_CATEGORY_LABEL, COMPARISON_STATUS_LABEL, COHORT_TIER_LABEL, BENCHMARK_CLASS_LABEL, percentileInterpretation, type MetricCategory, type ComparisonStatus, type BenchmarkClass } from '@/lib/engines/twin/taxonomy';
import type { StoredTwinDetail } from '@/lib/services/financialTwinService';
import { Stat } from '@/components/dashboard/SectionCard';

const STATUS_COLOR: Record<ComparisonStatus, string> = {
  materially_ahead: 'text-green-700 bg-green-50',
  ahead: 'text-green-700 bg-green-50',
  target_range_met: 'text-green-700 bg-green-50',
  broadly_aligned: 'text-gray-700 bg-gray-100',
  slightly_behind: 'text-amber-700 bg-amber-50',
  materially_behind: 'text-risk bg-red-50',
  context_required: 'text-gray-600 bg-gray-100',
  not_comparable: 'text-gray-400 bg-gray-50',
};

export function TwinDetailView({ twin, currency }: { twin: StoredTwinDetail; currency: 'AUD' | 'INR' }) {
  const byCategory = new Map<string, typeof twin.metrics>();
  for (const m of twin.metrics) {
    const list = byCategory.get(m.categoryCode) ?? [];
    list.push(m);
    byCategory.set(m.categoryCode, list);
  }

  return (
    <div className="space-y-8">
      <div className="rounded-card border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>Indicative comparison.</strong> Your Financial Twin is a synthetic peer profile, not an actual household. Early
        benchmarks are indicative until statistically validated at scale.
      </div>

      <section className="rounded-card border bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Your Twin</h2>
            <p className="mt-1 text-sm text-gray-600">
              {twin.cohortDescription ?? 'No specific peer cohort available — showing broader country and life-stage planning ranges.'}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Cohort tier: {twin.cohortTier ? COHORT_TIER_LABEL[twin.cohortTier as 1 | 2 | 3 | 4 | 5] : '—'} · Generated{' '}
              {new Date(twin.createdAt).toLocaleDateString('en-AU')}
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="Metrics compared" value={String(twin.metricsCompared)} />
          <Stat label="Ahead of benchmark" value={String(twin.aheadCount)} />
          <Stat label="Broadly aligned" value={String(twin.alignedCount)} />
          <Stat label="Below benchmark" value={String(twin.behindCount)} />
          <Stat label="Benchmark confidence" value={twin.overallConfidence !== null ? `${twin.overallConfidence.toFixed(0)}%` : '—'} />
        </div>
      </section>

      {twin.insights.length > 0 && (
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-card border bg-white p-6">
            <h3 className="font-semibold text-gray-900">Strengths</h3>
            <ul className="mt-3 space-y-3 text-sm">
              {twin.insights
                .filter((i) => i.insightType === 'strength')
                .map((i, idx) => (
                  <li key={idx}>
                    <p className="font-medium text-gray-800">{i.title}</p>
                    <p className="text-gray-500">{i.explanation}</p>
                  </li>
                ))}
              {twin.insights.filter((i) => i.insightType === 'strength').length === 0 && <li className="text-gray-400">No standout strengths yet.</li>}
            </ul>
          </div>
          <div className="rounded-card border bg-white p-6">
            <h3 className="font-semibold text-gray-900">Best-Fit Path — opportunities to review</h3>
            <ul className="mt-3 space-y-3 text-sm">
              {twin.insights
                .filter((i) => i.insightType === 'gap')
                .map((i, idx) => (
                  <li key={idx}>
                    <p className="font-medium text-gray-800">{i.title}</p>
                    <p className="text-gray-500">{i.explanation}</p>
                  </li>
                ))}
              {twin.insights.filter((i) => i.insightType === 'gap').length === 0 && <li className="text-gray-400">No material gaps identified.</li>}
            </ul>
          </div>
        </section>
      )}

      <section className="rounded-card border bg-white p-6">
        <h3 className="font-semibold text-gray-900">Detailed Comparison</h3>
        <p className="mt-1 text-sm text-gray-500">
          Similar Twin = an observed or synthetic peer comparison. Healthy Range = an FHIP planning target, not a peer median. Future
          Self = your own projected position, where a deterministic forecast exists.
        </p>
        <div className="mt-4 space-y-3">
          {(Object.keys(METRIC_CATEGORY_LABEL) as MetricCategory[]).map((cat) => {
            const rows = byCategory.get(cat) ?? [];
            if (rows.length === 0) return null;
            return (
              <details key={cat} className="rounded border">
                <summary className="cursor-pointer bg-gray-50 px-4 py-2 text-sm font-medium text-gray-800">
                  {METRIC_CATEGORY_LABEL[cat]} <span className="text-gray-400">({rows.length} metrics)</span>
                </summary>
                <div className="divide-y">
                  {rows.map((m) => (
                    <MetricRow key={m.metricCode} metric={m} currency={currency} />
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function MetricRow({ metric, currency }: { metric: StoredTwinDetail['metrics'][number]; currency: 'AUD' | 'INR' }) {
  const def = getMetricDefinition(metric.metricCode);
  if (!def) return null;
  const status = metric.comparisonStatus as ComparisonStatus | null;

  return (
    <details className="px-4 py-3">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium text-gray-800">{def.label}</span>
        <span className="flex items-center gap-2">
          <span className="text-gray-600">{formatMetricValue(metric.userValue, def.unit, currency)}</span>
          {status && <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_COLOR[status]}`}>{COMPARISON_STATUS_LABEL[status]}</span>}
        </span>
      </summary>
      <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-gray-600 sm:grid-cols-4">
        <div>
          <p className="text-gray-400">Your position</p>
          <p className="font-medium text-gray-800">{formatMetricValue(metric.userValue, def.unit, currency)}</p>
        </div>
        <div>
          <p className="text-gray-400">Similar Twin</p>
          <p className="font-medium text-gray-800">{formatMetricValue(metric.peerValue, def.unit, currency)}</p>
          {metric.benchmarkClass && <p className="text-gray-400">{BENCHMARK_CLASS_LABEL[metric.benchmarkClass as BenchmarkClass]}</p>}
        </div>
        <div>
          <p className="text-gray-400">Healthy range</p>
          <p className="font-medium text-gray-800">
            {metric.healthyMin !== null || metric.healthyMax !== null
              ? `${metric.healthyMin !== null ? formatMetricValue(metric.healthyMin, def.unit, currency) : '—'} – ${metric.healthyMax !== null ? formatMetricValue(metric.healthyMax, def.unit, currency) : '+'}`
              : 'Not available'}
          </p>
        </div>
        <div>
          <p className="text-gray-400">Future Self</p>
          <p className="font-medium text-gray-800">{formatMetricValue(metric.futureSelfValue, def.unit, currency)}</p>
        </div>
      </div>
      {metric.percentileRank !== null && (
        <p className="mt-2 text-xs text-gray-500">
          Percentile: {metric.percentileRank.toFixed(0)}th — {percentileInterpretation(metric.percentileRank)}
        </p>
      )}
      {metric.notComparableReason && <p className="mt-2 text-xs text-gray-400">{metric.notComparableReason}</p>}
      <p className="mt-2 text-xs text-gray-400">{def.explanation}</p>
      {metric.confidenceScore !== null && <p className="text-xs text-gray-400">Confidence: {metric.confidenceScore.toFixed(0)}%</p>}
    </details>
  );
}

export { METRIC_CATALOGUE };
