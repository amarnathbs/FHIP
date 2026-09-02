// II-PC1-F1 — R6 FIFO account-scope certification.
//
// THE QUESTION THIS SUITE SETTLES
// -------------------------------
// One user holds the SAME scheme (same instrument_id / same ISIN) in TWO
// folios. A redemption is placed against Folio B. Which acquisition lots may
// FIFO consume?
//
// DECIDED: ACCOUNT_SCOPED_FIFO — only lots opened in the DISPOSING account.
// The evidence chain (CBDT Circular No. 768 dated 24-6-1998 interpreting
// s.45(2A): "where an investor has more than one security account, FIFO
// method will be applied accountwise"; s.45 itself for folio-mode units;
// CAMS/KFintech folio-wise capital-gains statements; R5's already-
// account-partitioned SIP attribution; R3 publication reading ii_tax_lots by
// (account_id, instrument_id)) is written up in full in
// docs/investment-intelligence/II_PC1_F1_FIFO_SCOPE_DECISION.md.
//
// Before the fix, `consumeLotsFifo` matched on instrumentKey alone, so a
// Folio B redemption consumed the older Folio A lot. II-PC1 disclosed this
// as a known-but-unfixed architectural characteristic (its own fixtures used
// two DIFFERENT instruments, so account-scoping and instrument-scoping
// coincided and could not tell the two models apart). F1 is the dispatch
// that reproduced it with a same-instrument/two-folio fixture and repaired it.
//
// Hermetic (mocked Supabase), mirroring iiR12DisposalTypeSaleFix.test.ts and
// iiR6FinalTaxPaginationAudit.test.ts's established mocking pattern. The
// whole real pipeline is exercised: loadTaxDataset -> runTaxSimulation ->
// consumeLotsFifo -> computeDisposalTax.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadTaxDataset } from '@/lib/services/investment-intelligence/taxRepository';
import { runTaxSimulation } from '@/lib/engines/investment-intelligence/tax/taxOrchestrator';

// ===========================================================================
// Mocked Supabase (same shape as the two suites named above)
// ===========================================================================

type MockRow = Record<string, unknown>;

function makeTableBuilder(rows: MockRow[]) {
  let filtered = rows;
  const orderClauses: Array<{ col: string; ascending: boolean }> = [];
  const builder = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] === val);
      return builder;
    },
    in(col: string, vals: unknown[]) {
      const set = new Set(vals);
      filtered = filtered.filter((r) => set.has(r[col]));
      return builder;
    },
    lte(col: string, val: unknown) {
      filtered = filtered.filter((r) => (r[col] as string) <= (val as string));
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderClauses.push({ col, ascending: opts?.ascending !== false });
      return builder;
    },
    range(from: number, to: number) {
      const sorted = [...filtered];
      for (let i = orderClauses.length - 1; i >= 0; i--) {
        const { col, ascending } = orderClauses[i];
        sorted.sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av < bv) return ascending ? -1 : 1;
          if (av > bv) return ascending ? 1 : -1;
          return 0;
        });
      }
      return Promise.resolve({ data: sorted.slice(from, to + 1), error: null });
    },
  };
  return builder;
}

function makeSupabaseMock(tables: Record<string, MockRow[]>): SupabaseClient {
  return {
    from(table: string) {
      return makeTableBuilder(tables[table] ?? []);
    },
  } as unknown as SupabaseClient;
}

// ===========================================================================
// Canonical fixture vocabulary
// ===========================================================================

const USER_ID = 'user-f1-two-folio';

/** ONE instrument — the same scheme/ISIN held in both folios. This is the
 * whole point of the fixture: instrument-scoped and account-scoped FIFO can
 * only be told apart when the instrument id is genuinely shared. */
const INSTRUMENT = 'inst-f1-equity-scheme';
const INSTRUMENT_Y = 'inst-f1-second-scheme';

/** TWO canonical accounts — two folios of the SAME AMC, exactly the real
 * CAMS shape this dispatch exists to certify. */
const FOLIO_A = 'acct-f1-folio-a';
const FOLIO_B = 'acct-f1-folio-b';

interface TxnSpec {
  id: string;
  account: string;
  instrument?: string;
  type: string;
  date: string;
  units: number;
  price: number;
  status?: string;
}

function txnRow(t: TxnSpec): MockRow {
  return {
    id: t.id,
    account_id: t.account,
    instrument_id: t.instrument ?? INSTRUMENT,
    transaction_type: t.type,
    transaction_date: t.date,
    units: t.units,
    price_per_unit: t.price,
    gross_amount: Math.abs(t.units) * t.price,
    status: t.status ?? 'confirmed',
    user_id: USER_ID,
  };
}

function tables(txns: TxnSpec[], opts: { instruments?: string[] } = {}): Record<string, MockRow[]> {
  const instrumentIds = opts.instruments ?? [INSTRUMENT];
  return {
    ii_transactions: txns.map(txnRow),
    ii_accounts: [
      { id: FOLIO_A, institution_name: 'AMC Alpha', folio_number: '11111111/22', account_number_masked: null },
      { id: FOLIO_B, institution_name: 'AMC Alpha', folio_number: '99999999/88', account_number_masked: null },
    ],
    ii_instruments: instrumentIds.map((id) => ({ id, instrument_name: `Scheme ${id}`, country_of_domicile: 'IN' })),
    // Equity-oriented, so the 12-month STCG/LTCG split is live and the two
    // models can differ in tax CLASSIFICATION, not merely in rupees.
    ii_scheme_tax_classification: instrumentIds.map((id) => ({
      instrument_id: id,
      classification: 'equity_oriented',
      domestic_equity_pct: 98,
      basis: 'disclosed_holdings',
      disclosure_date: '2025-12-31',
      note: '',
    })),
    ii_prices_nav: [],
    ii_exit_load_schedules: [],
  };
}

/** Run the REAL production pipeline exactly as every route/report does:
 * loadTaxDataset -> flatten the per-instrument maps -> runTaxSimulation. The
 * `.flat()` is deliberate and load-bearing — it is what destroys any
 * repository-level partitioning, and is precisely why the account scope had
 * to be enforced inside the engine rather than only in the repository. */
async function runPipeline(txns: TxnSpec[], opts: { instruments?: string[] } = {}) {
  const supabase = makeSupabaseMock(tables(txns, opts));
  const { dataset, empty } = await loadTaxDataset(supabase, USER_ID);
  expect(empty).toBe(false);
  const acquisitions = [...dataset!.acquisitionsByInstrument.values()].flat();
  const disposals = [...dataset!.disposalsByInstrument.values()].flat();
  const result = runTaxSimulation({
    acquisitions,
    disposals,
    classificationByInstrument: dataset!.classificationByInstrument,
    fmv31Jan2018ByInstrument: dataset!.fmv31Jan2018ByInstrument,
    salePricePerUnitByDisposal: dataset!.salePricePerUnitByDisposal,
    exitLoadSchedules: dataset!.exitLoadSchedules,
    residencyProfile: {},
  });
  return { dataset: dataset!, result, acquisitions, disposals };
}

/** lotId -> the account that lot's opening transaction actually belonged to,
 * derived from the FIXTURE (independent of anything the engine reports), so
 * a cross-account consumption cannot hide behind the engine's own bookkeeping. */
function accountOfLotFromFixture(txns: TxnSpec[], lotId: string): string {
  const sourceEventId = lotId.startsWith('lot:') ? lotId.slice(4) : lotId;
  const spec = txns.find((t) => t.id === sourceEventId);
  if (!spec) throw new Error(`fixture has no transaction ${sourceEventId} for lot ${lotId}`);
  return spec.account;
}

function accountOfDisposalFromFixture(txns: TxnSpec[], disposalEventId: string): string {
  const spec = txns.find((t) => t.id === disposalEventId);
  if (!spec) throw new Error(`fixture has no transaction ${disposalEventId}`);
  return spec.account;
}

/** THE CONTAMINATION ORACLE (dispatch §13/§36). For every disposal result,
 * compare the account of the consumed lot against the account of the
 * disposal — both resolved from the FIXTURE, never from engine output. */
function countCrossAccountConsumptions(txns: TxnSpec[], results: Array<{ disposalEventId: string; lotId: string }>): number {
  let contaminated = 0;
  for (const r of results) {
    if (accountOfLotFromFixture(txns, r.lotId) !== accountOfDisposalFromFixture(txns, r.disposalEventId)) contaminated++;
  }
  return contaminated;
}

// ===========================================================================
// INDEPENDENT ORACLE (dispatch §13)
//
// Deliberately imports NOTHING from taxRepository.ts, taxLotEngine.ts or any
// R6 production grouping helper. It is a from-scratch, account-scoped FIFO
// written directly against the fixture, so agreement with the product is
// genuine corroboration rather than a tautology.
// ===========================================================================

interface OracleConsumption {
  disposalEventId: string;
  lotSourceEventId: string;
  account: string;
  instrument: string;
  unitsConsumed: number;
  costBasis: number;
  saleProceeds: number;
  gain: number;
  holdingDays: number;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

const ORACLE_ACQUISITION_TYPES = new Set(['purchase', 'sip', 'switch_in', 'reinvestment', 'bonus', 'split']);
const ORACLE_DISPOSAL_TYPES = new Set(['redemption', 'switch_out', 'sale']);

function oracle(txns: TxnSpec[]): OracleConsumption[] {
  const usable = txns.filter((t) => (t.status ?? 'confirmed') !== 'reversed' && (t.status ?? 'confirmed') !== 'review_required');
  // Deterministic canonical order: date, then transaction id — the same
  // ordering contract loadTaxDataset's query declares.
  const ordered = [...usable].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1));

  // Open lots keyed by (account, instrument) — the account boundary is the
  // whole point, so the oracle models it structurally as a separate queue.
  const queues = new Map<string, Array<{ id: string; date: string; units: number; costPerUnit: number }>>();
  const out: OracleConsumption[] = [];

  for (const t of ordered) {
    const instrument = t.instrument ?? INSTRUMENT;
    const key = `${t.account}::${instrument}`;
    if (ORACLE_ACQUISITION_TYPES.has(t.type)) {
      const q = queues.get(key) ?? [];
      q.push({ id: t.id, date: t.date, units: t.units, costPerUnit: t.price });
      queues.set(key, q);
    } else if (ORACLE_DISPOSAL_TYPES.has(t.type)) {
      const q = queues.get(key) ?? [];
      // FIFO within this queue only: oldest acquisition date first, ties by id.
      const candidates = q.filter((l) => l.units > 1e-9).sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1));
      let remaining = t.units;
      const salePricePerUnit = t.price;
      for (const lot of candidates) {
        if (remaining <= 1e-9) break;
        const take = Math.min(lot.units, remaining);
        lot.units -= take;
        remaining -= take;
        out.push({
          disposalEventId: t.id,
          lotSourceEventId: lot.id,
          account: t.account,
          instrument,
          unitsConsumed: take,
          costBasis: take * lot.costPerUnit,
          saleProceeds: take * salePricePerUnit,
          gain: take * salePricePerUnit - take * lot.costPerUnit,
          holdingDays: daysBetween(lot.date, t.date),
        });
      }
      if (remaining > 1e-9) throw new Error(`oracle: disposal ${t.id} exceeds account ${t.account}'s balance by ${remaining}`);
    }
  }
  return out;
}

// ===========================================================================
// PRIMARY FIXTURE (dispatch §6) — same instrument, two folios.
//
// Deliberately engineered so the two candidate models give MATERIALLY
// different answers on every axis that matters: lot identity, cost basis,
// realised gain, holding period, and STCG/LTCG classification.
//
//   Folio A  A1  2024-01-10  100 units @ 100   <- OLDER, CHEAPER
//   Folio B  B1  2025-10-10  100 units @ 200   <- NEWER, DEARER
//   Folio B  D1  2026-02-01   50 units @ 250   <- redemption FROM FOLIO B
//
//   account-scoped   -> consumes B1: cost 10,000, gain 2,500, held  114d STCG
//   instrument-wide  -> consumes A1: cost  5,000, gain 7,500, held  753d LTCG
// ===========================================================================

const PRIMARY: TxnSpec[] = [
  { id: 'a1', account: FOLIO_A, type: 'purchase', date: '2024-01-10', units: 100, price: 100 },
  { id: 'b1', account: FOLIO_B, type: 'purchase', date: '2025-10-10', units: 100, price: 200 },
  { id: 'd1', account: FOLIO_B, type: 'redemption', date: '2026-02-01', units: 50, price: 250 },
];

describe('II-PC1-F1 / F1-T01 — same instrument, two folios, disposal from Folio B', () => {
  it('consumes the FOLIO B lot, not the older cheaper Folio A lot', async () => {
    const { result } = await runPipeline(PRIMARY);

    expect(result.disposalResults).toHaveLength(1);
    const d = result.disposalResults[0];

    expect(d.disposalEventId).toBe('d1');
    expect(d.lotId).toBe('lot:b1'); // NOT lot:a1 — that was the defect
    expect(accountOfLotFromFixture(PRIMARY, d.lotId)).toBe(FOLIO_B);
    expect(d.unitsConsumed).toBe(50);
    expect(d.costBasisUsed).toBeCloseTo(10_000, 6); // 50 * 200 (Folio B cost), not 50 * 100
    expect(d.saleValue).toBeCloseTo(12_500, 6);
    expect(d.taxableGain).toBeCloseTo(2_500, 6); // not 7,500
    expect(d.holdingDays).toBe(114); // not 753
    expect(d.gainType).toBe('stcg'); // not ltcg — the models differ in CLASSIFICATION too
  });

  it("leaves Folio A's lot completely untouched", async () => {
    const { result } = await runPipeline(PRIMARY);
    const lotA = result.lots.find((l) => l.lotId === 'lot:a1')!;
    const lotB = result.lots.find((l) => l.lotId === 'lot:b1')!;

    expect(lotA.unitsRemaining).toBe(100); // fully intact
    expect(lotA.accountKey).toBe(FOLIO_A);
    expect(lotB.unitsRemaining).toBe(50); // 100 - 50 consumed
    expect(lotB.accountKey).toBe(FOLIO_B);
  });

  it('matches the independent oracle on every atomic value', async () => {
    const { result } = await runPipeline(PRIMARY);
    const expected = oracle(PRIMARY);

    expect(result.disposalResults).toHaveLength(expected.length);
    for (const [i, e] of expected.entries()) {
      const a = result.disposalResults[i];
      expect(a.disposalEventId).toBe(e.disposalEventId);
      expect(a.lotId).toBe(`lot:${e.lotSourceEventId}`);
      expect(a.unitsConsumed).toBeCloseTo(e.unitsConsumed, 6);
      expect(a.costBasisUsed).toBeCloseTo(e.costBasis, 6);
      expect(a.saleValue).toBeCloseTo(e.saleProceeds, 6);
      expect(a.taxableGain!).toBeCloseTo(e.gain, 6);
      expect(a.holdingDays).toBe(e.holdingDays);
    }
  });

  it('RED PROOF — the OLD instrument-only candidacy rule demonstrably picks the wrong lot on this same fixture', async () => {
    // Re-implements the pre-fix predicate verbatim (`l.instrumentKey ===
    // disposal.instrumentKey`, with NO account term) and runs it over the
    // REAL lots the REAL repository produced from this fixture. This is the
    // repo's established RED convention (see iiR6FinalTaxPaginationAudit's
    // own locally-reimplemented pre-fix query shape).
    const { dataset } = await runPipeline(PRIMARY);
    const acquisitions = [...dataset.acquisitionsByInstrument.values()].flat();
    const disposals = [...dataset.disposalsByInstrument.values()].flat();

    const lots = acquisitions.map((a) => ({ lotId: `lot:${a.sourceEventId}`, instrumentKey: a.instrumentKey, acquisitionDate: a.acquisitionDate, unitsRemaining: a.units, costPerUnit: a.costPerUnit }));
    const disposal = disposals[0];
    const oldCandidates = lots
      .filter((l) => l.instrumentKey === disposal.instrumentKey && l.unitsRemaining > 1e-9) // <- the defect: no account term
      .sort((a, b) => (a.acquisitionDate < b.acquisitionDate ? -1 : a.acquisitionDate > b.acquisitionDate ? 1 : 0));

    const oldChosen = oldCandidates[0];
    // Under the OLD rule the Folio B redemption reaches into Folio A.
    expect(oldChosen.lotId).toBe('lot:a1');
    expect(accountOfLotFromFixture(PRIMARY, oldChosen.lotId)).toBe(FOLIO_A);
    expect(accountOfDisposalFromFixture(PRIMARY, disposal.sourceEventId)).toBe(FOLIO_B);
    // ...and would have reported a materially different, wrong answer.
    expect(oldChosen.costPerUnit * 50).toBeCloseTo(5_000, 6); // vs the correct 10,000
    expect(daysBetween(oldChosen.acquisitionDate, '2026-02-01')).toBe(753); // vs the correct 114 (LTCG vs STCG)
  });
});

describe('II-PC1-F1 / F1-T02 — reverse disposal from Folio A', () => {
  // Catches a repair that only special-cases the FIRST disposal.
  const txns: TxnSpec[] = [...PRIMARY, { id: 'd2', account: FOLIO_A, type: 'redemption', date: '2026-03-01', units: 40, price: 260 }];

  it('the later Folio A disposal consumes the Folio A lot', async () => {
    const { result } = await runPipeline(txns);
    const d2 = result.disposalResults.find((d) => d.disposalEventId === 'd2')!;
    expect(d2.lotId).toBe('lot:a1');
    expect(accountOfLotFromFixture(txns, d2.lotId)).toBe(FOLIO_A);
    expect(d2.costBasisUsed).toBeCloseTo(4_000, 6); // 40 * 100
  });

  it('neither disposal contaminates the other account, and both match the oracle', async () => {
    const { result } = await runPipeline(txns);
    expect(countCrossAccountConsumptions(txns, result.disposalResults)).toBe(0);

    const expected = oracle(txns);
    const byKey = new Map(result.disposalResults.map((d) => [`${d.disposalEventId}:${d.lotId}`, d]));
    expect(result.disposalResults).toHaveLength(expected.length);
    for (const e of expected) {
      const a = byKey.get(`${e.disposalEventId}:lot:${e.lotSourceEventId}`)!;
      expect(a, `no product result for disposal ${e.disposalEventId} / lot ${e.lotSourceEventId}`).toBeDefined();
      expect(a.costBasisUsed).toBeCloseTo(e.costBasis, 6);
      expect(a.taxableGain!).toBeCloseTo(e.gain, 6);
      expect(a.holdingDays).toBe(e.holdingDays);
    }
  });
});

describe('II-PC1-F1 / F1-T03 + NC-F2 — one folio, same instrument, across three monthly documents', () => {
  // The grouping boundary under review is ACCOUNT, not DOCUMENT. Acquisitions
  // arriving in an initial statement plus two monthly deltas must form ONE
  // account-specific FIFO sequence — a fix that accidentally partitioned by
  // source document / parse run / statement month would split them.
  const txns: TxnSpec[] = [
    { id: 'init-a', account: FOLIO_A, type: 'purchase', date: '2024-01-10', units: 100, price: 100 },
    { id: 'jul-a', account: FOLIO_A, type: 'sip', date: '2024-07-10', units: 50, price: 120 },
    { id: 'aug-a', account: FOLIO_A, type: 'sip', date: '2024-08-10', units: 50, price: 130 },
    { id: 'sell-a', account: FOLIO_A, type: 'redemption', date: '2026-01-15', units: 175, price: 200 },
  ];

  it('all three documents feed ONE FIFO queue — the disposal walks init -> july -> august in order', async () => {
    const { result } = await runPipeline(txns);
    const consumed = result.disposalResults.filter((d) => d.disposalEventId === 'sell-a');
    expect(consumed.map((c) => c.lotId)).toEqual(['lot:init-a', 'lot:jul-a', 'lot:aug-a']);
    expect(consumed.map((c) => c.unitsConsumed)).toEqual([100, 50, 25]); // not split by document
    expect(countCrossAccountConsumptions(txns, result.disposalResults)).toBe(0);
  });

  it('matches the oracle', async () => {
    const { result } = await runPipeline(txns);
    const expected = oracle(txns);
    expect(result.disposalResults).toHaveLength(expected.length);
    for (const [i, e] of expected.entries()) {
      expect(result.disposalResults[i].lotId).toBe(`lot:${e.lotSourceEventId}`);
      expect(result.disposalResults[i].costBasisUsed).toBeCloseTo(e.costBasis, 6);
    }
  });
});

describe('II-PC1-F1 / F1-T04 + NC-F3 — one folio holding TWO instruments', () => {
  // An account-scoping fix must NOT collapse instruments merely because they
  // share an account. The required key is (user, account, instrument), never
  // (user, account).
  const txns: TxnSpec[] = [
    { id: 'x1', account: FOLIO_A, instrument: INSTRUMENT, type: 'purchase', date: '2024-01-10', units: 100, price: 100 },
    { id: 'y1', account: FOLIO_A, instrument: INSTRUMENT_Y, type: 'purchase', date: '2024-02-10', units: 100, price: 300 },
    { id: 'dy', account: FOLIO_A, instrument: INSTRUMENT_Y, type: 'redemption', date: '2026-01-10', units: 60, price: 400 },
  ];

  it('the instrument-Y disposal consumes the instrument-Y lot, never the same-account instrument-X lot', async () => {
    const { result } = await runPipeline(txns, { instruments: [INSTRUMENT, INSTRUMENT_Y] });
    const d = result.disposalResults.find((r) => r.disposalEventId === 'dy')!;
    expect(d.lotId).toBe('lot:y1');
    expect(d.instrumentKey).toBe(INSTRUMENT_Y);
    expect(d.costBasisUsed).toBeCloseTo(18_000, 6); // 60 * 300, not 60 * 100
    // instrument X's lot untouched despite sharing the folio
    expect(result.lots.find((l) => l.lotId === 'lot:x1')!.unitsRemaining).toBe(100);
  });
});

describe('II-PC1-F1 / F1-T05 + NC-F4 — transaction reorder negative control', () => {
  it('shuffling source rows with identical economics does not change any result', async () => {
    const forward = await runPipeline(PRIMARY);
    const shuffled = await runPipeline([PRIMARY[2], PRIMARY[0], PRIMARY[1]]);
    const reversed = await runPipeline([...PRIMARY].reverse());

    const shape = (r: Awaited<ReturnType<typeof runPipeline>>) =>
      r.result.disposalResults.map((d) => ({ d: d.disposalEventId, lot: d.lotId, units: d.unitsConsumed, cost: d.costBasisUsed, gain: d.taxableGain, days: d.holdingDays, type: d.gainType }));

    expect(shape(shuffled)).toEqual(shape(forward));
    expect(shape(reversed)).toEqual(shape(forward));
    // FIFO order depends on acquisition date / deterministic lot ordering —
    // never on document row order, parser array order, or DB insertion order.
  });
});

describe('II-PC1-F1 / F1-T06 — equal-date acquisitions, deterministic tie-break', () => {
  // Two acquisitions in the SAME account on the SAME date. loadTaxDataset
  // orders by (transaction_date asc, id asc) and Array.prototype.sort is
  // stable per ES2019, so the documented tie-breaker is ASCENDING
  // TRANSACTION ID. This asserts the existing behaviour; it does not invent
  // a new tie-breaker.
  const txns: TxnSpec[] = [
    { id: 'tie-b', account: FOLIO_A, type: 'purchase', date: '2024-05-01', units: 10, price: 100 },
    { id: 'tie-a', account: FOLIO_A, type: 'purchase', date: '2024-05-01', units: 10, price: 900 },
    { id: 'tie-sell', account: FOLIO_A, type: 'redemption', date: '2026-01-01', units: 10, price: 1000 },
  ];

  it('resolves the tie by ascending transaction id, identically across repeated and reordered runs', async () => {
    const first = await runPipeline(txns);
    const d = first.result.disposalResults[0];
    expect(d.lotId).toBe('lot:tie-a'); // 'tie-a' < 'tie-b'
    expect(d.costBasisUsed).toBeCloseTo(9_000, 6);

    // Deterministic across runs and across input permutations.
    for (const perm of [[txns[1], txns[0], txns[2]], [txns[2], txns[1], txns[0]]]) {
      const again = await runPipeline(perm);
      expect(again.result.disposalResults[0].lotId).toBe('lot:tie-a');
      expect(again.result.disposalResults[0].costBasisUsed).toBeCloseTo(9_000, 6);
    }
  });
});

describe('II-PC1-F1 / F1-T07..T10 — partial, full, repeated and exhausting disposals', () => {
  it('F1-T07 partial disposal consumes part of one lot and leaves the remainder open', async () => {
    const { result } = await runPipeline(PRIMARY);
    expect(result.lots.find((l) => l.lotId === 'lot:b1')!.unitsRemaining).toBe(50);
  });

  it('F1-T08 full disposal closes exactly the disposing account lot', async () => {
    const txns: TxnSpec[] = [...PRIMARY.slice(0, 2), { id: 'full-b', account: FOLIO_B, type: 'redemption', date: '2026-02-01', units: 100, price: 250 }];
    const { result } = await runPipeline(txns);
    expect(result.lots.find((l) => l.lotId === 'lot:b1')!.unitsRemaining).toBe(0);
    expect(result.lots.find((l) => l.lotId === 'lot:a1')!.unitsRemaining).toBe(100);
    expect(countCrossAccountConsumptions(txns, result.disposalResults)).toBe(0);
  });

  it('F1-T09 a second disposal after a partial one continues within the same account', async () => {
    const txns: TxnSpec[] = [...PRIMARY, { id: 'd1b', account: FOLIO_B, type: 'redemption', date: '2026-03-01', units: 30, price: 270 }];
    const { result } = await runPipeline(txns);
    const second = result.disposalResults.filter((d) => d.disposalEventId === 'd1b');
    expect(second).toHaveLength(1);
    expect(second[0].lotId).toBe('lot:b1'); // remainder of B's own lot, never A's
    expect(result.lots.find((l) => l.lotId === 'lot:b1')!.unitsRemaining).toBe(20);
    expect(result.lots.find((l) => l.lotId === 'lot:a1')!.unitsRemaining).toBe(100);
  });

  it('F1-T10 + NC-F7 exhausting one folio does NOT spill into the other folio — it raises an honest error', async () => {
    // Folio B holds 100 units; the redemption asks for 150. Under the OLD
    // instrument-wide rule this silently borrowed 50 units from Folio A and
    // reported a confident, wrong cost basis. Under the correct rule it is
    // an over-redemption against that folio and must surface as such.
    const txns: TxnSpec[] = [...PRIMARY.slice(0, 2), { id: 'over-b', account: FOLIO_B, type: 'redemption', date: '2026-02-01', units: 150, price: 250 }];
    await expect(runPipeline(txns)).rejects.toThrow(/exceeds that account's available open-lot balance/);
    // And the oracle independently agrees this input is over-redeemed.
    expect(() => oracle(txns)).toThrow(/exceeds account/);
  });

  it('F1-T10b the other folio remains fully available and usable afterwards', async () => {
    const txns: TxnSpec[] = [
      ...PRIMARY.slice(0, 2),
      { id: 'drain-b', account: FOLIO_B, type: 'redemption', date: '2026-02-01', units: 100, price: 250 },
      { id: 'then-a', account: FOLIO_A, type: 'redemption', date: '2026-04-01', units: 100, price: 300 },
    ];
    const { result } = await runPipeline(txns);
    expect(countCrossAccountConsumptions(txns, result.disposalResults)).toBe(0);
    expect(result.lots.every((l) => l.unitsRemaining === 0)).toBe(true);
  });
});

describe('II-PC1-F1 / F1-T11 + F1-T12 + NC-F1 — differing costs and differing holding periods across accounts', () => {
  it('F1-T11 each account uses its OWN acquisition cost', async () => {
    const txns: TxnSpec[] = [
      { id: 'cheap-a', account: FOLIO_A, type: 'purchase', date: '2024-01-10', units: 100, price: 50 },
      { id: 'dear-b', account: FOLIO_B, type: 'purchase', date: '2024-01-10', units: 100, price: 500 },
      { id: 'sell-a', account: FOLIO_A, type: 'redemption', date: '2026-01-10', units: 10, price: 600 },
      { id: 'sell-b', account: FOLIO_B, type: 'redemption', date: '2026-01-10', units: 10, price: 600 },
    ];
    const { result } = await runPipeline(txns);
    const a = result.disposalResults.find((d) => d.disposalEventId === 'sell-a')!;
    const b = result.disposalResults.find((d) => d.disposalEventId === 'sell-b')!;
    expect(a.costBasisUsed).toBeCloseTo(500, 6); // 10 * 50
    expect(b.costBasisUsed).toBeCloseTo(5_000, 6); // 10 * 500
    expect(a.taxableGain!).toBeCloseTo(5_500, 6);
    expect(b.taxableGain!).toBeCloseTo(1_000, 6);
    expect(countCrossAccountConsumptions(txns, result.disposalResults)).toBe(0);
  });

  it('F1-T12 each account uses its OWN holding period, so STCG/LTCG can differ per folio', async () => {
    const txns: TxnSpec[] = [
      { id: 'old-a', account: FOLIO_A, type: 'purchase', date: '2023-01-10', units: 100, price: 100 },
      { id: 'new-b', account: FOLIO_B, type: 'purchase', date: '2025-12-01', units: 100, price: 100 },
      { id: 'sell-a2', account: FOLIO_A, type: 'redemption', date: '2026-02-01', units: 10, price: 200 },
      { id: 'sell-b2', account: FOLIO_B, type: 'redemption', date: '2026-02-01', units: 10, price: 200 },
    ];
    const { result } = await runPipeline(txns);
    const a = result.disposalResults.find((d) => d.disposalEventId === 'sell-a2')!;
    const b = result.disposalResults.find((d) => d.disposalEventId === 'sell-b2')!;
    expect(a.holdingDays).toBe(daysBetween('2023-01-10', '2026-02-01'));
    expect(b.holdingDays).toBe(daysBetween('2025-12-01', '2026-02-01'));
    expect(a.gainType).toBe('ltcg');
    expect(b.gainType).toBe('stcg');
  });
});

describe('II-PC1-F1 / F1-T13 + NC-F8 — recalculation idempotency', () => {
  it('running the pipeline twice over unchanged input yields byte-identical results and no duplicate consumptions', async () => {
    const first = await runPipeline(PRIMARY);
    const second = await runPipeline(PRIMARY);
    expect(JSON.stringify(second.result.disposalResults)).toBe(JSON.stringify(first.result.disposalResults));
    expect(JSON.stringify(second.result.lots)).toBe(JSON.stringify(first.result.lots));
    expect(second.result.engineVersion).toBe(first.result.engineVersion);

    // One consumption record per (disposal, lot) — no duplicates.
    const keys = second.result.disposalResults.map((d) => `${d.disposalEventId}:${d.lotId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('II-PC1-F1 / F1-T14 + NC-F6 — monthly deltas keep account identity, and a wrong-instrument account never crosses over', () => {
  // INITIAL: Folio A + Folio B; JULY: Folio B only; AUGUST: Folio A only.
  const txns: TxnSpec[] = [
    { id: 'i-a', account: FOLIO_A, type: 'purchase', date: '2024-01-10', units: 100, price: 100 },
    { id: 'i-b', account: FOLIO_B, type: 'purchase', date: '2024-01-10', units: 100, price: 150 },
    { id: 'jul-b', account: FOLIO_B, type: 'sip', date: '2024-07-10', units: 20, price: 180 },
    { id: 'aug-a', account: FOLIO_A, type: 'sip', date: '2024-08-10', units: 20, price: 190 },
    { id: 'sell-b3', account: FOLIO_B, type: 'redemption', date: '2026-01-20', units: 110, price: 300 },
  ];

  it('the post-delta Folio B disposal walks Folio B lots only, in Folio B date order', async () => {
    const { result } = await runPipeline(txns);
    const consumed = result.disposalResults.filter((d) => d.disposalEventId === 'sell-b3');
    expect(consumed.map((c) => c.lotId)).toEqual(['lot:i-b', 'lot:jul-b']);
    expect(consumed.map((c) => c.unitsConsumed)).toEqual([100, 10]);
    expect(countCrossAccountConsumptions(txns, result.disposalResults)).toBe(0);
    // Folio A's initial and August lots are untouched.
    expect(result.lots.find((l) => l.lotId === 'lot:i-a')!.unitsRemaining).toBe(100);
    expect(result.lots.find((l) => l.lotId === 'lot:aug-a')!.unitsRemaining).toBe(20);
  });

  it('NC-F6 a valid account holding a DIFFERENT instrument yields no lot crossover', async () => {
    const mixed: TxnSpec[] = [
      { id: 'wrong-inst', account: FOLIO_B, instrument: INSTRUMENT_Y, type: 'purchase', date: '2023-01-01', units: 500, price: 1 },
      { id: 'right-inst', account: FOLIO_B, instrument: INSTRUMENT, type: 'purchase', date: '2025-01-01', units: 100, price: 100 },
      { id: 'sell-right', account: FOLIO_B, instrument: INSTRUMENT, type: 'redemption', date: '2026-01-01', units: 100, price: 150 },
    ];
    const { result } = await runPipeline(mixed, { instruments: [INSTRUMENT, INSTRUMENT_Y] });
    const consumed = result.disposalResults.filter((d) => d.disposalEventId === 'sell-right');
    expect(consumed).toHaveLength(1);
    expect(consumed[0].lotId).toBe('lot:right-inst'); // never the older, cheaper wrong-instrument lot
    expect(result.lots.find((l) => l.lotId === 'lot:wrong-inst')!.unitsRemaining).toBe(500);
  });
});

describe('II-PC1-F1 / F1-T15 — every consumer sees the same canonical R6 result', () => {
  it('the flattened whole-portfolio call (used by tax/summary, tax/lots and the R10 report) equals a per-account call', async () => {
    // Every production consumer flattens the per-instrument maps into one
    // array. This proves that flattening is now inert: partitioning happens
    // inside the engine, so the whole-portfolio answer for Folio B is
    // identical to the answer computed from Folio B's rows alone.
    const whole = await runPipeline(PRIMARY);
    const folioBOnly = await runPipeline(PRIMARY.filter((t) => t.account === FOLIO_B));

    const strip = (rs: typeof whole.result.disposalResults) => rs.map((d) => ({ lot: d.lotId, units: d.unitsConsumed, cost: d.costBasisUsed, gain: d.taxableGain, days: d.holdingDays, type: d.gainType }));

    expect(strip(whole.result.disposalResults)).toEqual(strip(folioBOnly.result.disposalResults));
  });

  it('lot account provenance is carried on every lot, so ii_tax_lots.account_id and R3 published cost basis stay correct', async () => {
    const { result } = await runPipeline(PRIMARY);
    // R3's investmentPublicationService reads ii_tax_lots filtered by
    // (account_id, instrument_id) to compute a position's published cost
    // basis. Under the old model a Folio B redemption decremented a FOLIO A
    // lot, understating Folio A's published cost basis. Assert the surviving
    // per-account open cost basis is now what each folio genuinely holds.
    const openCostFor = (account: string) =>
      result.lots.filter((l) => l.accountKey === account).reduce((s, l) => s + l.unitsRemaining * l.costPerUnit, 0);

    expect(openCostFor(FOLIO_A)).toBeCloseTo(10_000, 6); // 100 units @ 100, untouched
    expect(openCostFor(FOLIO_B)).toBeCloseTo(10_000, 6); // 50 units @ 200 remaining
    expect(result.lots.every((l) => l.accountKey === FOLIO_A || l.accountKey === FOLIO_B)).toBe(true);
  });
});

describe('II-PC1-F1 / §23 — direct equity + ETF regression across multiple demat accounts', () => {
  // R6's repository grouping is shared with R12 direct securities: 'sale' is
  // in DISPOSAL_TYPES. Account scoping is a generic R6 rule, so it must hold
  // for direct equity/ETF held across two demat accounts too — this is
  // exactly Circular 768's own literal fact pattern.
  const DEMAT_1 = FOLIO_A;
  const DEMAT_2 = FOLIO_B;
  const EQUITY = 'inst-f1-direct-equity';

  const txns: TxnSpec[] = [
    { id: 'eq-d1', account: DEMAT_1, instrument: EQUITY, type: 'purchase', date: '2021-04-01', units: 100, price: 250 },
    { id: 'eq-d2', account: DEMAT_2, instrument: EQUITY, type: 'purchase', date: '2025-11-01', units: 100, price: 900 },
    { id: 'eq-sell-d2', account: DEMAT_2, instrument: EQUITY, type: 'sale', date: '2026-01-05', units: 60, price: 1000 },
  ];

  it('a sale from demat account 2 consumes account 2 lots only (Circular 768 accountwise FIFO)', async () => {
    const { result } = await runPipeline(txns, { instruments: [EQUITY] });
    const d = result.disposalResults.find((r) => r.disposalEventId === 'eq-sell-d2')!;
    expect(d.lotId).toBe('lot:eq-d2');
    expect(d.costBasisUsed).toBeCloseTo(54_000, 6); // 60 * 900, not 60 * 250
    expect(d.gainType).toBe('stcg'); // held ~65 days in that account, not ~4.7 years
    expect(result.lots.find((l) => l.lotId === 'lot:eq-d1')!.unitsRemaining).toBe(100);
    expect(countCrossAccountConsumptions(txns, result.disposalResults)).toBe(0);
  });
});

describe('II-PC1-F1 / §37 — scale: >1000 acquisition events across multiple accounts and instruments', () => {
  it('pages the full transaction history and keeps every account partition correct beyond the 1000-row PostgREST page', async () => {
    // 1,200 SIP acquisitions alternating between two folios, plus a
    // late-dated disposal in each folio. If pagination truncated at 1000, or
    // if the account partition leaked, both the lot chosen and the cost
    // basis would be wrong.
    const txns: TxnSpec[] = [];
    for (let i = 0; i < 1200; i++) {
      const account = i % 2 === 0 ? FOLIO_A : FOLIO_B;
      const day = String((i % 28) + 1).padStart(2, '0');
      const month = String((Math.floor(i / 28) % 12) + 1).padStart(2, '0');
      const year = 2020 + Math.floor(i / 336);
      txns.push({
        id: `sip-${String(i).padStart(4, '0')}`,
        account,
        type: 'sip',
        // Folio A instalments are cheap, Folio B instalments are dear, so a
        // cross-account leak changes the cost basis detectably.
        date: `${year}-${month}-${day}`,
        units: 1,
        price: account === FOLIO_A ? 10 : 1000,
      });
    }
    txns.push({ id: 'scale-sell-b', account: FOLIO_B, type: 'redemption', date: '2026-06-01', units: 5, price: 2000 });

    const { result, acquisitions } = await runPipeline(txns);

    // Full pagination: all 1,200 acquisitions were read, not the first 1000.
    expect(acquisitions).toHaveLength(1200);
    expect(result.lots).toHaveLength(1200);

    const consumed = result.disposalResults.filter((d) => d.disposalEventId === 'scale-sell-b');
    expect(consumed).toHaveLength(5);
    // Every consumed lot must be a Folio B lot at Folio B's price.
    for (const c of consumed) {
      expect(accountOfLotFromFixture(txns, c.lotId)).toBe(FOLIO_B);
      expect(c.costBasisUsed).toBeCloseTo(1000, 6); // 1 unit @ 1000 — never @ 10
    }
    expect(countCrossAccountConsumptions(txns, result.disposalResults)).toBe(0);

    // And the independent oracle agrees on the exact lot sequence.
    const expected = oracle(txns);
    expect(consumed.map((c) => c.lotId)).toEqual(expected.map((e) => `lot:${e.lotSourceEventId}`));
  }, 60_000);
});

describe('II-PC1-F1 / runtime guard — a missing accountKey fails loudly, never silently instrument-wide', () => {
  // The `accountKey: string` type is the first line of defence but not the
  // last: JSON-deserialised fixtures and payloads are cast to these
  // interfaces without the compiler seeing the real shape, and an
  // `undefined` on BOTH sides of the candidacy comparison would compare
  // EQUAL — silently restoring the exact defect this dispatch removed. This
  // was found while migrating the R6-P1 142-case certification pack, whose
  // cases.json genuinely has no accountKey.
  it('buildTaxLots rejects an acquisition with no accountKey', async () => {
    const { buildTaxLots } = await import('@/lib/engines/investment-intelligence/tax/taxLotEngine');
    const bad = [{ sourceEventId: 'x', instrumentKey: INSTRUMENT, kind: 'purchase' as const, acquisitionDate: '2024-01-01', units: 1, costPerUnit: 1 }];
    expect(() => buildTaxLots(bad as unknown as Parameters<typeof buildTaxLots>[0])).toThrow(/has no accountKey/);
  });

  it('consumeLotsFifo rejects a disposal with no accountKey', async () => {
    const { buildTaxLots, consumeLotsFifo } = await import('@/lib/engines/investment-intelligence/tax/taxLotEngine');
    const lots = buildTaxLots([{ sourceEventId: 'x', accountKey: FOLIO_A, instrumentKey: INSTRUMENT, kind: 'purchase', acquisitionDate: '2024-01-01', units: 10, costPerUnit: 1 }]);
    const bad = { sourceEventId: 'd', instrumentKey: INSTRUMENT, disposalDate: '2025-01-01', units: 1, saleValue: 5 };
    expect(() => consumeLotsFifo(lots, bad as unknown as Parameters<typeof consumeLotsFifo>[1])).toThrow(/has no accountKey/);
  });
});

describe('II-PC1-F1 / NC-F5 — cross-user account reference', () => {
  it('another user\'s transactions are never loaded, so their accounts can never enter this user\'s FIFO', async () => {
    // loadTaxDataset filters ii_transactions by the SERVER-RESOLVED user id.
    // A row belonging to someone else — even with a valid, real account id —
    // is structurally unreachable.
    const otherUsersRow: MockRow = {
      id: 'foreign-1',
      account_id: 'acct-someone-else',
      instrument_id: INSTRUMENT,
      transaction_type: 'purchase',
      transaction_date: '2020-01-01',
      units: 999,
      price_per_unit: 1,
      gross_amount: 999,
      status: 'confirmed',
      user_id: 'user-someone-else',
    };
    const t = tables(PRIMARY);
    t.ii_transactions = [...t.ii_transactions, otherUsersRow];

    const supabase = makeSupabaseMock(t);
    const { dataset } = await loadTaxDataset(supabase, USER_ID);
    const acquisitions = [...dataset!.acquisitionsByInstrument.values()].flat();

    expect(acquisitions.map((a) => a.sourceEventId)).not.toContain('foreign-1');
    expect(acquisitions.every((a) => a.accountKey === FOLIO_A || a.accountKey === FOLIO_B)).toBe(true);
    expect(dataset!.accountIdsByInstrument.get(INSTRUMENT)).toEqual([FOLIO_A, FOLIO_B]);
  });
});

describe('II-PC1-F1 / §31 — the account association is canonical truth, not client input', () => {
  it('accountIdsByInstrument is derived solely from the user-scoped canonical transaction read', async () => {
    // The redemption simulator resolves a client-supplied accountId against
    // THIS list before use, so a crafted accountId can only ever select from
    // accounts the user genuinely holds the instrument in — it can never
    // assert an association.
    const { dataset } = await runPipeline(PRIMARY);
    const held = dataset.accountIdsByInstrument.get(INSTRUMENT) ?? [];
    expect(held).toEqual([FOLIO_A, FOLIO_B]);
    expect(held).not.toContain('acct-someone-else');
    // Folio labels resolve for disambiguation, and are display-only.
    expect(dataset.accountLabels.get(FOLIO_A)).toBe('AMC Alpha — 11111111/22');
    expect(dataset.accountLabels.get(FOLIO_B)).toBe('AMC Alpha — 99999999/88');
  });
});
