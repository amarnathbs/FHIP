// Market Index Data forms: the CONTRACT between what a form lets through (validate*Form + build*Body)
// and what the server accepts (the zod schemas in routeSupport.ts) and what the database enforces
// (CHECK constraints in migration 0241).
//
// WHY THIS EXISTS (PO, 2026-10-03): the Entitlements > Propose form passed its own validation, then the
// server answered 422 and the screen showed one generic banner with no field marked. Diagnosis (offline,
// this file's grid): form states that PASSED client validation and were then refused were
//   1. manual ingestion ticked without the storage right (database CHECK rights_coherent; the client only
//      knew the other four right-implies-right rules);
//   2. "Stored data after expiry" left on the empty placeholder choice (schema enum retain|delete|unknown);
//   3. a benchmark whose catalogue row has no declared variant or currency (schema needs both);
//   4. text longer than the schema allows (evidence reference/attribution 500, notes 1000, URLs 500).
// Each is now refused in the form, with its own field marked. The tests below prove that for EVERY form
// state in the grid either the client refuses it or the server schema AND the database model accept it,
// and that the OLD behaviour (each rule removed in turn) is caught by name.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogueBody, EntitlementBody, MappingBody } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import {
  buildCatalogueBody,
  buildEntitlementBody,
  buildMappingBody,
  emptyCatalogueForm,
  emptyEntitlementForm,
  emptyMappingForm,
  validateCatalogueForm,
  validateEntitlementForm,
  validateMappingForm,
  type EntitlementFormState,
} from '@/components/admin/benchmarkData/benchmarkDataUiLogic';

const ROOT = path.resolve(__dirname, '..', '..');
const BENCH_ID = '11111111-1111-4111-8111-111111111111';

type Row = { id: string; returnVariant: 'price' | 'total_return' | 'net_total_return' | null; currencyCode: string | null };
type Validator = (f: EntitlementFormState, row?: Pick<Row, 'returnVariant' | 'currencyCode'> | null) => Record<string, string>;

/**
 * The database's own rules for a proposed entitlement, transcribed from migration 0241 (propose_benchmark_entitlement
 * and the ii_benchmark_entitlements CHECK constraints). tests below pin the migration text so this cannot drift.
 */
function databaseRefusals(body: Record<string, unknown>, catalogue: Row): string[] {
  const out: string[] = [];
  const b = (k: string) => body[k] === true;
  if (!catalogue.returnVariant || !catalogue.currencyCode) out.push('catalogue row has no declared variant/currency');
  else if (body.return_variant !== catalogue.returnVariant || body.currency_code !== catalogue.currencyCode) out.push('variant/currency must equal the catalogue row');
  if (!(b('allow_calculation') ? b('allow_storage') : true) || !(b('allow_customer_display') ? b('allow_calculation') : true) || !(b('allow_report_export') ? b('allow_customer_display') : true) || !(b('allow_automation') ? b('allow_storage') : true) || !(b('allow_manual_ingest') ? b('allow_storage') : true)) {
    out.push('ii_benchmark_entitlements_rights_coherent');
  }
  const vf = body.valid_from as string | null;
  const vt = body.valid_to as string | null;
  if (vt && vf && vt < vf) out.push('ii_benchmark_entitlements_term');
  const df = body.data_from as string | null;
  const dt = body.data_to as string | null;
  if (dt && df && dt < df) out.push('ii_benchmark_entitlements_data_range');
  if (body.entitlement_kind === 'public_use_permission' && !(body.evidence_url && body.evidence_retrieved_at && body.evidence_document_date)) out.push('ii_benchmark_entitlements_public_needs_evidence');
  if (typeof body.evidence_reference !== 'string' || body.evidence_reference.trim().length < 5) out.push('evidence_reference length');
  return out;
}

const RIGHTS_KEYS = ['ingestManual', 'automation', 'storage', 'calculation', 'customerDisplay', 'reportExport'] as const;
function rightsCombos(): EntitlementFormState['rights'][] {
  const out: EntitlementFormState['rights'][] = [];
  for (let mask = 0; mask < 64; mask++) {
    const r = { ...emptyEntitlementForm().rights };
    RIGHTS_KEYS.forEach((k, i) => {
      r[k] = (mask & (1 << i)) !== 0;
    });
    out.push(r);
  }
  return out;
}

const CATALOGUE_ROWS: Row[] = [
  { id: BENCH_ID, returnVariant: 'total_return', currencyCode: 'INR' },
  { id: BENCH_ID, returnVariant: 'total_return', currencyCode: 'inr' },
  { id: BENCH_ID, returnVariant: null, currencyCode: 'INR' },
  { id: BENCH_ID, returnVariant: 'total_return', currencyCode: null },
  { id: BENCH_ID, returnVariant: 'price', currencyCode: 'AUD' },
];

function* entitlementGrid(): Generator<{ f: EntitlementFormState; row: Row }> {
  const longText = 'x'.repeat(501);
  for (const kind of ['public_use_permission', 'commercial_licence'] as const)
    for (const rights of rightsCombos())
      for (const row of CATALOGUE_ROWS)
        for (const pes of ['retain', 'delete', 'unknown', ''] as const)
          for (const url of ['', 'https://www.nseindices.com/terms', 'http://yahoofinance.com', 'example.org', `https://x.test/${'a'.repeat(500)}`])
            for (const ev of ['Licence 42', 'abc', longText])
              for (const dates of [
                { validFrom: '01-10-2026', validTo: '', dataFrom: '', dataTo: '', evidenceDocumentDate: '02/10/2026', evidenceRetrievedAt: '' },
                { validFrom: '01-10-2026', validTo: '30-09-2026', dataFrom: '01-01-2020', dataTo: '31-12-2019', evidenceDocumentDate: '', evidenceRetrievedAt: '03-10-2026' },
                { validFrom: '01-10-2026', validTo: '31-12-2026', dataFrom: '01-01-2000', dataTo: '31-12-2025', evidenceDocumentDate: '02-10-2026', evidenceRetrievedAt: '03-10-2026' },
              ]) {
                yield {
                  row,
                  f: { ...emptyEntitlementForm(), benchmarkKey: 'NIFTY50_TRI', kind, rights, postExpiryStorage: pes as never, evidenceUrl: url, evidenceReference: ev, ...dates },
                };
              }
  // Over-long free text (attribution 500, notes 1000) on otherwise good forms.
  for (const attributionText of ['', longText])
    for (const notes of ['', 'n'.repeat(1001)])
      yield {
        row: CATALOGUE_ROWS[0],
        f: { ...emptyEntitlementForm(), benchmarkKey: 'NIFTY50_TRI', kind: 'commercial_licence', rights: { ...emptyEntitlementForm().rights, ingestManual: true, storage: true }, validFrom: '01-10-2026', evidenceReference: 'Licence 42', attributionText, notes },
      };
}

/** States that pass `validate` but are refused downstream. Empty = the contract holds. */
function contractViolations(validate: Validator): string[] {
  const violations = new Set<string>();
  let checked = 0;
  for (const { f, row } of entitlementGrid()) {
    if (Object.keys(validate(f, row)).length > 0) continue; // the form refuses it: fine
    checked++;
    const body = buildEntitlementBody(f, row);
    const parsed = EntitlementBody.safeParse(body);
    if (!parsed.success) {
      for (const i of parsed.error.issues) violations.add(`schema:${i.path.join('.')}`);
      continue;
    }
    for (const r of databaseRefusals(body, row)) violations.add(`database:${r}`);
  }
  expect(checked, 'the grid must contain states that pass client validation, or the check proves nothing').toBeGreaterThan(200);
  return [...violations].sort();
}

describe('Entitlement form: no state passes client validation and fails the server schema or the database', () => {
  it('real validator: zero violations across the whole grid (both kinds x 64 right combinations x catalogue rows x ...)', () => {
    expect(contractViolations((f, row) => validateEntitlementForm(f, row))).toEqual([]);
  }, 120_000);

  // NAMED NEGATIVE CONTROLS: take the real validator and switch off ONE rule at a time (as it was before
  // this fix). The contract check must then name exactly the downstream refusal that rule prevents.
  it('NC-FORM-1: without the "manual ingestion needs storage" rule the database CHECK rights_coherent is hit', () => {
    const legacy: Validator = (f, row) => {
      const e = validateEntitlementForm(f, row);
      if (e.rights === 'Manual ingestion needs the storage right as well.') delete e.rights;
      return e;
    };
    expect(contractViolations(legacy)).toContain('database:ii_benchmark_entitlements_rights_coherent');
  });

  it('NC-FORM-2: without the "stored data after expiry" rule the empty choice reaches the schema enum', () => {
    const legacy: Validator = (f, row) => {
      const e = validateEntitlementForm(f, row);
      delete e.postExpiryStorage;
      return e;
    };
    expect(contractViolations(legacy)).toContain('schema:post_expiry_storage');
  });

  it('NC-FORM-3: without the catalogue-row check a benchmark with no variant/currency reaches the schema and database', () => {
    const legacy: Validator = (f) => validateEntitlementForm(f); // no row passed: the old behaviour
    const v = contractViolations(legacy);
    expect(v).toContain('schema:currency_code');
    expect(v).toContain('schema:return_variant');
  });

  it('NC-FORM-4: without the length rules over-long text reaches the schema', () => {
    const legacy: Validator = (f, row) => {
      const e = validateEntitlementForm(f, row);
      if (e.evidenceReference === 'Use at most 500 characters.') delete e.evidenceReference;
      if (e.attributionText) delete e.attributionText;
      if (e.evidenceUrl === 'The web address can be at most 500 characters.') delete e.evidenceUrl;
      return e;
    };
    const v = contractViolations(legacy);
    expect(v).toContain('schema:evidence_reference');
    expect(v).toContain('schema:attribution_text');
  });

  it('NC-FORM-5: the control itself can fail (a validator that refuses nothing is caught on every kind of rule)', () => {
    const v = contractViolations(() => ({}));
    expect(v.length).toBeGreaterThan(6);
    expect(v).toContain('database:ii_benchmark_entitlements_public_needs_evidence');
    expect(v).toContain('database:ii_benchmark_entitlements_term');
    expect(v).toContain('database:ii_benchmark_entitlements_data_range');
  }, 120_000);

  it('the database model matches migration 0241 (the constraints it transcribes are still there)', () => {
    const sql = readFileSync(path.join(ROOT, 'supabase/migrations/0241_bench1_phase2_benchmark_data_governance.sql'), 'utf8');
    expect(sql).toContain('constraint ii_benchmark_entitlements_term check (valid_to is null or valid_to >= valid_from)');
    expect(sql).toContain('constraint ii_benchmark_entitlements_data_range check (data_to is null or data_from is null or data_to >= data_from)');
    expect(sql).toContain('and (not allow_manual_ingest or allow_storage)');
    expect(sql).toContain('and (not allow_automation or allow_storage)');
    expect(sql).toContain('(not allow_calculation or allow_storage)');
    expect(sql).toContain('entitlement_kind <> \'public_use_permission\'');
    expect(sql).toContain('evidence_url is not null and evidence_retrieved_at is not null and evidence_document_date is not null');
    expect(sql).toContain('length(trim(evidence_reference)) >= 5');
    expect(sql).toContain("(p ->> 'return_variant') is distinct from b.return_variant");
  });
});

describe('Catalogue identity is sent exactly as the catalogue holds it', () => {
  it('a lower-case currency is not rewritten (the database compares for equality with the catalogue row)', () => {
    const f = { ...emptyEntitlementForm(), benchmarkKey: 'NIFTY50_TRI', kind: 'commercial_licence' as const, rights: { ...emptyEntitlementForm().rights, ingestManual: true, storage: true }, validFrom: '01-10-2026', evidenceReference: 'Licence 42' };
    expect(buildEntitlementBody(f, { id: BENCH_ID, returnVariant: 'total_return', currencyCode: 'inr' }).currency_code).toBe('inr');
    expect(buildEntitlementBody(f, { id: BENCH_ID, returnVariant: 'total_return', currencyCode: 'INR' }).currency_code).toBe('INR');
  });
  it('a catalogue row with no declared variant or currency is refused in the form, naming the Benchmark field', () => {
    const f = { ...emptyEntitlementForm(), benchmarkKey: 'NIFTY50_TRI', kind: 'commercial_licence' as const, rights: { ...emptyEntitlementForm().rights, storage: true }, validFrom: '01-10-2026', evidenceReference: 'Licence 42' };
    for (const row of [{ returnVariant: null, currencyCode: 'INR' }, { returnVariant: 'total_return' as const, currencyCode: null }, { returnVariant: 'total_return' as const, currencyCode: 'IN' }]) {
      expect(validateEntitlementForm(f, row).benchmarkKey).toMatch(/no declared return type or currency/);
    }
  });
});

describe('The reported screenshot: values that make the SERVER return 422', () => {
  // Evidence reference "2541abc2026", URL http://yahoofinance.com, document date 02/10/2026, retrieved date empty, valid from 01-10-2026.
  const screenshot = (kind: 'public_use_permission' | 'commercial_licence', rights: Partial<EntitlementFormState['rights']>) => ({
    ...emptyEntitlementForm(),
    benchmarkKey: 'NIFTY50_TRI',
    kind,
    rights: { ...emptyEntitlementForm().rights, ...rights },
    validFrom: '01-10-2026',
    evidenceReference: '2541abc2026',
    evidenceUrl: 'http://yahoofinance.com',
    evidenceDocumentDate: '02/10/2026',
    evidenceRetrievedAt: '',
  });
  const row: Row = { id: BENCH_ID, returnVariant: 'total_return', currencyCode: 'INR' };

  it('as a commercial licence with only "manual ingestion" ticked: the OLD client let it through and the database refused it (rights_coherent)', () => {
    const f = screenshot('commercial_licence', { ingestManual: true });
    const legacyErrors = (() => {
      const e = validateEntitlementForm(f, row);
      if (e.rights === 'Manual ingestion needs the storage right as well.') delete e.rights;
      return e;
    })();
    expect(legacyErrors).toEqual({});
    const body = buildEntitlementBody(f, row);
    expect(EntitlementBody.safeParse(body).success).toBe(true);
    expect(databaseRefusals(body, row)).toEqual(['ii_benchmark_entitlements_rights_coherent']);
    // The fixed client names the right field instead:
    expect(validateEntitlementForm(f, row)).toEqual({ rights: 'Manual ingestion needs the storage right as well.' });
  });

  it('as a public-use permission the retrieved-on date is flagged IN THE FORM, and so is the plain-http link', () => {
    const e = validateEntitlementForm(screenshot('public_use_permission', { ingestManual: true, storage: true }), row);
    expect(Object.keys(e).sort()).toEqual(['evidenceRetrievedAt', 'evidenceUrl']);
    expect(e.evidenceUrl).toMatch(/must start with https:\/\//);
    expect(e.evidenceRetrievedAt).toContain('DD-MM-YYYY');
  });

  it('the slash-typed date 02/10/2026 is accepted (it is not the failure)', () => {
    const e = validateEntitlementForm(screenshot('commercial_licence', { ingestManual: true, storage: true }), row);
    expect(e.evidenceDocumentDate).toBeUndefined();
    expect(e).toEqual({});
  });
});

describe('A blank Propose form flags EVERY missing required field at once', () => {
  it('kind not yet chosen: benchmark, kind, rights, valid from, evidence reference', () => {
    const e = validateEntitlementForm(emptyEntitlementForm());
    expect(Object.keys(e).sort()).toEqual(['benchmarkKey', 'evidenceReference', 'kind', 'rights', 'validFrom']);
  });

  it('public-use permission chosen: the https link, the document date and the retrieved-on date join the list', () => {
    const e = validateEntitlementForm({ ...emptyEntitlementForm(), kind: 'public_use_permission' });
    expect(Object.keys(e).sort()).toEqual(['benchmarkKey', 'evidenceDocumentDate', 'evidenceReference', 'evidenceRetrievedAt', 'evidenceUrl', 'rights', 'validFrom']);
    expect(e.evidenceUrl).toContain('required for a public-use permission');
  });

  it('commercial licence chosen: the evidence URL and dates stay optional', () => {
    const e = validateEntitlementForm({ ...emptyEntitlementForm(), kind: 'commercial_licence' });
    expect(Object.keys(e).sort()).toEqual(['benchmarkKey', 'evidenceReference', 'rights', 'validFrom']);
  });

  it('nothing is pre-filled except "stored data after expiry" (Not stated); in particular Valid from starts empty', () => {
    const f = emptyEntitlementForm();
    expect(f.validFrom).toBe('');
    expect(f.kind).toBe('');
    expect(f.benchmarkKey).toBe('');
    expect(f.postExpiryStorage).toBe('unknown');
    expect(Object.values(f.rights).every((v) => v === false)).toBe(true);
  });

  it('validation never stops at the first error: a form wrong in ten ways reports ten fields', () => {
    const e = validateEntitlementForm(
      { ...emptyEntitlementForm(), kind: 'public_use_permission', validFrom: 'x', validTo: 'y', dataFrom: 'z', dataTo: 'w', evidenceReference: 'a', evidenceUrl: 'ftp://nope', evidenceDocumentDate: 'q', evidenceRetrievedAt: 'r', postExpiryStorage: '' as never },
    );
    expect(Object.keys(e).sort()).toEqual(['benchmarkKey', 'dataFrom', 'dataTo', 'evidenceDocumentDate', 'evidenceReference', 'evidenceRetrievedAt', 'evidenceUrl', 'postExpiryStorage', 'rights', 'validFrom', 'validTo']);
  });
});

describe('Catalogue and mapping forms: no state passes client validation and fails the server schema', () => {
  const goodCat = () => ({ ...emptyCatalogueForm(), benchmarkKey: 'NIFTY50_TRI', officialName: 'Nifty 50 TRI', ownerName: 'NSE', assetClass: 'equity', countryCode: 'in', currencyCode: 'inr', returnType: 'TRI', returnVariant: 'total_return' as const, evidenceRef: 'NSE factsheet', evidenceRetrievedAt: '30-09-2026' });
  const goodMap = () => ({ ...emptyMappingForm(), instrumentId: '33333333-3333-4333-8333-333333333333', proposedBenchmarkName: 'Nifty 50 TRI', effectiveFrom: '01-01-2024', evidenceSource: 'amc_sid', evidenceUrl: 'https://example.org/sid.pdf', evidenceDocumentDate: '01-01-2024', evidenceRetrievedAt: '01-09-2026', resolutionMethod: 'deterministic_exact', confidence: 'high' });

  const catalogueMutations: Array<Partial<ReturnType<typeof goodCat>>> = [
    {}, { label: 'A' }, { label: 'AB' }, { label: 'x'.repeat(201) }, { officialName: 'x' }, { officialName: 'x'.repeat(201) }, { ownerName: 'x'.repeat(201) },
    { officialIdentifier: 'x'.repeat(101) }, { calendarCode: 'x'.repeat(41) }, { evidenceRef: 'abcd' }, { evidenceRef: 'x'.repeat(501) },
    { methodologyUrl: 'ftp://x' }, { methodologyUrl: `https://x.test/${'a'.repeat(500)}` }, { sourceUrl: 'https://ok.example/page' }, { sourceUrl: 'not a url' },
    { baseValue: '0' }, { baseValue: '-5' }, { baseValue: '1234.5' }, { baseValue: 'abc' }, { baseDate: '31-02-2026' }, { baseDate: '03-01-1996' },
    { countryCode: 'i' }, { countryCode: 'ind' }, { currencyCode: 'in' }, { currencyCode: 'inrr' }, { historyClass: 'backtested' }, { historyClass: 'backtested', backtestedThrough: '30-06-2020' },
    { evidenceRetrievedAt: '' }, { evidenceRetrievedAt: '2026-09-30' },
  ];
  it('catalogue: every mutated state is refused by the form or accepted by CatalogueBody', () => {
    let accepted = 0;
    for (const m of catalogueMutations) {
      const f = { ...goodCat(), ...m };
      if (Object.keys(validateCatalogueForm(f)).length > 0) continue;
      accepted++;
      const parsed = CatalogueBody.safeParse(buildCatalogueBody(f));
      expect(parsed.success, JSON.stringify(m) + ' ' + (parsed.success ? '' : JSON.stringify(parsed.error.issues.map((i) => i.path.join('.'))))).toBe(true);
    }
    expect(accepted).toBeGreaterThanOrEqual(5);
  });

  const mappingMutations: Array<Partial<ReturnType<typeof goodMap>>> = [
    {}, { proposedBenchmarkName: 'ab' }, { proposedBenchmarkName: 'x'.repeat(201) }, { evidenceTitle: 'x'.repeat(301) }, { ambiguityReason: 'x'.repeat(401) }, { evidenceExcerpt: 'x'.repeat(401) },
    { evidenceUrl: 'https://example.org/' + 'a'.repeat(500) }, { evidenceUrl: 'ftp://x.org/doc' }, { effectiveTo: '31-12-2023' }, { effectiveTo: '31-12-2030' }, { instrumentId: 'abc' },
    { evidenceSource: 'blog' }, { confidence: 'certain' }, { resolutionMethod: 'guess' }, { effectiveFrom: '' },
  ];
  it('mapping: every mutated state is refused by the form or accepted by MappingBody', () => {
    let accepted = 0;
    for (const m of mappingMutations) {
      const f = { ...goodMap(), ...m };
      if (Object.keys(validateMappingForm(f)).length > 0) continue;
      accepted++;
      const parsed = MappingBody.safeParse(buildMappingBody(f, null));
      expect(parsed.success, JSON.stringify(m)).toBe(true);
    }
    expect(accepted).toBeGreaterThanOrEqual(2);
  });

  it('NC-FORM-6: without the new length rules an over-long display label reaches the schema (the control can fail)', () => {
    const f = { ...goodCat(), label: 'A' };
    const legacyErrors = validateCatalogueForm(f);
    delete legacyErrors.label;
    expect(Object.keys(legacyErrors)).toEqual([]);
    expect(CatalogueBody.safeParse(buildCatalogueBody(f)).success).toBe(false);
  });
});
