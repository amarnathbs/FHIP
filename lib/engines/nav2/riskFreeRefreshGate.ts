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
//   (e) PO DECISION 13-11-2026 ("option A"). The first real production dry run found that RBI's weekly NSDP page runs about two weeks BEHIND the
//       auction (on Friday 13-11-2026 its latest week was the one ended 30-10-2026), so a fresh auction can never be matched against it, and the
//       scheduled run has no AI second reading. The NSDP value is therefore compared ONLY when its week is the week of the auction. When the
//       page has not reached that week yet ("not_yet"), the parser's reading is published on the release's OWN checks alone: the yield follows
//       from the printed price, a Wednesday auction, later than the stored date, within the week-on-week band of a stored previous value. The row
//       carries the mark `nsdp_pending`, and when the page catches up the same week is compared (decideNsdpBackCheck): a disagreement is a review
//       item, never a silent change. An NSDP page that cannot be read, or whose week is LATER than the auction's, still sends the case to review.
//   Idempotent: the same week again changes nothing; a DIFFERENT value for a stored date is
//   a review item, never an overwrite.
//   No accepted bids: a GAP row is recorded, never a value.
//   Repo rate: a change is detected from the NSDP weekly value differing from the stored
//   rate, and is appended ONLY with the monetary-policy press release as evidence (or an
//   admin's confirmation); otherwise it is a review item. An unchanged rate advances the
//   dataset's verified-through date and writes no observation.

import { addDaysIso, daysBetweenIso, isValidIsoDate } from './dates';
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

/** The shape of a fetch policy (the constants above are one; the staged steps below are others). */
export interface FetchPolicy {
  maxRequestsPerRun: number;
  minSpacingMs: number;
  userAgent: string;
  conditionalRequests: boolean;
  honourRobotsTxt: boolean;
  maxResponseBytes: number;
  perRequestTimeoutMs: number;
  runDeadlineMs: number;
  allowPdf: boolean;
  bypassHumanVerification: boolean;
}

/**
 * THE 28-SECOND RULE (found 09-11-2026 by the first real production dry run: HTTP 504, empty body). Amplify ends every request at 28 seconds
 * whatever the route declares (docs/nav2/NAV2_PRODUCTION_RELEASE_PLAN.md), and one run of robots + listing + release + weekly page at 4 seconds
 * spacing over a slow site does not fit. The run is therefore cut into three STEPS, each its own short request, each remembering what it read
 * in ii_risk_free_refresh_stage so the next one needs nothing from the page:
 *   listing  robots.txt + the month listing (+ the month archive when the listing shows another month)  -> where the release is
 *   release  the one "Treasury Bills: Full Auction Result" release -> the numbers on it
 *   decide   the weekly NSDP page -> cross-check, decision, writes
 * A step never starts a request after STEP_DEADLINE_MS and no request may last longer than the per-request timeout, so a step ends in about
 * 12 + 10 seconds at the very worst, plus the database. The request budget over the three steps is the same four pages as before.
 */
export type RefreshStep = 'listing' | 'release' | 'decide';
export const RISK_FREE_REFRESH_STEP_MAX_REQUESTS: Record<RefreshStep, number> = { listing: 2, release: 1, decide: 1 };
export const RISK_FREE_REFRESH_STEP_DEADLINE_MS = 12_000;
export const RISK_FREE_REFRESH_STEP_REQUEST_TIMEOUT_MS = 10_000;
/** After a refusal (a verification page, a robots refusal) or a release that is not out yet, the job makes NO further request for this long. */
export const RISK_FREE_REFRESH_COOL_OFF_HOURS = 6;

export function stepFetchPolicy(step: RefreshStep): FetchPolicy {
  return { ...RISK_FREE_REFRESH_FETCH_POLICY, maxRequestsPerRun: RISK_FREE_REFRESH_STEP_MAX_REQUESTS[step], runDeadlineMs: RISK_FREE_REFRESH_STEP_DEADLINE_MS, perRequestTimeoutMs: RISK_FREE_REFRESH_STEP_REQUEST_TIMEOUT_MS };
}

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
  /**
   * True when this is a CATCH-UP: an earlier missed auction being loaded now. The caller asserts that no row exists for that week. Then (and only
   * then) a date EARLIER than the latest stored value is acceptable, and a weekly page that has already moved past the auction's week is "not
   * comparable" instead of a reason to review.
   */
  catchUp?: boolean;
  /** The latest stored value strictly BEFORE the candidate date: the band reference for a catch-up that is earlier than the latest stored value. */
  previousStored?: StoredTbill | null;
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
  | 'conflicts_with_stored_value'
  /** A value published before the NSDP page reached its week was compared with that week later and DIFFERS. */
  | 'nsdp_backcheck_mismatch';

/** not_yet = the weekly page has not reached the auction's week (it runs about two weeks behind); unavailable = unreadable, or its week is later than the auction's. */
export type CheckState = 'pass' | 'fail' | 'unavailable' | 'not_yet' | 'not_run';

/** Written into `checksPassed` of a value published before the weekly page reached its week: the mark the later back-check looks for. */
export const NSDP_PENDING_CHECK = 'nsdp_pending';
/**
 * Written instead of nsdp_pending for a CATCH-UP value (an earlier missed auction loaded later) whose week the weekly page has already moved past:
 * the page can never be compared with it, so the back-check does not look for it. It is published on the release's own checks only.
 */
export const NSDP_NOT_COMPARABLE_CHECK = 'nsdp_not_comparable';

// ---------------------------------------------------------------------------
// CATCH-UP (PO decision 13-11-2026): an auction that was missed (the release was out of reach in every window of its week) is loaded later,
// while it is still inside the look-back window, by the same gate. Pure helpers: which Wednesdays to look at, and which of them have no row.
// ---------------------------------------------------------------------------
/** How many weeks before the current one a missed auction is still looked for. */
export const CATCH_UP_LOOKBACK_WEEKS = 4;

/** The latest Wednesday on or before the date (ISO). */
export function wednesdayOnOrBefore(iso: string): string {
  const dow = new Date(`${iso}T00:00:00.000Z`).getUTCDay(); // 0 Sunday .. 6 Saturday
  return addDaysIso(iso, -((dow + 4) % 7));
}

/** The Wednesdays of the look-back window, newest first, NOT including the current week's one. */
export function earlierAuctionWednesdays(todayIso: string, lookbackWeeks: number = CATCH_UP_LOOKBACK_WEEKS): string[] {
  const current = wednesdayOnOrBefore(todayIso);
  return Array.from({ length: lookbackWeeks }, (_, i) => addDaysIso(current, -7 * (i + 1)));
}

/**
 * A week's auction is "covered" when ANY stored row (a value or a documented gap) is dated Monday to Friday of that week. That is what keeps a
 * holiday-shifted Thursday auction from being mistaken for a missing Wednesday.
 */
export function isAuctionWeekCovered(wednesday: string, storedDates: readonly string[]): boolean {
  const from = addDaysIso(wednesday, -2);
  const to = addDaysIso(wednesday, 2);
  return storedDates.some((d) => d >= from && d <= to);
}

/** The earlier Wednesdays with no stored row, newest first. */
export function missingEarlierAuctions(todayIso: string, storedDates: readonly string[], lookbackWeeks: number = CATCH_UP_LOOKBACK_WEEKS): string[] {
  return earlierAuctionWednesdays(todayIso, lookbackWeeks).filter((w) => !isAuctionWeekCovered(w, storedDates));
}

/**
 * The moment after which a current week that is still not loaded counts as MISSED (an e-mail is sent once): Saturday 03:44 UTC, just before the
 * last call of the Saturday window, which is the final retry of the week. Wednesday + 3 days = Saturday.
 */
export function missedDeadlineMs(wednesday: string): number {
  return Date.parse(`${addDaysIso(wednesday, 3)}T03:44:00.000Z`);
}

export type NsdpCoverage = 'covers' | 'not_yet' | 'later_week' | 'no_reading';

/**
 * Does the weekly page's (latest) week contain this auction? The page's week ends on a Friday, so a Wednesday auction is covered when the week
 * ended 0 to 6 days after it. An earlier week = the page has not caught up (not_yet); a later one = the page no longer shows the auction's week.
 */
export function nsdpCoverage(nsdp: NsdpReading, auctionDate: string): NsdpCoverage {
  if (nsdp.state !== 'value' || nsdp.yield91dPercent === null) return 'no_reading';
  const days = daysBetweenIso(auctionDate, nsdp.weekEnded);
  if (days < 0) return 'not_yet';
  return days <= 6 ? 'covers' : 'later_week';
}

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
  // A catch-up is, by definition, an earlier week that has no row yet: "later than the stored value" does not apply to it (the stored-on-date
  // checks above already guarantee nothing is stored for this exact date). Everything else about the date still applies.
  const backfill = input.catchUp === true && !later;
  checks.auctionDate = weekday && (later || backfill) ? 'pass' : 'fail';
  if (!weekday) reasons.push('auction_date_not_a_weekday');
  if (!later && !backfill) reasons.push('auction_date_not_later_than_stored');

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
  // The band reference is the latest stored value; for a catch-up earlier than that it is the nearest stored value BEFORE the date.
  const bandReference = backfill ? (input.previousStored ?? null) : input.lastStored;
  if (bandReference === null) checks.plausibleBand = 'unavailable';
  else {
    checks.plausibleBand = Math.abs(y - bandReference.yieldPercent) <= RISK_FREE_REFRESH_RULES.weekOnWeekBandPp ? 'pass' : 'fail';
    if (checks.plausibleBand === 'fail') reasons.push('outside_plausible_band');
  }
  // The weekly page is compared ONLY when its week is the week of this auction (option A, see the header). A page that has not reached the week yet
  // is "not_yet", never a mismatch: comparing it with an older week's yield would reject nearly every fresh auction.
  const coverage = nsdpCoverage(input.nsdp, date);
  if (coverage === 'covers' && input.nsdp.state === 'value' && input.nsdp.yield91dPercent !== null) {
    checks.nsdpCrossCheck = Math.abs(round2(y) - input.nsdp.yield91dPercent) < RISK_FREE_REFRESH_RULES.nsdpToleranceUpToPp ? 'pass' : 'fail';
    if (checks.nsdpCrossCheck === 'fail') reasons.push('nsdp_mismatch');
  } else {
    // A catch-up whose week the page has already moved past can never be compared with it: not comparable (published on the release's own checks).
    const notComparable = input.catchUp === true && coverage === 'later_week';
    checks.nsdpCrossCheck = coverage === 'not_yet' || notComparable ? 'not_yet' : 'unavailable';
  }

  // ---- rules that need the NSDP match when the evidence is thinner -----------------
  const nsdpMatches = checks.nsdpCrossCheck === 'pass';
  const nsdpPending = checks.nsdpCrossCheck === 'not_yet';
  if (!nsdpMatches && checks.nsdpCrossCheck !== 'fail') {
    // Pending: the parser's reading stands on the release's own checks (the other rules below still apply), but a reading that is the AI's ALONE, with
    // the fixed parser failed, still needs the NSDP match. Everything else (unreadable page, a later week) keeps the original rule.
    if (nsdpPending ? method === 'ai' : method !== 'parser+ai') reasons.push('single_read_needs_nsdp_match');
    if (checks.plausibleBand === 'unavailable') reasons.push('no_previous_observation_needs_nsdp_match');
    if (dow !== 3) reasons.push('non_wednesday_needs_nsdp_match');
  }

  if (reasons.length > 0) return review(...reasons);
  const passed = [
    ...(checks.agreement === 'pass' ? ['parser_ai_agreement'] : []),
    'price_recompute',
    ...(checks.plausibleBand === 'pass' ? ['plausible_band'] : []),
    ...(nsdpMatches ? ['nsdp_cross_check'] : []),
    ...(nsdpPending ? [coverage === 'later_week' ? NSDP_NOT_COMPARABLE_CHECK : NSDP_PENDING_CHECK] : []),
    'auction_date',
  ];
  return { outcome: 'publish', auctionDate: date, yieldPercent: y, extraction: provenance(passed), checks };
}

// ---------------------------------------------------------------------------
// The later back-check of a value published before the weekly page reached its week
// ---------------------------------------------------------------------------

export interface PendingStoredValue {
  observationDate: string;
  yieldPercent: number;
}

export interface NsdpBackCheck {
  /** Stored values (marked nsdp_pending) whose week the page now shows. */
  checked: number;
  matched: PendingStoredValue[];
  mismatched: Array<PendingStoredValue & { nsdpYieldPercent: number; nsdpWeekEnded: string }>;
}

/**
 * Pure. For each stored value that was published on the release's own checks (the caller passes only those), compare it with the weekly page when the
 * page's week is that value's week. Values of other weeks are left alone (they are checked on the run where the page shows their week). A match
 * changes nothing. A disagreement is returned for a REVIEW ITEM: the stored value is never changed here.
 */
export function decideNsdpBackCheck(nsdp: NsdpReading, pending: PendingStoredValue[]): NsdpBackCheck {
  const out: NsdpBackCheck = { checked: 0, matched: [], mismatched: [] };
  if (nsdp.state !== 'value' || nsdp.yield91dPercent === null) return out;
  for (const p of pending) {
    if (nsdpCoverage(nsdp, p.observationDate) !== 'covers') continue;
    out.checked += 1;
    if (Math.abs(round2(p.yieldPercent) - nsdp.yield91dPercent) < RISK_FREE_REFRESH_RULES.nsdpToleranceUpToPp) out.matched.push(p);
    else out.mismatched.push({ ...p, nsdpYieldPercent: nsdp.yield91dPercent, nsdpWeekEnded: nsdp.weekEnded });
  }
  return out;
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
