# FDH-15 — Proposal State Machine

Real enums, taken verbatim from the current schema (migration `0091`, widened by `0096`/`0112`).
No state below was invented to match this brief's vocabulary — where the spec's suggested states
(`DRAFT`, `REVIEW`, `APPROVED`, `FAILED`, `SUPERSEDED`) do not exist as distinct DB states, that is
noted explicitly rather than fabricated.

## `fhip_import_proposals.status`

Enum: `'ready' | 'applied' | 'superseded' | 'dismissed' | 'expired'`.

There is no separate `DRAFT`/`REVIEW`/`APPROVED` state for the proposal itself — a proposal is
created already `'ready'` (spec's "READY"), because the precondition it depends on (evidence
approval) is tracked on the **evidence** row (`fdh_payroll_events.approval_status`,
`fdh_liability_statements.approval_status`, `fdh_retirement_statements.approval_status`,
`fdh_investment_statements.approval_status`), each independently gated `'pending'→'approved'` by
its own approve RPC/API before a proposal referencing it is even generated (or, for Retirement,
re-checked again at Apply time — `EVIDENCE_NOT_APPROVED`).

| From | To | Who | Enforced by | Reversible? |
|---|---|---|---|---|
| (none) | `ready` | System (proposal-generation service, on the owning user's request) | RLS `INSERT ... WITH CHECK (auth.uid()=user_id AND status='ready')` — only `'ready'` can ever be inserted | N/A |
| `ready` | `dismissed` | Owning user (Keep Existing decision) | Apply RPC's own `keep_existing` branch, via the internal-write GUC | No (a dismissed proposal cannot be re-opened; the read path filters it out) |
| `ready` | `applied` | Owning user (explicit Apply, any decision except `keep_existing`) | Apply RPC's compare-and-swap `UPDATE ... WHERE status='ready'` | No |
| `ready` | `superseded` | System (newer evidence arrives) | Documented column, no automatic detector implemented for revised-payslip supersession (disclosed gap, `FDH9_COMPLETION_REPORT.md`) | No |
| `ready` | `expired` | Reserved value in the CHECK constraint; **no code path sets it today** | N/A | N/A |
| `applied` | (any) | **No transition exists.** `applied` is terminal. | The RPC's own state check (`status <> 'ready'` → `ALREADY_APPLIED`/`PROPOSAL_NOT_ACTIONABLE`) and the RLS UPDATE policy (ownership only, not a transition allow-list) — the trigger `fdh9_import_proposals_assert_authoritative_write()`/`trg_fhip_import_proposals_authoritative_write` blocks any direct client PATCH that would otherwise attempt an authoritative transition | N/A |
| `dismissed`/`superseded`/`expired` | (any) | **No transition exists.** All three are terminal. | Same trigger/RPC discipline as above | N/A |

## `fhip_import_applications` (the Apply audit record)

Not a state machine — **append-only**. `unique(proposal_id)` means at most one application row can
ever exist per proposal (the DB-level idempotency guarantee, spec §34). No UPDATE/DELETE RLS policy
exists for the authenticated role.

## Per-domain evidence approval state (feeds proposal eligibility, not the proposal's own state)

| Table | Enum | Notes |
|---|---|---|
| `fdh_payroll_events.approval_status` | `'pending'\|'approved'` | Two states only — no reject state at the event level |
| `fdh_liability_statements.approval_status` | `'pending'\|'approved'` | Same shape |
| `fdh_retirement_statements.approval_status` | `'pending'\|'approved'` | Same shape; re-checked at Apply time (`EVIDENCE_NOT_APPROVED`) |
| `fdh_investment_statements.approval_status` | `'pending'\|'approved'` | Same shape |
| `fdh_transactions.approval_status` (Expenses) | `'pending'\|'approved'` | The terminal state for Expenses — there is no further "proposal" stage |

## Illegal transitions attempted and required-BLOCKED (spec §15)

Verified live on hosted DEV this round (see `FDH15_LIVE_DEV_CERTIFICATION.md`), using the real
`fdh9_apply_income_proposal`/`fdh10_apply_liability_proposal`/`fdh12_apply_retirement_proposal` RPCs
with a real authenticated JWT:

- `applied → applied` (double Apply): **BLOCKED** — `ALREADY_APPLIED`, zero additional mutation
  (Income: INC-2/2b live-confirmed).
- Foreign-user proposal → Apply (`ready` owned by Tenant A, Apply attempted by Tenant B):
  **BLOCKED** — `PROPOSAL_NOT_FOUND` (Income: XT-3 live-confirmed; Liability: LIA-3 live-confirmed).
- `ready` (stale) → `applied` after the target's live value diverged from the snapshot:
  **BLOCKED** — `STALE_PROPOSAL` (Income: INC-4 live-confirmed).
- `DRAFT → APPLIED` / `REJECTED → APPLIED` / `FAILED → APPLIED`: not directly testable as named,
  because this schema has no `DRAFT`, `REJECTED`, or `FAILED` proposal states (see enum above) —
  the closest equivalents (`dismissed`, and the non-existent-inserted-as-anything-but-`ready`
  invariant) are covered by the RLS INSERT check and the `keep_existing`/dismiss path, both
  live-confirmed not to be reachable-then-appliable.
