# NAV2 release candidate: raw run logs (DEV, 14-10-2026 UTC)

Logs of the runs quoted in `docs/nav2/NAV2_RELEASE_CANDIDATE_DEV_CERTIFICATION_15-10-2026.md`. DEV only, synthetic fixture users only, no secrets (checked for tokens and keys before copying). All journeys were run through the real routes of the application on port 3981 against the DEV project.

| File | What it is |
|---|---|
| `j12.log` | Journeys 1 and 2: accepted statement, held-only fetch, planner, report, PDF (54 pass) |
| `j3.log`, `j3b.log` | NAV correction and RBI value correction: cache freshness and immutability (28 and 17 pass) |
| `j4.log` | Version 7 cache proof (13 pass, 2 fail: the Product Owner's report version 6 is not on DEV, a precondition) |
| `j5.log`, `j5b.log` | Security and tenancy matrix (41 pass); states and reconciliation (6 pass) |
| `j6.log`, `j6b.log` | Ownership cases and joint SHARE (19 and 18 pass) |
| `j7.log` | Concurrency, 14 pass and 1 fail: more reports than intended because migration 0281 is not on DEV |
| `j8.log`, `j8b.log` | PDF acceptance (24 pass), UI, phone width, keyboard, axe (43 pass) |
| `j9.log` | Weekly RBI fetcher dry run (9 pass, writes nothing) |
| `d3.log` | Financial reconciliation across six surfaces (21 pass) |
| `d5.log` | Immutability extras and the permission split (15 pass) |
| `d8.log` | Concurrency and fairness (6 pass, 1 fail for the same 0281 reason) |
| `big_timing3.log`, `big_timing.json` | Timing of the real route for 1, 4, 10 and 20 funds, cold and warm, from the development machine |
| `big_user.log`, `big_hydrate2.log` | The 30-line statement and the choice of 20: first run (stopped by me after it showed the 22-fund merge and the livelock, see D-1 and D-6) and the second hydrate run |
| `oracle_final.log` | Independent oracle, 159 checks on report version 29 of the holder |
| `nav2_group_run2.log` | NAV2 tests together plus two migration-number guards (61 files, 948 tests) |

The full-suite comparison is summarised in `docs/nav2/BASELINE_FAILURES.md`; the JSON files of both full runs are not kept (about 6 MB each).
