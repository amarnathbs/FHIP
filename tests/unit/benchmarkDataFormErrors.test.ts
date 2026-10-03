// Market Index Data: per-field error mapping (pure) and the static render contract for invalid fields.
//
// A rejected form must show WHICH fields are wrong: red outline + red sentence under each field,
// aria-invalid / aria-describedby for assistive technology, one summary at the top of the form whose
// entries focus the field, the first invalid field scrolled to and focused, a banner INSIDE the form for
// errors that belong to no field. Nothing is dropped: an API path with no field on the form still shows
// in the summary. Decisions live in benchmarkDataFormErrors.ts; this file proves them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogueBody, EntitlementBody, MappingBody, StageParams } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import {
  CATALOGUE_DATE_KEYS,
  DATE_WORDS,
  CATALOGUE_FIELD_LABELS,
  CATALOGUE_FIELD_MAP,
  CATALOGUE_FIELD_ORDER,
  ENTITLEMENT_DATE_KEYS,
  ENTITLEMENT_FIELD_LABELS,
  ENTITLEMENT_FIELD_MAP,
  ENTITLEMENT_FIELD_ORDER,
  INGESTION_FIELD_MAP,
  INGESTION_FIELD_ORDER,
  MAPPING_FIELD_LABELS,
  MAPPING_FIELD_MAP,
  MAPPING_FIELD_ORDER,
  NOTE_FIELD_MAP,
  UPLOAD_FIELD_MAP,
  UPLOAD_FIELD_ORDER,
  UPLOAD_FIELD_STEP,
  buildSummary,
  firstInvalidKey,
  humanizePath,
  mapServerFields,
  serverFields,
  type FieldMap,
} from '@/components/admin/benchmarkData/benchmarkDataFormErrors';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('serverFields: only plain, short, safe sentences survive', () => {
  it('reads the `fields` map of a 422 body', () => {
    expect(serverFields({ error: 'x', fields: { valid_from: 'Enter a valid date.', evidence_reference: 'This is required.' } })).toEqual({ valid_from: 'Enter a valid date.', evidence_reference: 'This is required.' });
  });
  it('null for no map, a non-object body, an array, or only unusable entries', () => {
    expect(serverFields(null)).toBeNull();
    expect(serverFields('x')).toBeNull();
    expect(serverFields({ error: 'x' })).toBeNull();
    expect(serverFields({ fields: ['a'] })).toBeNull();
    expect(serverFields({ fields: { a: 5, b: '', c: '   ' } })).toBeNull();
  });
  it('engine text and over-long strings are dropped, never shown', () => {
    expect(serverFields({ fields: { a: 'new row violates check constraint "x"', b: 'relation "t" does not exist', c: 'x'.repeat(400), d: 'Fine sentence.' } })).toEqual({ d: 'Fine sentence.' });
  });
});

describe('mapServerFields: API paths -> form field keys', () => {
  it('maps snake_case API names to the form keys', () => {
    const m = mapServerFields({ valid_from: 'Enter a valid date.', evidence_reference: 'Enter at least 5 characters.', entitlement_kind: 'Choose one of the listed options.' }, ENTITLEMENT_FIELD_MAP, ENTITLEMENT_DATE_KEYS);
    expect(Object.keys(m.errors).sort()).toEqual(['evidenceReference', 'kind', 'validFrom']);
    expect(m.errors.evidenceReference).toBe('Enter at least 5 characters.');
    expect(m.unmapped).toEqual([]);
  });

  it('the date words match the client validators exactly', async () => {
    const { DATE_TYPING_HELP } = await import('@/components/admin/benchmarkData/benchmarkDataUiLogic');
    expect(DATE_WORDS).toBe(DATE_TYPING_HELP);
  });

  it('a date field always names the day-first format in words (the server cannot know the screen)', () => {
    const m = mapServerFields({ valid_from: 'Enter a valid date.', evidence_retrieved_at: 'This is required.' }, ENTITLEMENT_FIELD_MAP, ENTITLEMENT_DATE_KEYS);
    for (const k of ['validFrom', 'evidenceRetrievedAt']) {
      expect(m.errors[k]).toContain('DD-MM-YYYY');
      expect(m.errors[k]).toContain('01-10-2026');
      expect(m.errors[k]).not.toMatch(/YYYY-MM-DD|MM\/DD/);
    }
  });

  it('several rights fields collapse onto the one Rights field; the benchmark identity paths onto the Benchmark field with a plain sentence', () => {
    const m = mapServerFields({ allow_storage: 'x', allow_manual_ingest: 'y', return_variant: 'This is required.', currency_code: 'This is required.' }, ENTITLEMENT_FIELD_MAP, ENTITLEMENT_DATE_KEYS);
    expect(m.errors.rights).toBe('x');
    expect(m.errors.benchmarkKey).toMatch(/no declared return type or currency/);
  });

  it('nested upload paths map onto their field (columnMap.date -> the Date column)', () => {
    const m = mapServerFields({ 'columnMap.date': 'Use at most 100 characters.', sourceOwner: 'Enter at least 2 characters.', dataAsOf: 'Enter a valid date.' }, UPLOAD_FIELD_MAP);
    expect(Object.keys(m.errors).sort()).toEqual(['dataAsOf', 'dateColumn', 'sourceOwner']);
  });

  it('NEGATIVE CONTROL FE-NC-1: a path with no field on the form is NOT dropped; it is listed in the summary under its own readable name', () => {
    const m = mapServerFields({ valid_from: 'Enter a valid date.', source_id: 'This identifier is not valid.' }, ENTITLEMENT_FIELD_MAP, ENTITLEMENT_DATE_KEYS);
    expect(m.unmapped).toEqual([{ path: 'source_id', message: 'This identifier is not valid.' }]);
    const items = buildSummary(m.errors, m.unmapped, ENTITLEMENT_FIELD_LABELS, ENTITLEMENT_FIELD_ORDER);
    expect(items.map((i) => i.label)).toEqual(['Valid from', 'Source id']);
    expect(items[1]).toEqual({ key: null, label: 'Source id', message: 'This identifier is not valid.' });
    // The control: a summary built WITHOUT the unmapped list (the dropping behaviour) loses the error. The assertion above is what catches it.
    const dropping = buildSummary(m.errors, [], ENTITLEMENT_FIELD_LABELS, ENTITLEMENT_FIELD_ORDER);
    expect(dropping.map((i) => i.label)).toEqual(['Valid from']);
    expect(dropping.length).toBeLessThan(items.length);
  });

  it('NEGATIVE CONTROL FE-NC-2: removing one entry from a field map turns that error into an unmapped summary line, not silence', () => {
    const { valid_to: _removed, ...withoutValidTo } = ENTITLEMENT_FIELD_MAP as Record<string, string | { key: string; message?: string }>;
    void _removed;
    const m = mapServerFields({ valid_to: 'Enter a valid date.' }, withoutValidTo as FieldMap, ENTITLEMENT_DATE_KEYS);
    expect(m.errors).toEqual({});
    expect(buildSummary(m.errors, m.unmapped, ENTITLEMENT_FIELD_LABELS, ENTITLEMENT_FIELD_ORDER)).toEqual([{ key: null, label: 'Valid to', message: 'Enter a valid date.' }]);
  });
});

describe('buildSummary and firstInvalidKey', () => {
  it('entries follow the form order, not the arrival order', () => {
    const items = buildSummary({ evidenceReference: 'b', validFrom: 'a', kind: 'k' }, [], ENTITLEMENT_FIELD_LABELS, ENTITLEMENT_FIELD_ORDER);
    expect(items.map((i) => i.key)).toEqual(['kind', 'validFrom', 'evidenceReference']);
    expect(items.map((i) => i.label)).toEqual(['Kind of permission', 'Valid from', 'Evidence reference']);
  });
  it('an error for a key outside the declared order is still listed (never dropped)', () => {
    const items = buildSummary({ somethingNew: 'oops' }, [], ENTITLEMENT_FIELD_LABELS, ENTITLEMENT_FIELD_ORDER);
    expect(items).toEqual([{ key: 'somethingNew', label: 'Something new', message: 'oops' }]);
  });
  it('the first invalid field is the earliest in the form order; none when there are no errors', () => {
    expect(firstInvalidKey({ evidenceReference: 'x', validFrom: 'y' }, ENTITLEMENT_FIELD_ORDER)).toBe('validFrom');
    expect(firstInvalidKey({}, ENTITLEMENT_FIELD_ORDER)).toBeNull();
    expect(firstInvalidKey({ weird: 'x' }, ENTITLEMENT_FIELD_ORDER)).toBe('weird');
    expect(firstInvalidKey({ a: '' }, ENTITLEMENT_FIELD_ORDER)).toBeNull();
  });
  it('humanizePath reads like a label', () => {
    expect(humanizePath('valid_from')).toBe('Valid from');
    expect(humanizePath('columnMap.date')).toBe('Date');
    expect(humanizePath('evidenceRetrievedAt')).toBe('Evidence retrieved at');
  });
});

describe('every API field a schema can reject has a place on its form (or is knowingly unmapped)', () => {
  const keysOf = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape);
  it('entitlement: all EntitlementBody keys except the optional source link are mapped', () => {
    const unmapped = keysOf(EntitlementBody).filter((k) => !(k in ENTITLEMENT_FIELD_MAP));
    expect(unmapped.sort()).toEqual(['post_expiry_calculation', 'post_expiry_display', 'source_id']);
  });
  it('catalogue: every CatalogueBody key except the two the form never sends is mapped', () => {
    const unmapped = keysOf(CatalogueBody).filter((k) => !(k in CATALOGUE_FIELD_MAP));
    expect(unmapped.sort()).toEqual(['benchmark_category', 'frequency']);
  });
  it('mapping: every MappingBody key is mapped', () => {
    expect(keysOf(MappingBody).filter((k) => !(k in MAPPING_FIELD_MAP))).toEqual([]);
  });
  it('upload: every StageParams key the form sets is mapped (the rest are derived by the page)', () => {
    const unmapped = keysOf((StageParams as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def.schema).filter((k) => !(k in UPLOAD_FIELD_MAP) && !k.startsWith('columnMap'));
    expect(unmapped.sort()).toEqual(['includeHiddenRows', 'indexNameToKey', 'originalFileName']);
  });
  it('note and ingestion forms map their schema keys', () => {
    for (const k of ['note', 'reason']) expect(k in NOTE_FIELD_MAP).toBe(true);
    for (const k of ['mode', 'sourceKey', 'adapterId', 'automationEnabled', 'publicationLagDays', 'reason']) expect(k in INGESTION_FIELD_MAP).toBe(true);
  });
  it('every mapped form key has a label and sits in the form order (so it is both listed and focusable)', () => {
    for (const [map, labels, order] of [
      [ENTITLEMENT_FIELD_MAP, ENTITLEMENT_FIELD_LABELS, ENTITLEMENT_FIELD_ORDER],
      [CATALOGUE_FIELD_MAP, CATALOGUE_FIELD_LABELS, CATALOGUE_FIELD_ORDER],
      [MAPPING_FIELD_MAP, MAPPING_FIELD_LABELS, MAPPING_FIELD_ORDER],
    ] as Array<[FieldMap, Record<string, string>, readonly string[]]>) {
      for (const v of Object.values(map)) {
        const key = typeof v === 'string' ? v : v.key;
        expect(order, key).toContain(key);
        expect(labels[key], key).toBeTruthy();
      }
    }
    for (const k of ENTITLEMENT_DATE_KEYS) expect(ENTITLEMENT_FIELD_ORDER as readonly string[]).toContain(k);
    for (const k of CATALOGUE_DATE_KEYS) expect(CATALOGUE_FIELD_ORDER as readonly string[]).toContain(k);
  });
  it('every upload field in the order has a wizard step to switch to', () => {
    for (const k of UPLOAD_FIELD_ORDER) expect(UPLOAD_FIELD_STEP[k], k).toBeGreaterThanOrEqual(1);
    void INGESTION_FIELD_ORDER;
  });
});

// ------------------------------------------------------------------------------------------ source contract
const UI = read('components/admin/benchmarkData/ui.tsx');
const FEEDBACK = read('components/admin/benchmarkData/formFeedback.tsx');
const TABS: Record<string, string> = Object.fromEntries(['EntitlementsTab', 'CatalogueTab', 'MappingsTab', 'IngestionTab', 'UploadTab'].map((n) => [n, read(`components/admin/benchmarkData/${n}.tsx`)]));

/** Violations of the invalid-field render contract in the given sources (empty = the contract holds). */
function renderContractViolations(ui: string, feedback: string, tabs: Record<string, string>): string[] {
  const out: string[] = [];
  for (const fn of ['TextField', 'DateField', 'TextAreaField', 'SelectField']) {
    const start = ui.indexOf(`export function ${fn}(`);
    const block = ui.slice(start, ui.indexOf('\nexport ', start + 10));
    if (!/aria-invalid=\{error \? true : undefined\}/.test(block)) out.push(`${fn}: no aria-invalid`);
    if (!/aria-describedby=\{describedBy\(/.test(block)) out.push(`${fn}: no aria-describedby`);
    if (!/-error`/.test(block)) out.push(`${fn}: the error id is not referenced by aria-describedby`);
    if (!/className=\{inputClass\(error\)\}/.test(block)) out.push(`${fn}: no error styling`);
    if (!/data-field-key=\{fieldKey\}/.test(block)) out.push(`${fn}: not focusable by field key`);
  }
  if (!/error \? 'border-risk ring-1 ring-risk'/.test(ui)) out.push('ui: no red border/ring for an invalid input');
  if (!/FieldShell[\s\S]*?id=\{`\$\{id\}-error`\} role="alert" className="mt-1 text-xs font-medium text-risk"/.test(ui)) out.push('ui: no red message under the field');
  if (!/export function CheckField[\s\S]*?aria-invalid/.test(ui)) out.push('CheckField: no aria-invalid');
  if (!/export function RadioGroup[\s\S]*?aria-invalid/.test(ui)) out.push('RadioGroup: no aria-invalid');
  if (!feedback.includes('These fields need fixing:')) out.push('feedback: no summary heading');
  if (!/href=\{`#field-\$\{it\.key\}`\}/.test(feedback) || !/e\.preventDefault\(\)/.test(feedback)) out.push('feedback: summary entries are not links that focus the field');
  if (!feedback.includes('revealScrollBehavior(prefersReducedMotion())')) out.push('feedback: scroll is not reduced-motion aware');
  if (!feedback.includes('el.focus({ preventScroll: true })')) out.push('feedback: the first invalid field is not focused');
  if (!/role="alert" tabIndex=\{-1\}/.test(feedback)) out.push('feedback: summary/banner not announced');
  const need: Record<string, readonly string[]> = {
    EntitlementsTab: ENTITLEMENT_FIELD_ORDER,
    CatalogueTab: CATALOGUE_FIELD_ORDER,
    MappingsTab: MAPPING_FIELD_ORDER,
    IngestionTab: ['mode', 'adapterId', 'sourceKey', 'publicationLagDays', 'automationEnabled', 'reason'],
    UploadTab: ['benchmarkKey', 'returnVariant', 'currencyCode', 'sourceOwner', 'sourceReference', 'dataAsOf', 'historyClass', 'mode', 'dateFormat', 'numberLocale', 'headerRow'],
  };
  for (const [tab, keys] of Object.entries(need)) {
    const src = tabs[tab];
    if (!src.includes('<FormFeedback')) out.push(`${tab}: no FormFeedback (summary + in-form banner)`);
    if (!/data-form=\{fb\w*\.formId\}/.test(src)) out.push(`${tab}: no form wrapper for focusing`);
    for (const k of keys) {
      if (k === 'rights') {
        if (!/data-field-key="rights"/.test(src)) out.push(`${tab}: Rights group not focusable`);
        continue;
      }
      if (!new RegExp(`fieldKey="${k}"`).test(src)) out.push(`${tab}: field ${k} has no fieldKey (cannot be outlined or focused)`);
    }
  }
  return out;
}

describe('invalid fields render with error styling, aria-invalid and aria-describedby (static contract)', () => {
  it('the field components, the summary and every form wire it all up', () => {
    expect(renderContractViolations(UI, FEEDBACK, TABS)).toEqual([]);
  });

  it('a non-field error is a banner INSIDE the form (the same FormFeedback as the summary), not only the page banner', () => {
    expect(FEEDBACK).toMatch(/fb\.banner \? \(/);
    expect(FEEDBACK).toContain('This could not be saved');
    for (const [name, src] of Object.entries(TABS)) expect(src, name).toContain('<FormFeedback');
  });

  it('every submit routes a server failure through the form feedback (nothing swallowed into the page banner alone)', () => {
    for (const [name, src] of Object.entries(TABS)) {
      if (name === 'UploadTab') expect(src).toContain('fb.showServerFailure(r.body');
      else expect(src, name).toMatch(/showServerFailure\(/);
    }
  });

  // NEGATIVE CONTROLS: break one thing in the real sources; the contract must name it.
  it('FIELD-NC-1: a field component that stops setting aria-invalid is caught', () => {
    const mutated = UI.replace(/(export function TextField[\s\S]*?)aria-invalid=\{error \? true : undefined\}/, '$1');
    expect(renderContractViolations(mutated, FEEDBACK, TABS)).toContain('TextField: no aria-invalid');
  });
  it('FIELD-NC-2: the red border removed is caught', () => {
    const mutated = UI.replace("error ? 'border-risk ring-1 ring-risk' : 'border-line'", "'border-line'");
    expect(renderContractViolations(mutated, FEEDBACK, TABS)).toContain('ui: no red border/ring for an invalid input');
  });
  it('FIELD-NC-3: a form field with no fieldKey is caught (it could never be outlined or focused)', () => {
    const mutated = { ...TABS, EntitlementsTab: TABS.EntitlementsTab.replace('fieldKey="validFrom"', '') };
    expect(renderContractViolations(UI, FEEDBACK, mutated)).toContain('EntitlementsTab: field validFrom has no fieldKey (cannot be outlined or focused)');
  });
  it('FIELD-NC-4: a summary that is not a focusing link, or a scroll that ignores reduced motion, is caught', () => {
    expect(renderContractViolations(UI, FEEDBACK.replace('e.preventDefault();', ''), TABS)).toContain('feedback: summary entries are not links that focus the field');
    expect(renderContractViolations(UI, FEEDBACK.replace('revealScrollBehavior(prefersReducedMotion())', "'smooth'"), TABS)).toContain('feedback: scroll is not reduced-motion aware');
  });
  it('FIELD-NC-5: the clean sources report nothing (the controls above are not noise)', () => {
    expect(renderContractViolations(UI, FEEDBACK, TABS)).toEqual([]);
  });
});

describe('required markers: the entitlement form says what is required, and for whom', () => {
  const ent = TABS.EntitlementsTab;
  it('Valid from, Evidence reference, Benchmark and Kind carry the (required) marker; Rights says tick at least one', () => {
    expect(ent).toMatch(/<DateField label="Valid from" required /);
    expect(ent).toMatch(/<TextField label="Evidence reference" required /);
    expect(ent).toMatch(/<SelectField label="Benchmark" required /);
    expect(ent).toMatch(/<SelectField label="Kind of permission" required /);
    expect(ent).toContain('(required: tick at least one)');
  });
  it('the evidence URL and dates are required for a public-use permission and say so when they are not yet required', () => {
    expect(ent.match(/'optional; required for a public-use permission'/g)?.length).toBe(3);
    expect(UI).toMatch(/typeof required === 'string' && required \? <span className="text-muted"> \(\{required\}\)<\/span>/);
  });
});
