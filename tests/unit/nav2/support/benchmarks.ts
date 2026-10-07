// Test-only builders for the benchmark input the NAV2 engine takes. The levels in
// the suites are synthetic; no licensed or real index series is used anywhere.
import type { Nav2BenchmarkInput } from '@/lib/engines/nav2/benchmarkGate';

export function benchmarkFor(dates: readonly string[], levels: readonly number[], over: Partial<Nav2BenchmarkInput> = {}): Nav2BenchmarkInput[] {
  return [
    {
      basis: 'declared',
      categoryLabel: null,
      benchmarkId: 'bm-test-1',
      benchmarkKey: 'IN_TEST_TRI',
      label: 'Synthetic Test Index TRI',
      returnType: 'TRI',
      effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
      effectiveTo: null,
      catalogueVerified: true,
      entitled: true,
      series: dates.map((d, i) => ({ date: new Date(`${d}T00:00:00.000Z`), value: levels[i] })),
      datasetVersion: 'test-benchmark-v1',
      licenceStatus: 'synthetic_test_data',
      ...over,
    },
  ];
}
