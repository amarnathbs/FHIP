# FDH-15 — Idempotency and Concurrency Certification

FRESH FDH-15 EXECUTION. Live-DEV evidence from `scripts/fdh15_bridge_governance_live_dev_certification.mjs`.

## 1. Double-Apply — live-tested, structurally idempotent

Mechanism (identical shape in Income/Liability/Retirement RPCs): a compare-and-swap `UPDATE
fhip_import_proposals SET status='applied' ... WHERE id=$1 AND status='ready'`, executed *inside*
the same row lock (`SELECT ... FOR UPDATE`) taken at the top of the function. A second call:

- If it arrives after the first committed: `status` is already `applied`, the `WHERE status='ready'`
  clause matches zero rows, `NOT FOUND` fires, and the RPC returns `ALREADY_APPLIED` before any
  further mutation.
- If it arrives while the first is still in-flight: it blocks on the row lock until the first
  transaction commits or aborts, then re-reads a `status` that is no longer `'ready'` and returns
  `PROPOSAL_NOT_ACTIONABLE`/`ALREADY_APPLIED` via the same early check.

**Live result (INC-2)**: second call to `fdh9_apply_income_proposal` for the same proposal returned
`{"ok":false,"code":"ALREADY_APPLIED"}`. **INC-2b**: exactly one `fhip_import_applications` row
exists for that proposal — independently backstopped by the table's own `UNIQUE(proposal_id)`
constraint (migration 0091), so even a hypothetical bypass of the application-layer guard could not
produce a second audit/application row.

## 2. Concurrent Apply — the same mechanism provides the guarantee

Two simultaneous requests for the SAME proposal serialise on the `SELECT ... FOR UPDATE` row lock —
Postgres guarantees only one transaction holds it at a time. There is no window where both readers
see `status='ready'` and both proceed to mutate: the second to acquire the lock always observes the
first's committed `status='applied'` (or, if the first aborted, observes `'ready'` again and may
legitimately proceed — correct behaviour, not a race). This is a genuine database-level guarantee,
not merely an application-layer convention, and was not fault-injected under real concurrent load in
this pass (repository/spec discipline against damaging shared DEV — reused from FDH-14's own
disclosed residual R-14-3/item 19 in its risk register: "sequential-insert / true concurrent-request
race conditions not exercised under real load" remains an open, bounded, non-blocking residual,
architecturally reasoned rather than load-tested).

## 3. HTTP replay — idempotent by the same mechanism

Replaying the identical successful Apply HTTP request (same proposal id, same decision, same
selected fields) hits the identical RPC path and the identical compare-and-swap — **duplicate
canonical effect: 0**, by the same evidence as §1.

## 4. Unknown commit outcome (server commits, client never sees the response)

The RPC's mutation (canonical write + application-audit insert + provenance stamp + proposal status
flip) all happen inside the one PL/pgSQL function invocation, which Postgres executes as a single
transaction (implicit, since the whole function body runs under one statement-level transaction
unless it explicitly starts a subtransaction, which it does not). A client that loses the connection
after the server committed, then retries, hits the same compare-and-swap and receives
`ALREADY_APPLIED` — **idempotent result**, not a duplicate.

## 5. Partial/atomic Apply

Every canonical write (the `income_sources`/`liabilities`/`retirement_accounts` UPDATE, the
`fhip_import_applications` INSERT, and the provenance-column UPDATE) happens inside the same
function invocation as the proposal's own status flip — Postgres functions execute inside the
calling statement's transaction, so a failure anywhere in the function body (e.g. the domain
`validateApply()` check, or a constraint violation on the `INSERT`) rolls back every write made so
far in that call, including the `status='applied'` flip. **Partial canonical mutation: 0** — this is
a structural guarantee (one function body = one transaction), not merely observed behaviour; it was
not additionally fault-injected against real hosted DEV this pass (would require a way to force a
mid-function failure without damaging shared DEV state, judged out of proportion for a pattern that
is already structurally guaranteed by PL/pgSQL's transaction semantics — disclosed as an
architectural-reasoning-only proof, consistent with FDH-14's own equivalent disclosure for its
Failure Mode Certification).

## 6. Investment (AU) idempotency — a different, ledger-appropriate mechanism

AU Investment Apply is NOT proposal-based (see `FDH15_BRIDGE_ARCHITECTURE_INVENTORY.md`). Its
idempotency guarantee is: (a) a compare-and-swap on the evidence row's own `apply_status`
(`pending→applying`), and (b) a **unique fingerprint index** on `ii_transactions.transaction_
fingerprint` — a second Apply attempt for the same evidence activity, even if it raced past the
`apply_status` CAS, would still hit a real Postgres `23505` unique-violation on the fingerprint,
never creating a duplicate transaction row. This exact mechanism was live-proven by FDH-14's own
golden-household oracle (`fdh14_golden_household_e2e_oracle.mjs`, Event 8's negative control: a
genuine `23505` rejection on a duplicate retirement-contribution activity) — REUSED evidence, the
underlying fingerprint-index code has not changed this pass.

## 7. Retirement idempotency

Same shared-RPC compare-and-swap mechanism as Income/Liability (§1-2) — one `fhip_import_
applications` row per proposal, `UNIQUE(proposal_id)` enforced.
