// NAV2 -- the weekly RBI refresh, run as THREE SHORT STEPS instead of one long request.
//
// WHY. The first real production dry run (09-11-2026) answered HTTP 504 with no body: Amplify ends every request at 28 seconds whatever the
// route declares, and robots.txt + month listing + release + weekly page, paced politely, did not fit. Each call to the route now does ONE step
// and remembers what it read in ii_risk_free_refresh_stage (numbers and pointers only, never page text):
//
//   listing  robots.txt + the month listing (+ the month archive when the listing shows another month)  -> where the release is
//   release  the one "Treasury Bills: Full Auction Result" release  -> parser (+ AI when a reader exists) readings
//   decide   the weekly NSDP page  -> the SAME decision and writes as the one-request run (finishRefresh), then the week is done
//
// The route simply calls "the next step": the schedule fires it a few times, five minutes apart, and each call advances the week by one step.
// A call that finds nothing to do (the week is done, or RBI refused and the job is cooling off) makes NO request to RBI.
//
// SAFETY, unchanged: the kill switch comes first (off = no request, no read of the stage table, no write); a dry run decides and writes no rate,
// no review item and no job-control change (its only write is the scratch row in the stage table, which is how the three dry-run calls pass
// their readings on); a refusal by RBI (403, 429, a verification page, a robots refusal) stops the job and it makes no further request for six
// hours; every decision and every write is exactly the gate's (finishRefresh), so the staged run cannot decide differently from the one-request run.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isAuctionWeekCovered, missedDeadlineMs, missingEarlierAuctions, earlierAuctionWednesdays, planRefreshRun, RISK_FREE_REFRESH_COOL_OFF_HOURS, type NsdpReading, type ParsedAuction, type RefreshStep } from '@/lib/engines/nav2/riskFreeRefreshGate';
import { addDaysIso } from '@/lib/engines/nav2/dates';
import type { Mailer } from '@/lib/services/premiumReminderMailer';
import { sendRefreshAlert, type MailOutcome, type RefreshAlertInput } from './riskFreeRefreshAlert';
import { RbiFetchError, type RobotsOutcome } from './rbiFetcher';
import { parseNsdpHtml } from './rbiHtml';
import type { AiAuctionReader } from './rbiAiReader';
import type { ListingSearch, RbiSource } from './rbiSource';
import { finishRefresh, lastValue, lastValueBefore, latestWednesdayOnOrBefore, queueAlertItem, queueBlockedAlertResult, readReleaseFacts, RISK_FREE_REFRESH_JOB_VERSION, storedAuctionDates, TBILL_SERIES, type RefreshRunReport } from './riskFreeRefreshJob';
import { dmy } from './riskFreeCsv';

export const STAGE_TABLE = 'ii_risk_free_refresh_stage';
/** A stage row older than this with no outcome is abandoned and the week starts again from the listing step. */
const STALE_AFTER_MS = 48 * 3600 * 1000;
/** The robots.txt rules are kept for the later steps only when they are small. */
const ROBOTS_KEEP_MAX_CHARS = 20_000;
/** The weekly page is asked for at most this many times before the gate is allowed to decide without it (it then queues a review item). */
const NSDP_MAX_TRIES = 2;
/** Refusals that start a cooling-off period. A timeout, a network failure or a deadline is retried by the next call instead. */
const COOL_OFF_CODES = new Set(['human_verification', 'robots_unavailable', 'robots_disallowed', 'blocked_host', 'blocked_file_type']);

export interface StageEvidence {
  v: 1;
  jobVersion: string;
  startedOn: string;
  tbillDue: boolean;
  robots: { outcome: RobotsOutcome; text: string } | null;
  counts: { pages: number; robots: number };
  listing: ListingSearch | null;
  reading: { parser: ParsedAuction | null; ai: ParsedAuction | null } | null;
  nsdpTries: number;
  /** True when the cooling-off period of this row was started by a REFUSAL by RBI (not by a release that is merely not out yet): a refusal stops every auction. */
  refused?: boolean;
}

export interface StageRow {
  expectedAuctionDate: string;
  step: 'listing_done' | 'release_done';
  evidence: StageEvidence;
  retryNotBefore: string | null;
  decidedLiveAt: string | null;
  updatedAt: string;
}

export interface StageStore {
  load(expected: string): Promise<StageRow | null>;
  save(row: Omit<StageRow, 'updatedAt'>, nowIso: string): Promise<void>;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A stage row read back from the database is checked before it is trusted: anything unexpected means "start the week again". */
export function parseEvidence(x: unknown): StageEvidence | null {
  if (!isObj(x) || x.v !== 1 || typeof x.tbillDue !== 'boolean' || typeof x.startedOn !== 'string') return null;
  const c = x.counts;
  if (!isObj(c) || typeof c.pages !== 'number' || typeof c.robots !== 'number') return null;
  const l = x.listing;
  if (l !== null && !(isObj(l) && typeof l.found === 'boolean' && (l.found ? typeof l.url === 'string' && typeof l.releaseDate === 'string' && typeof l.prid === 'string' : typeof l.reason === 'string'))) return null;
  const r = x.reading;
  if (r !== null && !(isObj(r) && (r.parser === null || isObj(r.parser)) && (r.ai === null || isObj(r.ai)))) return null;
  const rb = x.robots;
  if (rb !== null && !(isObj(rb) && typeof rb.text === 'string' && (rb.outcome === 'robots_ok' || rb.outcome === 'robots_unavailable_continued'))) return null;
  return {
    v: 1,
    jobVersion: typeof x.jobVersion === 'string' ? x.jobVersion : '',
    startedOn: x.startedOn,
    tbillDue: x.tbillDue,
    robots: rb as StageEvidence['robots'],
    counts: { pages: c.pages, robots: c.robots },
    listing: l as ListingSearch | null,
    reading: r as StageEvidence['reading'],
    nsdpTries: typeof x.nsdpTries === 'number' ? x.nsdpTries : 0,
    refused: x.refused === true,
  };
}

export function createSupabaseStageStore(admin: SupabaseClient): StageStore {
  return {
    async load(expected) {
      const { data, error } = await admin.from(STAGE_TABLE).select('expected_auction_date, step, evidence, retry_not_before, decided_live_at, updated_at').eq('expected_auction_date', expected).maybeSingle();
      if (error) throw new Error('The refresh stage could not be read.');
      if (!data) return null;
      const d = data as { expected_auction_date: string; step: string; evidence: unknown; retry_not_before: string | null; decided_live_at: string | null; updated_at: string };
      const evidence = parseEvidence(d.evidence);
      if (!evidence || (d.step !== 'listing_done' && d.step !== 'release_done')) return null;
      return { expectedAuctionDate: String(d.expected_auction_date).slice(0, 10), step: d.step, evidence, retryNotBefore: d.retry_not_before, decidedLiveAt: d.decided_live_at, updatedAt: d.updated_at };
    },
    async save(row, nowIso) {
      const { error } = await admin.from(STAGE_TABLE).upsert({ expected_auction_date: row.expectedAuctionDate, step: row.step, evidence: row.evidence, retry_not_before: row.retryNotBefore, decided_live_at: row.decidedLiveAt, updated_at: nowIso }, { onConflict: 'expected_auction_date' });
      if (error) throw new Error('The refresh stage could not be saved.');
    },
  };
}

export type StepName = RefreshStep | 'complete' | 'waiting' | 'skipped_kill_switch';

export interface StepReport {
  version: string;
  mode: 'skipped_kill_switch' | 'dry_run' | 'live';
  asOfDate: string;
  expectedAuctionDate: string;
  step: StepName;
  detail: string;
  /** Requests made by THIS call only. */
  requests: { pages: number; robots: number };
  /** How long each request of this call took, in milliseconds (robots.txt first). */
  requestMillis: number[];
  elapsedMs: number;
  robots: RobotsOutcome;
  sourceStatus: 'ok' | 'blocked_by_source' | 'fetch_problem';
  fetchProblem: { code: string; message: string } | null;
  /** No request to RBI is made for this auction before this time. */
  retryNotBefore?: string;
  listing?: { found: boolean; releaseDate?: string; reason?: string };
  reading?: { parser: ParsedAuction | null; ai: ParsedAuction | null };
  tbill?: RefreshRunReport['tbill'];
  repo?: RefreshRunReport['repo'];
  wrote?: RefreshRunReport['wrote'];
  /** Earlier values published before the weekly page reached their week, compared with it now. Present on the decide step when the page was read. */
  backCheck?: RefreshRunReport['backCheck'];
  /** True when this call worked on an EARLIER missed auction (catch-up) instead of the current week's. */
  catchUp?: boolean;
  /** What happened to the alert e-mail of this call, when one was due. */
  mail?: MailOutcome;
  /** The whole week so far (all steps). Present on the decide step. */
  weekRequests?: { pages: number; robots: number };
}

/** One row for ii_risk_free_refresh_attempts plus the job-control bookkeeping. Present only for a LIVE call that ended the week or failed. */
export interface AttemptRecord {
  job_version: string;
  robots_outcome: RobotsOutcome;
  source_status: 'ok' | 'blocked_by_source' | 'fetch_problem';
  fetch_problem_code: string | null;
  tbill_outcome: string | null;
  repo_outcome: string | null;
  pages_requested: number;
  robots_requests: number;
  failed: boolean;
}

export interface StepInput {
  admin: SupabaseClient;
  store: StageStore;
  /** A source for one step, with the robots.txt rules an earlier step already read (null = read them). */
  makeSource: (step: RefreshStep, robots: { outcome: RobotsOutcome; text: string } | null) => RbiSource;
  ai: AiAuctionReader | null;
  enabled: boolean;
  dryRun: boolean;
  todayIso: string;
  nowIso: string;
  nowMs: () => number;
  /** Where an alert e-mail goes (live calls only). Absent or null = not configured: the review item still records the case. */
  alert?: { mailer: Mailer; to: string } | null;
}

export interface StepResult {
  report: StepReport;
  attempt: AttemptRecord | null;
}

const addHours = (iso: string, h: number): string => new Date(Date.parse(iso) + h * 3600 * 1000).toISOString();

function robotsToKeep(src: RbiSource, previous: StageEvidence['robots']): StageEvidence['robots'] {
  const snap = src.robotsSnapshot?.() ?? null;
  if (snap && snap.text.length <= ROBOTS_KEEP_MAX_CHARS) return snap;
  return snap ? null : previous;
}

async function runRefreshStepCore(input: StepInput): Promise<StepResult> {
  const t0 = input.nowMs();
  const plan = planRefreshRun({ enabled: input.enabled, dryRun: input.dryRun });
  const currentWed = latestWednesdayOnOrBefore(input.todayIso);
  // The auction THIS call works on: the current week's, or (catch-up) an earlier one that was missed. Chosen below, once the switch is known to be on.
  let expected = currentWed;
  let catchUp = false;
  const finish = (r: Omit<StepReport, 'version' | 'mode' | 'asOfDate' | 'expectedAuctionDate' | 'elapsedMs' | 'requestMillis' | 'requests' | 'robots' | 'sourceStatus' | 'fetchProblem'> & Partial<Pick<StepReport, 'requestMillis' | 'requests' | 'robots' | 'sourceStatus' | 'fetchProblem'>>, attempt: AttemptRecord | null = null): StepResult => ({
    report: { version: RISK_FREE_REFRESH_JOB_VERSION, mode: plan.mode, asOfDate: input.todayIso, expectedAuctionDate: expected, requests: { pages: 0, robots: 0 }, requestMillis: [], robots: 'not_read', sourceStatus: 'ok', fetchProblem: null, ...(catchUp ? { catchUp: true } : {}), ...r, elapsedMs: Math.max(0, input.nowMs() - t0) },
    attempt: plan.mayWrite ? attempt : null,
  });

  if (plan.mode === 'skipped_kill_switch') return finish({ step: 'skipped_kill_switch', detail: 'The weekly refresh switch is off, so no request was made to RBI and nothing was read or written.' });

  // ---- which auction: this week's, or an earlier one that was missed (catch-up) ---------------------------------
  const nowMs = Date.parse(input.nowIso);
  const candidates = [currentWed, ...earlierAuctionWednesdays(input.todayIso)];
  const rows = new Map<string, StageRow | null>();
  for (const w of candidates) rows.set(w, await input.store.load(w));
  const waitingFor = (r: StageRow | null | undefined): boolean => !!r?.retryNotBefore && Date.parse(r.retryNotBefore) > nowMs;
  // A refusal by RBI stops the WHOLE job, whichever auction was being read: no request for any week until the waiting time is over.
  const refusal = candidates.map((w) => rows.get(w)).find((r): r is StageRow => !!r && waitingFor(r) && r.evidence.refused === true);
  if (refusal && refusal.expectedAuctionDate !== currentWed) {
    return finish({ step: 'waiting', detail: `RBI refused a page while the auction of ${dmy(refusal.expectedAuctionDate)} was being read. No request is made for any auction before ${refusal.retryNotBefore}.`, retryNotBefore: refusal.retryNotBefore! });
  }
  // Catch-up: only once the current week is finished (done, or waiting for a release that is not out yet), newest missing week first, never a week that
  // was already decided or is cooling off.
  const currentRow = rows.get(currentWed) ?? null;
  if (!refusal && (currentRow?.decidedLiveAt || waitingFor(currentRow))) {
    const stored = await storedAuctionDates(input.admin, addDaysIso(candidates[candidates.length - 1], -2));
    for (const w of missingEarlierAuctions(input.todayIso, stored)) {
      const r = rows.get(w) ?? null;
      if (r?.decidedLiveAt || waitingFor(r)) continue;
      expected = w;
      catchUp = true;
      break;
    }
  }

  // ---- which step is next -------------------------------------------------------------------------------------
  let row = rows.get(expected) ?? null;
  if (row) {
    if (row.decidedLiveAt) return finish({ step: 'complete', detail: `The refresh for the auction of ${dmy(expected)} is already done (${row.decidedLiveAt}); nothing was requested.` });
    if (row.retryNotBefore) {
      if (Date.parse(row.retryNotBefore) > nowMs) return finish({ step: 'waiting', detail: `No request is made for the auction of ${dmy(expected)} before ${row.retryNotBefore} (RBI refused a page, or the release was not out yet).`, retryNotBefore: row.retryNotBefore });
      row = null; // the waiting time is over: start the week again
    } else if (nowMs - Date.parse(row.updatedAt) > STALE_AFTER_MS) {
      row = null;
    }
  }
  const step: RefreshStep = !row ? 'listing' : row.step === 'listing_done' ? 'release' : 'decide';

  const fail = async (e: unknown, src: RbiSource, evidence: StageEvidence, keepStep: 'listing_done' | 'release_done', total: { pages: number; robots: number }): Promise<StepResult> => {
    const problem = e instanceof RbiFetchError ? { code: e.code, message: e.message } : { code: 'unexpected', message: 'The read failed.' };
    const sourceStatus = problem.code === 'human_verification' ? 'blocked_by_source' : 'fetch_problem';
    const requests = src.requestsMade();
    const robots = src.robotsOutcome?.() ?? 'not_read';
    let retryNotBefore: string | undefined;
    if (COOL_OFF_CODES.has(problem.code)) {
      retryNotBefore = addHours(input.nowIso, RISK_FREE_REFRESH_COOL_OFF_HOURS);
      await input.store.save({ expectedAuctionDate: expected, step: keepStep, evidence: { ...evidence, counts: total, refused: true }, retryNotBefore, decidedLiveAt: null }, input.nowIso);
    }
    let alert: boolean | undefined;
    let alertNew = false;
    if (plan.mayWrite && sourceStatus === 'blocked_by_source') {
      const queued = await queueBlockedAlertResult(input.admin, problem, expected, input.todayIso);
      alert = queued.recorded;
      alertNew = queued.newlyQueued;
    }
    return finish(
      { step, detail: retryNotBefore ? `RBI refused or could not serve a page (${problem.code}). The job stops and makes no further request before ${retryNotBefore}.` : `A page could not be read (${problem.code}). Nothing was decided; the next call tries this step again.`, requests, requestMillis: src.requestMillis?.() ?? [], robots, sourceStatus, fetchProblem: problem, ...(retryNotBefore ? { retryNotBefore } : {}), ...(alert !== undefined ? { wrote: { tbill: null, repo: null, alert, ...(alertNew ? { alertNew: true } : {}) } } : {}) },
      { job_version: RISK_FREE_REFRESH_JOB_VERSION, robots_outcome: robots, source_status: sourceStatus, fetch_problem_code: problem.code, tbill_outcome: 'not_attempted', repo_outcome: 'not_attempted', pages_requested: total.pages, robots_requests: total.robots, failed: true },
    );
  };

  // ---- LISTING --------------------------------------------------------------------------------------------------
  if (step === 'listing') {
    const lastTbill = catchUp ? null : await lastValue(input.admin, TBILL_SERIES);
    const tbillDue = catchUp || lastTbill === null || lastTbill.observationDate < expected;
    const base: StageEvidence = { v: 1, jobVersion: RISK_FREE_REFRESH_JOB_VERSION, startedOn: input.todayIso, tbillDue, robots: null, counts: { pages: 0, robots: 0 }, listing: null, reading: null, nsdpTries: 0 };
    if (!tbillDue) {
      await input.store.save({ expectedAuctionDate: expected, step: 'release_done', evidence: base, retryNotBefore: null, decidedLiveAt: null }, input.nowIso);
      return finish({ step, detail: `The stored series already reaches the expected auction (${dmy(expected)}); no listing or release is read. The next call checks the weekly page for the policy rate.` });
    }
    const src = input.makeSource('listing', null);
    let listing: ListingSearch;
    try {
      listing = await src.findAuctionListing(expected);
    } catch (e) {
      return fail(e, src, base, 'listing_done', src.requestsMade());
    }
    const requests = src.requestsMade();
    const evidence: StageEvidence = { ...base, robots: robotsToKeep(src, null), counts: requests, listing };
    // Nothing to read when the release is not in the listing yet: go straight on to the decide step (which will say "not out yet").
    await input.store.save({ expectedAuctionDate: expected, step: listing.found ? 'listing_done' : 'release_done', evidence, retryNotBefore: null, decidedLiveAt: null }, input.nowIso);
    return finish({
      step,
      detail: listing.found ? `The release of ${dmy(listing.releaseDate)} was found in the listing. The next call reads it.` : `No "Treasury Bills: Full Auction Result" release for ${dmy(expected)} is in the listing yet. The next call checks the weekly page and records that it will try again.`,
      requests,
      requestMillis: src.requestMillis?.() ?? [],
      robots: src.robotsOutcome?.() ?? 'not_read',
      listing: listing.found ? { found: true, releaseDate: listing.releaseDate } : { found: false, reason: listing.reason },
    });
  }

  const ev = row!.evidence;

  // ---- RELEASE ---------------------------------------------------------------------------------------------------
  if (step === 'release') {
    if (ev.listing?.found !== true) {
      await input.store.save({ expectedAuctionDate: expected, step: 'release_done', evidence: ev, retryNotBefore: null, decidedLiveAt: null }, input.nowIso);
      return finish({ step, detail: 'There is no release to read; nothing was requested.' });
    }
    const src = input.makeSource('release', ev.robots);
    let html: string;
    try {
      html = await src.readReleasePage(ev.listing.url);
    } catch (e) {
      return fail(e, src, ev, 'listing_done', { pages: ev.counts.pages + src.requestsMade().pages, robots: ev.counts.robots + src.requestsMade().robots });
    }
    const made = src.requestsMade();
    const reading = await readReleaseFacts({ found: true, releaseDate: ev.listing.releaseDate, html }, input.ai);
    const evidence: StageEvidence = { ...ev, robots: robotsToKeep(src, ev.robots), counts: { pages: ev.counts.pages + made.pages, robots: ev.counts.robots + made.robots }, reading };
    await input.store.save({ expectedAuctionDate: expected, step: 'release_done', evidence, retryNotBefore: null, decidedLiveAt: null }, input.nowIso);
    return finish({
      step,
      detail: reading.parser ? `The release was read: auction ${reading.parser.auctionDate ? dmy(reading.parser.auctionDate) : 'date not read'}${reading.parser.noAcceptedBids ? ', no accepted bids' : `, 91-day cut-off yield ${reading.parser.cutoffYieldPercent}`}. The next call checks it against the weekly page and decides.` : 'The release could not be read by the fixed reader (a changed layout). The next call decides, and without a second reading nothing is published.',
      requests: made,
      requestMillis: src.requestMillis?.() ?? [],
      robots: src.robotsOutcome?.() ?? ev.robots?.outcome ?? 'not_read',
      reading,
    });
  }

  // ---- DECIDE ----------------------------------------------------------------------------------------------------
  const src = input.makeSource('decide', ev.robots);
  let nsdpHtml: string | null;
  try {
    nsdpHtml = await src.readNsdp();
  } catch (e) {
    return fail(e, src, ev, 'release_done', { pages: ev.counts.pages + src.requestsMade().pages, robots: ev.counts.robots + src.requestsMade().robots });
  }
  const made = src.requestsMade();
  const total = { pages: ev.counts.pages + made.pages, robots: ev.counts.robots + made.robots };
  if (nsdpHtml === null && ev.nsdpTries + 1 < NSDP_MAX_TRIES) {
    // The weekly page could not be read this time (a slow answer, a missing page). Ask once more on the next call before letting the gate
    // decide without it, so a passing hiccup does not turn into a review item.
    await input.store.save({ expectedAuctionDate: expected, step: 'release_done', evidence: { ...ev, robots: robotsToKeep(src, ev.robots), counts: total, nsdpTries: ev.nsdpTries + 1 }, retryNotBefore: null, decidedLiveAt: null }, input.nowIso);
    return finish({ step, detail: 'The weekly page could not be read this time. Nothing was decided; the next call asks once more.', requests: made, requestMillis: src.requestMillis?.() ?? [], robots: src.robotsOutcome?.() ?? 'not_read' });
  }
  const nsdp: NsdpReading = nsdpHtml ? parseNsdpHtml(nsdpHtml) : { state: 'unavailable' };
  const lastTbill = await lastValue(input.admin, TBILL_SERIES);
  const robots = src.robotsOutcome?.() ?? ev.robots?.outcome ?? 'not_read';
  const run: RefreshRunReport = { version: RISK_FREE_REFRESH_JOB_VERSION, mode: plan.mode, asOfDate: input.todayIso, expectedAuctionDate: expected, requests: total, robots, sourceStatus: 'ok', fetchProblem: null, tbill: null, repo: null, wrote: { tbill: null, repo: null } };
  const done = await finishRefresh({
    admin: input.admin,
    plan,
    report: run,
    expected,
    todayIso: input.todayIso,
    tbillDue: ev.tbillDue,
    lastTbill,
    catchUp,
    previousStored: catchUp ? await lastValueBefore(input.admin, TBILL_SERIES, expected) : null,
    release: ev.listing?.found ? { found: true, url: ev.listing.url, releaseDate: ev.listing.releaseDate } : { found: false },
    parser: ev.reading?.parser ?? null,
    ai: ev.reading?.ai ?? null,
    nsdp,
  });

  // A LIVE decision ends the week -- except "the release is not out yet", which waits and starts the week again later.
  let retryNotBefore: string | undefined;
  if (plan.mayWrite) {
    const notOutYet = done.tbill?.outcome === 'no_release_yet';
    retryNotBefore = notOutYet ? addHours(input.nowIso, RISK_FREE_REFRESH_COOL_OFF_HOURS) : undefined;
    await input.store.save({ expectedAuctionDate: expected, step: 'release_done', evidence: { ...ev, counts: total }, retryNotBefore: retryNotBefore ?? null, decidedLiveAt: notOutYet ? null : input.nowIso }, input.nowIso);
  }
  return finish(
    { step, detail: done.tbill?.detail ?? done.repo?.detail ?? 'Decided.', requests: made, requestMillis: src.requestMillis?.() ?? [], robots, tbill: done.tbill, repo: done.repo, wrote: done.wrote, ...(done.backCheck ? { backCheck: done.backCheck } : {}), weekRequests: total, ...(retryNotBefore ? { retryNotBefore } : {}) },
    { job_version: RISK_FREE_REFRESH_JOB_VERSION, robots_outcome: robots, source_status: 'ok', fetch_problem_code: null, tbill_outcome: done.tbill?.outcome ?? null, repo_outcome: done.repo?.outcome ?? null, pages_requested: total.pages, robots_requests: total.robots, failed: false },
  );
}

/**
 * The current week's auction is MISSED when, after the Saturday retry window, it is still undecided and the series has no row for that week.
 * Records ONE open review item (the database keeps one per series and date) and answers an alert only when it is NEW. Never throws.
 */
async function missedWeekAlert(input: StepInput, currentWed: string): Promise<RefreshAlertInput | null> {
  try {
    if (Date.parse(input.nowIso) < missedDeadlineMs(currentWed)) return null;
    const row = await input.store.load(currentWed);
    if (row?.decidedLiveAt) return null;
    const stored = await storedAuctionDates(input.admin, addDaysIso(currentWed, -2));
    if (isAuctionWeekCovered(currentWed, stored)) return null;
    const queued = await queueAlertItem(input.admin, {
      date: currentWed,
      reasons: ['week_not_loaded_after_retries'],
      evidence: { expectedAuctionDate: currentWed, detectedOn: input.todayIso, action: 'The weekly refresh could not load this auction in the Wednesday, Thursday, Friday and Saturday windows. It keeps looking back for four weeks. If RBI has published it, load it by upload.' },
    });
    return queued.newlyQueued ? { kind: 'week_not_loaded', auctionDate: currentWed } : null;
  } catch {
    return null;
  }
}

/**
 * One call of the weekly refresh: the step itself (runRefreshStepCore), then, for a LIVE call only, the alert e-mail when a case was NEWLY recorded
 * (RBI refused a page, a result needs review, or the week is still not loaded after the Saturday retry). A dry run never sends. A missing setting,
 * a mail provider that is down or a slow answer never changes the step's answer except for the `mail` line.
 */
export async function runRefreshStep(input: StepInput): Promise<StepResult> {
  const t0 = input.nowMs();
  const result = await runRefreshStepCore(input);
  const r = result.report;
  if (r.mode !== 'live') return result;
  let alert: RefreshAlertInput | null = null;
  if (r.sourceStatus === 'blocked_by_source' && r.wrote?.alertNew === true) {
    alert = { kind: 'blocked', auctionDate: r.expectedAuctionDate };
  } else if (r.step === 'decide') {
    const queued = (r.wrote?.tbill?.queued ?? 0) + (r.wrote?.repo?.queued ?? 0);
    const needsAttention = r.tbill?.outcome === 'review' || r.repo?.outcome === 'review' || (r.backCheck?.mismatched ?? 0) > 0;
    if (needsAttention && queued > 0) alert = { kind: 'needs_review', auctionDate: r.expectedAuctionDate, reasons: r.tbill?.reasons };
  }
  if (!alert) alert = await missedWeekAlert(input, latestWednesdayOnOrBefore(input.todayIso));
  if (!alert) return result;
  const mail = await sendRefreshAlert({ mailer: input.alert?.mailer, to: input.alert?.to, alert, usedMs: input.nowMs() - t0 });
  return { ...result, report: { ...result.report, mail } };
}
