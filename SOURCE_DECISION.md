# BENCH-1 — Source Decision (India Mutual Fund Benchmark Data)

Status: **DRAFT / DECISION PACK ONLY — no commercial commitment made or authorized.**
Prepared: 2026-09-30, as part of BENCH-1 discovery (stage B1). Updated same day (continuation
dispatch) after a second attempt to reach the official reference pages and after finding that a
prior mission (PC6, 2026-09-15) already reached the identical blocked conclusion independently.

**PC6 cross-reference (found after this document's first draft).** A separate prior mission
(`docs/investment-intelligence/PC6_MARKET_DATA_CERTIFICATION_2026-09-15.md`) already investigated
this exact question on 2026-09-15 and recorded, as `BLOCKER PO-PC6-1`: NIFTY belongs to NSE Indices
Ltd, SENSEX to BSE/Asia Index, neither is open data, and the legacy unauthenticated
`niftyindices.com/Backpage.aspx/getTotalReturnIndexString` endpoint "now returns the HTML site shell
rather than data, so there is not even a technical path, let alone a licensed one." That mission also
registered both indices as `licence_required` sources in
`lib/config/investment-intelligence/pc6ReferenceSources.ts`, which refuses to build a fetch URL for
either (`buildUrl()` throws). This document's own independent fetch attempts below reached the same
practical outcome from a different angle (network-level failure rather than a data response), which
is corroborating rather than contradictory: whether the block is "returns no data" or "cannot even
connect," the practical conclusion — no real Indian index level can be ingested without a licence —
is the same, reached twice, independently, five months apart.

**Second retry, this same continuation dispatch.** Per PO authorization, the three official
reference pages were fetched again:
- `https://www.amfiindia.com/otherdata/listofbenchmarkindices` — `ECONNREFUSED` (connection refused
  at the IP layer), same failure mode as the first attempt and as PC6's own 2026-09-15 finding that
  `www.amfiindia.com` was unreachable from a build environment while `portal.amfiindia.com` was not
  (this document did not additionally try the portal host for this specific benchmark-list page,
  since AMFI's portal mirrors its NAV files, not its benchmark-index list page).
- `https://www.niftyindices.com/terms-of-use` — timed out (60s) on both attempts.
- `https://www.niftyindices.com/offerings/data-subscription` — `ECONNRESET` on the first attempt.
No terms, pricing, or entitlement text was retrieved on either attempt. Nothing below is invented to
fill that gap.

This document exists to give the Product Owner what is needed to choose a benchmark-data
source. No purchase, vendor outreach, paid signup, or production activation has occurred or is
recommended by this document alone (per the mission's own instruction and this session's
environment constraints, which prohibit any external commercial commitment).

## 1. What was actually verified this session

- The three official reference pages listed in the mission (niftyindices.com terms-of-use,
  niftyindices.com data-subscription, amfiindia.com listofbenchmarkindices) were each attempted
  via a read-only fetch. All three failed at the network level in this environment (timeout,
  connection reset, connection refused) rather than returning content. **No terms, pricing, or
  entitlement text from those pages was retrieved or can be quoted here.** This is recorded
  honestly rather than papered over with remembered/assumed text — re-verification with a
  working fetch path (or manual PO visit) is required before any of the general knowledge below
  is relied on for a commercial decision.
- What follows below the line is background knowledge from general training, not a live-verified
  quote. It must be re-confirmed against the current live pages before use in any procurement
  decision. Nothing here should be treated as a verified entitlement.

## 2. Candidate sources (unverified this session — re-check before acting)

| Source | What it would plausibly offer | Known friction |
|---|---|---|
| NSE Indices Ltd (niftyindices.com) direct subscription | Official owner of Nifty family indices (Price and TRI variants); has historically published a "data subscription" offering distinct from its public historical-reports download. | Public historical-reports section is documented (elsewhere, pre-session) as restricted to personal/non-commercial use in its terms — a commercial subscription tier, if any, would need to be requested and quoted directly; not verified this session. |
| BSE Ltd (index services) | Owner of Sensex and other BSE indices, needed only if a held scheme's disclosed benchmark is BSE-owned. | Not investigated this session — no held scheme in DEV data pointed at a BSE-owned index (see §6). |
| CRISIL (index services) | Owner of CRISIL debt/hybrid indices, needed for debt/hybrid/liquid scheme benchmarks. | Not investigated this session; required only once a real debt/hybrid scheme's factsheet-declared benchmark is confirmed CRISIL-owned. |
| Authorised multi-index vendor (e.g. a market-data distributor carrying NSE/BSE/CRISIL feeds under redistribution agreements) | Single integration point, one contract, one bill. | Mission explicitly warns: a vendor's general "NSE data" credential does NOT itself prove TRI/BSE/CRISIL/redistribution rights — each entitlement must be verified per index, per variant. Not identified or contacted this session (outreach is out of scope). |
| Manual CSV import (licensed) | Continuity channel, not a primary source — already has a design touchpoint in the existing Admin CSV-import pattern this repo uses elsewhere (see `app/api/admin/benchmarks/*` — note, that path is a **different, pre-existing "benchmark_datasets" governance system** for financial-planning targets, not this mission's index-level `ii_benchmarks`; see §7). | Requires the same licensing proof as any other channel — CSV delivery does not itself confer usage rights. |

## 3. Comparison matrix (per mission §3) — status: NOT POPULATED

Every column the mission asks for (exact index identifiers, price/TRI/net-TRI distinction, earliest
date, publication time, transport, automation rights, storage/caching rights, derived-returns
rights, display/export rights, attribution, user-count limits, retention-on-cancellation,
correction delivery, SLA, rate limits, support, annual/setup quote, historical charges,
redistribution fees, currency/tax, contract expiry) requires either a live-fetched terms page or a
vendor response. Neither was obtained this session (network access to the reference pages failed;
outreach is explicitly out of scope for this dispatch). **The matrix is intentionally left blank
rather than filled with invented numbers.** Populating it is the concrete next step and does not
require code — it requires either (a) a working fetch/browse path to the three reference URLs and
NSE Indices' actual subscription page, or (b) the PO or an authorised person visiting those pages
directly and pasting the current terms back for the next dispatch to encode.

## 4. What this means for build sequencing (mission §14)

Because no source is contractually or technically confirmed, this mission is currently
**source-blocked for B4 (ingestion)**, exactly as the mission's own decision-rule anticipates: the
provider-neutral adapter interface (mission §8) and the CSV staging/validation/publish path
(mission §10, §13) can and should be built and tested against fixtures without waiting on a
vendor, but no adapter can be pointed at a real endpoint, and no `source-blocked` status can be
cleared, until real credentials/rights exist.

## 5. Category averages

Per mission §2/§5, category averages require a separately licensed peer dataset and are explicitly
out of scope for initial index certification. No category-average work should be attempted before
a dedicated PO decision on that separate dataset.

## 6. Held-instrument demand (what benchmarks would actually need to be sourced)

DEV's `ii_scheme_master` table (14,374 rows) was inspected directly this session. It has **no
declared-benchmark column at all** — its columns are identity/classification only
(`amfi_scheme_code`, `scheme_name`, `amc_name`, `isin_*`, `category_group`, `sub_category`,
`scheme_structure`, lifecycle/effective-dating). This empirically confirms the mission's own
warning (§6): AMFI scheme-master data does not carry each scheme's declared benchmark, and none
should be assumed from it. Actual per-scheme declared benchmarks still need to come from AMC
scheme documents/factsheets/addenda, which this session did not attempt to source (that is B3
mapping work, not B1 source procurement, and depends on the outcome of this document).

No genuine held-instrument-to-index demand list exists yet (see the B1 discovery note for why the
current `ii_instrument_benchmarks` rows in DEV cannot be used for this — they are test-fixture
artifacts, not real mappings).

## 7. A naming collision to flag for the Product Owner

This repository already has an **unrelated, pre-existing** "Benchmarks" Admin surface at
`app/api/admin/benchmarks/*` and `components/admin/AdminBenchmarksClient.tsx`, backed by
`benchmark_datasets` / `benchmark_sources` / `benchmark_cohorts` / `benchmark_target_ranges`
tables (see `lib/services/benchmarkGovernance.ts`). That system is about **financial-planning
targets** (e.g. DTI/DSR benchmark ranges, per the "Dashboard formula decisions" and "UX redesign
decision" memory entries), not investment index levels. This mission's `ii_benchmarks` /
`ii_benchmark_series` / `ii_instrument_benchmarks` tables are a **separate system** for
Investment-Intelligence index comparisons. The mission's own §13 instruction ("no duplicate
administration portal") should be read as: reuse the existing Admin shell/navigation/role model,
but this is legitimately new admin *content* inside it — not a merge with the unrelated
`benchmark_datasets` governance system. Flagging this now so a future dispatch does not
accidentally conflate the two or try to "reuse" the wrong governance module.
