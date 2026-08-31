# FDH-12 — Scale Certification

Spec sections 138-142.

Harness: `tests/unit/fdh12ScaleCertification.test.ts` — **28 tests, all PASS**.

## What was done

### Statement activity scale (spec 138)

Every scale the spec names, end to end through detection → extraction →
reconciliation → fingerprint → dedup:

| Rows | Extraction exact | Reconciles to the cent | Dedup: 0 false positives |
| --- | --- | --- | --- |
| 100 | PASS | PASS | PASS |
| 500 | PASS | PASS | PASS |
| 1,000 | PASS | PASS | PASS |
| **1,001** | PASS | PASS | PASS |
| 5,000 | PASS | PASS | PASS |
| 10,000 | PASS | PASS | PASS |

The 1,000/1,001 pair is the boundary that matters: an off-by-one truncation
would show 1,000 rows for a 1,001-row statement and still look plausible.

### Exactness does not degrade with volume

A $0.01 error is still detected at **10,000 activities**. The negative control
shows binary float would have drifted: 10,000 additions of `0.1` does not equal
1000, while the integer-minor-unit path gives 1000 exactly.

### PostgREST pagination boundary (spec 139)

`fetchAllRows` is exercised against a fake pager that behaves exactly as
PostgREST does (at most `pageSize` rows per request, stop on a short page), at
999 / 1,000 / 1,001 / 2,500 rows. Every row is returned, ids contiguous —
nothing lost at the boundary or in the middle.

The negative control shows a naive single-page read returns 1,000 rows for a
1,001-row set.

`fetchAllRows` is used at **every** collection read in FDH-12: the review
route's activities and positions, the account-resolution account list and prior
statements, the payslip-match activity and payroll reads, the bank-match
activity and transaction reads, the rollover leg read, and the fingerprint
refresh. Asserted by `tests/unit/fdh12Isolation.test.ts`.

### Multiple accounts (spec 140)

Households of **1, 5, 10 and 20** retirement accounts. Every account remains
reachable by its own masked identifier at every scale — no ambiguity is
introduced by scale alone.

### Long history (spec 141)

**1, 3, 5 and 10 years** of monthly contributions:
* reconcile exactly at every horizon;
* produce no false duplicates (every month is a distinct fingerprint);
* re-import as fully duplicate, with nothing lost.

## What was NOT done — honestly disclosed

* ~~The 1,000/1,001 boundary has not been exercised against hosted DEV.~~
  **CLOSED 2026-08-30.** Migration 0112 was applied to DEV and the boundary was
  then exercised for real (`scripts/fdh12_live_dev_certification.mjs`, phase
  `pagination`), 6/6 PASS:

  | Rows | Extracted | Stored in hosted DEV | Seen by the application's own read path |
  | --- | --- | --- | --- |
  | 1000 (at PostgREST's cap) | 1000 | 1000 | **1000** |
  | 1001 (one past the cap) | 1001 | 1001 | **1001** |

  "Seen by the application's own read path" is the sum of every bank-match
  outcome returned by `/evidence-matches`, which reads through `fetchAllRows`. A
  silent truncation at `db-max-rows` would have reported 1000 for the 1001-row
  statement. It did not.
* **5,000 and 10,000 rows were certified in PGlite and in pure TypeScript, not
  live.** Spec section 139 explicitly permits this ("Retain PGlite
  certification for 5k/10k if live latency is unreasonable").
* No load or latency benchmark was run. Correctness at scale was the target;
  throughput was not measured.
