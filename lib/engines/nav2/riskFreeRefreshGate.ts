// NAV2 -- the PUBLICATION GATE of the weekly risk-free refresh (PO decision
// 2026-10-03: the RBI series are refreshed weekly by an automated read of RBI's HTML,
// AI-assisted, instead of manual entry). Stage 1 delivers the DECISION CONTRACT only:
// pure, deterministic, no network, no database, no clock. The job that fetches the
// pages, runs the parser and the AI extraction and writes the rows is Stage 2
// (docs/nav2/NAV2_BENCHMARK_AND_RISK_FREE_DEPENDENCY_REGISTER.md section 5); it calls
// these functions and writes exactly what they say, nothing else.
//
// THE RULE: automatic publication is the exception that has to earn itself. A value is
// published only when EVERY applicable check passes; anything else becomes a review item
// with its evidence and NOTHING is published. There is no "best guess" path.
//
//   (a) two independent reads agree: the deterministic parser and the AI extraction
//       return the same date and yield; a disagreement NEVER publishes. If only one read
//       is available, publication additionally needs the NSDP cross-check to MATCH;
//   (b) the yield recomputed from the printed 91-day cut-off price matches the printed
//       yield within tolerance: yield = (100 - price) / price x 365 / 91 x 100;
//   (c) the value is plausible: within a band of the previous stored observation and, when
//       the RBI weekly NSDP page has the week, equal to it at its two decimals;
//   (d) the date is a weekday, later than the last stored observation (a Wednesday auction;
//       a Thursday holiday-shifted auction needs the NSDP match as well).
//   Idempotent: the same week again changes nothing; a DIFFERENT value for a stored date is
//   a review item, never an overwrite.
//   No accepted bids: a GAP row is recorded, never a value.
//   Repo rate: a change is detected from the NSDP weekly value differing from the stored
//   rate, and is appended ONLY with the monetary-policy press release as evidence (or an
//   admin's confirmation); otherwise it is a review item. An unchanged rate advances the
//   dataset's verified-through date and writes no observation.

import { daysBetweenIso, isValidIsoDate } from './dates';
import type { RiskFreeExtractionProvenance } from './riskFree';

export const RISK_FREE_REFRESH_RULES_VERSION = 'nav2-risk-free-refresh-rules-v1';

export const RISK_FREE_REFRESH_RULES = {
  version: RISK_FREE_REFRESH_RULES_VERSION,
  /** The 91-day bill is priced on actual/365 over 91 days. */
  billDays: 91,
  dayCountBasis: 365,
  /** Recomputed yield versus printed yield, in percentage points. The first-load check found every 2026 release within 0.0001. */
  yieldRecomputeTolerancePp: 0.001,
  /** A week-on-week move larger than this is not published automatically (the 2026 weekly moves were all under 0.2). PO-CONFIRM. */
  weekOnWeekBandPp: 0.5,
  /** NSDP prints two decimals: the stored yield rounded to 2 dp must equal it. */
  nsdpToleranceUpToPp: 0.0051,
  /** Repo: NSDP prints two decimals. */
  repoToleranceUpToPp: 0.005,
} as const;

/**
 * How the Stage 2 job must behave towards rbi.org.in (a courtesy and a safety rule, enforced in the job and
 * tested there): descriptive User-Agent, few and slow requests, conditional requests, robots.txt honoured,
 * hard caps, never a CAPTCHA bypass, never a PDF.
 */
export const RISK_FREE_REFRESH_FETCH_POLICY = {
  /** Listing page for the month, the release itself, the NSDP page, plus one spare (e.g. a policy statement). */
  maxRequestsPerRun: 4,
  minSpacingMs: 4000,
  userAgent: 'FHIP-RiskFreeRefresh/1.0 (weekly, descriptive; contact: platform owner)',
  conditionalRequests: true,
  honourRobotsTxt: true,
  maxResponseBytes: 1_000_000,
  perRequestTimeoutMs: 15_000,
  runDeadlineMs: 60_000,
  allowPdf: false,
  bypassHumanVerification: false,
} as const;

export interface RefreshRunPlan {
  mode: 'skipped_kill_switch' | 'dry_run' | 'live';
  /** The most provider requests the run may make: ZERO when the kill switch is off. */
  maxRequests: number;
  /** A dry run reads and decides but writes nothing. */
  mayWrite: boolean;
}

/** The kill switch comes first: with it off the job makes NO request at all (and writes nothing). Dry run reads, decides and writes nothing. */
export function planRefreshRun(args: { enabled: boolean; dryRun: boolean }): RefreshRunPlan {
  if (!args.enabled) return { mode: 'skipped_kill_switch', maxRequests: 0, mayWrite: false };
  if (args.dryRun) return { mode: 'dry_run', maxRequests: RISK_FREE_REFRESH_FETCH_POLICY.maxRequestsPerRun, mayWrite: false };
  return { mode: 'live', maxRequests: RISK_FREE_REFRESH_FETCH_POLICY.maxRequestsPerRun, mayWrite: true };
}

/** What a read of the "Treasury Bills: Full Auction Result" release yields (the parser and the AI extraction return the same shape). */
export interface ParsedAuction {
  /** e.g. "2026-2027/1218". */
  releaseNumber: string | null;
  /** The release title, e.g. "Treasury Bills: Full Auction Result". */
  title: string | null;
  /** The auction (release) date, ISO. */
  auctionDate: string | null;
  /** Row III, 91-day column: the cut-off price. null when the cell is "-". */
  cutoffPrice: number | null;
  /** Row III, 91-day column: the cut-off yield (YTM), percent. null when the cell is "-". */
  cutoffYieldPercent: number | null;
  /** True when the release shows no accepted bids for the 91-day bill (the cut-off cells are "-"). */
  noAcceptedBids: boolean;
}

export type NsdpReading =
  | { state: 'unavailable' }
  | { state: 'value'; weekEnded: string; yield91dPercent: number | null; policyRepoPercent: number | null };

export interface StoredTbill {
  observationDate: string;
  yieldPercent: number;
}

export interface TbillRefreshInput {
  /** False when the listing had no release for the expected week yet (not published, or published late): retry later, write nothing. */
  releaseFound: boolean;
  /** The deterministic parser's reading; null = the parser failed (layout change, missing row). */
  parser: ParsedAuction | null;
  /** The AI extraction's reading; null = not run or failed. */
  ai: ParsedAuction | null;
  nsdp: NsdpReading;
  /** The latest stored VALUE observation, or null when none. */
  lastStored: StoredTbill | null;
  /** Whatever is already stored for the candidate auction date (a value or a gap), or null. */
  storedOnDate: { kind: 'value'; yieldPercent: number } | { kind: 'gap' } | null;
  extractionVersion: string;
}

export type ReviewReason =
  | 'parser_failed_and_ai_unavailable'
  | 'parser_ai_disagree'
  | 'auction_date_missing_or_invalid'
  | 'cutoff_price_missing_cannot_recompute'
  | 'printed_yield_mismatch_with_price'
  | 'yield_missing'
  | 'auction_date_not_a_weekday'
  | 'auction_date_not_later_than_stored'
  | 'outside_plausible_band'
  | 'nsdp_mismatch'
  | 'single_read_needs_nsdp_match'
  | 'no_previous_observation_needs_nsdp_match'
  | 'non_wednesday_needs_nsdp_match'
  | 'conflicts_with_stored_value';

export type CheckState = 'pass' | 'fail' | 'unavailable' | 'not_run';

export interface RefreshChecks {
  agreement: CheckState;
  priceRecompute: CheckState;
  plausibleBand: CheckState;
  nsdpCrossCheck: CheckState;
  auctionDate: CheckState;
}

export type TbillRefreshOutcome =
  | { outcome: 'no_release_yet'; reason: string }
  | { outcome: 'noop_duplicate'; auctionDate: string }
  | { outcome: 'record_gap'; auctionDate: string; gapReason: 'no_accepted_bids'; extraction: RiskFreeExtractionProvenance }
  | { outcome: 'publish'; auctionDate: string; yieldPercent: number; extraction: RiskFreeExtractionProvenance; checks: RefreshChecks }
  | { outcome: 'review'; reasons: ReviewReason[]; checks: RefreshChecks; evidence: { parser: ParsedAuction | null; ai: ParsedAuction | null; nsdp: NsdpReading; lastStored: StoredTbill | null } };

/** yield (percent) = (100 - price) / price x 365 / 91 x 100. */
export function recomputeYieldPercent(cutoffPrice: number): number {
  return ((100 - cutoffPrice) / cutoffPrice) * (RISK_FREE_REFRESH_RULES.dayCountBasis / RISK_FREE_REFRESH_RULES.billDays) * 100;
}

const sameReading = (a: ParsedAuction, b: ParsedAuction): boolean =>
  a.auctionDate === b.auctionDate &&
  a.noAcceptedBids === b.noAcceptedBids &&
  (a.cutoffYieldPercent === b.cutoffYieldPercent || (a.cutoffYieldPercent !== null && b.cutoffYieldPercent !== null && Math.abs(a.cutoffYieldPercent - b.cutoffYieldPercent) < 1e-9));

const round2 = (n: number): number => Math.round(n * 100) / 100;
const dayOfWeek = (iso: string): number => new Date(`${iso}T00:00:00.000Z`).getUTCDay(); // 0 Sunday .. 6 Saturday

/**
 * The one decision for the T-bill refresh. Pure. The job writes ONLY what `publish` and `record_gap` say; a `review`
 * writes a review item (evidence attached) and publishes nothing.
 */
export function decideTbillRefresh(input: TbillRefreshInput): TbillRefreshOutcome {
  if (!input.releaseFound) return { outcome: 'no_release_yet', reason: 'No "Treasury Bills: Full Auction Result" release for the expected auction has been found yet; nothing is written and the next run tries again.' };

  const checks: RefreshChecks = { agreement: 'not_run', priceRecompute: 'not_run', plausibleBand: 'not_run', nsdpCrossCheck: 'not_run', auctionDate: 'not_run' };
  const evidence = { parser: input.parser, ai: input.ai, nsdp: input.nsdp, lastStored: input.lastStored };
  const review = (...reasons: ReviewReason[]): TbillRefreshOutcome => ({ outcome: 'review', reasons, checks, evidence });

  // ---- (a) the two reads -------------------------------------------------------
  if (input.parser === null && input.ai === null) return review('parser_failed_and_ai_unavailable');
  let method: RiskFreeExtractionProvenance['method'];
  let read: ParsedAuction;
  if (input.parser && input.ai) {
    if (!sameReading(input.parser, input.ai)) {
      checks.agreement = 'fail';
      return review('parser_ai_disagree');
    }
    checks.agreement = 'pass';
    method = 'parser+ai';
    read = input.parser;
  } else if (input.parser) {
    checks.agreement = 'unavailable';
    method = 'parser';
    read = input.parser;
  } else {
    checks.agreement = 'unavailable';
    method = 'ai';
    read = input.ai!;
  }
  const provenance = (checksPassed: string[]): RiskFreeExtractionProvenance => ({ pressReleaseNumber: read.releaseNumber, method, version: input.extractionVersion, checksPassed });

  // ---- the date --------------------------------------------------------------------
  const date = read.auctionDate;
  if (!date || !isValidIsoDate(date)) {
    checks.auctionDate = 'fail';
    return review('auction_date_missing_or_invalid');
  }

  // ---- no accepted bids: a GAP row, never a value --------------------------------
  if (read.noAcceptedBids) {
    if (input.storedOnDate?.kind === 'gap') return { outcome: 'noop_duplicate', auctionDate: date };
    if (input.storedOnDate?.kind === 'value') return review('conflicts_with_stored_value');
    return { outcome: 'record_gap', auctionDate: date, gapReason: 'no_accepted_bids', extraction: provenance(['gap_row_no_value']) };
  }

  // ---- idempotence -------------------------------------------------------------------
  if (read.cutoffYieldPercent === null) return review('yield_missing');
  const y = read.cutoffYieldPercent;
  // A GAP is already stored for that date but this release shows a value: never replace one with the other automatically.
  if (input.storedOnDate?.kind === 'gap') return review('conflicts_with_stored_value');
  if (input.storedOnDate?.kind === 'value') {
    return Math.abs(input.storedOnDate.yieldPercent - y) < 1e-9 ? { outcome: 'noop_duplicate', auctionDate: date } : review('conflicts_with_stored_value');
  }

  const reasons: ReviewReason[] = [];

  // ---- (d) the date -------------------------------------------------------------------
  const dow = dayOfWeek(date);
  const weekday = dow >= 1 && dow <= 5;
  const later = input.lastStored === null || date > input.lastStored.observationDate;
  checks.auctionDate = weekday && later ? 'pass' : 'fail';
  if (!weekday) reasons.push('auction_date_not_a_weekday');
  if (!later) reasons.push('auction_date_not_later_than_stored');

  // ---- (b) recompute from the printed price ----------------------------------------
  if (read.cutoffPrice === null) {
    checks.priceRecompute = 'fail';
    reasons.push('cutoff_price_missing_cannot_recompute');
  } else {
    const diff = Math.abs(recomputeYieldPercent(read.cutoffPrice) - y);
    checks.priceRecompute = diff <= RISK_FREE_REFRESH_RULES.yieldRecomputeTolerancePp ? 'pass' : 'fail';
    if (checks.priceRecompute === 'fail') reasons.push('printed_yield_mismatch_with_price');
  }

  // ---- (c) plausibility ------------------------------------------------------------
  if (input.lastStored === null) checks.plausibleBand = 'unavailable';
  else {
    checks.plausibleBand = Math.abs(y - input.lastStored.yieldPercent) <= RISK_FREE_REFRESH_RULES.weekOnWeekBandPp ? 'pass' : 'fail';
    if (checks.plausibleBand === 'fail') reasons.push('outside_plausible_band');
  }
  if (input.nsdp.state === 'value' && input.nsdp.yield91dPercent !== null) {
    checks.nsdpCrossCheck = Math.abs(round2(y) - input.nsdp.yield91dPercent) < RISK_FREE_REFRESH_RULES.nsdpToleranceUpToPp ? 'pass' : 'fail';
    if (checks.nsdpCrossCheck === 'fail') reasons.push('nsdp_mismatch');
  } else {
    checks.nsdpCrossCheck = 'unavailable';
  }

  // ---- rules that need the NSDP match when the evidence is thinner -----------------
  const nsdpMatches = checks.nsdpCrossCheck === 'pass';
  if (!nsdpMatches && checks.nsdpCrossCheck !== 'fail') {
    if (method !== 'parser+ai') reasons.push('single_read_needs_nsdp_match');
    if (checks.plausibleBand === 'unavailable') reasons.push('no_previous_observation_needs_nsdp_match');
    if (dow !== 3) reasons.push('non_wednesday_needs_nsdp_match');
  }

  if (reasons.length > 0) return review(...reasons);
  const passed = [
    ...(checks.agreement === 'pass' ? ['parser_ai_agreement'] : []),
    'price_recompute',
    ...(checks.plausibleBand === 'pass' ? ['plausible_band'] : []),
    ...(nsdpMatches ? ['nsdp_cross_check'] : []),
    'auction_date',
  ];
  return { outcome: 'publish', auctionDate: date, yieldPercent: y, extraction: provenance(passed), checks };
}

// ---------------------------------------------------------------------------
// Repo rate
// ---------------------------------------------------------------------------

export interface RepoRefreshInput {
  stored: { effectiveDate: string; ratePercent: number } | null;
  nsdp: NsdpReading;
  /** The Monetary Policy Statement evidence for a change, when one was found and read. */
  policyEvidence: { repoPercent: number; effectiveDate: string; document: string; url: string | null } | null;
  /** An administrator's explicit confirmation of the new rate (the manual path). */
  adminConfirmed: { repoPercent: number; effectiveDate: string } | null;
  todayIso: string;
}

export type RepoRefreshOutcome =
  | { outcome: 'no_nsdp_reading'; reason: string }
  | { outcome: 'confirm_unchanged'; verifiedThroughDate: string; evidence: string }
  | { outcome: 'publish_new_row'; effectiveDate: string; ratePercent: number; basis: 'policy_press_release' | 'admin_confirmation' }
  | { outcome: 'review'; reason: 'repo_change_without_policy_evidence' | 'no_stored_rate' | 'evidence_disagrees_with_nsdp' | 'evidence_date_not_after_stored' | 'evidence_date_in_future' };

const near = (a: number, b: number): boolean => Math.abs(a - b) < RISK_FREE_REFRESH_RULES.repoToleranceUpToPp;

/**
 * Weekly repo check. An unchanged rate advances the verified-through date and writes NO observation. A different NSDP
 * value is only a SIGNAL: a new row is appended only with the policy press release (or an admin's confirmation) as
 * evidence that agrees with it and carries an effective date after the stored one.
 */
export function decideRepoRefresh(input: RepoRefreshInput): RepoRefreshOutcome {
  if (input.nsdp.state !== 'value' || input.nsdp.policyRepoPercent === null) {
    return { outcome: 'no_nsdp_reading', reason: 'The weekly NSDP page gave no policy repo rate, so the series is neither confirmed nor changed; the verified-through date does not move.' };
  }
  if (input.stored === null) return { outcome: 'review', reason: 'no_stored_rate' };
  const seen = input.nsdp.policyRepoPercent;
  if (near(seen, input.stored.ratePercent)) {
    return { outcome: 'confirm_unchanged', verifiedThroughDate: input.nsdp.weekEnded, evidence: `NSDP week ended ${input.nsdp.weekEnded} shows ${seen}, equal to the stored rate` };
  }
  const evidence = input.policyEvidence ?? (input.adminConfirmed ? { repoPercent: input.adminConfirmed.repoPercent, effectiveDate: input.adminConfirmed.effectiveDate } : null);
  if (!evidence) return { outcome: 'review', reason: 'repo_change_without_policy_evidence' };
  if (!near(evidence.repoPercent, seen)) return { outcome: 'review', reason: 'evidence_disagrees_with_nsdp' };
  if (evidence.effectiveDate <= input.stored.effectiveDate) return { outcome: 'review', reason: 'evidence_date_not_after_stored' };
  if (evidence.effectiveDate > input.todayIso) return { outcome: 'review', reason: 'evidence_date_in_future' };
  return { outcome: 'publish_new_row', effectiveDate: evidence.effectiveDate, ratePercent: evidence.repoPercent, basis: input.policyEvidence ? 'policy_press_release' : 'admin_confirmation' };
}

/** Whole days an auction release is overdue: from the expected Wednesday to today (for the dashboard / alert; 0 when not yet due). */
export function daysOverdue(expectedAuctionDate: string, todayIso: string): number {
  return Math.max(0, daysBetweenIso(expectedAuctionDate, todayIso));
}
