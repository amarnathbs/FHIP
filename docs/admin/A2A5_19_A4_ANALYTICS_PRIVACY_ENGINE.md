# A4.3 — Canonical Analytics Privacy Engine

## Status: NOT STARTED (implementation). Design fully specified pre-existing (`A1_15`); this document is a gap analysis against the mission's own explicit build/test checklist, not new design work.

## 1. Why this remains NOT STARTED

`A1_20` names this "the highest [privacy risk] in the roadmap... a defect here is exactly the class of defect that produced the Recommendations Gap Review incident" — the one Admin feature that ever exposed individual-level data, which was withdrawn entirely rather than patched. Mission §10.8 is explicit: **"A4 cannot receive FULL PASS without real DEV proof."** Building this engine's actual suppression logic without the ability to run mission §10.3's 16-vector threat model against a real, populated database would produce exactly the "code exists, never verified" outcome this repository's own history repeatedly warns against (see `MEMORY.md`'s pattern of downgraded self-certified passes). No DEV credentials exist in this environment (`A2A5_09` §1). This is a deliberate, reasoned non-start, not an oversight.

## 2. Threat-model test vectors (mission §10.3) — mapped to what each would need, none executable here

| # | Vector | What it needs to test for real |
|---|---|---|
| 1 | Small cell | A populated table with a cell below the size-5 threshold |
| 2 | Small distinct-person count | A cell with fewer than 10 distinct people, even if the row count is ≥5 |
| 3 | Complementary category | A partition where suppressing one cell must force a second suppression in the same partition |
| 4 | Total-minus-visible-cell subtraction | A real total/subtotal alongside suppressed and visible cells, checked for reconstructibility |
| 5 | Repeated date filtering | Multiple real queries narrowing a date range to try to isolate a suppressed cohort |
| 6 | Repeated geography filtering | Same, for a geographic/jurisdiction dimension |
| 7 | Overlapping cohorts | Two queries whose cohorts overlap, checked for a reconstructible difference |
| 8 | Sorting/ranking leakage | A ranked result set checked for whether rank position alone discloses a suppressed value |
| 9 | Export bypass | The same query via CSV/PDF export, checked for identical suppression to the UI/API |
| 10 | API bypass | The same query via direct API call, checked for identical suppression to the UI |
| 11 | Pagination leakage | Paged results checked for a suppressed row becoming inferable across pages |
| 12 | Cached unsuppressed result | A cache invalidation check ensuring a stale cached value can't resurface after data changes make it unsafe |
| 13 | Mixed-role leakage | Two different roles' views of the same data, checked for one role's view disclosing what another's suppression hides |
| 14 | Stable pseudonym correlation | A keyed-HMAC pseudonym checked for whether it can be correlated back to a real identity across two datasets |
| 15 | Exact rare-value disclosure | A rare-but-not-suppressed value checked for whether its exactness itself is identifying |
| 16 | Benchmark/segment intersection attack | Two segment filters combined, checked for whether their intersection isolates a suppressed individual |

None of these 16 can be meaningfully run against mocked/synthetic in-memory data with any real assurance — the entire point of an adversarial suppression test is that it must run against realistic data *distributions* (Standard §7.2: "starting controls... require pre-production revalidation against real data distributions"), which a hand-rolled unit-test fixture cannot honestly claim to represent. Attempting a hermetic version of these 16 tests here would risk exactly the false-confidence outcome mission §14 warns against ("Do not downgrade a stop condition into a documentation note merely to reach FULL PASS").

## 3. What the design already commits to (unchanged, `A1_15`, restated for this register's completeness)

Minimum cell size 5, minimum distinct people 10, minimum evaluation runs 20 (Standard §7.2, interim); complementary suppression; no individual drill-down; no exact pseudonymous financial profiles; rounding/banding for sensitive financial measures; identical protection across UI/API/export; privacy review before any new dimension or export; keyed-HMAC pseudonymization (never an unsalted hash) where a stable pseudonym is genuinely required.

## 4. Verdict

**NOT STARTED.** Cannot reach FULL PASS in this environment by the mission's own explicit rule (§10.8/§15.3). Recommended next step: a follow-up pass with real DEV access builds the RPC against `A1_15`'s contract, then runs all 16 vectors above against real data before any part of this is considered complete.
