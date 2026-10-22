// "Generate all my funds" (PO decision 20-10-2026, option B). ONE REPORT still covers at most FUND_ANALYTICS_MAX_FUNDS funds (the 22 s request budget is
// untouched). A person who holds more can press one button; the screen then asks for their reports ONE AFTER THE OTHER, in batches of at most that many
// funds (the largest by current value first, then the next ones; 17 funds are 10 + 7). Every batch is a normal request to the same endpoint: its own
// funds, its own Idempotency-Key, its own 22 s budget, its own saved version. Nothing here weakens the server: it still decides the 10-fund limit,
// Premium and whose funds these are.
//
// This module is PURE (no React, no fetch, no timers of its own): the request and the waiting are injected, so the sequencing, the key per batch, the
// retry handling and the partial-failure state are unit-tested without a browser. The screen (components/reports/FundAnalyticsReportClient.tsx) only
// renders the state and supplies the real request.
import { FUND_ANALYTICS_MAX_FUNDS } from '@/lib/config/nav2/reportLimits';
import { COMBINED_MAX_REPORTS } from '@/lib/reports/fundAnalyticsCombinedPrint';

/** The screen checks again every 15 seconds while a report is prepared in steps (the same cadence as the single report), for up to 40 checks (10 minutes). */
export const GENERATE_ALL_POLL_MS = 15_000;
export const GENERATE_ALL_MAX_POLLS = 40;

export interface BatchCandidate {
  instrumentId: string;
  schemeName: string;
  currentValue: number | null;
}

/** The size of one batch: the server's own cap, and never above the application constant (defence in depth, the server stays authoritative). */
export function batchSize(serverMax: number | null | undefined): number {
  const m = typeof serverMax === 'number' && Number.isFinite(serverMax) ? Math.floor(serverMax) : FUND_ANALYTICS_MAX_FUNDS;
  return Math.max(1, Math.min(m, FUND_ANALYTICS_MAX_FUNDS));
}

/**
 * Splits the held funds into batches: the largest by current value first (a fund with no value last, ties kept in list order), at most `batchSize` per
 * batch. Every fund appears in EXACTLY ONE batch; a repeated id is counted once. The batches are the reports the person will get.
 */
export function planBatches(candidates: readonly BatchCandidate[], serverMax: number | null | undefined): string[][] {
  const size = batchSize(serverMax);
  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.instrumentId) ? false : (seen.add(c.instrumentId), true)));
  const ordered = unique
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.currentValue ?? -Infinity) - (a.c.currentValue ?? -Infinity) || a.i - b.i)
    .map((x) => x.c.instrumentId);
  const out: string[][] = [];
  for (let i = 0; i < ordered.length; i += size) out.push(ordered.slice(i, i + size));
  return out;
}

/** How many reports "Generate all" would make for this many held funds, or null when that is more than a combined PDF can hold (the funds are still all covered by separate reports). */
export function reportCountFor(heldFundCount: number, serverMax: number | null | undefined): number {
  return Math.max(1, Math.ceil(heldFundCount / batchSize(serverMax)));
}

/** True when the one-PDF set can hold this many reports (the combined print page refuses more than COMBINED_MAX_REPORTS). */
export function fitsCombinedPdf(reportCount: number): boolean {
  return reportCount >= 2 && reportCount <= COMBINED_MAX_REPORTS;
}

// ---------------------------------------------------------------------------------------------------------------------
// One request, classified
// ---------------------------------------------------------------------------------------------------------------------

export interface WaitingInfo {
  headline: string | null;
  loaded: number;
  total: number;
  waitingFunds: string[];
  unavailableFunds: string[];
}

export type BatchOutcome =
  | { kind: 'ready'; reportId: string; replayed: boolean }
  /** 202 "prepared in steps" / "preparing", or 503 "timed out, nothing was lost": ask again with the SAME key. */
  | { kind: 'retry'; waiting: WaitingInfo }
  /** The server answered that this batch has nothing to report on (the single-report screen shows the same message). */
  | { kind: 'no_funds'; message: string }
  /** Any other answer: the report was not made. `dropKey` = the server answered (the next attempt is a NEW intended report), false = unknown (keep the key: the request may have been accepted). */
  | { kind: 'failed'; message: string; dropKey: boolean };

interface LooseBody {
  error?: unknown;
  data?: { status?: unknown; message?: unknown; headline?: unknown; loaded?: unknown; total?: unknown; waitingFunds?: unknown; unavailableFunds?: unknown; replayed?: unknown; report?: { id?: unknown } } | null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Reads the endpoint's answer to ONE batch the same way the single-report screen does (status codes and typed states as documented in app/api/reports/fund-analytics/route.ts). */
export function classifyBatchResponse(status: number, body: unknown): BatchOutcome {
  const j = (body && typeof body === 'object' ? body : null) as LooseBody | null;
  const d = j?.data ?? null;
  const waiting = (): WaitingInfo => ({
    headline: typeof d?.headline === 'string' ? d.headline : typeof j?.error === 'string' ? j.error : typeof d?.message === 'string' ? d.message : null,
    loaded: num(d?.loaded),
    total: num(d?.total),
    waitingFunds: strings(d?.waitingFunds),
    unavailableFunds: strings(d?.unavailableFunds),
  });
  if (status === 503 && d?.status === 'timed_out') return { kind: 'retry', waiting: waiting() };
  if (status === 202) return { kind: 'retry', waiting: waiting() };
  if (status === 409 && d?.status === 'select_funds') return { kind: 'failed', message: typeof d.message === 'string' ? d.message : 'This report needs a choice of funds.', dropKey: true };
  const ok = status >= 200 && status < 300;
  if (!ok) return { kind: 'failed', message: typeof j?.error === 'string' && j.error ? j.error : `The report could not be generated (${status}).`, dropKey: true };
  if (d?.status === 'no_funds') return { kind: 'no_funds', message: typeof d.message === 'string' ? d.message : 'There are no funds to report on.' };
  const id = d?.report?.id;
  if (d?.status === 'ready' && typeof id === 'string' && id) return { kind: 'ready', reportId: id, replayed: status === 200 || d.replayed === true };
  return { kind: 'failed', message: 'The report could not be generated.', dropKey: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------

export type BatchStatus = 'waiting' | 'running' | 'ready' | 'failed' | 'skipped';

export interface BatchState {
  index: number;
  fundIds: string[];
  status: BatchStatus;
  reportId: string | null;
  /** The plain reason a batch is failed or skipped. */
  message: string | null;
  /** While a report is prepared in steps: what the server said. */
  waiting: WaitingInfo | null;
  polls: number;
}

export function initialBatches(plan: readonly string[][]): BatchState[] {
  return plan.map((fundIds, index) => ({ index, fundIds: [...fundIds], status: 'waiting', reportId: null, message: null, waiting: null, polls: 0 }));
}

export interface RunDeps {
  /** One real request for one batch. Called strictly one at a time. */
  post(fundIds: string[], key: string): Promise<{ status: number; body: unknown }>;
  /** Resolves after `ms` (the real screen waits on a timer; tests resolve at once). */
  sleep(ms: number): Promise<void>;
  /** The Idempotency-Key of a batch: the same key every time the same batch is asked for, until dropKey. */
  keyFor(batch: BatchState): string;
  /** Forgets the key of a batch (the server answered with something that is not "ask again"). */
  dropKey(batch: BatchState): void;
  /** True once the screen has gone away: the run stops without another request. */
  cancelled(): boolean;
  /** Called with a fresh copy of every batch after each change. */
  onChange(batches: BatchState[]): void;
}

/**
 * Asks for each batch that is not yet ready, strictly one after the other. A batch the server prepares in steps (202) or times out (503) is asked
 * again with the SAME key every GENERATE_ALL_POLL_MS, up to GENERATE_ALL_MAX_POLLS times. The FIRST failed batch stops the run (the later batches stay
 * "waiting", i.e. not yet covered); a batch the server says has nothing to report on is skipped and the run goes on. Batches already ready are never
 * asked for again, so "Try the remaining funds again" cannot make a second copy of a saved report.
 */
export async function runBatches(batches: BatchState[], deps: RunDeps): Promise<BatchState[]> {
  const state = batches.map((b) => ({ ...b, fundIds: [...b.fundIds] }));
  const emit = () => deps.onChange(state.map((b) => ({ ...b, fundIds: [...b.fundIds], waiting: b.waiting ? { ...b.waiting } : null })));
  for (const b of state) {
    if (b.status === 'ready') continue;
    b.status = 'running';
    b.message = null;
    b.polls = 0;
    emit();
    for (;;) {
      if (deps.cancelled()) return state;
      let outcome: BatchOutcome;
      try {
        const res = await deps.post([...b.fundIds], deps.keyFor(b));
        outcome = classifyBatchResponse(res.status, res.body);
      } catch {
        // no answer at all: the request may have been accepted, so the key is kept
        outcome = { kind: 'failed', message: 'The report could not be generated.', dropKey: false };
      }
      if (deps.cancelled()) return state;
      if (outcome.kind === 'ready') {
        b.status = 'ready';
        b.reportId = outcome.reportId;
        b.waiting = null;
        emit();
        break;
      }
      if (outcome.kind === 'retry') {
        b.waiting = outcome.waiting;
        if (b.polls >= GENERATE_ALL_MAX_POLLS) {
          // still not ready after 10 minutes of checking: stop, keep the key (the funds already prepared are kept by the server)
          b.status = 'failed';
          b.message = 'Price history for some funds is still being prepared. Nothing was lost: try again in a while.';
          emit();
          return state;
        }
        b.polls += 1;
        emit();
        await deps.sleep(GENERATE_ALL_POLL_MS);
        continue;
      }
      if (outcome.kind === 'no_funds') {
        deps.dropKey(b);
        b.status = 'skipped';
        b.message = outcome.message;
        b.waiting = null;
        emit();
        break;
      }
      if (outcome.dropKey) deps.dropKey(b);
      b.status = 'failed';
      b.message = outcome.message;
      b.waiting = null;
      emit();
      return state;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the screen says
// ---------------------------------------------------------------------------------------------------------------------

const fundsWord = (n: number) => `${n} fund${n === 1 ? '' : 's'}`;

/** "Report 1 of 2: 10 funds - ready" and the other states, in plain words. */
export function batchProgressLine(batch: BatchState, total: number): string {
  const head = `Report ${batch.index + 1} of ${total}: ${fundsWord(batch.fundIds.length)}`;
  switch (batch.status) {
    case 'ready':
      return `${head} - ready`;
    case 'running':
      return batch.waiting
        ? `${head} - price history is being prepared${batch.waiting.total > 0 ? ` (${batch.waiting.loaded} of ${batch.waiting.total} loaded)` : ''}; this screen checks again by itself`
        : `${head} - being made`;
    case 'failed':
      return `${head} - not ready${batch.message ? `: ${batch.message}` : ''}`;
    case 'skipped':
      return `${head} - no report${batch.message ? `: ${batch.message}` : ''}`;
    default:
      return `${head} - waiting`;
  }
}

export type RunPhase = 'running' | 'done' | 'partial';

export interface RunSummary {
  phase: RunPhase;
  readyReportIds: string[];
  /** The funds no saved report covers yet, in batch order. */
  uncoveredFundIds: string[];
  /** A plain sentence when the run did not cover every fund, else null. */
  message: string | null;
}

/** Where a run stands: still going, every fund covered, or only partly covered (the saved reports are kept and the rest named). */
export function summarizeRun(batches: readonly BatchState[], nameOf: (instrumentId: string) => string): RunSummary {
  const readyReportIds = batches.filter((b) => b.status === 'ready' && b.reportId).map((b) => b.reportId as string);
  const uncovered = batches.filter((b) => b.status !== 'ready');
  const uncoveredFundIds = uncovered.flatMap((b) => b.fundIds);
  const running = batches.some((b) => b.status === 'running') || (batches.some((b) => b.status === 'waiting') && !batches.some((b) => b.status === 'failed' || b.status === 'skipped'));
  if (running) return { phase: 'running', readyReportIds, uncoveredFundIds, message: null };
  if (uncovered.length === 0) return { phase: 'done', readyReportIds, uncoveredFundIds: [], message: null };
  const total = batches.length;
  const savedN = readyReportIds.length;
  const failed = uncovered.find((b) => b.status === 'failed') ?? uncovered[0];
  const saved = savedN === 0 ? 'No report was saved.' : `${savedN === 1 ? 'Report 1' : `${savedN} reports`} of ${total} ${savedN === 1 ? 'is' : 'are'} saved and kept.`;
  const names = uncoveredFundIds.map(nameOf).join('; ');
  return {
    phase: 'partial',
    readyReportIds,
    uncoveredFundIds,
    message: `${saved} Report ${failed.index + 1} of ${total} is not ready. ${fundsWord(uncoveredFundIds.length)} not covered yet: ${names}.`,
  };
}
