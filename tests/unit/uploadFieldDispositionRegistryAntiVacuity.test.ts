/**
 * Anti-vacuity controls for the upload field-disposition gate (WP-00).
 *
 * A green gate is indistinguishable from one that checks nothing. Each control
 * here feeds the SAME checker a deliberately broken input -- an injected
 * orphan field, a removed entry, a stale column, an injected enum value, a
 * broken parser -- and asserts the exact NAMED failure, never just "throws".
 * The unmodified baseline is asserted clean first, so every failure below is
 * caused by the one change the control makes.
 *
 * ORACLE (plan WP-00): adding `fooOrphan?: number` to an in-memory
 * PayrollExtraction produces 'payslip_native.fooOrphan has no disposition'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { REGISTRY_FILES, renderRegistryMarkdown, type FieldDispositionEntry, type RegistryFile } from '@/lib/canonical-data/disposition';
import { checkRegistry, loadGapRegister, parseGapRegister, type EnumeratedSource } from './helpers/dispositionChecker';
import { REPO_ROOT, SOURCES, enumerateAll, interfaceProperties, replayColumns, migrationLedger, resolveSourceFile } from './helpers/dispositionSources';

const gapRegister = loadGapRegister();
const baseline = enumerateAll();
const check = (files: readonly RegistryFile[] = REGISTRY_FILES, enumerated: readonly EnumeratedSource[] = baseline) =>
  checkRegistry(files, enumerated, { gapRegister, strict: false }).map((v) => v.message);

/** The enumeration with ONE source's keys replaced. */
function withSource(sourceRef: string, keys: string[]): EnumeratedSource[] {
  const hit = baseline.some((e) => e.source.sourceRef === sourceRef);
  if (!hit) throw new Error(`no source ${sourceRef}`);
  return baseline.map((e) => (e.source.sourceRef === sourceRef ? { source: e.source, keys } : e));
}

/** A deep-enough clone of the registry with one file's entries transformed. */
function withEntries(fileId: string, transform: (entries: FieldDispositionEntry[]) => FieldDispositionEntry[], ceilingDelta = 0): RegistryFile[] {
  return REGISTRY_FILES.map((f) => (f.id === fileId ? { ...f, OPEN_GAP_CEILING: f.OPEN_GAP_CEILING + ceilingDelta, entries: transform(f.entries.map((e) => ({ ...e }))) } : f));
}

describe('baseline', () => {
  it('the unmodified registry and tree produce zero violations (so each control below is attributable)', () => {
    expect(check()).toEqual([]);
  });
});

describe('(i) injected orphan property', () => {
  it("adding `fooOrphan?: number` to an in-memory PayrollExtraction fails with 'payslip_native.fooOrphan has no disposition'", () => {
    const ref = 'fdh:payslip/types.ts#PayrollExtraction';
    const real = fs.readFileSync(resolveSourceFile(ref), 'utf8');
    const injected = real.replace('export interface PayrollExtraction {', 'export interface PayrollExtraction {\n  fooOrphan?: number;');
    expect(injected).not.toBe(real); // the injection really happened
    const source = SOURCES.find((s) => s.sourceRef === ref)!;
    const keys = source.enumerate({ sourceText: injected });
    expect(keys).toContain('fooOrphan');
    expect(check(REGISTRY_FILES, withSource(ref, keys))).toEqual([
      'R1 orphan: payslip_native.fooOrphan has no disposition (fdh:payslip/types.ts#PayrollExtraction)',
    ]);
  });

  it('an orphan key on an AI-fallback zod schema is caught the same way', () => {
    const ref = 'aie:bankStatement/schema.ts#bankStatementTransactionSchema';
    const keys = [...baseline.find((e) => e.source.sourceRef === ref)!.keys, 'merchantCategory'];
    expect(check(REGISTRY_FILES, withSource(ref, keys))).toEqual([
      'R1 orphan: bank_ai_draft.merchantCategory has no disposition (aie:bankStatement/schema.ts#bankStatementTransactionSchema)',
    ]);
  });

  it('a column added by a NEW migration is caught (ledger replay, not a hand list)', () => {
    const source = SOURCES.find((s) => s.sourceRef === 'db:fdh_transactions')!;
    const keys = source.enumerate({ sourceText: 'alter table fdh_transactions add column if not exists foo_orphan_col text;' });
    expect(keys).toContain('foo_orphan_col');
    expect(check(REGISTRY_FILES, withSource('db:fdh_transactions', keys))).toEqual([
      'R1 orphan: bank_ledger.foo_orphan_col has no disposition (db:fdh_transactions)',
    ]);
  });
});

describe('(ii) removed entry', () => {
  it("removing bank_csv.amountOriginal fails with R1 naming it", () => {
    const files = withEntries('bankStatement', (es) => es.filter((e) => !(e.adapter === 'bank_csv' && e.field === 'amountOriginal')));
    expect(check(files)).toEqual(['R1 orphan: bank_csv.amountOriginal has no disposition (fdh:bank-csv/normalize.ts#NormalizedTransactionCandidate)']);
  });

  it('a duplicated entry is also R1', () => {
    const files = withEntries('payslip', (es) => [...es, { ...es.find((e) => e.field === 'grossPay')! }]);
    expect(check(files)).toEqual(['R1 duplicate: payslip_native.grossPay has 2 dispositions (fdh:payslip/types.ts#PayrollExtraction)']);
  });
});

describe('(iii) stale entry', () => {
  it('an entry for a column that does not exist fails with R2', () => {
    const files = withEntries('bankStatement', (es) => [...es, { ...es.find((e) => e.sourceRef === 'db:fdh_transactions')!, field: 'not_a_column' }]);
    expect(check(files)).toEqual(['R2 stale: bank_ledger.not_a_column no longer exists in db:fdh_transactions']);
  });

  it('a column DROPPED by a later migration makes its entry stale', () => {
    const source = SOURCES.find((s) => s.sourceRef === 'db:fdh_transactions')!;
    const keys = source.enumerate({ sourceText: 'alter table fdh_transactions drop column if exists merchant_raw;' });
    expect(keys).not.toContain('merchant_raw');
    // Both the stale entry AND the floor fire: floors are the exact current
    // counts, so a column that disappears can never go unnoticed.
    expect(check(REGISTRY_FILES, withSource('db:fdh_transactions', keys))).toEqual([
      'R8 floor: bank_ledger db:fdh_transactions enumerated 47 keys, floor is 48',
      'R2 stale: bank_ledger.merchant_raw no longer exists in db:fdh_transactions',
    ]);
  });
});

describe('(iv) injected enum value', () => {
  it('a synthetic LIABILITY_ACTIVITY_TYPES value fails with R1 naming it', () => {
    const source = SOURCES.find((s) => s.sourceRef === 'enum:LIABILITY_ACTIVITY_TYPES')!;
    const keys = source.enumerate({ values: [...source.enumerate(), 'SYNTHETIC_TYPE'] });
    expect(check(REGISTRY_FILES, withSource('enum:LIABILITY_ACTIVITY_TYPES', keys))).toEqual([
      'R1 orphan: liability_ledger.SYNTHETIC_TYPE has no disposition (enum:LIABILITY_ACTIVITY_TYPES)',
    ]);
  });

  it('a new economic_transaction_type value fails with R1 naming it', () => {
    const keys = [...baseline.find((e) => e.source.sourceRef === 'enum:FDH_ECONOMIC_TRANSACTION_TYPES')!.keys, 'liability_settlement'];
    expect(check(REGISTRY_FILES, withSource('enum:FDH_ECONOMIC_TRANSACTION_TYPES', keys))).toEqual([
      'R1 orphan: economic_type.liability_settlement has no disposition (enum:FDH_ECONOMIC_TRANSACTION_TYPES)',
    ]);
  });
});

describe('(v) the enumerators really enumerate (floors)', () => {
  it('every source enumerates more than zero keys and at least its floor; the total is non-trivial', () => {
    let total = 0;
    for (const { source, keys } of baseline) {
      expect(keys.length, source.sourceRef).toBeGreaterThan(0);
      expect(keys.length, source.sourceRef).toBeGreaterThanOrEqual(source.floor);
      total += keys.length;
    }
    expect(total).toBeGreaterThanOrEqual(880);
  });

  it('a parser that silently finds nothing fails with R8, not a pass', () => {
    const emptied = baseline.map((e) => (e.source.sourceRef === 'db:fdh_payroll_events' ? { source: e.source, keys: [] as string[] } : e));
    const messages = check(REGISTRY_FILES, emptied);
    expect(messages).toContain('R8 floor: payslip_native db:fdh_payroll_events enumerated 0 keys, floor is 56');
  });

  it('a renamed interface is a loud error, not an empty list', () => {
    const real = fs.readFileSync(resolveSourceFile('fdh:payslip/types.ts#PayrollExtraction'), 'utf8');
    expect(() => interfaceProperties(real.replace('interface PayrollExtraction', 'interface PayrollExtractionV2'), 'PayrollExtraction')).toThrow(/interface PayrollExtraction not found/);
  });

  it('the ledger replay agrees with an independent substring count for a sample table', () => {
    // fdh_payroll_components is created once (0091) and never altered: its
    // column count must equal the number of lines in that CREATE block that
    // start with a column name.
    const cols = replayColumns(migrationLedger(), ['fdh_payroll_components']).fdh_payroll_components;
    const sql = migrationLedger().find((m) => m.name.startsWith('0091_'))!.sql;
    const block = sql.slice(sql.indexOf('create table fdh_payroll_components ('));
    const body = block.slice(0, block.indexOf('\n);'));
    const colLines = body.split('\n').slice(1).filter((l) => /^\s{2}[a-z_]+\s+(uuid|text|numeric|boolean|timestamptz|date|int|char)/.test(l));
    expect(cols).toHaveLength(colLines.length);
  });
});

describe('the other rules bite (named failures)', () => {
  it('R3: a compliant evidence entry with no user-visible place', () => {
    const files = withEntries('iiCas', (es) => es.map((e) => (e.field === 'holderName' ? { ...e, userVisibleAt: null } : e)));
    expect(check(files)).toEqual(['R3 invisible: ii_cas.holderName (ii:parsers/types.ts#ParsedAccountRecord) is C_EVIDENCE but has no userVisibleAt']);
  });

  it('R4: a state entry that lands in an FDH evidence table instead of a canonical register', () => {
    const files = withEntries('payslip', (es) => es.map((e) => (e.adapter === 'payslip_native' && e.field === 'grossPay' ? { ...e, destination: 'fdh_payroll_events.gross_pay' } : e)));
    expect(check(files)).toEqual(['R4 non-canonical destination: payslip_native.grossPay (fdh:payslip/types.ts#PayrollExtraction) -> fdh_payroll_events.gross_pay']);
  });

  it('R5: an open gap naming an id the matrix does not have, or the wrong severity', () => {
    const unknown = withEntries('payslip', (es) => es.map((e) => (e.adapter === 'payslip_native' && e.field === 'basePay' ? { ...e, gapId: 'GAP-99' } : e)));
    expect(check(unknown)).toEqual(['R5 unknown gap: payslip_native.basePay (fdh:payslip/types.ts#PayrollExtraction) names GAP-99, which is not in the matrix gap register']);
    const wrongSev = withEntries('payslip', (es) => es.map((e) => (e.adapter === 'payslip_native' && e.field === 'basePay' ? { ...e, severity: 'P0' as const } : e)));
    expect(check(wrongSev)).toEqual(['R5 severity mismatch: payslip_native.basePay (fdh:payslip/types.ts#PayrollExtraction) says GAP-07 is P0, the matrix says P2']);
  });

  it('R6: the ratchet -- one more open gap than the ceiling allows', () => {
    const files = withEntries('iiCas', (es) => es.map((e) => (e.field === 'holderName' ? { ...e, status: 'open_gap' as const, gapId: 'INV-G9', severity: 'P2' as const, ownerWp: 'WP-12' } : e)));
    expect(check(files)).toEqual(['R6 ratchet: iiCas has 1 open gaps, ceiling 0']);
  });

  it('R7: strict mode names every open P0/P1 gap', () => {
    // WP-11 closed the real G1 entries, so the control re-opens one in memory
    // (the rule, not today's data, is what is under test).
    const reopened = withEntries('liabilityActivityLedger', (es) => es.map((e) => (e.field === 'PURCHASE' ? { ...e, status: 'open_gap', gapId: 'G1', severity: 'P0', ownerWp: 'WP-11' } : e)), 1);
    const strict = checkRegistry(reopened, baseline, { gapRegister, strict: true }).map((v) => v.message);
    expect(strict).toContain('R7 strict: liability_ledger.PURCHASE (enum:LIABILITY_ACTIVITY_TYPES) is an open P0 gap (G1)');
    expect(checkRegistry(reopened, baseline, { gapRegister, strict: false }).filter((v) => v.rule === 'R7')).toEqual([]);
  });

  it('R10: a registry change without regenerating the doc is detected', () => {
    const onDisk = fs.readFileSync(path.join(REPO_ROOT, 'docs/financial-data-hub/UPLOAD_FIELD_DISPOSITION_REGISTRY.md'), 'utf8').replace(/\r\n/g, '\n');
    const mutated = withEntries('iiCas', (es) => es.map((e) => (e.field === 'holderName' ? { ...e, destination: 'changed' } : e)));
    expect(`${renderRegistryMarkdown(mutated)}\n`).not.toBe(onDisk);
    expect(`${renderRegistryMarkdown()}\n`).toBe(onDisk);
  });

  it('the gap-register parser reads the real matrix (non-trivial) and refuses a doc without the section', () => {
    expect(gapRegister.size).toBeGreaterThanOrEqual(100);
    expect(gapRegister.get('G1')).toBe('P0');
    expect(() => parseGapRegister('# no register here')).toThrow(/Gap register/);
  });
});
