// READ-TIME loader for category-reference benchmarks (see categoryReference.ts for the rules).
//
// For the instruments that have NO declared primary mapping it works out each fund's category (scheme
// master, then section header, then name), looks the category up in the single category table, and
// resolves the table's catalogue series by benchmark_key. It returns IN-MEMORY mappings of kind
// 'category_reference'. It writes NOTHING and never produces a stored 'primary' mapping.
//
// FAIL CLOSED: a failed read, a missing catalogue entry or an inactive series produces "no category
// benchmark" for the affected funds, never a guessed one. The entitlement, verification and
// total-return gates are NOT decided here; the consumers apply them exactly as for a declared mapping.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BenchmarkMapping } from '@/lib/engines/investment-intelligence/benchmarkEngine';
import { categoryReferenceBasisLabel, categoryReferenceBenchmarkKeys, categoryReferenceFor, NO_CATEGORY_BENCHMARK_MESSAGE } from './categoryReference';
import { loadDeclaredRecords } from './declaredRecordLoader';
import { declaredRecordMessage } from './declaredRecordStatus';

export interface CategoryReferenceFacts {
  label: string;
  catalogueVerified: boolean;
}

export interface CategoryReferenceSet {
  /** One in-memory mapping per fund that has a usable category benchmark (basis 'category_reference'). */
  mappings: BenchmarkMapping[];
  /** Catalogue facts for the benchmark ids used, keyed by ii_benchmarks.id. */
  facts: Map<string, CategoryReferenceFacts>;
  /** instrumentId -> the sentence shown instead of a number (no benchmark for this fund category, or not resolvable). */
  noBenchmark: Map<string, string>;
  benchmarkIds: string[];
}

export const EMPTY_CATEGORY_REFERENCE_SET = (): CategoryReferenceSet => ({ mappings: [], facts: new Map(), noBenchmark: new Map(), benchmarkIds: [] });

/** A category reference applies in every period: it is "the usual benchmark for the category", not a dated declaration. */
const OPEN_FROM = new Date('1900-01-01T00:00:00.000Z');
const CHUNK = 200;

interface SchemeMasterCat {
  instrument_id: string;
  sub_category: string | null;
  category_header_raw: string | null;
}

export async function loadCategoryReferenceMappings(supabase: SupabaseClient, instrumentIds: readonly string[], declaredInstrumentIds: ReadonlySet<string>): Promise<CategoryReferenceSet> {
  // A category reference is a nicety on top of the page: if anything at all goes wrong reading it, the funds simply
  // have "no category benchmark" (an explicit message). It must never take the Holdings or Performance page down.
  try {
    return await loadInner(supabase, instrumentIds, declaredInstrumentIds);
  } catch {
    const out = EMPTY_CATEGORY_REFERENCE_SET();
    for (const id of new Set(instrumentIds)) if (!declaredInstrumentIds.has(id)) out.noBenchmark.set(id, `${NO_CATEGORY_BENCHMARK_MESSAGE} (the fund category could not be read).`);
    return out;
  }
}

async function loadInner(supabase: SupabaseClient, instrumentIds: readonly string[], declaredInstrumentIds: ReadonlySet<string>): Promise<CategoryReferenceSet> {
  const out = EMPTY_CATEGORY_REFERENCE_SET();
  const allCandidates = [...new Set(instrumentIds)].filter((id) => !declaredInstrumentIds.has(id)); // a declared mapping ALWAYS wins
  if (allCandidates.length === 0) return out;

  // A scheme whose OWN documents declare a benchmark the data we hold cannot represent (composite, gold/silver price, an index
  // we do not hold) is NEVER compared with its category benchmark: that would set the fund against an index its documents say
  // it does not follow. It gets the explicit "Declared benchmark: <name> (cannot be compared with the data we hold)" sentence
  // and no number. Only a scheme with NO declared record at all continues to the category reference below.
  const declared = await loadDeclaredRecords(supabase, allCandidates);
  if (!declared.ok) {
    // Fail closed: if we cannot tell whether a declared record exists, no category comparison is guessed.
    for (const id of allCandidates) out.noBenchmark.set(id, `${NO_CATEGORY_BENCHMARK_MESSAGE} (the fund's declared-benchmark record could not be read).`);
    return out;
  }
  for (const [id, rec] of declared.records) out.noBenchmark.set(id, declaredRecordMessage(rec));
  const candidates = allCandidates.filter((id) => !declared.records.has(id));
  if (candidates.length === 0) return out;

  const failAll = (why: string) => {
    for (const id of candidates) out.noBenchmark.set(id, why);
    return out;
  };

  const master = new Map<string, SchemeMasterCat>();
  const names = new Map<string, string>();
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const slice = candidates.slice(i, i + CHUNK);
    const { data: sm, error: smErr } = await supabase.from('ii_scheme_master').select('instrument_id, sub_category, category_header_raw').in('instrument_id', slice).is('effective_to', null);
    if (smErr) return failAll(`${NO_CATEGORY_BENCHMARK_MESSAGE} (the fund category could not be read).`);
    for (const r of (sm ?? []) as SchemeMasterCat[]) master.set(r.instrument_id, r);
    const { data: ins, error: insErr } = await supabase.from('ii_instruments').select('id, instrument_name').in('id', slice);
    if (insErr) return failAll(`${NO_CATEGORY_BENCHMARK_MESSAGE} (the fund name could not be read).`);
    for (const r of (ins ?? []) as Array<{ id: string; instrument_name: string }>) names.set(r.id, r.instrument_name);
  }

  const resolved = new Map<string, ReturnType<typeof categoryReferenceFor>>();
  const keys = new Set<string>();
  for (const id of candidates) {
    const m = master.get(id);
    const ref = categoryReferenceFor({ subCategory: m?.sub_category ?? null, categoryHeaderRaw: m?.category_header_raw ?? null, instrumentName: names.get(id) ?? null });
    resolved.set(id, ref);
    if (ref.state === 'available') keys.add(ref.benchmarkKey);
    else out.noBenchmark.set(id, ref.message);
  }
  if (keys.size === 0) return out;

  // The table's series, by catalogue key. A key the catalogue does not hold leaves its funds with a named "not in the catalogue" message.
  const wanted = categoryReferenceBenchmarkKeys().filter((k) => keys.has(k));
  const select = (cols: string) => supabase.from('ii_benchmarks').select(cols).in('benchmark_key', wanted);
  let { data: bm, error: bmErr } = await select('id, benchmark_key, benchmark_label, return_type, lifecycle_status, catalogue_status');
  if (bmErr && /catalogue_status|lifecycle_status/i.test(bmErr.message)) {
    ({ data: bm, error: bmErr } = await select('id, benchmark_key, benchmark_label, return_type'));
  }
  if (bmErr) {
    for (const [id, ref] of resolved) if (ref.state === 'available') out.noBenchmark.set(id, `${ref.benchmarkLabel}: the benchmark catalogue could not be read, so no comparison is shown.`);
    return out;
  }
  const byKey = new Map<string, { id: string; label: string; returnType: string | null; verified: boolean }>();
  for (const r of (bm ?? []) as unknown as Array<{ id: string; benchmark_key: string; benchmark_label: string; return_type: string | null; lifecycle_status?: string | null; catalogue_status?: string | null }>) {
    if (r.lifecycle_status !== undefined && r.lifecycle_status !== null && r.lifecycle_status !== 'active') continue;
    byKey.set(r.benchmark_key, { id: r.id, label: r.benchmark_label, returnType: r.return_type, verified: r.catalogue_status === 'verified' });
  }

  const usedIds = new Set<string>();
  for (const [instrumentId, ref] of resolved) {
    if (ref.state !== 'available') continue;
    const entry = byKey.get(ref.benchmarkKey);
    if (!entry) {
      out.noBenchmark.set(instrumentId, `${ref.benchmarkLabel}: this benchmark is not in the catalogue yet, so no comparison is shown.`);
      continue;
    }
    out.mappings.push({
      instrumentId,
      benchmarkId: entry.id,
      benchmarkKey: ref.benchmarkKey,
      returnType: (entry.returnType ?? 'OTHER') as BenchmarkMapping['returnType'],
      effectiveFrom: OPEN_FROM,
      effectiveTo: null,
      basis: 'category_reference',
      categoryLabel: ref.categoryLabel,
      basisLabel: categoryReferenceBasisLabel(ref.categoryLabel),
    });
    out.facts.set(entry.id, { label: entry.label, catalogueVerified: entry.verified });
    usedIds.add(entry.id);
  }
  out.benchmarkIds = [...usedIds];
  return out;
}
