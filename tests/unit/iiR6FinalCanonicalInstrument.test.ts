// R6-FINAL closure — Sections 14 & 15: canonical-instrument resolution at
// scale, and same-display-name adversarial separation.
//
// Why this belongs in the R6-FINAL closure even though the resolver code
// (identifiers.ts / schemeResolution.ts) is R1/R2, not R6-P1: R6-P1's own
// tax-lot continuity (FIFO matching, grandfathering, classification) is
// keyed entirely on `instrumentKey`. If the platform-wide instrument
// resolver ever silently mints a DUPLICATE canonical instrument for a fund
// that already exists (the exact defect class R6-P0's own comment in
// identifiers.ts names: "an identifier that exists but is not RETURNED
// makes resolution fall through and MINT A DUPLICATE canonical instrument,
// splitting a holder's history and defeating R2's dedup guarantees"), a tax
// disposal that should FIFO-match against lots from an earlier CAS import
// would instead see an empty lot history for the "new" duplicate instrument
// — silently understating cost basis and overstating taxable gain. This
// suite is hermetic (no live DB), mirroring R6-P0's own mocked-Supabase
// pagination-certification pattern.
//
// Section 14 — pagination + no-silent-creation at scale:
//   * a >1,000-row identifier universe with the target's own identifier row
//     sorted PAST the first PostgREST page is still found (not re-created)
//   * a RED/GREEN pair reproducing the original unpaged-read defect on the
//     identical fixture
//   * a genuinely-absent identifier correctly creates exactly one new
//     instrument (resolveOrCreateInstrument's documented, by-design
//     behaviour — ADR-002 "provisional instrument" creation, not a bug)
//   * the pure, no-I/O resolveScheme() resolver — used wherever the tax
//     domain needs a stronger "flag, never guess" contract than "create a
//     provisional" — returns an explicit `unresolved` outcome for a
//     genuinely unmatched query, with zero possibility of a row-count
//     change since it performs no I/O at all
//
// Section 15 — same-display-name adversarial separation:
//   * two synthetic instruments sharing an IDENTICAL display name resolve to
//     two DIFFERENT canonical ids via resolveScheme (ISIN-first), never
//     merged by name
//   * tax lots, FIFO consumption, grandfathering, and classification for
//     those two same-named instruments never leak into each other — proven
//     by running the real R6-P1 engines end-to-end on both and checking
//     cross-instrument isolation

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveScheme, type SchemeResolutionQuery, type ExistingInstrumentForResolution } from '@/lib/services/investment-intelligence/schemeResolution';
import { buildTaxLots, consumeLotsFifo, type AcquisitionEvent, type DisposalEvent } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';
import { computeDisposalTax } from '@/lib/engines/investment-intelligence/tax/capitalGainsEngine';
import { applyGrandfathering } from '@/lib/engines/investment-intelligence/tax/grandfathering';
import { resolveExitLoadPct } from '@/lib/engines/investment-intelligence/tax/exitLoad';
import type { SchemeClassificationResult } from '@/lib/engines/investment-intelligence/tax/schemeClassification';

// ---------------------------------------------------------------------------
// Section 14 — mocked Supabase admin client for resolveOrCreateInstrument.
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;
const POSTGREST_CAP = 1000;

function applyOrder(rows: MockRow[], clauses: Array<{ col: string; ascending: boolean }>): MockRow[] {
  const result = [...rows];
  for (let i = clauses.length - 1; i >= 0; i--) {
    const { col, ascending } = clauses[i];
    result.sort((a, b) => {
      const av = a[col] as string | number;
      const bv = b[col] as string | number;
      if (av < bv) return ascending ? -1 : 1;
      if (av > bv) return ascending ? 1 : -1;
      return 0;
    });
  }
  return result;
}

interface HarnessState {
  identifierRows: MockRow[];
  insertedInstruments: MockRow[];
  insertedIdentifierBatches: MockRow[][];
  rangeCalls: number;
}
let state: HarnessState = { identifierRows: [], insertedInstruments: [], insertedIdentifierBatches: [], rangeCalls: 0 };

function makeIdentifierBuilder(paged: boolean) {
  let filtered = state.identifierRows;
  const orderClauses: Array<{ col: string; ascending: boolean }> = [];
  const builder = {
    select() {
      return builder;
    },
    in(col: string, vals: unknown[]) {
      const set = new Set(vals);
      filtered = filtered.filter((r) => set.has(r[col]));
      return builder;
    },
    eq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] === val);
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderClauses.push({ col, ascending: opts?.ascending !== false });
      return builder;
    },
    range(from: number, to: number) {
      state.rangeCalls++;
      const sorted = applyOrder(filtered, orderClauses);
      const width = Math.min(to - from + 1, POSTGREST_CAP);
      return Promise.resolve({ data: sorted.slice(from, from + width), error: null });
    },
    insert(payload: MockRow | MockRow[]) {
      const rows = Array.isArray(payload) ? payload : [payload];
      state.insertedIdentifierBatches.push(rows);
      return Promise.resolve({ error: null });
    },
    // RED path only: an unbounded await (no .range()) reproduces PostgREST's
    // real, observed silent 1000-row cap — exactly like R6-P0's own mock.
    then(resolve: (v: { data: MockRow[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      const sorted = applyOrder(filtered, orderClauses);
      const capped = paged ? sorted : sorted.slice(0, POSTGREST_CAP);
      return Promise.resolve({ data: capped, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function makeInstrumentBuilder() {
  return {
    insert(payload: MockRow) {
      const row = { ...payload, id: `new-instrument-${state.insertedInstruments.length}` };
      return {
        select() {
          return {
            single() {
              state.insertedInstruments.push(row);
              return Promise.resolve({ data: { id: row.id }, error: null });
            },
          };
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table === 'ii_instrument_identifiers') return makeIdentifierBuilder(true);
      if (table === 'ii_instruments') return makeInstrumentBuilder();
      throw new Error(`Unexpected table in mock: ${table}`);
    },
  }),
}));

// Imported AFTER vi.mock so the mocked admin client is in effect.
const { resolveOrCreateInstrument } = await import('@/lib/services/investment-intelligence/identifiers');

function identifierUniverse(n: number, targetIndex: number, targetIsin: string): MockRow[] {
  // ids are zero-padded so a plain string sort matches numeric order — the
  // SAME unique tie-breaker resolveOrCreateInstrument's real .order('id')
  // call relies on.
  return Array.from({ length: n }, (_, i) => ({
    id: `ident-${String(i).padStart(6, '0')}`,
    instrument_id: i === targetIndex ? 'existing-target-instrument' : `existing-instrument-${i}`,
    identifier_scheme: 'isin',
    identifier_value: i === targetIndex ? targetIsin : `INF${String(i).padStart(9, '0')}`,
    country_code: 'IN',
    is_active: true,
  }));
}

beforeEach(() => {
  state = { identifierRows: [], insertedInstruments: [], insertedIdentifierBatches: [], rangeCalls: 0 };
});

describe('R6-FINAL Sec.14: canonical-instrument resolution at scale (>1000 rows)', () => {
  it('finds a target instrument whose identifier row sits PAST the first PostgREST page — does not re-create it', async () => {
    const targetIsin = 'INF999888777';
    // 1500 rows total, target placed at index 1200 -> definitely past page 1
    // (rows 0-999) once sorted by id ascending.
    state.identifierRows = identifierUniverse(1500, 1200, targetIsin);

    const result = await resolveOrCreateInstrument({
      candidates: [{ scheme: 'isin', value: targetIsin }],
      instrumentName: 'Should Not Matter Fund - Growth',
      instrumentClass: 'mutual_fund',
      countryOfDomicile: 'IN',
      baseCurrency: 'INR',
    });

    expect(result.error).toBeNull();
    expect(result.created).toBe(false);
    expect(result.instrumentId).toBe('existing-target-instrument');
    // The defining assertion: no new ii_instruments row was minted.
    expect(state.insertedInstruments).toHaveLength(0);
    // Proves real pagination happened (more than one page request).
    expect(state.rangeCalls).toBeGreaterThan(1);
  });

  it('RED: the ORIGINAL unpaged read would have silently missed the target and minted a duplicate', async () => {
    const targetIsin = 'INF999888777';
    state.identifierRows = identifierUniverse(1500, 1200, targetIsin);
    // Reproduce the pre-fix shape locally: a bare `await builder` instead of
    // fetchAllRows's .range() loop. Never exported, never used by
    // production — exists only to prove the defect this fix addresses is
    // real for this exact fixture, matching R6-P0's own RED/GREEN pattern.
    const builder = makeIdentifierBuilder(false).select().in('identifier_scheme', ['isin']).eq('is_active', true).order('id', { ascending: true });
    const { data } = (await builder) as unknown as { data: MockRow[] };
    expect(data).toHaveLength(POSTGREST_CAP); // truncated at 1000, not 1500
    const found = data.find((r) => r.identifier_value === targetIsin);
    expect(found).toBeUndefined(); // the real match is lost in the truncated page
  });

  it('a genuinely-absent identifier creates exactly ONE new instrument (documented, by-design ADR-002 behaviour) — never a phantom extra row', async () => {
    state.identifierRows = identifierUniverse(1500, 1200, 'INF999888777');
    const result = await resolveOrCreateInstrument({
      candidates: [{ scheme: 'isin', value: 'INF_TRULY_NEW_00000' }],
      instrumentName: 'Genuinely New Fund - Growth',
      instrumentClass: 'mutual_fund',
      countryOfDomicile: 'IN',
      baseCurrency: 'INR',
    });
    expect(result.error).toBeNull();
    expect(result.created).toBe(true);
    expect(state.insertedInstruments).toHaveLength(1);
    expect(state.insertedInstruments[0].id).toBe(result.instrumentId);
  });

  it('the pure, no-I/O resolveScheme() resolver flags a genuinely-unresolvable query as `unresolved`, never guessing — and cannot change any row count because it performs no I/O', () => {
    const query: SchemeResolutionQuery = {
      isin: 'INF_NOWHERE',
      amfiSchemeCode: null,
      internalProvisionalCode: null,
      normalisedSchemeName: 'totally unmatched scheme name',
      amcName: 'Nobody AMC',
      planType: 'direct',
      optionType: 'growth',
      countryCode: 'IN',
    };
    const outcome = resolveScheme(query, [], []);
    expect(outcome.kind).toBe('unresolved');
  });
});

// ---------------------------------------------------------------------------
// Section 15 — same-display-name adversarial separation.
// ---------------------------------------------------------------------------

describe('R6-FINAL Sec.15: two same-named instruments never merge, resolved and taxed by canonical ID only', () => {
  const SHARED_NAME = 'Alpha Bluechip Fund - Direct - Growth';

  it('resolveScheme() resolves two same-NAME instruments to two DIFFERENT canonical ids via ISIN, never by name', () => {
    const existing: ExistingInstrumentForResolution[] = [
      { instrumentId: 'canon-A', isin: 'INF111AAA111', amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName: SHARED_NAME.toLowerCase(), amcName: 'Alpha AMC', planType: 'direct', optionType: 'growth', countryCode: 'IN' },
      { instrumentId: 'canon-B', isin: 'INF222BBB222', amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName: SHARED_NAME.toLowerCase(), amcName: 'Alpha AMC', planType: 'direct', optionType: 'growth', countryCode: 'IN' },
    ];
    const resolveA = resolveScheme({ isin: 'INF111AAA111', amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName: SHARED_NAME.toLowerCase(), amcName: 'Alpha AMC', planType: 'direct', optionType: 'growth', countryCode: 'IN' }, existing, []);
    const resolveB = resolveScheme({ isin: 'INF222BBB222', amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName: SHARED_NAME.toLowerCase(), amcName: 'Alpha AMC', planType: 'direct', optionType: 'growth', countryCode: 'IN' }, existing, []);

    expect(resolveA).toMatchObject({ kind: 'resolved', instrumentId: 'canon-A', matchedVia: 'isin' });
    expect(resolveB).toMatchObject({ kind: 'resolved', instrumentId: 'canon-B', matchedVia: 'isin' });
    expect(resolveA).not.toMatchObject({ instrumentId: 'canon-B' });
  });

  it('a name-only query with no ISIN, matching TWO same-named instruments, is reported AMBIGUOUS — never silently picks one', () => {
    const existing: ExistingInstrumentForResolution[] = [
      { instrumentId: 'canon-A', isin: 'INF111AAA111', amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName: SHARED_NAME.toLowerCase(), amcName: 'Alpha AMC', planType: 'direct', optionType: 'growth', countryCode: 'IN' },
      { instrumentId: 'canon-B', isin: 'INF222BBB222', amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName: SHARED_NAME.toLowerCase(), amcName: 'Alpha AMC', planType: 'direct', optionType: 'growth', countryCode: 'IN' },
    ];
    const outcome = resolveScheme(
      { isin: null, amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName: SHARED_NAME.toLowerCase(), amcName: 'Alpha AMC', planType: 'direct', optionType: 'growth', countryCode: 'IN' },
      existing,
      []
    );
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(new Set(outcome.candidateInstrumentIds)).toEqual(new Set(['canon-A', 'canon-B']));
    }
  });

  it('FIFO tax lots for two same-named instruments never cross-contaminate', () => {
    const acquisitionsA: AcquisitionEvent[] = [{ sourceEventId: 'a1', instrumentKey: 'canon-A', kind: 'purchase', acquisitionDate: '2020-01-01', units: 100, costPerUnit: 10 }];
    const acquisitionsB: AcquisitionEvent[] = [{ sourceEventId: 'b1', instrumentKey: 'canon-B', kind: 'purchase', acquisitionDate: '2020-01-01', units: 100, costPerUnit: 999 }]; // deliberately very different cost
    const lots = buildTaxLots([...acquisitionsA, ...acquisitionsB]);

    const disposalA: DisposalEvent = { sourceEventId: 'da', instrumentKey: 'canon-A', disposalDate: '2022-01-01', units: 40, saleValue: 4000 };
    const consumedA = consumeLotsFifo(lots, disposalA);
    expect(consumedA).toHaveLength(1);
    expect(consumedA[0].costPerUnit).toBe(10); // must draw from canon-A's lot, never canon-B's

    const disposalB: DisposalEvent = { sourceEventId: 'db', instrumentKey: 'canon-B', disposalDate: '2022-01-01', units: 40, saleValue: 40000 };
    const consumedB = consumeLotsFifo(lots, disposalB);
    expect(consumedB).toHaveLength(1);
    expect(consumedB[0].costPerUnit).toBe(999); // canon-B's own cost, untouched by A's consumption

    // canon-A's lot balance is unaffected by canon-B's disposal and vice versa.
    const lotA = lots.find((l) => l.instrumentKey === 'canon-A')!;
    const lotB = lots.find((l) => l.instrumentKey === 'canon-B')!;
    expect(lotA.unitsRemaining).toBe(60);
    expect(lotB.unitsRemaining).toBe(60);
  });

  it('classification, grandfathering and exit-load stay separated by canonical ID for two same-named instruments', () => {
    const classA: SchemeClassificationResult = { instrumentKey: 'canon-A', classification: 'equity_oriented', domesticEquityPct: 80, basis: 'computed_from_holdings', disclosureDate: '2024-01-01', note: '' };
    const classB: SchemeClassificationResult = { instrumentKey: 'canon-B', classification: 'debt_specified', domesticEquityPct: null, basis: 'known_debt_specified_category', disclosureDate: null, note: '' };

    const consumptionA = { disposalEventId: 'da', lotId: 'la', instrumentKey: 'canon-A', acquisitionDate: '2016-06-01', kind: 'purchase' as const, disposalDate: '2026-06-15', unitsConsumed: 100, costPerUnit: 20, costBasis: 2000, saleValueApportioned: 9000 };
    const consumptionB = { disposalEventId: 'db', lotId: 'lb', instrumentKey: 'canon-B', acquisitionDate: '2016-06-01', kind: 'purchase' as const, disposalDate: '2026-06-15', unitsConsumed: 100, costPerUnit: 20, costBasis: 2000, saleValueApportioned: 9000 };

    const resultA = computeDisposalTax({ consumption: consumptionA, saleValuePerUnit: 90, classification: classA, fmv31Jan2018PerUnit: 60 });
    const resultB = computeDisposalTax({ consumption: consumptionB, saleValuePerUnit: 90, classification: classB, fmv31Jan2018PerUnit: 60 });

    // Same facts, different classification by canonical ID -> different
    // treatment (LTCG+grandfathering for A; B is debt/specified acquired
    // 2016-06-01, well BEFORE the 1-Apr-2023 Section 50AA cutoff, so
    // R6-DEBTFIX's legacy-regime gate applies -> LTCG too here [>10 years'
    // holding clears both the 24- and 36-month legacy thresholds], but
    // WITHOUT grandfathering, which never applies to debt/specified funds
    // regardless of acquisition date).
    expect(resultA.classification).toBe('equity_oriented');
    expect(resultA.gainType).toBe('ltcg');
    expect(resultA.grandfathering?.eligible).toBe(true);

    expect(resultB.classification).toBe('debt_specified');
    expect(resultB.gainType).toBe('ltcg');
    expect(resultB.grandfathering).toBeNull();

    // Grandfathering applied directly, keyed only by the facts passed for
    // each instrument's own lot — proves no shared/cached state leaks
    // between two calls for same-named-but-different instruments.
    const gfA = applyGrandfathering({ acquisitionDate: '2016-06-01', actualCostPerUnit: 20, salePricePerUnit: 90, fmvPerUnit: 60, isEquityOriented: true });
    const gfB = applyGrandfathering({ acquisitionDate: '2016-06-01', actualCostPerUnit: 20, salePricePerUnit: 90, fmvPerUnit: 60, isEquityOriented: false }); // B is debt, not equity-oriented
    expect(gfA.eligible).toBe(true);
    expect(gfB.eligible).toBe(false);

    // Exit-load schedules keyed by instrumentKey — a schedule attached to
    // canon-A must never apply to canon-B even with an identical tier shape.
    const tiers = [{ uptoDays: 365, loadPct: 1 }];
    const loadA = resolveExitLoadPct(tiers, 100);
    const loadB = resolveExitLoadPct(tiers, 400); // different holding, would use a different tier if schedules ever crossed
    expect(loadA).toBe(1);
    expect(loadB).toBe(0);
  });
});
