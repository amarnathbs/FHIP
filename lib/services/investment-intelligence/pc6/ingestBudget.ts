// PC6 — the wall-clock budget for one ingest invocation (2026-09-25).
//
// WHY. Production runs on AWS Amplify compute, which kills every request at
// 28 s ("Request timed out - your application took too long to respond",
// Duration 28003 ms in CloudWatch). The first scheduled daily-NAV tick
// (25 Sep 03:30 UTC) and a manual server run (04:01) both died there and left
// their batch 'running' with 0 rows. A job that must finish inside one
// request cannot be made reliable by making it faster alone: the daily file's
// write volume varies (8,715 inserts on 25 Sep, 14,341 on 20 Sep), so the
// job instead does as much as fits in a fixed budget, closes its batch
// honestly, and the schedule calls it again (migration 0205) until nothing
// is left. Every write is idempotent, so a rerun re-plans and continues.
//
// SHAPE. A "write unit" is one committed request group: an insert chunk, one
// correction, or one scheme-master chunk. A unit is started only when the
// time already used plus the slowest unit seen so far (or a conservative
// initial estimate) still fits the budget -- so the budget is respected
// before a slow unit starts, not discovered after it has overrun.
//
// PROGRESS FLOOR. If the read phase alone used the budget, one unit may still
// start while it fits within `budgetMs + progressGraceMs`, so a slow-but-
// working day makes progress rather than looping on zero-progress partials.
// The defaults (18 s + 5 s = 23 s, plus the unit itself) stay under 28 s.

/** Default wall-clock budget per invocation, measured from invocation start. */
export const PC6_INGEST_DEFAULT_BUDGET_MS = 18_000;

/** Extra room allowed ONLY for the first write unit of an invocation. */
export const PC6_INGEST_PROGRESS_GRACE_MS = 5_000;

/** Upper bound accepted from an HTTP caller (the route); anything larger would outlive the 28 s platform limit. */
export const PC6_INGEST_MAX_HTTP_BUDGET_MS = 22_000;

/**
 * The budget for this invocation: an explicit value wins, then the
 * PC6_INGEST_BUDGET_MS environment variable, then the 18 s default.
 * `Infinity` is allowed from code (hand-run scripts) and means unbounded.
 */
export function resolveBudgetMs(explicit?: number, envValue: string | undefined = process.env.PC6_INGEST_BUDGET_MS): number {
  if (typeof explicit === 'number' && (explicit === Infinity || (Number.isFinite(explicit) && explicit > 0))) return explicit;
  const fromEnv = envValue !== undefined && envValue !== '' ? Number(envValue) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return PC6_INGEST_DEFAULT_BUDGET_MS;
}

export type WriteUnitKind = 'insert_chunk' | 'correction' | 'scheme_master_chunk';

/** Conservative first guesses, replaced by the slowest observed unit of each kind. */
export const INITIAL_UNIT_ESTIMATE_MS: Record<WriteUnitKind, number> = {
  insert_chunk: 2_000,
  correction: 800,
  scheme_master_chunk: 2_000,
};

export interface WriteBudget {
  readonly startedAtMs: number;
  readonly budgetMs: number;
  elapsedMs(): number;
  /** May another unit of this kind start now? */
  canStart(kind: WriteUnitKind): boolean;
  /** Record a completed unit's duration (also counts it as progress). */
  record(kind: WriteUnitKind, durationMs: number): void;
  /** Units completed in this invocation. */
  unitsDone(): number;
  /** Time a unit, recording it. */
  time<T>(kind: WriteUnitKind, fn: () => Promise<T>): Promise<T>;
}

export function createWriteBudget(opts: {
  startedAtMs: number;
  budgetMs: number;
  clock: () => number;
  progressGraceMs?: number;
}): WriteBudget {
  const grace = opts.progressGraceMs ?? PC6_INGEST_PROGRESS_GRACE_MS;
  const estimate: Record<WriteUnitKind, number> = { ...INITIAL_UNIT_ESTIMATE_MS };
  let done = 0;
  const elapsedMs = () => opts.clock() - opts.startedAtMs;
  const budget: WriteBudget = {
    startedAtMs: opts.startedAtMs,
    budgetMs: opts.budgetMs,
    elapsedMs,
    canStart(kind) {
      if (opts.budgetMs === Infinity) return true;
      const projected = elapsedMs() + estimate[kind];
      if (projected <= opts.budgetMs) return true;
      return done === 0 && projected <= opts.budgetMs + grace;
    },
    record(kind, durationMs) {
      estimate[kind] = Math.max(estimate[kind], durationMs);
      done++;
    },
    unitsDone: () => done,
    async time(kind, fn) {
      const s = opts.clock();
      try {
        return await fn();
      } finally {
        budget.record(kind, opts.clock() - s);
      }
    },
  };
  return budget;
}

/** Run `fn` over `items` with at most `concurrency` in flight; results keep input order. Rejects on the first failure. */
export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed: unknown = null;
  async function worker() {
    while (failed === null && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (failed === null) failed = e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  if (failed !== null) throw failed;
  return results;
}
