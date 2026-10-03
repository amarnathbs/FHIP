// "Wait for the data, but a permanently missing source never traps the user"
// (PO decision 2026-10-03). The Monthly Report -- and the Performance page --
// must not render partial / "not available" figures while the price history of
// the user's own funds is still being loaded.
//
// THE RULE
//   * A fund whose history is complete is never waited for. A user with no gaps
//     sees no change at all.
//   * A fund with a gap that is still being fetched HOLDS the report: nothing is
//     generated, the user sees "Your report will be ready once price history is
//     loaded (3 of 5 funds loaded)", the fetch is kicked (idempotent, bounded,
//     exactly the user-scoped path in userNavHistory.ts) and the screen
//     generates automatically as soon as every fund is in.
//   * Never forever. A fund is marked 'history unavailable' -- and no longer
//     holds anything -- when any of these is true:
//       - it has a confirmed unrecoverable coverage gap over the window it needs
//         (ii_nav_source_coverage_gaps, e.g. HSBC AMFI 151069): fetching cannot
//         help, so waiting would be pointless;
//       - it has no AMFI scheme code (an unresolvable identifier failed);
//       - its attempts are exhausted (REPORT_NAV_MAX_FAILED_ATTEMPTS consecutive
//         failures in the job's own attempt ledger);
//       - the bounded retry window has elapsed (REPORT_NAV_RETRY_WINDOW_MINUTES
//         since this hold began), which also covers the kill switch being off
//         and the per-user rate limit, neither of which leaves a failure record.
//     The report then generates and says, in plain words, "Price history for
//     <fund> could not be loaded; its figures are marked not available."
//
// WHERE THE HOLD'S START COMES FROM. There is no per-user timestamp for "this
// gap was first seen", and none is added (no migration): the first time a hold
// is evaluated it writes ONE audit event ('calculation', metadata.kind =
// REPORT_NAV_ANCHOR_KIND) and that is the start of the window. An anchor older
// than REPORT_NAV_ANCHOR_MAX_AGE_MINUTES is ignored (a later, new gap starts a
// new window; it does not inherit an old release).
//
// The pure decision (evaluateReportNavGate) is separate from the I/O so every
// branch is unit-testable with fake data.

import type { SupabaseClient } from '@supabase/supabase-js';
import { emitAuditEvent } from '../audit';
import {
  loadAttempts,
  loadCoverage,
  loadUserSchemeNeeds,
  planSchemeGap,
  type AttemptInfo,
  type SchemeGap,
} from './userNavHistory';

type Db = Pick<SupabaseClient, 'from'>;

/** How long a report may be held for price history before a fund still missing it is marked unavailable. */
export const REPORT_NAV_RETRY_WINDOW_MINUTES = 10;
/** Consecutive failed fetch attempts after which a fund is marked unavailable (the job's own persistent-failure threshold). */
export const REPORT_NAV_MAX_FAILED_ATTEMPTS = 3;
export const REPORT_NAV_ANCHOR_KIND = 'report_nav_history_gate_held';
/** A hold anchor older than this is ignored; a new gap then starts a fresh window. */
export const REPORT_NAV_ANCHOR_MAX_AGE_MINUTES = 60;

export type GateFundState = 'loaded' | 'waiting' | 'unavailable';
export type UnavailableReason = 'coverage_gap' | 'unresolvable' | 'attempts_exhausted' | 'retry_window_elapsed';

export interface GateFund {
  instrumentId: string;
  schemeName: string;
  state: GateFundState;
  reason: UnavailableReason | null;
}

export interface GateSchemeInput {
  instrumentId: string;
  schemeName: string;
  gap: SchemeGap;
  attempt: AttemptInfo | null;
  /** The gap window overlaps a confirmed unrecoverable coverage gap. */
  overlapsCoverageGap: boolean;
}

export interface ReportNavGate {
  /** True = do NOT generate yet. */
  hold: boolean;
  funds: GateFund[];
  total: number;
  loaded: number;
  waiting: GateFund[];
  unavailable: GateFund[];
  /** ISO, when the current hold began (null when nothing is held or no anchor exists yet). */
  heldSince: string | null;
  /** The sentence shown while held; null when not held. */
  headline: string | null;
  /** One plain sentence per fund that could not be loaded, for the report and the screen. */
  disclosures: string[];
}

export function unavailableDisclosure(schemeName: string): string {
  return `Price history for ${schemeName} could not be loaded; its figures are marked not available.`;
}

export function heldHeadline(loaded: number, total: number): string {
  return `Your report will be ready once price history is loaded (${loaded} of ${total} ${total === 1 ? 'fund' : 'funds'} loaded)`;
}

/** Pure. See the module header for the rule. */
export function evaluateReportNavGate(input: { schemes: readonly GateSchemeInput[]; heldSinceIso: string | null; nowIso: string }): ReportNavGate {
  const windowMs = REPORT_NAV_RETRY_WINDOW_MINUTES * 60_000;
  const windowElapsed = input.heldSinceIso !== null && new Date(input.nowIso).getTime() - new Date(input.heldSinceIso).getTime() >= windowMs;

  const funds: GateFund[] = input.schemes.map((s) => {
    const base = { instrumentId: s.instrumentId, schemeName: s.schemeName };
    if (s.gap.state === 'complete') return { ...base, state: 'loaded' as const, reason: null };
    if (s.overlapsCoverageGap) return { ...base, state: 'unavailable' as const, reason: 'coverage_gap' as const };
    if (s.attempt && s.attempt.lastOutcome === 'unresolvable_identifier' && s.attempt.consecutiveFailures >= 1) return { ...base, state: 'unavailable' as const, reason: 'unresolvable' as const };
    if (s.attempt && s.attempt.consecutiveFailures >= REPORT_NAV_MAX_FAILED_ATTEMPTS) return { ...base, state: 'unavailable' as const, reason: 'attempts_exhausted' as const };
    if (windowElapsed) return { ...base, state: 'unavailable' as const, reason: 'retry_window_elapsed' as const };
    return { ...base, state: 'waiting' as const, reason: null };
  });

  const waiting = funds.filter((f) => f.state === 'waiting');
  const unavailable = funds.filter((f) => f.state === 'unavailable');
  const loaded = funds.filter((f) => f.state === 'loaded').length;
  const hold = waiting.length > 0;
  return {
    hold,
    funds,
    total: funds.length,
    loaded,
    waiting,
    unavailable,
    heldSince: input.heldSinceIso,
    headline: hold ? heldHeadline(loaded, funds.length) : null,
    disclosures: unavailable.map((f) => unavailableDisclosure(f.schemeName)),
  };
}

/** The error generateReport() throws when the report must wait. Routes turn it into a 202; nothing is stored. */
export class ReportWaitingForPriceHistoryError extends Error {
  readonly gate: ReportNavGate;
  constructor(gate: ReportNavGate) {
    super(gate.headline ?? 'Your report will be ready once price history is loaded.');
    this.name = 'ReportWaitingForPriceHistoryError';
    this.gate = gate;
  }
}

/** The body the routes return with HTTP 202 while a report is held. Plain words, no ids beyond the fund list the screen needs. */
export function waitingBody(gate: ReportNavGate) {
  return {
    waiting: gate.hold,
    headline: gate.headline,
    loaded: gate.loaded,
    total: gate.total,
    waitingFunds: gate.waiting.map((f) => f.schemeName),
    unavailableFunds: gate.unavailable.map((f) => f.schemeName),
    retryWindowMinutes: REPORT_NAV_RETRY_WINDOW_MINUTES,
  };
}

/** HTTP 202 for a held report (the shared answer of every route that can generate), or null for any other error. */
export function waitingResponseFor(e: unknown): Response | null {
  if (!(e instanceof ReportWaitingForPriceHistoryError)) return null;
  return Response.json({ data: waitingBody(e.gate) }, { status: 202 });
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------
async function loadOverlappingCoverageGapIds(db: Db, windows: Map<string, { fromDate: string; toDate: string }>): Promise<Set<string>> {
  const out = new Set<string>();
  if (windows.size === 0) return out;
  // The table may not exist where the code ships first: no table = no known gaps, never a failure.
  const { data, error } = await db.from('ii_nav_source_coverage_gaps').select('instrument_id, gap_from, gap_to').in('instrument_id', [...windows.keys()]).is('resolved_at', null);
  if (error) return out;
  for (const g of (data ?? []) as unknown as Array<{ instrument_id: string; gap_from: string; gap_to: string }>) {
    const w = windows.get(g.instrument_id);
    if (w && g.gap_from <= w.toDate && g.gap_to >= w.fromDate) out.add(g.instrument_id);
  }
  return out;
}

async function findAnchor(db: Db, userId: string, nowIso: string): Promise<string | null> {
  const since = new Date(new Date(nowIso).getTime() - REPORT_NAV_ANCHOR_MAX_AGE_MINUTES * 60_000).toISOString();
  const { data } = await db
    .from('ii_audit_events')
    .select('created_at')
    .eq('user_id', userId)
    .eq('event_type', 'calculation')
    .contains('metadata', { kind: REPORT_NAV_ANCHOR_KIND })
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { created_at?: string } | null)?.created_at ?? null;
}

/**
 * Read the user's funds and decide. `createAnchor` is true for the paths that
 * actually try to generate (so the window starts once, on the first hold) and
 * `kick` starts the user-scoped fetch when something is held and nothing else
 * has. Never throws for a read problem on the optional tables; a failure to
 * read the user's own funds propagates (the caller fails open, see
 * generateReport()).
 */
export async function checkReportNavHistoryGate(args: {
  db: Db;
  userId: string;
  today: string;
  nowIso?: string;
  createAnchor?: boolean;
  kick?: (userId: string) => boolean;
}): Promise<ReportNavGate> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const needs = await loadUserSchemeNeeds(args.db, args.userId);
  if (needs.length === 0) return evaluateReportNavGate({ schemes: [], heldSinceIso: null, nowIso });
  const ids = needs.map((n) => n.instrumentId);
  const [coverage, attempts] = await Promise.all([loadCoverage(args.db, ids), loadAttempts(args.db, ids)]);
  const gaps = new Map(needs.map((n) => [n.instrumentId, planSchemeGap(n, coverage.get(n.instrumentId)!, args.today)]));
  const windows = new Map<string, { fromDate: string; toDate: string }>();
  for (const [id, g] of gaps) if (g.state === 'gap') windows.set(id, { fromDate: g.fromDate, toDate: g.toDate });
  const overlapping = await loadOverlappingCoverageGapIds(args.db, windows);

  const schemes: GateSchemeInput[] = needs.map((n) => ({
    instrumentId: n.instrumentId,
    schemeName: n.schemeName,
    gap: gaps.get(n.instrumentId)!,
    attempt: attempts.get(n.instrumentId) ?? null,
    overlapsCoverageGap: overlapping.has(n.instrumentId),
  }));

  let heldSince = await findAnchor(args.db, args.userId, nowIso);
  let gate = evaluateReportNavGate({ schemes, heldSinceIso: heldSince, nowIso });
  if (gate.hold && heldSince === null && args.createAnchor) {
    // The first hold of this window: remember when it began (audit trail, no migration).
    await emitAuditEvent({ userId: args.userId, eventType: 'calculation', subjectType: 'reports', actorType: 'system', metadata: { kind: REPORT_NAV_ANCHOR_KIND, waiting: gate.waiting.length, total: gate.total } }).catch(() => ({ error: 'anchor not saved' }));
    heldSince = nowIso;
    gate = evaluateReportNavGate({ schemes, heldSinceIso: heldSince, nowIso });
  }
  if (gate.hold && args.createAnchor && args.kick) args.kick(args.userId); // idempotent and bounded: the user-scoped batch is single-flight, rate limited and time-boxed
  return gate;
}

/** Adds the disclosure sentences to the sections a missing price history affects. Pure; returns new sections. */
export function applyNavDisclosures<T extends { sectionCode: string; narrativeText: string | null; limitationText: string | null; sectionData: Record<string, unknown> }>(
  sections: readonly T[],
  gate: Pick<ReportNavGate, 'unavailable' | 'disclosures'>,
  affectedSectionCodes: readonly string[] = ['india_mf_investment_report', 'investment_performance']
): T[] {
  if (gate.unavailable.length === 0) return [...sections];
  const text = gate.disclosures.join(' ');
  return sections.map((s) =>
    affectedSectionCodes.includes(s.sectionCode)
      ? {
          ...s,
          narrativeText: s.narrativeText ? `${s.narrativeText} ${text}` : text,
          limitationText: s.limitationText ? `${s.limitationText} ${text}` : text,
          sectionData: { ...s.sectionData, priceHistoryUnavailable: gate.unavailable.map((f) => ({ fund: f.schemeName, reason: f.reason })) },
        }
      : s
  );
}
