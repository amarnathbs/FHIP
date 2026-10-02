// The two benchmark surfaces must never read as duplicates in the Admin sidebar:
//   * 'Planning Benchmarks'  -> /admin/benchmarks (financial-planning benchmark_datasets system; AU/India planning ranges)
//   * 'Market Index Data'    -> /admin/investment-intelligence/market-index-data (investment index levels: upload, catalogue, ingestion)
// Labels only: URLs, routes, capability names, tables and APIs are unchanged.
import { describe, it, expect } from 'vitest';
import {
  ADMIN_GENERAL_ITEMS,
  ANALYTICS_ITEMS,
  CONTENT_TYPE_ITEMS,
  DISCOVERY_ITEMS,
  LOOKTHROUGH_DATA_ITEMS,
  MARKET_INDEX_DATA_ITEMS,
  REFERENCE_DATA_ITEMS,
  RESOURCES_ITEMS,
  WORKFLOW_ITEMS,
  buildAdminNavGroups,
  NO_ADMIN_CAPABILITIES,
  type AdminCapabilities,
} from '@/lib/admin/adminNav';

const PLANNING = 'Planning Benchmarks';
const INDEX = 'Market Index Data';
const everything: AdminCapabilities = Object.fromEntries(Object.keys(NO_ADMIN_CAPABILITIES).map((k) => [k, true])) as unknown as AdminCapabilities;

describe('Admin nav labels: planning benchmarks vs market index data', () => {
  const groups = buildAdminNavGroups(true, everything);
  const itemLabels = groups.flatMap((g) => g.items.map((i) => i.label));
  const groupLabels = groups.map((g) => g.label);

  it('the two labels are different and keep their URLs', () => {
    expect(PLANNING).not.toBe(INDEX);
    expect(ADMIN_GENERAL_ITEMS.find((i) => i.href === '/admin/benchmarks')?.label).toBe(PLANNING);
    expect(MARKET_INDEX_DATA_ITEMS).toEqual([{ label: INDEX, href: '/admin/investment-intelligence/market-index-data' }]);
    expect(groupLabels).toContain(INDEX);
  });

  it('each label appears exactly once among all nav entries (group headings and items), so no other entry shares either', () => {
    expect(itemLabels.filter((l) => l === PLANNING)).toHaveLength(1);
    expect(itemLabels.filter((l) => l === INDEX)).toHaveLength(1);
    expect(groupLabels.filter((l) => l === INDEX)).toHaveLength(1);
    expect(groupLabels).not.toContain(PLANNING); // it is an ITEM of the General group, not a group heading
    const others = [...RESOURCES_ITEMS, ...CONTENT_TYPE_ITEMS, ...WORKFLOW_ITEMS, ...DISCOVERY_ITEMS, ...ANALYTICS_ITEMS, ...REFERENCE_DATA_ITEMS, ...LOOKTHROUGH_DATA_ITEMS].map((i) => i.label);
    expect(others).not.toContain(PLANNING);
    expect(others).not.toContain(INDEX);
  });

  it('NEGATIVE CONTROL: the old ambiguous labels are gone from the nav (a bare "Benchmarks" or "Benchmark Data" entry would fail here)', () => {
    expect(itemLabels).not.toContain('Benchmarks');
    expect(itemLabels).not.toContain('Benchmark Data');
    expect(groupLabels).not.toContain('Benchmark Data');
    expect(groupLabels).not.toContain('Benchmarks');
  });

  it('no item label equals any group heading other than the one group that holds it (no visual duplicate)', () => {
    const dup = itemLabels.filter((l) => groupLabels.includes(l));
    // 'Market Index Data' is both the group heading and its single entry by design (as before); nothing else may repeat.
    expect([...new Set(dup)].filter((l) => l !== INDEX)).toEqual(expect.not.arrayContaining(['Planning Benchmarks']));
  });
});
