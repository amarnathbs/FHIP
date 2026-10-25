// Investment Intelligence -- staging of a PARSED statement between processing slices (Document2 (4) WP-J). Pure.
//
// A large statement is processed in several short slices (each its own web request). The PDF is read exactly once, in the first slice,
// with the person's password if it has one; the structured result is then kept as TEMPORARY staging rows (ii_statement_job_chunks,
// server-only) so that no later slice ever needs the file or the password again. Staging holds only what becomes database rows anyway
// (folios, schemes, transaction lines, holding lines); it never holds the file, the extracted full text or the password. It is deleted
// when the job ends and swept after 24 hours.
//
// BIGINT. The parser works in exact scaled integers (bigint), which JSON cannot carry. They travel as {"__b":"123"} and are revived on
// reading, so the staged data is bit-for-bit what the parser produced.

import type {
  ParsedAccountRecord,
  ParsedDocumentOutput,
  ParsedHoldingRecord,
  ParsedInstrumentRecord,
  ParsedTransactionRecord,
  ParseMetadata,
  ParsedWarning,
} from './parsers/types';
import { createHash } from 'node:crypto';
import { accountResolutionKey, planFolioAccountResolution, type FolioAmcAssignment } from './accountResolution';

export const STAGE_TXN_BATCH = 200;
export const STAGE_HOLD_BATCH = 250;

// ---------------------------------------------------------------------------------------------------------------------
// bigint-safe JSON
// ---------------------------------------------------------------------------------------------------------------------
export function toPlain(value: unknown): unknown {
  if (typeof value === 'bigint') return { __b: value.toString() };
  if (Array.isArray(value)) return value.map(toPlain);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toPlain(v);
    }
    return out;
  }
  return value;
}

export function fromPlain<T = unknown>(value: unknown): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v as Record<string, unknown>);
      if (keys.length === 1 && keys[0] === '__b' && typeof (v as { __b: unknown }).__b === 'string') return BigInt((v as { __b: string }).__b);
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

// ---------------------------------------------------------------------------------------------------------------------
// The staged shape
// ---------------------------------------------------------------------------------------------------------------------
export type StagedTxn = Omit<ParsedTransactionRecord, 'scheme'> & { si: number };
export type StagedHold = Omit<ParsedHoldingRecord, 'scheme'> & { si: number };

export interface StagedMeta {
  v: 1;
  parserCode: ParsedDocumentOutput['parserCode'];
  parserVersion: string;
  metadata: ParseMetadata;
  parserConfidence: number;
  warnings: ParsedWarning[];
  errors: ParsedWarning[];
  /** The parsed folio blocks without their raw source block (never needed again, and not worth keeping). */
  accounts: ParsedAccountRecord[];
  /** Every DISTINCT scheme record in first-seen order (transactions first, then holdings). Lines refer to it by index. */
  schemes: ParsedInstrumentRecord[];
  assignments: FolioAmcAssignment[];
  /** folio -> fund house printed on the folio block, for the row-key rule (see makeResolveRowKey). */
  accAmcNameByFolio: Array<[string, string]>;
  txnCount: number;
  holdCount: number;
  txnBatches: number;
  holdBatches: number;
}

export interface StagedParsed {
  meta: StagedMeta;
  txnBatches: StagedTxn[][];
  holdBatches: StagedHold[][];
}

const schemeIdentity = (s: ParsedInstrumentRecord): string =>
  JSON.stringify([s.rawSchemeName, s.normalisedSchemeName, s.amcName, s.planType, s.optionType, s.isin, s.amfiSchemeCode]);

export function stageParsed(parsed: ParsedDocumentOutput): StagedParsed {
  const schemes: ParsedInstrumentRecord[] = [];
  const indexOf = new Map<string, number>();
  const refer = (s: ParsedInstrumentRecord): number => {
    const id = schemeIdentity(s);
    let i = indexOf.get(id);
    if (i === undefined) {
      i = schemes.length;
      schemes.push(s);
      indexOf.set(id, i);
    }
    return i;
  };
  const txns: StagedTxn[] = parsed.transactions.map((t) => {
    const { scheme, ...rest } = t;
    return { ...rest, si: refer(scheme) };
  });
  const holds: StagedHold[] = parsed.holdings.map((h) => {
    const { scheme, ...rest } = h;
    return { ...rest, si: refer(scheme) };
  });
  const plan = planFolioAccountResolution({ accounts: parsed.accounts, transactions: parsed.transactions, holdings: parsed.holdings });
  const accAmcNameByFolio = new Map<string, string>();
  for (const acc of parsed.accounts) if (acc.amcName) accAmcNameByFolio.set(acc.folioNumber ?? '__no_folio__', acc.amcName);
  const txnBatches: StagedTxn[][] = [];
  for (let i = 0; i < txns.length; i += STAGE_TXN_BATCH) txnBatches.push(txns.slice(i, i + STAGE_TXN_BATCH));
  const holdBatches: StagedHold[][] = [];
  for (let i = 0; i < holds.length; i += STAGE_HOLD_BATCH) holdBatches.push(holds.slice(i, i + STAGE_HOLD_BATCH));
  return {
    meta: {
      v: 1,
      parserCode: parsed.parserCode,
      parserVersion: parsed.parserVersion,
      metadata: parsed.metadata,
      parserConfidence: parsed.parserConfidence,
      warnings: parsed.warnings,
      errors: parsed.errors,
      accounts: parsed.accounts.map((a) => ({ ...a, raw: '' })),
      schemes,
      assignments: plan.assignments,
      accAmcNameByFolio: [...accAmcNameByFolio.entries()],
      txnCount: txns.length,
      holdCount: holds.length,
      txnBatches: txnBatches.length,
      holdBatches: holdBatches.length,
    },
    txnBatches,
    holdBatches,
  };
}

/** The same row-key rule planFolioAccountResolution().resolveRowKey applies, rebuilt from the staged folio table. */
export function makeResolveRowKey(accAmcNameByFolio: ReadonlyArray<readonly [string, string]>): (folioNumber: string | null, schemeAmcName: string) => string {
  const byFolio = new Map(accAmcNameByFolio);
  return (folioNumber, schemeAmcName) => {
    const folioKey = folioNumber ?? '__no_folio__';
    const amcName = byFolio.get(folioKey) || schemeAmcName || 'Unknown AMC';
    return accountResolutionKey(folioNumber, amcName);
  };
}

export function unstageTxn(t: StagedTxn, schemes: readonly ParsedInstrumentRecord[]): ParsedTransactionRecord {
  const { si, ...rest } = t;
  return { ...rest, scheme: schemes[si] };
}

export function unstageHold(h: StagedHold, schemes: readonly ParsedInstrumentRecord[]): ParsedHoldingRecord {
  const { si, ...rest } = h;
  return { ...rest, scheme: schemes[si] };
}

// (moved here from documentProcessing.ts so the pipeline and the job share it without a circular import)
/** Merges two records of the same scheme key, keeping whichever side's isin / amfiSchemeCode is non-null. */
export function mergeSchemeRecords(a: ParsedInstrumentRecord, b: ParsedInstrumentRecord): ParsedInstrumentRecord {
  return { ...a, isin: a.isin ?? b.isin, amfiSchemeCode: a.amfiSchemeCode ?? b.amfiSchemeCode };
}

/** A stable UUID derived from its parts (so a replayed step produces the SAME id it produced the first time). */
export function deterministicUuid(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
