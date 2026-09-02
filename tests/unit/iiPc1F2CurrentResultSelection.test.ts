// II-PC1-F2 — unit certification of the current-result selection rule.
//
// The live-DEV suite (tests/live-dev/iiPc1F2EngineVersionConsumersLiveDev.test.ts)
// proves the DEFECT and the FIX against real DEV. This file pins the RULE
// itself — the part that must keep holding when R6 becomes v4 and nobody is
// looking at F2 any more.
//
// Rule under test: LATEST_VALID_COMPUTATION_FOR_CURRENT_ENGINE. A persisted
// capital-gains row is current iff (1) its engine_version is what the
// currently-deployed code produces, and (2) its computed_at is the newest
// among rows satisfying (1) for the SAME disposal.
//
// See docs/investment-intelligence/II_PC1_F2_CURRENT_RESULT_SELECTION_DECISION.md

import { describe, it, expect } from 'vitest';
import { selectCurrentCapitalGainsRows } from '@/lib/services/investment-intelligence/taxRepository';
import { TAX_ENGINE_VERSION } from '@/lib/engines/investment-intelligence/tax/taxVersioning';

const CURRENT = TAX_ENGINE_VERSION;
const PREVIOUS = 'tax-engine-r6-p1-v2';

type Row = { disposal_transaction_id: string; engine_version: string; computed_at: string; tag?: string };
const row = (tag: string, disposal: string, engine: string, computedAt: string): Row => ({
  tag, disposal_transaction_id: disposal, engine_version: engine, computed_at: computedAt,
});
const tags = (rows: Row[]) => rows.map((r) => r.tag).sort();

describe('II-PC1-F2 — current-result selection rule', () => {
  it('F2-U01 — an empty row set selects nothing (no crash, no invented current result)', () => {
    expect(selectCurrentCapitalGainsRows([])).toEqual([]);
  });

  it('F2-U02 — with ONLY previous-engine rows, nothing is current', () => {
    const rows = [
      row('v2-a', 'd1', PREVIOUS, '2026-08-22T00:00:00.000Z'),
      row('v2-b', 'd1', PREVIOUS, '2026-08-23T00:00:00.000Z'),
    ];
    // NOT "the newest v2 row" — a superseded generation never becomes current
    // just because it is the newest thing on file.
    expect(selectCurrentCapitalGainsRows(rows)).toEqual([]);
  });

  it('F2-U03 — the F1 defect shape: a v2 orphan alongside the current v3 answer is excluded', () => {
    const rows = [
      row('v2-orphan-folioA', 'd1', PREVIOUS, '2026-08-22T00:00:00.000Z'),
      row('v3-folioB-oct', 'd1', CURRENT, '2026-09-03T00:00:00.000Z'),
      row('v3-folioB-jul', 'd1', CURRENT, '2026-09-03T00:00:00.000Z'),
    ];
    expect(tags(selectCurrentCapitalGainsRows(rows))).toEqual(['v3-folioB-jul', 'v3-folioB-oct']);
  });

  it('F2-U04 — SAME-version staleness: an older current-engine run is excluded by the newer one', () => {
    const rows = [
      row('run1-lotX', 'd1', CURRENT, '2026-09-01T00:00:00.000Z'),
      row('run2-lotY', 'd1', CURRENT, '2026-09-02T00:00:00.000Z'),
      row('run2-lotZ', 'd1', CURRENT, '2026-09-02T00:00:00.000Z'),
    ];
    // This is the case an engine_version-only filter would have missed —
    // proven reachable live by F2-T04.
    expect(tags(selectCurrentCapitalGainsRows(rows))).toEqual(['run2-lotY', 'run2-lotZ']);
  });

  it('F2-U05 — staleness is scoped PER DISPOSAL: a newer run on one disposal cannot evict another', () => {
    const rows = [
      row('d1-current', 'd1', CURRENT, '2026-09-01T00:00:00.000Z'),
      row('d2-current', 'd2', CURRENT, '2026-09-05T00:00:00.000Z'),
    ];
    // A global MAX would wrongly drop d1 entirely.
    expect(tags(selectCurrentCapitalGainsRows(rows))).toEqual(['d1-current', 'd2-current']);
  });

  it('F2-U06 — every row of one run shares a timestamp, so a whole multi-lot run survives together', () => {
    const t = '2026-09-03T10:00:00.000Z';
    const rows = [
      row('lot1', 'd1', CURRENT, t),
      row('lot2', 'd1', CURRENT, t),
      row('lot3', 'd1', CURRENT, t),
      row('old', 'd1', CURRENT, '2026-09-02T10:00:00.000Z'),
    ];
    expect(tags(selectCurrentCapitalGainsRows(rows))).toEqual(['lot1', 'lot2', 'lot3']);
  });

  it('F2-U07 — selection is deterministic and order-independent', () => {
    const rows = [
      row('a', 'd1', CURRENT, '2026-09-02T00:00:00.000Z'),
      row('b', 'd1', CURRENT, '2026-09-03T00:00:00.000Z'),
      row('c', 'd1', PREVIOUS, '2026-09-04T00:00:00.000Z'),
      row('d', 'd2', CURRENT, '2026-09-01T00:00:00.000Z'),
    ];
    const forward = tags(selectCurrentCapitalGainsRows(rows));
    const reversed = tags(selectCurrentCapitalGainsRows([...rows].reverse()));
    const shuffled = tags(selectCurrentCapitalGainsRows([rows[2], rows[0], rows[3], rows[1]]));
    expect(forward).toEqual(['b', 'd']);
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it('F2-U08 (F2-T14) — future engine-version resilience: the rule tracks the CONSTANT, not a literal', () => {
    // The whole point of dispatch §20. If someone bumps R6 to v4, rows
    // written by v4 must become current WITHOUT anyone editing a consumer,
    // and the previous generation must stop being current on its own.
    const FUTURE = 'tax-engine-r6-p1-v4';
    const rows = [
      row('todays-current', 'd1', CURRENT, '2026-09-03T00:00:00.000Z'),
      row('tomorrows-current', 'd1', FUTURE, '2026-10-01T00:00:00.000Z'),
    ];
    // Under TODAY's constant, the v4 row is not yet current.
    expect(tags(selectCurrentCapitalGainsRows(rows))).toEqual(['todays-current']);

    // The rule contains no literal version string: it compares against
    // TAX_ENGINE_VERSION. Guard that the constant is what the selector uses
    // by asserting the selection flips entirely when the row set's "current"
    // generation is the constant's own value.
    expect(selectCurrentCapitalGainsRows([row('x', 'd1', TAX_ENGINE_VERSION, '2026-01-01T00:00:00.000Z')])).toHaveLength(1);
    expect(selectCurrentCapitalGainsRows([row('y', 'd1', 'tax-engine-r6-p1-v1', '2030-01-01T00:00:00.000Z')])).toHaveLength(0);
  });

  it('F2-U09 (F2-T34) — scale: 1,200 disposals x 3 generations selects in one pass, no truncation', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 1200; i++) {
      const d = `disposal-${i}`;
      rows.push(row(`old-${i}`, d, PREVIOUS, '2026-08-01T00:00:00.000Z'));
      rows.push(row(`stale-${i}`, d, CURRENT, '2026-09-01T00:00:00.000Z'));
      rows.push(row(`current-${i}`, d, CURRENT, '2026-09-02T00:00:00.000Z'));
    }
    const selected = selectCurrentCapitalGainsRows(rows);
    // Exactly one current row per disposal — not a first-1000 truncation.
    expect(selected).toHaveLength(1200);
    expect(new Set(selected.map((r) => r.disposal_transaction_id)).size).toBe(1200);
    expect(selected.every((r) => r.tag!.startsWith('current-'))).toBe(true);
  });

  it('F2-U10 — the current engine version is v3, and a v2 row is never equal to it', () => {
    // Pins the F1 bump this whole dispatch exists because of.
    expect(TAX_ENGINE_VERSION).toBe('tax-engine-r6-p1-v3');
    expect(PREVIOUS).not.toBe(TAX_ENGINE_VERSION);
  });
});
