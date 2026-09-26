/**
 * THE upload field-disposition gate (WP-00; brief: "a deliberately added orphan
 * field makes certification FAIL"). Runs under `npm test` and
 * `npm run check:dispositions`.
 *
 *   R1 orphan    every enumerated field / column / enum value has exactly one entry
 *   R2 stale     every entry still exists in the source tree
 *   R3 visible   C and E entries say where the user sees them (unless a named gap)
 *   R4 canonical A and B entries land in a canonical table
 *   R5 gaps      every open gap is in the matrix gap register, same severity
 *   R6 ratchet   open gaps per file <= OPEN_GAP_CEILING (may only go down)
 *   R7 strict    (WP-14) no open P0/P1 in an active adapter
 *   R8 floors    no enumerator found fewer keys than its floor
 *   R9 buckets   every economic type's registry bucket == the read model's bucket
 *   R10 doc sync the generated markdown equals the checked-in doc (compared, never written)
 *
 * The anti-vacuity controls are in uploadFieldDispositionRegistryAntiVacuity.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FIELD_DISPOSITION_REGISTRY, REGISTRY_FILES, STRICT_CERTIFICATION, renderRegistryMarkdown } from '@/lib/canonical-data/disposition';
import { ECONOMIC_TYPE_BUCKET } from '@/lib/read-models/core/spendingRules';
import { checkRegistry, loadGapRegister } from './helpers/dispositionChecker';
import { REPO_ROOT, SOURCES, enumerateAll } from './helpers/dispositionSources';

const REGISTRY_DOC = path.join(REPO_ROOT, 'docs/financial-data-hub/UPLOAD_FIELD_DISPOSITION_REGISTRY.md');

describe('upload field-disposition registry gate', () => {
  const enumerated = enumerateAll();
  const gapRegister = loadGapRegister();

  it('R1-R8: zero violations against the live source tree', () => {
    const violations = checkRegistry(REGISTRY_FILES, enumerated, { gapRegister, strict: STRICT_CERTIFICATION });
    expect(violations.map((x) => x.message)).toEqual([]);
  });

  it('the enumeration is real: every source found keys, and the registry is not trivially small', () => {
    for (const { source, keys } of enumerated) expect(keys.length, source.sourceRef).toBeGreaterThanOrEqual(source.floor);
    const total = enumerated.reduce((s, e) => s + e.keys.length, 0);
    expect(total).toBeGreaterThanOrEqual(880);
    expect(FIELD_DISPOSITION_REGISTRY).toHaveLength(total);
    expect(SOURCES.length).toBe(47);
  });

  it('R6: every ceiling is EXACTLY the current open-gap count (a closed gap must lower it)', () => {
    for (const f of REGISTRY_FILES) {
      expect(f.entries.filter((e) => e.status === 'open_gap').length, `${f.id} ceiling`).toBe(f.OPEN_GAP_CEILING);
    }
  });

  it('R9: every economic_transaction_type entry names exactly the read-model bucket', () => {
    const entries = FIELD_DISPOSITION_REGISTRY.filter((e) => e.adapter === 'economic_type');
    expect(entries.map((e) => e.field).sort()).toEqual(Object.keys(ECONOMIC_TYPE_BUCKET).sort());
    for (const e of entries) {
      expect(e.destination, e.field).toBe(`fdh_transactions(bucket=${ECONOMIC_TYPE_BUCKET[e.field as keyof typeof ECONOMIC_TYPE_BUCKET]})`);
    }
  });

  it('insurance and the AIE-fronted intakes are recorded as not active, never certified', () => {
    const ins = FIELD_DISPOSITION_REGISTRY.filter((e) => e.adapter === 'insurance');
    expect(ins.length).toBe(21);
    expect(ins.every((e) => e.status === 'not_active')).toBe(true);
  });

  it('R7 is OFF until WP-14, and would fail today (the open P0/P1 gaps are real, not hidden)', () => {
    expect(STRICT_CERTIFICATION).toBe(false);
    const strict = checkRegistry(REGISTRY_FILES, enumerated, { gapRegister, strict: true });
    expect(strict.filter((x) => x.rule === 'R7').length).toBeGreaterThan(0);
  });

  it('R10: the checked-in registry doc equals the generated one (run scripts/generate-upload-field-disposition-doc.mjs)', () => {
    const onDisk = fs.readFileSync(REGISTRY_DOC, 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(`${renderRegistryMarkdown()}\n`);
  });
});
