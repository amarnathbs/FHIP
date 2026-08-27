// Investment Intelligence R12 — Pagination & Scale Certification continuation
// (spec sections 25 NC-set / 27 scale matrix / 28 page-boundary negative
// control), closing the gap R12_PAGINATION_SCALE_CERTIFICATION.md and
// R12_NEGATIVE_CONTROL_CERTIFICATION.md's NC8 disclosed as "not run this
// round" in the original R12 pass.
//
// Mirrors tests/unit/iiR11PaginationNegativeControl.test.ts's proven,
// accepted pattern exactly (same repo, same certification standard,
// R12 now depends on the identical shared helper): hermetic, no live DB,
// isolated to this file, never mutates lib/services/investment-intelligence/
// pagination.ts. R12's OWN new read path
// (r5Repository.ts -> addDirectSecuritySelfSnapshots(), reading
// ii_security_classifications) imports this exact fetchAllRows helper --
// verified by static import inspection below -- so proving the helper's
// RED->GREEN behaviour here is not a generic, unrelated proof; it is a
// direct proof of the mechanism R12's own fixed read path relies on.
//
//   RED:   a naive single-page (.range(0,999)) read silently drops the
//          real sector classification for R12's direct-equity instrument
//          when it happens to sit at row 1005 of ii_security_classifications
//          -- Review Centre's single-security-concentration evidence (spec
//          section 21) would then be computed from a missing classification,
//          not a wrong one (fails safe, but still an unacceptable economic
//          truncation this control exists to catch).
//   GREEN: the real fetchAllRows() (the same helper r5Repository.ts now
//          imports for this exact table) retrieves the full set, the
//          classification is found, and the count is exact with no
//          duplicate page-boundary rows.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fetchAllRows, type RangeableQuery } from '@/lib/services/investment-intelligence/pagination';

const POSTGREST_CAP = 1000;

describe('R12 pagination static-dependency check', () => {
  it('r5Repository.ts addDirectSecuritySelfSnapshots() genuinely imports fetchAllRows for ii_security_classifications (not a claim, a grep)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'services', 'investment-intelligence', 'r5Repository.ts'), 'utf8');
    expect(src).toContain("import { fetchAllRows } from './pagination'");
    // The classification read block itself uses fetchAllRows, not a bare .select().
    const classBlockMatch = src.match(/const classRows = await fetchAllRows[\s\S]{0,300}ii_security_classifications/);
    expect(classBlockMatch).not.toBeNull();
  });
});

type ClassificationRow = { id: string; instrument_id: string; sector: string | null };

function buildRows(total: number, targetInstrumentId: string): ClassificationRow[] {
  const rows: ClassificationRow[] = [];
  for (let i = 0; i < total; i++) {
    rows.push({
      id: `class-${String(i).padStart(6, '0')}`,
      instrument_id: i === total - 1 ? targetInstrumentId : `noise-instrument-${i}`,
      sector: i === total - 1 ? 'Information Technology' : 'Diversified',
    });
  }
  return rows;
}

function makeRangeableBuilder(rows: ClassificationRow[]): RangeableQuery<ClassificationRow> {
  return { range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }) };
}

async function naiveUnboundedSelect(rows: ClassificationRow[]): Promise<ClassificationRow[]> {
  const { data } = await makeRangeableBuilder(rows).range(0, POSTGREST_CAP - 1); // no continuation past page 1
  return data ?? [];
}

const TARGET = 'r12-direct-equity-instrument-id';

describe('R12 NC8 — pagination negative control (spec sections 25/28), real economic result past row 1000', () => {
  it('RED: naive single-page read silently drops the R12 direct-equity sector classification seeded at row 1005', async () => {
    const rows = buildRows(1005, TARGET);
    const naive = await naiveUnboundedSelect(rows);
    expect(naive).toHaveLength(1000); // silently truncated
    const found = naive.find((r) => r.instrument_id === TARGET);
    expect(found).toBeUndefined(); // RED: the real sector classification (row 1004) was silently dropped
  });

  it('GREEN: fetchAllRows (the real helper R12 depends on) finds the classification, exact count, no duplicates', async () => {
    const rows = buildRows(1005, TARGET);
    const full = await fetchAllRows(() => makeRangeableBuilder(rows));
    expect(full).toHaveLength(1005);
    const found = full.find((r) => r.instrument_id === TARGET);
    expect(found).toBeDefined();
    expect(found?.sector).toBe('Information Technology'); // the real, non-fabricated value -- not silently defaulted
    const ids = full.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('restore GREEN also holds at every certified scale point: 999/1000/1001/2500/5001/10000', async () => {
    for (const size of [999, 1000, 1001, 2500, 5001, 10000]) {
      const rows = buildRows(size, TARGET);
      const naive = await naiveUnboundedSelect(rows);
      const naiveFound = naive.some((r) => r.instrument_id === TARGET);
      const real = await fetchAllRows(() => makeRangeableBuilder(rows));
      const realFound = real.some((r) => r.instrument_id === TARGET);
      expect(real).toHaveLength(size); // GREEN: exact count at every scale point, no silent truncation
      expect(realFound).toBe(true);
      if (size > POSTGREST_CAP) {
        expect(naiveFound).toBe(false); // RED only manifests once the target sits past the page-1 cap
      } else {
        expect(naiveFound).toBe(true); // at/under the cap naive and real agree -- sanity-checks the harness itself is not vacuous
      }
    }
  });
});
