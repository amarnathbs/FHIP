// PC7 (M7) — the Underlying Fund Holdings import runner (O.3, O.4, O.5).
//
// REUSE, NOT A SECOND STACK. Phase 7 built `pc6/referenceImportRunner.ts` to
// be reused, and this module reuses it rather than growing a parallel
// ingestion stack:
//
//   decideStart      kill switch + fail-closed authorisation   (unchanged)
//   backoffMinutes   bounded exponential backoff               (unchanged)
//   nextAttemptAfter                                           (unchanged)
//   classifyFetch    source-outage classification              (unchanged)
//   settleBatch      partial-batch settlement semantics        (unchanged)
//   buildAlerts      operator alerting                         (unchanged)
//
// Everything above is imported and re-exported, not reimplemented. What PC7
// adds is the part that is genuinely different: a SNAPSHOT is not a row.
//
// WHY THE PLAN SHAPE DIFFERS FROM PC6'S. A NAV import writes independent
// dated scalars, so PC6 can settle chunk-by-chunk and let a re-run complete
// the tail. A holdings disclosure is an ALL-OR-NOTHING DOCUMENT: a snapshot
// whose lines are half-written is not a smaller portfolio, it is a WRONG one —
// its weights sum to 60%, its coverage reads as a genuine 60% disclosure, and
// every downstream exposure number is understated in a way that looks
// measured rather than missing. PC7 therefore plans per-snapshot with
// `all_or_nothing` atomicity, which `settleBatch` already supports and which
// PC6's own comment anticipated for exactly this class of data.
//
// BOUNDARY (O.3, O.7, D.1, D.2). This module writes ONLY to
// `ii_fund_holdings_snapshots` and `ii_fund_holdings_lines` (plus the PC6
// batch ledger). It has no code path that touches `investments`, `assets`,
// `retirement_accounts`, `liabilities`, `financial_snapshots`,
// `ii_transactions`, `ii_holding_snapshots` or `ii_fhip_publications`, and no
// code path that reads a user document or enters the AIE acceptance
// lifecycle. O.7 is preserved BY CONSTRUCTION: there is nothing here that
// could add to household net worth, because the tables that carry net worth
// are never named.

import { createHash } from 'node:crypto';
import {
  decideStart,
  backoffMinutes,
  nextAttemptAfter,
  classifyFetch,
  settleBatch,
  buildAlerts,
  type JobControlRow,
  type StartDecision,
  type FetchOutcome,
  type BatchSettlement,
  type BatchAtomicity,
  type ChunkOutcome,
  type Alert,
} from '../pc6/referenceImportRunner';
import {
  type DisclosureParseResult,
  type DisclosureHoldingRecord,
  type AssetKind,
  recordChecksum,
} from './portfolioDisclosureParser';
import { getDisclosureSource, type DisclosureSourceDefinition } from '@/lib/config/investment-intelligence/pc7DisclosureSources';

export const PC7_RUNNER_VERSION = 'pc7-disclosure-import-runner-v1';

/** The new `ii_reference_import_batches.batch_kind` value migration 0157 adds. */
export const PC7_BATCH_KIND = 'fund_holdings_disclosure';

/** The `ii_reference_job_control.job_key` migration 0157 seeds, DISABLED. */
export const PC7_JOB_KEY = 'pc7_fund_holdings_disclosure';

// PC6 controls, re-exported so a PC7 caller never has to reach across modules
// and never has a reason to write its own.
export { decideStart, backoffMinutes, nextAttemptAfter, classifyFetch, settleBatch, buildAlerts };
export type { JobControlRow, StartDecision, FetchOutcome, BatchSettlement, BatchAtomicity, ChunkOutcome, Alert };

/**
 * A holdings file is a document, not a feed. 10 KB is a generous floor for a
 * single-scheme disclosure and still catches an error page or a truncated
 * transfer, which would otherwise parse to "no holdings found" and be
 * recorded as a successful empty snapshot.
 */
export const MIN_PLAUSIBLE_DISCLOSURE_BYTES = 10_000;

// ---------------------------------------------------------------------------
// Scheme resolution (O.5)
// ---------------------------------------------------------------------------

/**
 * Scheme identity for a disclosure file.
 *
 * O.5: reuse the authoritative security master — `ii_instruments` for the
 * canonical instrument and PC6's `ii_scheme_master` for scheme-level identity.
 * PC7 creates NO new security identity of its own.
 */
export interface SchemeIdentityIndex {
  /** AMFI scheme code -> ii_instruments.id (via ii_scheme_master where applied). */
  byAmfiCode: Map<string, string>;
  /** ISIN -> ii_instruments.id */
  byIsin: Map<string, string>;
  /**
   * Whether PC6's ii_scheme_master was actually readable. FALSE is an honest
   * state (migration 0155 unapplied), and it downgrades the resolution
   * PROVENANCE rather than silently pretending scheme-master identity was
   * consulted.
   */
  schemeMasterAvailable: boolean;
}

export type SchemeIdentityResolution =
  | { state: 'resolved'; instrumentId: string; via: 'amfi_scheme_code' | 'isin'; schemeMasterConsulted: boolean }
  | { state: 'unresolved'; reason: 'NO_MATCHING_SCHEME' | 'AMBIGUOUS_SCHEME_CONFLICT' | 'NO_IDENTIFIER_SUPPLIED'; detail: string };

export interface DisclosureSchemeKey {
  amfiSchemeCode: string | null;
  isin: string | null;
  schemeNameRaw: string;
}

/**
 * Resolve the SCHEME a disclosure file describes.
 *
 * EXACT IDENTIFIERS ONLY, and for a stronger reason than PC6's. PC6 resolved
 * one NAV per record; a mis-resolved scheme here attaches an ENTIRE portfolio
 * — 60 securities, every sector weight, every credit band — to the wrong fund,
 * and the result looks completely plausible. There is deliberately no
 * name-based fallback, and a code/ISIN disagreement is surfaced rather than
 * broken by precedence.
 */
export function resolveSchemeIdentity(key: DisclosureSchemeKey, index: SchemeIdentityIndex): SchemeIdentityResolution {
  if (!key.amfiSchemeCode && !key.isin) {
    return {
      state: 'unresolved',
      reason: 'NO_IDENTIFIER_SUPPLIED',
      detail:
        `The disclosure for "${key.schemeNameRaw.slice(0, 80)}" carries neither an AMFI scheme code nor an ISIN. ` +
        'PC7 will not match a scheme by name: a name match that picks the Direct plan instead of the Regular plan, ' +
        'or one AMC\'s "Large Cap Fund" instead of another\'s, produces a fully-populated and entirely wrong portfolio.',
    };
  }
  const byCode = key.amfiSchemeCode ? index.byAmfiCode.get(key.amfiSchemeCode) : undefined;
  const byIsin = key.isin ? index.byIsin.get(key.isin) : undefined;

  if (byCode && byIsin && byCode !== byIsin) {
    return {
      state: 'unresolved',
      reason: 'AMBIGUOUS_SCHEME_CONFLICT',
      detail: `AMFI code ${key.amfiSchemeCode} resolves to instrument ${byCode} but ISIN ${key.isin} resolves to ${byIsin}. No holdings are written until a human resolves the instrument master's disagreement with itself.`,
    };
  }
  if (byCode) return { state: 'resolved', instrumentId: byCode, via: 'amfi_scheme_code', schemeMasterConsulted: index.schemeMasterAvailable };
  if (byIsin) return { state: 'resolved', instrumentId: byIsin, via: 'isin', schemeMasterConsulted: index.schemeMasterAvailable };
  return {
    state: 'unresolved',
    reason: 'NO_MATCHING_SCHEME',
    detail: `No instrument carries AMFI code ${key.amfiSchemeCode ?? '(none)'}${key.isin ? ` or ISIN ${key.isin}` : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// Constituent resolution (O.5)
// ---------------------------------------------------------------------------

export interface ConstituentIndex {
  /** ISIN -> ii_instruments.id */
  byIsin: Map<string, string>;
  /**
   * CURATED exact maps only (`ii_security_aliases`). There is no fuzzy path:
   * a name-matched constituent is how "Bajaj Finance" becomes "Bajaj Finserv"
   * and a user is told they hold something they do not.
   */
  byCuratedAlias: Map<string, string>;
}

export type ConstituentResolutionMethod = 'ISIN' | 'CONTROLLED_ALIAS' | 'UNRESOLVED';

export interface ResolvedConstituent {
  record: DisclosureHoldingRecord;
  underlyingInstrumentId: string | null;
  resolutionMethod: ConstituentResolutionMethod;
}

/**
 * Resolve one constituent line to a canonical security.
 *
 * An unresolved line is RETAINED, never dropped and never name-matched. The
 * look-through engine already carries `unresolvedWeight` as explicit, visible
 * exposure, which is the honest representation: "we know this fund holds 4%
 * of something we could not identify" is true and useful; silently removing
 * it would make the fund look 4% smaller than it is.
 */
export function resolveConstituent(record: DisclosureHoldingRecord, index: ConstituentIndex): ResolvedConstituent {
  // Cash, derivative and receivable buckets are PRESERVED as buckets. They are
  // not securities and must never be resolved into one.
  if (record.assetKind !== 'security') {
    return { record, underlyingInstrumentId: null, resolutionMethod: 'UNRESOLVED' };
  }
  if (record.isin) {
    const id = index.byIsin.get(record.isin);
    if (id) return { record, underlyingInstrumentId: id, resolutionMethod: 'ISIN' };
  }
  const aliasId = index.byCuratedAlias.get(record.instrumentName.toUpperCase());
  if (aliasId) return { record, underlyingInstrumentId: aliasId, resolutionMethod: 'CONTROLLED_ALIAS' };
  return { record, underlyingInstrumentId: null, resolutionMethod: 'UNRESOLVED' };
}

// ---------------------------------------------------------------------------
// The snapshot plan (O.4)
// ---------------------------------------------------------------------------

export interface PlannedHoldingLine {
  underlyingInstrumentId: string | null;
  holdingName: string;
  isin: string | null;
  assetKind: AssetKind;
  quantity: number | null;
  marketValue: number | null;
  /** The publisher's own disclosed weight. Never rescaled. */
  weightPct: number;
  securityType: string | null;
  creditRatingBand: string | null;
  industryOrRatingRaw: string | null;
  resolutionMethod: ConstituentResolutionMethod;
  recordChecksum: string;
}

export interface PlannedSnapshot {
  fundInstrumentId: string;
  holdingsAsOfDate: string;
  sourceKey: string;
  sourceDocumentVersion: string;
  sourceDataVersion: string;
  /** Sum of ALL disclosed line weights, as disclosed. */
  disclosedWeightTotalPct: number;
  qualityStatus: 'ok' | 'partial_disclosure' | 'unverified_source';
  lines: PlannedHoldingLine[];
}

export type SnapshotAction = 'insert' | 'skip_identical' | 'insert_new_version';

export interface SnapshotPlan {
  action: SnapshotAction;
  snapshot: PlannedSnapshot | null;
  /** Lines whose security could not be identified. Reported, never dropped. */
  unresolvedLineCount: number;
  unresolvedWeightPct: number;
  detail: string;
}

/**
 * Existing snapshot state for `(fund, as-of date, source document version)`.
 * PC6's `decideUpsert` operates on a single scalar observation and does not
 * fit a multi-line document, so PC7 states its own — deliberately, and with
 * the reasoning visible rather than hidden behind a reused name.
 */
export interface ExistingSnapshot {
  snapshotId: string;
  /** sha256 over the ordered line checksums. */
  contentChecksum: string;
}

export function snapshotContentChecksum(lines: PlannedHoldingLine[]): string {
  // Order-independent: the same disclosure re-parsed must yield the same
  // checksum even if a publisher reorders rows between reissues of the same
  // document version.
  const sorted = [...lines].map((l) => l.recordChecksum).sort();
  return createHash('sha256').update(sorted.join('|')).digest('hex');
}

export interface PlanSnapshotInputs {
  parsed: DisclosureParseResult;
  schemeResolution: SchemeIdentityResolution;
  constituentIndex: ConstituentIndex;
  holdingsAsOfDate: string;
  sourceKey: string;
  /** Publisher document identity — the file's sha256 is the honest default. */
  sourceDocumentVersion: string;
  sourceDataVersion: string;
  existing: ExistingSnapshot | null;
  /**
   * Below this disclosed total the snapshot is marked `partial_disclosure`.
   * 90% is the point below which a portfolio conclusion stops being safe to
   * draw, and it matches the existing X-Ray coverage thresholds rather than
   * introducing a second, conflicting notion of "enough".
   */
  partialDisclosureBelowPct?: number;
}

export const DEFAULT_PARTIAL_DISCLOSURE_BELOW_PCT = 90;

/**
 * Turn a parsed disclosure into an exact, side-effect-free snapshot plan.
 *
 * IDEMPOTENCY IS BY CONTENT, like PC6's: re-importing the same file yields
 * `skip_identical`, provable by inspecting the plan rather than the database.
 * A genuine REISSUE of the same as-of date with different content yields
 * `insert_new_version` — never an in-place update, because migration 0044's
 * whole posture is that a snapshot is immutable and supersession is additive.
 */
export function planSnapshot(inputs: PlanSnapshotInputs): SnapshotPlan {
  if (inputs.schemeResolution.state === 'unresolved') {
    return {
      action: 'skip_identical',
      snapshot: null,
      unresolvedLineCount: 0,
      unresolvedWeightPct: 0,
      detail: `Scheme unresolved (${inputs.schemeResolution.reason}): ${inputs.schemeResolution.detail} No snapshot is written.`,
    };
  }
  if (inputs.parsed.records.length === 0) {
    return {
      action: 'skip_identical',
      snapshot: null,
      unresolvedLineCount: 0,
      unresolvedWeightPct: 0,
      detail:
        'The file parsed to zero holding records. An EMPTY snapshot is never written: it would read downstream ' +
        'as a fund that genuinely holds nothing, which is the "zero as if measured" failure O.8 forbids. The ' +
        'batch fails and the scheme keeps whatever earlier disclosure it had.',
    };
  }

  const lines: PlannedHoldingLine[] = [];
  let unresolvedLineCount = 0;
  let unresolvedWeightPct = 0;

  for (const rec of inputs.parsed.records) {
    const res = resolveConstituent(rec, inputs.constituentIndex);
    if (rec.assetKind === 'security' && res.underlyingInstrumentId === null) {
      unresolvedLineCount++;
      unresolvedWeightPct += rec.weightPct;
    }
    lines.push({
      underlyingInstrumentId: res.underlyingInstrumentId,
      holdingName: rec.instrumentName,
      isin: rec.isin,
      assetKind: rec.assetKind,
      quantity: rec.quantity,
      marketValue: rec.marketValue,
      weightPct: rec.weightPct,
      securityType: rec.securityType,
      creditRatingBand: rec.creditRatingBand,
      industryOrRatingRaw: rec.industryOrRatingRaw,
      resolutionMethod: res.resolutionMethod,
      recordChecksum: recordChecksum(rec),
    });
  }

  const threshold = inputs.partialDisclosureBelowPct ?? DEFAULT_PARTIAL_DISCLOSURE_BELOW_PCT;
  const total = inputs.parsed.disclosedWeightTotalPct;
  const snapshot: PlannedSnapshot = {
    fundInstrumentId: inputs.schemeResolution.instrumentId,
    holdingsAsOfDate: inputs.holdingsAsOfDate,
    sourceKey: inputs.sourceKey,
    sourceDocumentVersion: inputs.sourceDocumentVersion,
    sourceDataVersion: inputs.sourceDataVersion,
    disclosedWeightTotalPct: total,
    qualityStatus: total < threshold ? 'partial_disclosure' : 'ok',
    lines,
  };

  const checksum = snapshotContentChecksum(lines);
  if (inputs.existing && inputs.existing.contentChecksum === checksum) {
    return {
      action: 'skip_identical',
      snapshot,
      unresolvedLineCount,
      unresolvedWeightPct,
      detail: `Snapshot ${inputs.existing.snapshotId} already carries byte-identical content (${lines.length} lines). Genuine no-op.`,
    };
  }
  if (inputs.existing) {
    return {
      action: 'insert_new_version',
      snapshot,
      unresolvedLineCount,
      unresolvedWeightPct,
      detail: `A snapshot already exists for this fund/date/document version with DIFFERENT content. A new version is inserted; snapshot ${inputs.existing.snapshotId} is preserved, never overwritten.`,
    };
  }
  return {
    action: 'insert',
    snapshot,
    unresolvedLineCount,
    unresolvedWeightPct,
    detail: `New snapshot: ${lines.length} line(s), ${total.toFixed(4)}% disclosed, ${unresolvedLineCount} unresolved security line(s) carrying ${unresolvedWeightPct.toFixed(4)}%.`,
  };
}

/**
 * PC7 settles ALL-OR-NOTHING. See the module header for why this differs from
 * PC6's chunk-committing NAV semantics.
 */
export const PC7_BATCH_ATOMICITY: BatchAtomicity = 'all_or_nothing';

export function settleSnapshotBatch(chunks: ChunkOutcome[]): BatchSettlement {
  return settleBatch(chunks, PC7_BATCH_ATOMICITY);
}

export function disclosureSourceFor(configId: string): DisclosureSourceDefinition {
  return getDisclosureSource(configId);
}
