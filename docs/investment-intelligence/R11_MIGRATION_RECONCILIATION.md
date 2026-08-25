# II-R11 Migration Reconciliation

R11's five migrations — `0082`, `0083`, `0086`, `0087`, `0088` — are all applied to DEV (`0087`/`0088` applied by the Product Owner via the Supabase SQL Editor 2026-08-25/26, no agent in this project has DDL execution access) and are FROZEN: never edit, rename, renumber, rewrite, or squash away any of them.

## Collision history (three legitimate rounds)

1. **Collision 1**: original R11 `0078`/`0079` collided with the unmerged Property↔Liability Linking branch (`0078`) and the App Review remainder branch (`0079`). Resolved: R11 renumbered to `0082`/`0083`.
2. **Collision 2**: R11 attempted `0084`, already owned by SMSF/Jurisdiction Segregation. `0085` was also allocated elsewhere (FDH-8's split-approval fix). Resolved: R11 used `0086`.
3. **Collision 3**: R11's live-DEV closure work introduced `0087`/`0088` for the authoritative-forgery guard and report-access-log cascade fix. `0087` collided with a concurrent SMSF migration (`0087_smsf_switch_to_summary.sql`). Resolved: canonical allocation retained R11 → `0087`/`0088`; SMSF renumbered to `0089` (later `0090` was added for a related SMSF integrity guard). Confirmed on the actual latest `origin/main` (`6a2701a`): SMSF's migrations are `0089`/`0090`, R11's `0082`/`0083`/`0086`/`0087`/`0088` have zero overlap.

## Fourth, non-blocking observation (R11-TERMINAL-FINAL round, not a fourth "collision round" against R11 itself)

A stale copy of the pre-renumber SMSF file (`0087_smsf_switch_to_summary.sql`) was found sitting in an **unmerged, non-ancestor-of-main** branch, `g0cr-reconciliation` (worktree `agent-acba2851d0cf00f2d`, HEAD `73717dd`) — an artifact of that branch merging an old SMSF lineage fork point that predates SMSF's own `0087→0089` renumber. This branch is not going to be merged as-is; a separately dispatched SMSF production-release task has been told to reconcile against current main via a fresh branch rather than reuse that stale merge. Per this task's own section 36 discipline, R11's frozen migrations are not touched in response to this — it is recorded here as a disclosed observation only.

## Final collision guard (re-run immediately before the terminal verdict)

Scanned every active git worktree's `supabase/migrations/` directory plus `origin/main` (`6a2701a`) for files matching `0082`, `0083`, `0086`, `0087`, `0088`:

- `origin/main`: none present (main's own 008x/009x range is `0084`, `0085`, `0089`, `0090` — all SMSF/FDH-8, zero overlap).
- R11's own worktree and its own prior-lineage worktrees (`r11-closure-work`, the original `feature/investment-intelligence-r11-multisource-professional` branch): same R11 content, not a distinct claim.
- `g0cr-reconciliation`: the one disclosed, contained, non-blocking `0087` observation above.

**Result: 0082 unique, 0083 unique, 0086 unique, 0087 unique (modulo the disclosed non-merging observation), 0088 unique. Collision Guard: PASS.**
