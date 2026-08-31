// Module 11.0 residual closure — the certified-source database client.
//
// WHY THIS EXISTS
// ---------------
// Two real defects were found during the residual-closure certification
// round, both by exercising the real context-build path above a
// deliberately-failing database dependency:
//
//  1. FAIL-OPEN ON DATABASE FAILURE. Every certified Module 1-10 loader
//     (`loadDashboard`, `loadHealthScore`, `loadFinancialDna`,
//     `loadResilience`, `computeGoalsPagePayload`, ...) coalesces a failed
//     PostgREST read to an empty array (`income.data ?? []`). That is correct
//     for a page render — but for certification it makes a DATABASE OUTAGE
//     indistinguishable from "this household has entered no data". The
//     certification service then honestly reports UNAVAILABLE per domain,
//     the root rollup lands on PARTIAL (because `certifyInsurance` returns
//     PARTIAL for an unreviewed household), and `AIModelGateway` — which
//     only fails closed on UNAVAILABLE/INVALID — ADMITS the request and
//     reaches the provider with a context full of fabricated zeros.
//
//  2. CANONICAL WRITES FROM A READ PATH. Module 11.0's own completion report
//     claims "no AI writes to canonical financial data". Measured, a single
//     `buildFinancialContextObject()` call issued SEVEN `financial_snapshots`
//     upserts (and, for a household with active goals, `goal_forecasts`
//     inserts and `goal_snapshots` upserts) — because the Module 1-10
//     loaders are load-AND-persist functions, not pure readers. Under a
//     partial outage (reads failing, writes succeeding) that writes a ZEROED
//     snapshot over the household's real current-month history.
//
// This wrapper closes both, without modifying a single Module 1-10 file:
//   * every read result is inspected, and any PostgREST error is recorded so
//     the context builder can fail the whole context closed (INVALID);
//   * every write verb is intercepted and never reaches the database, so the
//     AI context path is STRUCTURALLY incapable of mutating canonical
//     financial data rather than merely intended not to.
//
// Blocked writes are inert, not throwing: they resolve to the PostgREST
// `{ data: null, error }` shape the loaders already tolerate (each one guards
// its follow-up writes behind `if (scoreRow)`/`if (profileRow)` and ignores
// the snapshot upsert's result entirely), so blocking changes no returned
// financial value — only the persistence side effect.

import type { SupabaseServerClient } from '@/lib/services/dashboardData';

export interface SourceReadFailure {
  table: string;
  code: string | null;
  message: string;
}

export interface BlockedWrite {
  table: string;
  verb: string;
}

export interface SourceIntegrity {
  readFailures: SourceReadFailure[];
  blockedWrites: BlockedWrite[];
}

export interface CertifiedSourceClient {
  /** Drop-in replacement for the real server client. */
  client: SupabaseServerClient;
  integrity: SourceIntegrity;
}

const WRITE_VERBS = new Set(['insert', 'update', 'upsert', 'delete']);

/** PostgREST codes that mean "the query ran and simply matched nothing" —
 *  a legitimate empty result, NOT a source-integrity failure. `.single()`
 *  returns PGRST116 for zero rows, which several Module 1-10 loaders rely on
 *  as an ordinary "no row yet" signal. */
const BENIGN_CODES = new Set(['PGRST116']);

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

/**
 * Wraps a real Supabase server client so that the AI context path can:
 *   (a) observe every read failure, and
 *   (b) never perform a write.
 */
export function createCertifiedSourceClient(base: SupabaseServerClient): CertifiedSourceClient {
  const integrity: SourceIntegrity = { readFailures: [], blockedWrites: [] };

  function recordResult(table: string, result: unknown) {
    const error = (result as { error?: { code?: string | null; message?: string } | null } | null)?.error;
    if (!error) return result;
    if (error.code && BENIGN_CODES.has(error.code)) return result;
    integrity.readFailures.push({ table, code: error.code ?? null, message: error.message ?? 'unknown database error' });
    return result;
  }

  /** An inert stand-in for a write chain: every builder method returns itself,
   *  and awaiting it yields the PostgREST error shape without touching the DB. */
  function inertWrite(table: string, verb: string): unknown {
    integrity.blockedWrites.push({ table, verb });
    const rejection = {
      data: null,
      error: {
        code: 'M11_READONLY',
        message: `Module 11.0 AI context path is read-only: a ${verb} on "${table}" was blocked before reaching the database.`,
        details: null,
        hint: null,
      },
    };
    const stub: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(rejection).then(resolve, reject);
      },
    };
    const passthrough = new Proxy(stub, {
      get(target, prop) {
        if (prop in target) return Reflect.get(target, prop);
        if (typeof prop === 'symbol') return undefined;
        return () => passthrough;
      },
    });
    return passthrough;
  }

  function wrapBuilder(table: string, builder: unknown): unknown {
    if (typeof builder !== 'object' || builder === null) return builder;
    return new Proxy(builder as object, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && WRITE_VERBS.has(prop)) {
          return () => inertWrite(table, prop);
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            (value as (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => unknown).call(
              target,
              (result: unknown) => resolve(recordResult(table, result)),
              reject
            );
        }
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (isThenable(out) && !(out instanceof Promise)) return wrapBuilder(table, out);
          if (out instanceof Promise) return out.then((r) => recordResult(table, r));
          if (typeof out === 'object' && out !== null) return wrapBuilder(table, out);
          return out;
        };
      },
    });
  }

  const client = new Proxy(base as object, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) => wrapBuilder(table, (target as { from: (t: string) => unknown }).from(table));
      }
      if (prop === 'rpc') {
        return (...args: unknown[]) => {
          const out = (target as { rpc: (...a: unknown[]) => unknown }).rpc(...args);
          const name = typeof args[0] === 'string' ? `rpc:${args[0]}` : 'rpc';
          if (isThenable(out) && !(out instanceof Promise)) return wrapBuilder(name, out);
          if (out instanceof Promise) return out.then((r) => recordResult(name, r));
          return out;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SupabaseServerClient;

  return { client, integrity };
}
