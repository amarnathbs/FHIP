// BENCH-1 Phase 2 - the registry of benchmark feed adapters available to the
// recurring-ingestion runtime.
//
// SHIPS EMPTY. As of 2026-10-01 NO index owner's terms grant automated access,
// storage, customer display or export of index levels to FHIP in a form that
// has been verified (see SOURCE_DECISION.md); the NSE Indices, BSE Index
// Services and CRISIL terms reviewed prohibit robots / automated collection /
// storage without written consent. Registering an adapter here is therefore a
// deliberate act that must be paired with an APPROVED 'automation' entitlement
// record for each benchmark it serves (checked centrally by the orchestrator
// and again by the database). A registered adapter without that record is
// refused: `skipped_not_entitled`.
//
// An adapter must: use only documented endpoints; send an identifying
// User-Agent; never follow bot-protection challenges; map 401/403 to
// 'auth_failed'/'blocked', 429 to 'rate_limited', 5xx/transport to 'outage',
// and HTTP 200 with none of the expected rows to 'empty' (never 'ok').
import type { BenchmarkFeedAdapter } from './orchestrator';

export const BENCHMARK_FEED_ADAPTERS: ReadonlyMap<string, BenchmarkFeedAdapter> = new Map<string, BenchmarkFeedAdapter>();
