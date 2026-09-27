# NAV 1 — Historical Depth Policy

**Status:** Formal policy, PO decision #2, 2026-09-27. Supersedes any prior informal description of "how far back hydration goes" in chat, memory notes or code comments.

## The policy, verbatim

> For any scheme protected through transactions, holdings, statements, reports or merged-scheme lineage, hydrate and retain all reliably obtainable NAV history from scheme launch to the latest published NAV. Where the complete history is unavailable, record the earliest reliably available date, missing range, provider and limitation. Never manufacture or interpolate NAVs.

This document says, clause by clause, what the current code does, what gap was found, and what this dispatch (2026-09-27) fixed.

## Clause 1: "hydrate and retain all reliably obtainable NAV history from scheme launch to the latest published NAV"

**Scope of "protected":** matches `pc6_nav_row_is_candidate()`'s own KEEP conditions (migrations 0189, 0200, 0219) — an instrument any user holds or has held (any of the 7 user-scoped `ii_*` tables, any status), any instrument mapped as a benchmark, any instrument a finalized report is pinned to, any instrument under an open retention hold, and now (0219) any instrument or merge-family member inside a known source coverage gap.

**"From scheme launch":** `selectiveHistoricalHydrationJob.ts`'s `HISTORICAL_FLOOR_DATE` (`'2006-04-01'`) is used as the fetch lower bound when nothing more specific is known — this is AMFI's own earliest published history, not a per-scheme launch date, and the code says so. A per-scheme actual launch date is not tracked as a first-class field anywhere in `ii_scheme_master` (`inception_date` exists as a column but is null for every scheme checked, including the one case this dispatch investigated in depth — see the companion data-integrity note). **This is compliant with the policy as written**: hydration walks back from the AMFI-wide floor until a source genuinely has nothing older, which is the operational definition of "scheme launch" this system can actually verify (rather than trusting an unverified metadata field). The floor mechanism (0190, below) is what turns the first "nothing older" result into a stored fact instead of a repeated, wasted fetch.

**"To the latest published NAV":** the daily NAV cron (`0187`/`0205`, live and verified — see `NAV1_Production_Final_Certification_2026-09-27.md` §3) keeps every live scheme current from the changeover date forward, independent of holdings. Held/pinned schemes are additionally covered by the same daily tick since they are a subset of "every live scheme."

**Verdict: COMPLIANT**, with one caveat carried over unchanged from the 24 Sep decision: hydration fetches "from inception" using the AMFI-wide floor, not a verified per-scheme launch date — this is the correct, honest choice given no verified per-scheme launch date exists anywhere in this system.

## Clause 2: "Where the complete history is unavailable, record the earliest reliably available date, missing range, provider and limitation"

This is where a real, previously undocumented gap was found and fixed this dispatch.

**What already existed (`ii_nav_history_floors`, migration 0190):** records `floor_date` — the earliest date with data — the instant hydration walks back far enough to get `not_found` from both providers while newer data exists. This satisfies "record the earliest reliably available date" **on its own**, but its `detail` field is free text with no structured provider/reason distinction, and — more importantly — it treats every such boundary as "this is where the scheme's history starts" (a presumed-launch fact). That framing is **correct** for an ordinary scheme launched later than the floor, and **wrong** for a scheme whose gap exists for an unrelated reason (its provider coverage has a hole that has nothing to do with when the scheme actually launched). Recording the latter as a floor would manufacture a false "launched here" fact — exactly what the policy's own last sentence forbids.

**Gap found:** nothing distinguished these two cases, and nothing recorded "provider" or "limitation" as structured, queryable facts — only as prose inside a floor's `detail` column, and only for the narrow "hydration walked back and found nothing" trigger. A gap discovered any other way (e.g. a Stage-E readiness canary re-fetch, as happened here) had nowhere to go.

**Fix (migration 0219, this dispatch):** `ii_nav_source_coverage_gaps` — a new table recording, per instrument: the exact date range, which providers were checked (`providers_checked text[]`), a `reason_code` (`fund_house_transition`, `presumed_pre_launch`, `provider_outage_unresolved`, `other`), and a free-text `detail`. Seeded with the one confirmed real case (HSBC Short Term Fund, AMFI 151069 — see the companion data-integrity note for the full evidence trail). `pc6_nav_row_is_candidate()` now also treats any row inside an *unresolved* gap as protected, independent of held status — because "reliably available" data that has already been retained must not be deleted just because nobody happens to hold that scheme today.

**Verdict on clause 2: was PARTIALLY compliant (floor_date existed; provider/limitation did not, and the two failure modes were conflated); now COMPLIANT** for every case this dispatch could find and reason about. See the companion note for the one honest limitation: a full scan of the ~14,336-instrument AMFI universe for other undiscovered coverage gaps was not attempted (cost-prohibitive — it would require thousands of external fetches per full pass) and is recommended as separate, deliberately scoped future work, not silently declared complete here.

## Clause 3: "Never manufacture or interpolate NAVs"

**Verified unchanged and still true.** Every adapter (`amfiHistoricalAdapter.ts`, `tigzigHistoricalAdapter.ts`, `fallbackHistoricalAdapter.ts`) either returns a real observed value or an explicit failure/`not_found` — there is no code path anywhere in the hydration or reconciliation stack that fills a gap with an estimated, averaged or carried-forward value. `ii_nav_source_coverage_gaps` (0219) exists specifically so that an unrecoverable gap is *disclosed*, never quietly filled.

## What a reader should take away

1. Depth: compliant by construction (walk back to the first genuine "nothing here," not a guessed date).
2. Recording of limitations: was incomplete for the "known-reason gap" case; now has a real, structured, queryable table (`ii_nav_source_coverage_gaps`) feeding both the retention predicate and render-time disclosure (see `lib/engines/investment-intelligence/navCoverageDisclosure.ts`).
3. No manufactured data: unchanged and confirmed.
4. Known, disclosed limitation of this pass: coverage-gap discovery is currently manual/incident-driven (a canary check, this dispatch's re-verification), not a scheduled universe-wide scan. Building that scan is future work, not claimed here.
