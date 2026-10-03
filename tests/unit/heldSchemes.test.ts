// "Held schemes": pure logic, the route, the optional factsheet form and the migration contract.
// EVIDENCE LABEL: code-level unit tests. The database behaviour (exclusion of reversed / review_required,
// capability refusal, no personal columns) is proven against real Postgres by
// scripts/bench1_held_schemes_0251_pglite_verification.mjs (PGlite, synthetic fixtures); 0251 has NOT been
// applied to DEV or production. Nothing here was seen in a browser. The category-benchmark rules are in
// categoryReference.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildHeldSchemeRows,
  categoryHintFromName,
  cleanSchemeName,
  declaredBenchmarksFor,
  heldRawFromRpc,
  planTypeFromName,
  VERIFIED_DECLARED_BENCHMARK_SOURCE_AVAILABLE,
  VERIFIED_DECLARED_BENCHMARKS,
  type HeldSchemeRaw,
  type VerifiedDeclaredBenchmark,
} from '@/lib/services/investment-intelligence/benchmarkData/heldSchemes';
import { summariseUnmappedSchemes } from '@/lib/services/investment-intelligence/benchmarkData/schemeMappingProposals';
import { describeApiFailure, formatDate, mappingFormForFactsheet, validateMappingForm } from '@/components/admin/benchmarkData/benchmarkDataUiLogic';
import { DECLARED_BENCHMARK_EVIDENCE_NOTES } from '@/lib/services/investment-intelligence/benchmarkData/declaredBenchmarkEvidenceNotes';

const ROOT = path.resolve(__dirname, '..', '..');
const raw = (over: Partial<HeldSchemeRaw> = {}): HeldSchemeRaw => ({
  instrumentId: '11111111-1111-4111-8111-111111111111',
  instrumentName: 'H02-HDFC Flexi Cap Fund - Regular Plan - Growth (Non-Demat)',
  amcName: 'HDFC Mutual Fund',
  amfiSchemeCode: '101762',
  subCategory: 'Flexi Cap Fund',
  categoryHeaderRaw: 'Open Ended Schemes(Equity Scheme - Flexi Cap Fund)',
  holderCount: 12,
  firstHeldDate: '2022-12-12',
  mapped: false,
  proposalWaiting: false,
  ...over,
});

describe('display-name cleaning (display only; the original is kept)', () => {
  it.each([
    ['108MFGPG-UTI MNC Fund - Regular Plan (Non Demat)', 'UTI MNC Fund - Regular Plan'],
    ['H44-HDFC Large Cap Fund - Regular Plan - Growth (formerly HDFC Top 100 Fund) (Non-Demat)', 'HDFC Large Cap Fund - Regular Plan - Growth (formerly HDFC Top 100 Fund)'],
    ['L101G-SBI Multi Asset Allocation Fund Regular Growth (formerly SBI Magnum Monthly Income Plan Floater) (Non-Demat)', 'SBI Multi Asset Allocation Fund Regular Growth (formerly SBI Magnum Monthly Income Plan Floater)'],
    ['HGFG-HDFC Balanced Advantage Fund - Regular Plan - Growth (Non-Demat)', 'HDFC Balanced Advantage Fund - Regular Plan - Growth'],
    ['Parag Parikh Flexi Cap Fund', 'Parag Parikh Flexi Cap Fund'],
    ['SBI Large Cap Fund', 'SBI Large Cap Fund'],
  ])('%s', (input, expected) => {
    expect(cleanSchemeName(input)).toBe(expected);
  });

  it('strips the registrar prefix and the demat noise from EVERY one of the 19 production names read on 1 October 2026', () => {
    const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/investment-intelligence/bench1_phase2/inventory/inventory_prod.json'), 'utf8')) as { rows: Array<{ instrument_name: string }> };
    expect(inv.rows).toHaveLength(19);
    for (const r of inv.rows) {
      const c = cleanSchemeName(r.instrument_name);
      expect(c, r.instrument_name).not.toMatch(/^[A-Z0-9]{2,10}-\S/);
      expect(c, r.instrument_name).not.toMatch(/non[\s-]*demat/i);
      expect(c.length).toBeGreaterThan(8);
    }
  });

  it('NEGATIVE CONTROL: an AMC name or a short word before a hyphen is NOT mistaken for a registrar code', () => {
    expect(cleanSchemeName('UTI-Nifty Index Fund')).toBe('UTI-Nifty Index Fund');
    expect(cleanSchemeName('SBI-Magnum Midcap Fund')).toBe('SBI-Magnum Midcap Fund');
    expect(cleanSchemeName('Axis Bluechip - Direct Plan')).toBe('Axis Bluechip - Direct Plan');
  });

  it('plan type and a category hint come from the name, and "Not stated" is said when it is', () => {
    expect(planTypeFromName('H44T-HDFC Large Cap Fund - Direct Plan - Growth Option')).toBe('Direct');
    expect(planTypeFromName('HDFC Mid Cap Fund - Regular Plan - Growth')).toBe('Regular');
    expect(planTypeFromName('SBI Large Cap Fund')).toBe('Not stated in the name');
    expect(categoryHintFromName('HDFC Mid Cap Fund - Regular')).toBe('Mid Cap');
    expect(categoryHintFromName('SBI Contra Fund')).toBe('Contra');
    expect(categoryHintFromName('Something Entirely Unrecognisable')).toBeNull();
  });
});

describe('the held list', () => {
  it('RULE: a statement-created instrument with NO scheme-master link is listed, category from the name, or "Unknown"', () => {
    const unlinked = raw({ instrumentId: '22222222-2222-4222-8222-222222222222', subCategory: null, categoryHeaderRaw: null, amfiSchemeCode: null, amcName: null, instrumentName: 'H44-HDFC Large Cap Fund - Regular Plan - Growth (Non-Demat)' });
    const nameless = raw({ instrumentId: '33333333-3333-4333-8333-333333333333', subCategory: null, categoryHeaderRaw: null, amfiSchemeCode: null, instrumentName: 'XYZ-Mystery Holding' });
    const { rows } = buildHeldSchemeRows([unlinked, nameless]);
    const a = rows.find((r) => r.instrumentId === unlinked.instrumentId)!;
    expect(a.category).toBe('Large Cap');
    expect(a.categorySource).toBe('name_hint');
    expect(a.displayName).toBe('HDFC Large Cap Fund - Regular Plan - Growth');
    expect(a.originalName).toBe('H44-HDFC Large Cap Fund - Regular Plan - Growth (Non-Demat)');
    expect(a.benchmark).toMatchObject({ kind: 'category_reference', categorySource: 'name_inference', benchmarkLabel: 'NIFTY 100 TRI' });
    expect(rows.find((r) => r.instrumentId === nameless.instrumentId)).toMatchObject({ category: 'Unknown', categorySource: 'unknown', benchmark: { kind: 'none' } });
  });

  it('NEGATIVE CONTROL: the OLD universe route cannot show that instrument (it only counts scheme-master rows) and does not identify held schemes at all', () => {
    const unlinkedId = '22222222-2222-4222-8222-222222222222';
    const universe = [{ instrumentId: '11111111-1111-4111-8111-111111111111', subCategory: 'Flexi Cap Fund', schemeName: 'HDFC Flexi Cap Fund', amcName: 'HDFC' }]; // what ii_scheme_master supplies
    const old = summariseUnmappedSchemes(universe, new Set(), new Set());
    expect(JSON.stringify(old)).not.toContain(unlinkedId); // invisible to the old panel
    expect(Object.keys(old.byCategory[0])).not.toContain('instrumentId'); // and rows carry no per-scheme identity or "held" marker
    const heldList = buildHeldSchemeRows([raw({ instrumentId: unlinkedId, subCategory: null, amfiSchemeCode: null })]);
    expect(heldList.rows.map((r) => r.instrumentId)).toContain(unlinkedId); // the held list shows it
  });

  it('shows holder counts only: no user, account, unit or amount field exists on a row, and extra RPC columns are dropped', () => {
    const smuggled = heldRawFromRpc([{ instrument_id: '44444444-4444-4444-8444-444444444444', instrument_name: 'X Fund', holder_count: 2, first_held_date: '2024-01-05', mapped: false, proposal_waiting: false, user_id: 'SECRET-USER', gross_amount: 99999, units: 12.5 }]);
    const out = buildHeldSchemeRows(smuggled);
    const flat = JSON.stringify(out);
    expect(flat).not.toMatch(/SECRET-USER|99999|12\.5|user_id|gross_amount/);
    expect(Object.keys(out.rows[0]).filter((k) => /user|account|folio|unit|amount|value/i.test(k))).toEqual([]);
  });

  it('drops malformed RPC rows rather than showing them (fail closed)', () => {
    expect(heldRawFromRpc(null)).toEqual([]);
    expect(heldRawFromRpc([{ instrument_name: 'no id' }, { instrument_id: 7 }])).toEqual([]);
  });

  it('ordering and counts: no declared benchmark first, then waiting, then declared; by NAME within a group (never by holder count)', () => {
    const { rows, counts } = buildHeldSchemeRows([
      raw({ instrumentId: 'a', instrumentName: 'Mapped Fund', mapped: true, holderCount: 90 }),
      raw({ instrumentId: 'b', instrumentName: 'Waiting Fund', proposalWaiting: true, holderCount: 80 }),
      raw({ instrumentId: 'c', instrumentName: 'Zed Small Fund', holderCount: null, firstHeldDate: null }),
      raw({ instrumentId: 'd', instrumentName: 'Alpha Big Fund', holderCount: 50 }),
      raw({ instrumentId: 'e', instrumentName: 'Mid Fund', holderCount: 11 }),
    ]);
    expect(rows.map((r) => [r.instrumentId, r.status])).toEqual([['d', 'not_mapped'], ['e', 'not_mapped'], ['c', 'not_mapped'], ['b', 'proposal_waiting'], ['a', 'mapped']]);
    expect(counts).toEqual({ held: 5, declared: 1, categoryReference: 4, noBenchmark: 0, proposalWaiting: 1 });
  });

  it('the first-held date is shown day-first (India format), never ISO', () => {
    expect(formatDate('2022-12-12')).toBe('12-12-2022');
    expect(formatDate('2018-03-01')).toBe('01-03-2018');
  });
});

describe('which benchmark applies (informational; no admin step)', () => {
  it('declared (admin) wins: a mapped scheme is "Fund\'s declared benchmark" whatever its category', () => {
    const r = buildHeldSchemeRows([raw({ mapped: true, subCategory: 'Gilt Fund' })]).rows[0];
    expect(r.benchmark).toEqual({ kind: 'declared', label: "Fund's declared benchmark" });
  });
  it('no declared mapping and a supported category: the category reference, with the honest label', () => {
    const r = buildHeldSchemeRows([raw()]).rows[0];
    expect(r.benchmark).toMatchObject({ kind: 'category_reference', benchmarkKey: 'IN_NIFTY_500_TRI', basisLabel: "Compared with the usual benchmark for Flexi Cap funds (not this fund's own declared benchmark)" });
  });
  it('NEGATIVE CONTROL: an unsupported category has NO benchmark and says so', () => {
    const r = buildHeldSchemeRows([raw({ subCategory: 'FoF Domestic', categoryHeaderRaw: null, instrumentName: 'HGFOF-HDFC Gold ETF Fund of Fund - Regular Plan - Growth (Non-Demat)' })]).rows[0];
    expect(r.benchmark).toMatchObject({ kind: 'none' });
    expect((r.benchmark as { message: string }).message).toMatch(/Benchmark not available for this fund category/);
  });
});

describe('RULE (Admin Standard 7.2): fewer than 10 holders => no count and no date', () => {
  it('a scheme whose count the database withheld is still LISTED, with "suppressed" set and no count or date', () => {
    const { rows } = buildHeldSchemeRows([raw({ holderCount: null, firstHeldDate: '2024-05-06' })]); // even if a date were supplied alongside a null count
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ holderCount: null, firstHeldDate: null, holdersSuppressed: true });
  });
  it('NEGATIVE CONTROL: a 3-holder instrument must not expose its count or date - the RPC coercion keeps a withheld count null (never 0) and drops the date with it', () => {
    const out = heldRawFromRpc([{ instrument_id: '44444444-4444-4444-8444-444444444444', instrument_name: 'Three Holder Fund', holder_count: null, first_held_date: '2024-01-05', mapped: false, proposal_waiting: false }]);
    expect(out[0].holderCount).toBeNull();
    expect(out[0].firstHeldDate).toBeNull();
    const built = buildHeldSchemeRows(out).rows[0];
    expect(JSON.stringify(built)).not.toMatch(/2024-01-05/);
    expect(built.holdersSuppressed).toBe(true);
  });
  it('CONTROL: a shown count (10 or more, as the database returns it) and its date pass through', () => {
    const out = buildHeldSchemeRows(heldRawFromRpc([{ instrument_id: '44444444-4444-4444-8444-444444444444', instrument_name: 'Big Fund', holder_count: 10, first_held_date: '2016-04-01', mapped: false, proposal_waiting: false }])).rows[0];
    expect(out).toMatchObject({ holderCount: 10, firstHeldDate: '2016-04-01', holdersSuppressed: false });
  });
  it('the screen says "Fewer than 10 holders" and shows no date', () => {
    const tab = fs.readFileSync(path.join(ROOT, 'components/admin/benchmarkData/MappingsTab.tsx'), 'utf8');
    expect(tab).toMatch(/Fewer than 10 holders/);
    expect(tab).toMatch(/Not shown/);
  });
});

describe('a held scheme whose declared benchmark (per the repository\'s own evidence) differs from the category benchmark is FLAGGED, not mapped', () => {
  const flagged = (code: string, subCategory: string, name: string) =>
    buildHeldSchemeRows([raw({ amfiSchemeCode: code, subCategory, instrumentName: name })]).rows[0].benchmark;
  it.each([
    ['112277', 'Large Cap Fund', '128EFGPG-Axis Large Cap Fund - Regular Growth (Non Demat)', 'BSE 100 TRI'],
    ['103504', 'Large Cap Fund', 'SBI Large Cap Fund', 'BSE 100 TRI'],
    ['102414', 'Contra Fund', 'L036G-SBI Contra Fund - Regular Plan - Growth (Non-Demat)', 'BSE 500 TRI'],
  ])('%s is flagged with its declared benchmark and the evidence reference', (code, sub, name, declared) => {
    const b = flagged(code, sub, name);
    expect(b).toMatchObject({ kind: 'category_reference', declaredDiffers: { declaredName: expect.stringContaining(declared), evidenceRef: expect.stringContaining('scheme_benchmark_matrix.csv') } });
  });
  it('NEGATIVE CONTROL: schemes whose declared benchmark MATCHES the category one are not flagged (ABSL and HDFC Large Cap declare NIFTY 100 TRI; HDFC Mid Cap declares Nifty Midcap 150)', () => {
    expect((flagged('103174', 'Large Cap Fund', 'ABSL Large Cap Fund') as { declaredDiffers: unknown }).declaredDiffers).toBeNull();
    expect((flagged('102000', 'Large Cap Fund', 'HDFC Large Cap Fund') as { declaredDiffers: unknown }).declaredDiffers).toBeNull();
    expect((flagged('105758', 'Mid Cap Fund', 'HDFC Mid Cap Fund') as { declaredDiffers: unknown }).declaredDiffers).toBeNull();
  });
  it('a scheme with no evidence note is never flagged (nothing is invented), and a flag creates no mapping or proposal', () => {
    expect((flagged('999999', 'Large Cap Fund', 'Unknown Large Cap Fund') as { declaredDiffers: unknown }).declaredDiffers).toBeNull();
    const src = fs.readFileSync(path.join(ROOT, 'lib/services/investment-intelligence/benchmarkData/declaredBenchmarkEvidenceNotes.ts'), 'utf8');
    expect(src).not.toMatch(/fetch\(|\.rpc\(|\.insert\(/);
  });
  it('the evidence notes are exactly the rows of the repository\'s own matrix (generated, not typed): all three flagged funds are present', () => {
    const codes = new Set(DECLARED_BENCHMARK_EVIDENCE_NOTES.map((n) => n.amfiSchemeCode));
    for (const c of ['112277', '103504', '102414', '103174']) expect(codes.has(c)).toBe(true);
    const csv = fs.readFileSync(path.join(ROOT, 'docs/investment-intelligence/bench1_phase2/scheme_benchmark_matrix.csv'), 'utf8');
    for (const n of DECLARED_BENCHMARK_EVIDENCE_NOTES) expect(csv).toContain(n.amfiSchemeCode);
  });
  it('the panel says "Declared benchmark differs from category benchmark - enter declared."', () => {
    expect(fs.readFileSync(path.join(ROOT, 'components/admin/benchmarkData/MappingsTab.tsx'), 'utf8')).toMatch(/Declared benchmark differs from category benchmark - enter declared\./);
  });
});

describe('the missing-migration state is friendly, not a raw error', () => {
  it('the 503 carries the plain sentence and the client recognises it', () => {
    const f = describeApiFailure(503, { error: 'This list needs a database update that has not been applied yet.', code: 'unavailable' }, 'load the held schemes');
    expect(f.kind).toBe('unavailable');
    expect(f.message).toMatch(/database update/i);
  });
  it('the panel shows a plain notice for it (and an ordinary error panel otherwise)', () => {
    const tab = fs.readFileSync(path.join(ROOT, 'components/admin/benchmarkData/MappingsTab.tsx'), 'utf8');
    expect(tab).toMatch(/This list needs a database update that has not been applied yet\./);
    expect(tab).toMatch(/\/database update\/i\.test\(held\.state\.failure\.message\)/);
  });
});

describe('verified declared-benchmark source plumbing (nothing invented)', () => {
  const declared: VerifiedDeclaredBenchmark = {
    amfiSchemeCode: '101762',
    declared: [{ benchmarkName: 'NIFTY 500 TRI', effectiveFrom: '2018-02-01', evidenceSource: 'amc_sid', evidenceUrl: 'https://example.test/sid.pdf', evidenceDocumentDate: '2025-05-30', evidenceRetrievedAt: '2026-10-03' }],
  };

  it('the shipped state is NONE: the switch is off and the source list is empty', () => {
    expect(VERIFIED_DECLARED_BENCHMARK_SOURCE_AVAILABLE).toBe(false);
    expect(VERIFIED_DECLARED_BENCHMARKS).toHaveLength(0);
    const out = buildHeldSchemeRows([raw(), raw({ instrumentId: '55555555-5555-4555-8555-555555555555', amfiSchemeCode: '103174' })]);
    expect(out.verifiedSourceAvailable).toBe(false);
    expect(out.rows.every((r) => !r.sourcePrefilled && r.prefilledDeclared.length === 0)).toBe(true);
  });

  it('NEGATIVE CONTROL: a source is present but the switch is off => still nothing pre-filled', () => {
    expect(declaredBenchmarksFor('101762', false, [declared])).toEqual([]);
    expect(buildHeldSchemeRows([raw()], { verifiedSourceEnabled: false, verifiedSources: [declared] }).rows[0].sourcePrefilled).toBe(false);
  });

  it('switch ON + an evidenced declaration for that scheme => pre-filled for that scheme only; a mapped scheme is never pre-filled', () => {
    const out = buildHeldSchemeRows([raw(), raw({ instrumentId: '55555555-5555-4555-8555-555555555555', amfiSchemeCode: '103174' }), raw({ instrumentId: '66666666-6666-4666-8666-666666666666', mapped: true })], { verifiedSourceEnabled: true, verifiedSources: [declared] });
    expect(out.rows.find((r) => r.instrumentId === '11111111-1111-4111-8111-111111111111')).toMatchObject({ sourcePrefilled: true });
    expect(out.rows.find((r) => r.amfiSchemeCode === '103174')?.sourcePrefilled).toBe(false);
    expect(out.rows.find((r) => r.instrumentId === '66666666-6666-4666-8666-666666666666')?.sourcePrefilled).toBe(false);
  });

  it('the OPTIONAL factsheet form carries only the instrument and the factsheet document type, and is invalid until the reviewer enters the factsheet evidence (nothing is pre-filled from a category)', () => {
    const id = '99999999-9999-4999-8999-999999999999';
    const f = mappingFormForFactsheet(id);
    expect(f).toMatchObject({ instrumentId: id, evidenceSource: 'amc_factsheet', proposedBenchmarkName: '', evidenceUrl: '', confidence: '', resolutionMethod: '' });
    expect(Object.keys(validateMappingForm(f))).toEqual(expect.arrayContaining(['proposedBenchmarkName', 'evidenceUrl', 'evidenceDocumentDate', 'confidence']));
    expect(validateMappingForm(f).instrumentId).toBeUndefined(); // any instrument UUID is accepted, linked to the scheme master or not
  });
});

describe('migration 0251 contract (source)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/0251_bench1_held_schemes_for_benchmark_mapping.sql'), 'utf8');
  const returns = /returns table \(([\s\S]*?)\)\s*language/i.exec(sql)?.[1] ?? '';
  it('is additive and idempotent: one function, no table/constraint/drop/delete', () => {
    expect(sql).toMatch(/create or replace function public\.benchmark_held_schemes\(\)/);
    expect(sql).not.toMatch(/\bdrop\s+(table|constraint|column|function|policy)\b|\bdelete\s+from\b|\balter\s+table\b|\binsert\s+into\b|\bupdate\s+public\./i);
  });
  it('enforces the cohort minimum of 10 INSIDE the database, keeps below-threshold schemes in the list, and does not order by count', () => {
    expect(sql).toMatch(/v_min_holders constant integer := 10;/);
    expect(sql).toMatch(/case when h\.holders >= v_min_holders then h\.holders else null end/);
    expect(sql).toMatch(/case when h\.holders >= v_min_holders then h\.first_date else null end/);
    expect(sql).not.toMatch(/where h\.holders >= v_min_holders/); // schemes below the threshold are NOT filtered out
    expect(sql).not.toMatch(/order by h\.holders/);
  });
  it('counts only non-reversed, non-review_required transactions and is capability-gated inside the function', () => {
    expect(sql).toMatch(/coalesce\(t\.status, ''\) not in \('reversed', 'review_required'\)/);
    expect(sql).toMatch(/is_benchmark_data_viewer\(\)/);
    expect(sql).toMatch(/errcode = '42501'/);
    expect(sql).toMatch(/revoke all on function public\.benchmark_held_schemes\(\) from public, anon/);
  });
  it('returns no user, account, unit or amount column', () => {
    expect(returns.length).toBeGreaterThan(50);
    expect(returns).not.toMatch(/user|account|folio|units|amount|gross|value/i);
  });
});

// ---- the route ---------------------------------------------------------------------------------
const rpc = vi.fn();
vi.mock('@/lib/services/investment-intelligence/benchmarkData/routeSupport', async (orig) => {
  const real = await orig<typeof import('@/lib/services/investment-intelligence/benchmarkData/routeSupport')>();
  return { ...real, guarded: async () => ({ ok: true as const, user: { id: 'admin' }, flags: {}, supabase: { rpc } }) };
});

describe('GET mappings/held', () => {
  beforeEach(() => rpc.mockReset());
  it('returns the held rows built from the aggregate RPC, with counts only', async () => {
    rpc.mockResolvedValue({ data: [{ instrument_id: '77777777-7777-4777-8777-777777777777', instrument_name: 'K123-Kotak Mid Cap Fund Regular Growth (Non-Demat)', amc_name: 'Kotak Mahindra Mutual Fund', amfi_scheme_code: '104908', sub_category: 'Mid Cap Fund', category_header_raw: 'x', holder_count: 2, first_held_date: '2022-08-23', mapped: false, proposal_waiting: false }], error: null });
    const { GET } = await import('@/app/api/admin/investment-intelligence/benchmark-data/mappings/held/route');
    const res = await GET();
    const body = (await res.json()) as { data: { rows: Array<{ displayName: string; benchmark: { kind: string; benchmarkLabel?: string } }>; counts: { categoryReference: number } } };
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('benchmark_held_schemes');
    expect(body.data.rows[0].displayName).toBe('Kotak Mid Cap Fund Regular Growth');
    expect(body.data.rows[0].benchmark).toMatchObject({ kind: 'category_reference', benchmarkLabel: 'Nifty Midcap 150 TRI' });
    expect(body.data.counts.categoryReference).toBe(1);
  });
  it('an unapplied migration is an explicit 503, never an empty list', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.benchmark_held_schemes' } });
    const { GET } = await import('@/app/api/admin/investment-intelligence/benchmark-data/mappings/held/route');
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'unavailable', error: 'This list needs a database update that has not been applied yet.' });
  });
  it('a database refusal (42501) is an explicit 403, never an empty list', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'benchmark held schemes: benchmark data view capability required' } });
    const { GET } = await import('@/app/api/admin/investment-intelligence/benchmark-data/mappings/held/route');
    expect((await GET()).status).toBe(403);
  });
});
