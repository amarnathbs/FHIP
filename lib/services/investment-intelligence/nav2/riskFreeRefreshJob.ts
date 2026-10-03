// NAV2 Stage 2 -- the weekly risk-free refresh: read RBI's HTML politely, read it twice (deterministic parser, AI second opinion),
// decide with the Stage 1 publication gate, and write ONLY what the gate says through the service-role database function.
//
// ORDER OF THINGS (and what each gives up):
//   1. planRefreshRun: the kill switch comes FIRST. Switch off = zero requests, zero writes. A dry run reads and decides, writes nothing.
//   2. the expected auction is the latest Wednesday on or before today; nothing is fetched for the T-bill if the stored series
//      already reaches it (the repo-rate check still needs the NSDP page, so that one page is read).
//   3. T-bill: listing -> the one release -> parser (+ AI when its kill switch is on) + NSDP -> decideTbillRefresh:
//        publish | record_gap (no accepted bids) | noop | review (evidence attached, NOTHING published) | no_release_yet (a late release is retried next week; nothing written).
//   4. repo rate: the NSDP value equal to the stored rate advances `verified_through_date` and writes no observation; a DIFFERENT value
//      is only a signal: it becomes a review item (a new row needs the monetary-policy statement as evidence or an administrator's
//      confirmation by upload), never an automatic row.
//   5. every write is ONE call to record_risk_free_refresh_results() (service role only): idempotent, append-only, a conflicting value
//      is queued for review by the function itself, never overwritten.
//
// No page is cached, stored or republished: only the extracted numbers and the pointer to the publication (release number, date, URL).
// The job NEVER bypasses a verification page, never requests a document, and stops at the first fetch problem (the report names it).

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decideRepoRefresh,
  decideTbillRefresh,
  planRefreshRun,
  type NsdpReading,
  type ParsedAuction,
  type RepoRefreshOutcome,
  type StoredTbill,
  type TbillRefreshOutcome,
} from '@/lib/engines/nav2/riskFreeRefreshGate';
import { RbiFetchError } from './rbiFetcher';
import { auctionTextForAi, parseAuctionResultHtml, parseNsdpHtml, RBI_HTML_READER_VERSION } from './rbiHtml';
import type { AiAuctionReader } from './rbiAiReader';
import type { RbiSource } from './rbiSource';
import { dmy } from './riskFreeCsv';

export const RISK_FREE_REFRESH_JOB_VERSION = `nav2-risk-free-refresh-job-v1+${RBI_HTML_READER_VERSION}`;
export const TBILL_SERIES = 'RBI_91D_TBILL_CUTOFF_YIELD';
export const REPO_SERIES = 'RBI_POLICY_REPO_RATE';

export function latestWednesdayOnOrBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 4) % 7)); // Wednesday = 3: (dow - 3 + 7) % 7 days back
  return d.toISOString().slice(0, 10);
}

export interface RefreshRunReport {
  version: string;
  mode: 'skipped_kill_switch' | 'dry_run' | 'live';
  asOfDate: string;
  expectedAuctionDate: string;
  requests: { pages: number; robots: number };
  fetchProblem: { code: string; message: string } | null;
  tbill: { outcome: TbillRefreshOutcome['outcome'] | 'up_to_date' | 'not_attempted'; detail: string; reasons?: string[]; auctionDate?: string; yieldPercent?: number } | null;
  repo: { outcome: RepoRefreshOutcome['outcome'] | 'not_attempted'; detail: string } | null;
  wrote: { tbill: { inserted: number; identical: number; queued: number } | null; repo: { inserted: number; identical: number; queued: number } | null };
}

interface RpcRow {
  date: string;
  kind: 'value' | 'gap';
  value_percent: number | null;
  gap_reason: 'no_accepted_bids' | null;
  source_document: string;
  source_url: string | null;
  retrieved_on: string;
  notes: string | null;
  extraction: unknown;
}

interface RpcReview {
  observation_date: string | null;
  reasons: string[];
  candidate: RpcRow | null;
  evidence: unknown;
}

async function lastValue(admin: SupabaseClient, seriesId: string): Promise<StoredTbill | null> {
  const { data, error } = await admin.from('ii_risk_free_observations').select('observation_date, value_percent').eq('series_id', seriesId).eq('kind', 'value').order('observation_date', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error('The stored series could not be read.');
  if (!data) return null;
  const r = data as { observation_date: string; value_percent: number | string };
  return { observationDate: String(r.observation_date).slice(0, 10), yieldPercent: Number(r.value_percent) };
}

async function storedOn(admin: SupabaseClient, seriesId: string, date: string): Promise<{ kind: 'value'; yieldPercent: number } | { kind: 'gap' } | null> {
  const { data, error } = await admin.from('ii_risk_free_observations').select('kind, value_percent').eq('series_id', seriesId).eq('observation_date', date).maybeSingle();
  if (error) throw new Error('The stored series could not be read.');
  if (!data) return null;
  const r = data as { kind: string; value_percent: number | string | null };
  return r.kind === 'gap' ? { kind: 'gap' } : { kind: 'value', yieldPercent: Number(r.value_percent) };
}

function sourceDocument(read: ParsedAuction): string {
  return `RBI press release ${read.releaseNumber ?? '(number not read)'} '${read.title}' dated ${read.auctionDate ? dmy(read.auctionDate) : 'unknown date'}; row III Cut-off price/Yield (91-Day), YTM`;
}

function candidateFrom(read: ParsedAuction | null, url: string | null, todayIso: string, extraction: unknown): RpcRow | null {
  if (!read || !read.auctionDate) return null;
  if (read.noAcceptedBids) return { date: read.auctionDate, kind: 'gap', value_percent: null, gap_reason: 'no_accepted_bids', source_document: sourceDocument(read), source_url: url, retrieved_on: todayIso, notes: null, extraction };
  if (read.cutoffYieldPercent === null) return null;
  return { date: read.auctionDate, kind: 'value', value_percent: read.cutoffYieldPercent, gap_reason: null, source_document: sourceDocument(read), source_url: url, retrieved_on: todayIso, notes: read.cutoffPrice !== null ? `cut-off price ${read.cutoffPrice}` : null, extraction };
}

export interface RefreshJobInput {
  admin: SupabaseClient;
  source: RbiSource;
  ai: AiAuctionReader | null;
  /** The job-control switch. */
  enabled: boolean;
  /** Reads and decides but writes nothing. */
  dryRun: boolean;
  todayIso: string;
}

export async function runRiskFreeRefresh(input: RefreshJobInput): Promise<RefreshRunReport> {
  const plan = planRefreshRun({ enabled: input.enabled, dryRun: input.dryRun });
  const expected = latestWednesdayOnOrBefore(input.todayIso);
  const report: RefreshRunReport = {
    version: RISK_FREE_REFRESH_JOB_VERSION,
    mode: plan.mode,
    asOfDate: input.todayIso,
    expectedAuctionDate: expected,
    requests: { pages: 0, robots: 0 },
    fetchProblem: null,
    tbill: null,
    repo: null,
    wrote: { tbill: null, repo: null },
  };
  if (plan.mode === 'skipped_kill_switch') return report;

  const lastTbill = await lastValue(input.admin, TBILL_SERIES);
  const tbillDue = lastTbill === null || lastTbill.observationDate < expected;

  let release: { found: boolean; prid?: string; url?: string; releaseDate?: string; html?: string; reason?: string } = { found: false, reason: 'not attempted' };
  let nsdp: NsdpReading = { state: 'unavailable' };
  try {
    if (tbillDue) {
      const r = await input.source.findAuctionRelease(expected);
      release = r.found ? { found: true, prid: r.prid, url: r.url, releaseDate: r.releaseDate, html: r.html } : { found: false, reason: r.reason };
    }
    const nsdpHtml = await input.source.readNsdp();
    nsdp = nsdpHtml ? parseNsdpHtml(nsdpHtml) : { state: 'unavailable' };
  } catch (e) {
    // The first fetch problem stops the run: the report names it, nothing is guessed, nothing is written from partial evidence.
    report.requests = input.source.requestsMade();
    report.fetchProblem = e instanceof RbiFetchError ? { code: e.code, message: e.message } : { code: 'unexpected', message: 'The read failed.' };
    report.tbill = tbillDue ? { outcome: 'not_attempted', detail: 'The read stopped before a decision could be made.' } : null;
    report.repo = { outcome: 'not_attempted', detail: 'The read stopped before a decision could be made.' };
    return report;
  }
  report.requests = input.source.requestsMade();

  const tbillRows: RpcRow[] = [];
  const tbillReviews: RpcReview[] = [];
  const repoReviews: RpcReview[] = [];
  let repoVerifiedThrough: string | null = null;

  // ---- T-bill ---------------------------------------------------------------------------------------------------
  if (!tbillDue) {
    report.tbill = { outcome: 'up_to_date', detail: `The stored series already reaches the expected auction (${dmy(expected)}); nothing was fetched for it.` };
  } else {
    let parser: ParsedAuction | null = release.found && release.html ? parseAuctionResultHtml(release.html) : null;
    // The date on the page must be the date the listing gave it; a mismatch means the reader is confused, so it is not trusted.
    if (parser && release.releaseDate && parser.auctionDate !== release.releaseDate) parser = null;
    let ai: ParsedAuction | null = null;
    if (release.found && release.html && input.ai) {
      try {
        ai = await input.ai.read(auctionTextForAi(release.html));
      } catch {
        ai = null;
      }
    }
    const candidateDate = parser?.auctionDate ?? ai?.auctionDate ?? null;
    const stored = candidateDate ? await storedOn(input.admin, TBILL_SERIES, candidateDate) : null;
    const decision = decideTbillRefresh({ releaseFound: release.found, parser, ai, nsdp, lastStored: lastTbill, storedOnDate: stored, extractionVersion: RISK_FREE_REFRESH_JOB_VERSION });
    const detailFor = (d: TbillRefreshOutcome): string =>
      d.outcome === 'publish' ? `Published ${dmy(d.auctionDate)} at ${d.yieldPercent}% (checks: ${d.extraction.checksPassed.join(', ')}).`
      : d.outcome === 'record_gap' ? `Recorded a gap for ${dmy(d.auctionDate)}: no accepted bids.`
      : d.outcome === 'noop_duplicate' ? `${dmy(d.auctionDate)} is already stored with the same value.`
      : d.outcome === 'no_release_yet' ? d.reason
      : `Not published: sent to review (${d.reasons.join(', ')}).`;
    report.tbill = { outcome: decision.outcome, detail: detailFor(decision), ...(decision.outcome === 'review' ? { reasons: decision.reasons } : {}), ...(decision.outcome === 'publish' ? { auctionDate: decision.auctionDate, yieldPercent: decision.yieldPercent } : {}) };
    if (decision.outcome === 'publish') {
      tbillRows.push({ date: decision.auctionDate, kind: 'value', value_percent: decision.yieldPercent, gap_reason: null, source_document: sourceDocument((parser ?? ai) as ParsedAuction), source_url: release.url ?? null, retrieved_on: input.todayIso, notes: (parser ?? ai)?.cutoffPrice != null ? `cut-off price ${(parser ?? ai)?.cutoffPrice}` : null, extraction: decision.extraction });
    } else if (decision.outcome === 'record_gap') {
      tbillRows.push({ date: decision.auctionDate, kind: 'gap', value_percent: null, gap_reason: 'no_accepted_bids', source_document: sourceDocument((parser ?? ai) as ParsedAuction), source_url: release.url ?? null, retrieved_on: input.todayIso, notes: null, extraction: decision.extraction });
    } else if (decision.outcome === 'review') {
      const best = parser ?? ai;
      tbillReviews.push({ observation_date: best?.auctionDate ?? release.releaseDate ?? null, reasons: decision.reasons, candidate: candidateFrom(best, release.url ?? null, input.todayIso, { pressReleaseNumber: best?.releaseNumber ?? null, method: parser && ai ? 'parser+ai' : parser ? 'parser' : 'ai', version: RISK_FREE_REFRESH_JOB_VERSION, checksPassed: [] }), evidence: decision.evidence });
    }
  }

  // ---- repo -------------------------------------------------------------------------------------------------------
  const lastRepo = await lastValue(input.admin, REPO_SERIES);
  const repoDecision = decideRepoRefresh({ stored: lastRepo ? { effectiveDate: lastRepo.observationDate, ratePercent: lastRepo.yieldPercent } : null, nsdp, policyEvidence: null, adminConfirmed: null, todayIso: input.todayIso });
  report.repo = {
    outcome: repoDecision.outcome,
    detail:
      repoDecision.outcome === 'confirm_unchanged' ? `Unchanged: ${repoDecision.evidence}; verified through ${dmy(repoDecision.verifiedThroughDate)}.`
      : repoDecision.outcome === 'no_nsdp_reading' ? repoDecision.reason
      : repoDecision.outcome === 'publish_new_row' ? 'A new policy rate was confirmed.'
      : `Not changed: sent to review (${repoDecision.reason}).`,
  };
  if (repoDecision.outcome === 'confirm_unchanged') repoVerifiedThrough = repoDecision.verifiedThroughDate;
  else if (repoDecision.outcome === 'review') repoReviews.push({ observation_date: nsdp.state === 'value' ? nsdp.weekEnded : null, reasons: [repoDecision.reason], candidate: null, evidence: { nsdp, stored: lastRepo } });

  if (!plan.mayWrite) return report; // dry run: decisions only

  // ---- writes: one service-role function call per series that has something to record ---------------------------
  const call = async (seriesId: string, rows: RpcRow[], reviews: RpcReview[], verified: string | null): Promise<{ inserted: number; identical: number; queued: number } | null> => {
    if (rows.length === 0 && reviews.length === 0 && verified === null) return null;
    const { data, error } = await input.admin.rpc('record_risk_free_refresh_results', { p_series_id: seriesId, p_rows: rows, p_review_items: reviews, p_verified_through: verified });
    if (error) throw new Error('The refresh results could not be recorded.');
    const o = data as { inserted?: number; identical?: number; queued?: number };
    return { inserted: o.inserted ?? 0, identical: o.identical ?? 0, queued: o.queued ?? 0 };
  };
  report.wrote.tbill = await call(TBILL_SERIES, tbillRows, tbillReviews, null);
  report.wrote.repo = await call(REPO_SERIES, [], repoReviews, repoVerifiedThrough);
  return report;
}
