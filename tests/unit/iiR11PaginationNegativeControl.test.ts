// R11 terminal closure — spec section 34 mandatory pagination negative
// control, framed in R11's own domain (a page-boundary cross-source match
// candidate sitting past PostgREST's 1000-row cap — the exact live scenario
// certified in scripts/r11_scale_certification.ts SCALE-A-1001+ and
// r11_final_live_dev_tests.ts LIVE-R11-025).
//
// This is hermetic (no live DB) and isolated to this test file only — it
// does NOT touch the real lib/services/investment-intelligence/pagination.ts
// module (that module is never mutated; R11's live-DEV runs are unaffected).
// It reproduces, locally, what a NAIVE unbounded-select implementation would
// do (PostgREST silently caps at 1000 rows) versus the real fetchAllRows
// contract R11's live code actually uses.
//
//   RED:   the naive "continuation disabled after row 1000" implementation
//          misses a genuine cross-source match candidate seeded at row 1005.
//   GREEN: the real fetchAllRows helper (same one R11's live code imports)
//          finds it, proving R11's live PASS above is not vacuous — it would
//          have caught the defect if the pagination contract were broken.
import { describe, it, expect } from 'vitest';
import { fetchAllRows, type RangeableQuery } from '@/lib/services/investment-intelligence/pagination';

type Row = { id: string; account_id: string; instrument_id: string; source_reference: string };

const POSTGREST_CAP = 1000;

function buildRows(total: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < total; i++) {
    rows.push({
      id: `row-${String(i).padStart(6, '0')}`,
      account_id: 'acc-1',
      instrument_id: 'instr-1',
      // The genuine cross-source match candidate sits at the LAST row —
      // for total=1005 that's row 1004, i.e. past the 1000-row page cap.
      source_reference: i === total - 1 ? 'MATCH-CANDIDATE' : `noise-${i}`,
    });
  }
  return rows;
}

/** Real PostgREST behaviour: an explicit .range(from,to) returns exactly that slice. */
function makeRangeableBuilder(rows: Row[]): RangeableQuery<Row> {
  return {
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
  };
}

/**
 * The NAIVE implementation this whole helper class of bug (R4/R5/R6-P0/R11)
 * exists to prevent: an unbounded select with no continuation past
 * PostgREST's silent `db-max-rows` cap. Deliberately reproduced here ONLY
 * inside this test file, never touching production code.
 */
async function naiveUnboundedSelect(rows: Row[]): Promise<Row[]> {
  const { data } = await makeRangeableBuilder(rows).range(0, POSTGREST_CAP - 1); // no continuation
  return data ?? [];
}

describe('R11 pagination negative control (spec section 34) — isolated, hermetic', () => {
  it('RED: naive single-page fetch silently misses the page-boundary cross-source match candidate at 1005 rows', async () => {
    const rows = buildRows(1005);
    const naiveResult = await naiveUnboundedSelect(rows);
    expect(naiveResult).toHaveLength(1000); // silently truncated, no error anywhere
    const foundMatch = naiveResult.some((r) => r.source_reference === 'MATCH-CANDIDATE');
    expect(foundMatch).toBe(false); // RED: the real match candidate (row 1004) was silently dropped
  });

  it('GREEN: fetchAllRows (the real R11 helper) finds the same match candidate, full pagination restored', async () => {
    const rows = buildRows(1005);
    const fullResult = await fetchAllRows(() => makeRangeableBuilder(rows));
    expect(fullResult).toHaveLength(1005); // no truncation
    const foundMatch = fullResult.some((r) => r.source_reference === 'MATCH-CANDIDATE');
    expect(foundMatch).toBe(true); // GREEN: real helper retrieves the full set, match found
    const ids = fullResult.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate page boundaries
  });

  it('RED->GREEN also holds at the other certified scale sizes (999/1000/1001/2500/5001/10000)', async () => {
    for (const size of [999, 1000, 1001, 2500, 5001, 10000]) {
      const rows = buildRows(size);
      const naive = await naiveUnboundedSelect(rows);
      const naiveFound = naive.some((r) => r.source_reference === 'MATCH-CANDIDATE');
      const real = await fetchAllRows(() => makeRangeableBuilder(rows));
      const realFound = real.some((r) => r.source_reference === 'MATCH-CANDIDATE');
      expect(real).toHaveLength(size); // GREEN: exact count, no silent truncation, no dupes
      expect(realFound).toBe(true);
      if (size > POSTGREST_CAP) {
        expect(naiveFound).toBe(false); // RED only manifests once the match sits past the cap
      } else {
        expect(naiveFound).toBe(true); // at/under the cap, naive and real agree (sanity check the test itself is not vacuous)
      }
    }
  });
});
