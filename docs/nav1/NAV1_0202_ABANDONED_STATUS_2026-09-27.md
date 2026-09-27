# NAV 1 — migration `0202`: abandoned status, 27 Sep 2026

**`0202` must never be applied, under any name, on any branch, to any database.**

## Why

`0202_nav1_nav_schedules_http_timeout.sql` re-registered the daily-NAV and
scheme-master pg_cron jobs with an explicit 300-second `net.http_post`
timeout, but kept the OLD single-tick schedules (`'30 3 * * 2-6'` /
`'0 3 * * 2'`). It was superseded the same day by `0204` (the exact-pair
lookup RPC) + `0205` (the budgeted, repeated-call morning window), which
includes the identical 300-second timeout AND the correct repeated schedule.
`0205`'s own header states this explicitly: *"0202 is harmless BEFORE 0205
... but must never be applied AFTER it: it would put back the single 03:30
tick, and a single budgeted call writes only part of a day."*

## Where it is today (checked 27 Sep 2026, this dispatch)

- **`origin/main`**: does **not** contain `0202` under either name it was ever
  given. Verified directly: `git ls-tree -r --name-only origin/main --
  supabase/migrations | grep 0202` returns nothing.
- **A second, unrelated migration also numbered `0202`**
  (`0202_ii_ai_extraction_reviews_server_write_only.sql`, from a different,
  concurrent programme) exists both in history and — separately — the
  repository now uses `0203` for that file on `main`. This is a different
  migration with a different purpose; it is not the NAV1 one and is not
  abandoned.
- **A loose copy of the real NAV1 `0202`
  (`0202_nav1_nav_schedules_http_timeout.sql`) still exists** on the
  **unmerged** branch `fix/nav1-production-completion-2026-09-25`, tip
  `6199281` at the time of this check:
  ```
  git ls-tree -r --name-only origin/fix/nav1-production-completion-2026-09-25 \
    -- supabase/migrations | grep 0202
  -> supabase/migrations/0202_nav1_nav_schedules_http_timeout.sql
  ```
  That branch's *other* commits were carried into `main` as `bc47a9f`
  ("without 0202" — recorded at the time), but the branch itself was never
  rewritten, so this one file is still sitting in that branch's own history
  and working tree.

## What this dispatch did about it

Nothing to that branch — per this mission's explicit instruction, another
branch's contents are not this session's to touch, and no broad `git
checkout`/reset was run anywhere. This note exists so the fact is recorded
and actionable rather than silently re-discovered later.

## Action for the PO (or that branch's owner)

Delete `supabase/migrations/0202_nav1_nav_schedules_http_timeout.sql` from
`fix/nav1-production-completion-2026-09-25` (or mark it abandoned in a commit
on that branch), or simply delete the branch if it is no longer needed for
anything else — its useful commits are already on `main`. Until then, the
only real risk is a future session or operator checking out that specific
branch and running its migrations directory wholesale without checking this
note first; migration `0205` (and this dispatch's `0220`/`0221`/`0222`, all
numbered well after `0202`) apply cleanly regardless of whether the loose
`0202` file is ever deleted, since a fresh chain replay always applies `0205`
*after* `0202` alphabetically and `0205`'s own logic re-asserts the correct
schedule unconditionally.
