/**
 * Upload field-disposition gate -- the CHECKING side (WP-00). Pure: takes the
 * registry files and the enumerated sources, returns every violation with a
 * rule code and a message that names the adapter and field. The gate test
 * asserts there are none; the anti-vacuity test feeds it deliberately broken
 * inputs and asserts the exact named failure.
 */
import fs from 'node:fs';
import path from 'node:path';

import { CANONICAL_DESTINATION_PREFIXES, type FieldDispositionEntry, type RegistryFile } from '@/lib/canonical-data/disposition/types';
import { REPO_ROOT, type DispositionSource } from './dispositionSources';

export interface Violation {
  rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';
  message: string;
}

export interface EnumeratedSource {
  source: Pick<DispositionSource, 'adapter' | 'sourceRef' | 'floor'>;
  keys: string[];
}

export const MATRIX_DOC = path.join(REPO_ROOT, 'docs/financial-data-hub/APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md');

/** Gap id -> severity, parsed from the matrix doc's "Gap register" section. */
export function parseGapRegister(markdown: string): Map<string, string> {
  const start = markdown.search(/^## .*Gap register/m);
  if (start === -1) throw new Error('the matrix doc has no "Gap register" section');
  const section = markdown.slice(start).split(/\n## /)[0];
  const out = new Map<string, string>();
  for (const m of section.matchAll(/^\| ([A-Z][A-Z0-9-]*) \| (P[0-3]) \|/gm)) out.set(m[1], m[2]);
  return out;
}

export function loadGapRegister(): Map<string, string> {
  return parseGapRegister(fs.readFileSync(MATRIX_DOC, 'utf8'));
}

export interface CheckOptions {
  gapRegister: Map<string, string>;
  strict: boolean;
}

const key = (adapter: string, sourceRef: string, field: string) => `${adapter}\u0000${sourceRef}\u0000${field}`;

export function checkRegistry(files: readonly RegistryFile[], enumerated: readonly EnumeratedSource[], opts: CheckOptions): Violation[] {
  const v: Violation[] = [];
  const entries: FieldDispositionEntry[] = files.flatMap((f) => [...f.entries]);
  const byKey = new Map<string, FieldDispositionEntry[]>();
  for (const e of entries) {
    const k = key(e.adapter, e.sourceRef, e.field);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(e);
  }

  // R8: floors (anti-vacuity: a broken enumerator cannot pass silently).
  for (const { source, keys } of enumerated) {
    if (keys.length < source.floor) v.push({ rule: 'R8', message: `R8 floor: ${source.adapter} ${source.sourceRef} enumerated ${keys.length} keys, floor is ${source.floor}` });
  }

  // R1: every enumerated key has exactly one entry.
  const enumeratedKeys = new Set<string>();
  const knownSources = new Set<string>();
  for (const { source, keys } of enumerated) {
    knownSources.add(`${source.adapter}\u0000${source.sourceRef}`);
    for (const field of keys) {
      const k = key(source.adapter, source.sourceRef, field);
      enumeratedKeys.add(k);
      const found = byKey.get(k) ?? [];
      if (found.length === 0) v.push({ rule: 'R1', message: `R1 orphan: ${source.adapter}.${field} has no disposition (${source.sourceRef})` });
      if (found.length > 1) v.push({ rule: 'R1', message: `R1 duplicate: ${source.adapter}.${field} has ${found.length} dispositions (${source.sourceRef})` });
    }
  }

  // R2: every entry resolves to an enumerated key.
  for (const e of entries) {
    if (!knownSources.has(`${e.adapter}\u0000${e.sourceRef}`)) {
      v.push({ rule: 'R2', message: `R2 stale: ${e.adapter}.${e.field} names an unknown source ${e.sourceRef}` });
    } else if (!enumeratedKeys.has(key(e.adapter, e.sourceRef, e.field))) {
      v.push({ rule: 'R2', message: `R2 stale: ${e.adapter}.${e.field} no longer exists in ${e.sourceRef}` });
    }
  }

  for (const e of entries) {
    const id = `${e.adapter}.${e.field} (${e.sourceRef})`;
    // R3: evidence and unsupported facts must be visible, unless a named gap or an inactive flow.
    if ((e.disposition === 'C_EVIDENCE' || e.disposition === 'E_UNSUPPORTED') && !e.userVisibleAt && e.status === 'compliant') {
      v.push({ rule: 'R3', message: `R3 invisible: ${id} is ${e.disposition} but has no userVisibleAt` });
    }
    // R4: state and events must land in a canonical table.
    if ((e.disposition === 'A_STATE' || e.disposition === 'B_EVENT') && !CANONICAL_DESTINATION_PREFIXES.some((p) => e.destination.startsWith(p))) {
      v.push({ rule: 'R4', message: `R4 non-canonical destination: ${id} -> ${e.destination}` });
    }
    // R5: an open gap is named in the matrix, with the matrix's severity and an owner.
    if (e.status === 'open_gap') {
      if (!e.gapId || !e.severity || !e.ownerWp) v.push({ rule: 'R5', message: `R5 incomplete gap: ${id} is open_gap without gapId/severity/ownerWp` });
      else if (!opts.gapRegister.has(e.gapId)) v.push({ rule: 'R5', message: `R5 unknown gap: ${id} names ${e.gapId}, which is not in the matrix gap register` });
      else if (opts.gapRegister.get(e.gapId) !== e.severity) v.push({ rule: 'R5', message: `R5 severity mismatch: ${id} says ${e.gapId} is ${e.severity}, the matrix says ${opts.gapRegister.get(e.gapId)}` });
    }
    // R7: strict certification -- no open P0/P1 in an active adapter.
    if (opts.strict && e.status === 'open_gap' && (e.severity === 'P0' || e.severity === 'P1')) {
      v.push({ rule: 'R7', message: `R7 strict: ${id} is an open ${e.severity} gap (${e.gapId})` });
    }
  }

  // R6: the per-file ratchet.
  for (const f of files) {
    const open = f.entries.filter((e) => e.status === 'open_gap').length;
    if (open > f.OPEN_GAP_CEILING) v.push({ rule: 'R6', message: `R6 ratchet: ${f.id} has ${open} open gaps, ceiling ${f.OPEN_GAP_CEILING}` });
  }
  return v;
}
