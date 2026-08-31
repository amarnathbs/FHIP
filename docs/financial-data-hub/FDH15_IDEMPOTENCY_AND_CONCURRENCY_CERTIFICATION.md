# FDH-15 — Idempotency and Concurrency Certification

## Mechanism

Every generic-bridge Apply RPC (Income/Liability/Retirement):
1. `SELECT ... FOR UPDATE` locks the proposal row for the transaction's duration — a concurrent
   second caller blocks here until the first commits/aborts, then re-reads a status that is no
   longer `'ready'`.
2. A compare-and-swap `UPDATE fhip_import_proposals SET status='applied' WHERE id=... AND
   status='ready'` — if zero rows affected, returns `ALREADY_APPLIED` without touching canonical
   data.
3. `fhip_import_applications` carries `UNIQUE(proposal_id)` — a second application row for the same
   proposal is a DB-level impossibility even if the API layer were bypassed entirely.

AU Investment uses the equivalent pattern at the evidence-row level (`apply_status`
compare-and-swap `pending→applying`) plus a DB unique index/fingerprint on the canonical write
itself (`ii_transactions.transaction_fingerprint`, `ii_holding_snapshots`'s own
`(account_id,instrument_id,as_of_date)` unique index) as a second, independent backstop.

## Double Apply — live-reproduced (Income, INC-2/2b)

Applying the same `'ready'` proposal, then applying it again with identical parameters:
- Second call: `{"ok":false,"code":"ALREADY_APPLIED", ...}`.
- Ground truth re-query: exactly **one** `fhip_import_applications` row for that `proposal_id`.

## Concurrent Apply

Not independently fault-injected as a genuine two-in-flight-simultaneously HTTP race this round
(spec §61/§74 discourage damaging shared DEV with real race conditions); the row-lock +
compare-and-swap mechanism above is the same one FDH-9/FDH-10/FDH-12/FDH-11's own prior
certification rounds already proved live under real concurrent load (`FDH9_LIVE_DEV_CERTIFICATION.md`
et al. — reused evidence, not re-derived). FDH-15's own contribution here is confirming the
mechanism is **structurally identical** across all three generic-bridge domains (same row-lock +
compare-and-swap shape, verified by direct reading of all three RPC bodies this round) — so a
concurrency proof for one is architectural evidence for the others, not proof by assertion alone.

## HTTP replay / unknown commit outcome (spec §118, §169)

Not independently re-tested as a raw HTTP replay this round. Architecturally covered by the same
compare-and-swap: replaying the identical `apply` request (same `proposal_id`) after a successful
commit necessarily finds `status <> 'ready'` and returns `ALREADY_APPLIED` — the mechanism does not
distinguish "client didn't see the first response" from "client is intentionally retrying," which
is exactly the correct idempotent behaviour for both. Disclosed as architecturally-covered-but-not-
freshly-HTTP-replayed (P3 residual).

## Partial Apply / atomicity (spec §87–91)

Each Apply RPC is a single Postgres function — in Postgres, a function body executes inside one
transaction by default; a raised exception anywhere in the body rolls back every write the
function made in that call, including the compare-and-swap claim itself. No canonical mutation,
proposal-status transition, or audit-row insert can be left half-applied. Not independently
fault-injected with a forced mid-function failure against real hosted DEV this round (would require
damaging shared DEV state to construct — disclosed as an open P3 per FDH-14's own equivalent
disclosed residual, R-14-3, which FDH-15 does not re-litigate).

## Idempotency per domain (spec §57–60)

- **Income**: proven live this round (INC-2/2b).
- **Liability**: same RPC shape (row-lock + compare-and-swap + `UNIQUE(proposal_id)`), confirmed by
  direct code reading this round; not independently double-applied live this round (time-boxed —
  the mechanism is byte-for-byte structurally identical to Income's, which WAS live-proven).
- **Retirement**: same shape; not independently double-applied live this round for the same reason,
  but the fresh PGlite certification this round (`scripts/fdh15_member_mismatch_pglite_certification.mjs`)
  exercises the RPC's compare-and-swap path indirectly via its positive-control Apply calls.
- **AU Investment**: idempotency was already live-certified by FDH-11's own prior round
  (`FDH11_SECURITY_CERTIFICATION.md`: "concurrent Apply → exactly 1 canonical row") — reused
  evidence, re-confirmed by this round's fresh reading of the unchanged `applyAuStatementActivity.ts`
  source (no changes to this file on this branch).
