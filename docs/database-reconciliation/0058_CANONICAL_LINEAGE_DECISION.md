# 0058 reconciliation — canonical lineage decision

## Confirmed: zero schema overlap

Cross-checking `0058_FDH3_MANIFEST.md` against `0058_II_R6_MANIFEST.md`
object-by-object: FDH-3's file touches only `fdh_*` tables/functions/
triggers plus one `storage.objects` policy scoped to the
`fdh-source-documents` bucket. Investment Intelligence R6's five files touch
only `ii_*` tables plus one pre-existing R1 table's RLS policy
(`ii_tax_lots`). No table name, column name, function name, trigger name, or
policy name appears in both manifests. This was not assumed — it was
verified by reading both migrations' complete SQL (see the two manifest
files) and confirmed structurally by the zero-conflict merge (`git status
--short | grep -E "^(UU|AA|DD)"` returned nothing after each merge) and the
clean 63/63 rebuild replay. **Classification: `CONFLICTING` = none.**

The only thing the two files ever had in common was the two-digit string
"0058" in their filenames.

## Why the collision happened

Both branches applied the project's own binding numbering rule ("sync
main, run the guard, take the next free version") *correctly*, at *different
points in main's history*:

- FDH-3 forked from `origin/main` at `c868de6` — its own tip at the time —
  where `0057` was the highest active migration. `0058` was genuinely the
  next free version *as observed from that branch*.
- R6-security-final forked earlier, at `d18c4ac` (an ancestor of `main`
  strictly before `c868de6` — proven in `0058_BRANCH_TOPOLOGY.md`). At that
  earlier point in main's history, `0058` was ALSO genuinely the next free
  version *as observed from that branch* (after R6's own internal `0045`
  collision with FDH-1 was separately resolved during R6-FINAL closure —
  see `0059`'s own header comment for that distinct, already-resolved
  history).
- Neither branch's guard run (`check-migration-versions.mjs`) could see the
  other branch's allocation, because that guard — by design, matching every
  prior occurrence of this collision class in this project — inspects only
  the one checked-out working tree.

This is the same root-cause pattern as the prior Investment Intelligence +
Resources + Phase 0C collision
(`docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md`): parallel
unmerged branches, correct local reasoning, no cross-branch visibility.

## Why FDH-3 keeps `0058`

Two asymmetric facts, either one independently sufficient:

1. **FDH-3 is the direct continuation of canonical `main`'s own certified
   chain.** Its merge-base with `origin/main` IS `origin/main`'s current
   tip (`c868de6`) — i.e. FDH-3 was forked from main *as it stands today*,
   with nothing else in flight ahead of it. R6-security-final's merge-base
   with `origin/main` is the strictly earlier `d18c4ac` — main advanced
   without it.
2. **Renumbering FDH-3 would touch one file with zero downstream
   consumers; renumbering R6 touches a chain of five, four of which
   reference each other by number in prose (now-corrected) comments and
   all of which were already independently certified and live-verified
   under their original numbers in prior sessions this same day** (R6-P1,
   R6-FINAL, R6-DEBTFIX — see `investment_intelligence_r6` project memory).
   Shifting the smaller, newer, standalone file is strictly less invasive
   than shifting the larger, already-certified chain — and it isn't even
   necessary to shift the chain's *content*, only its *filenames* (see
   below).

## Why forward-renumbering (not a rewritten "re-emission migration") was correct here

The prior reconciliation
(`docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md`) used a
different mechanism — archive the ten displaced files verbatim, and
re-emit their *effects* via one new idempotent forward migration (`0049`)
— because at that time DEV had never been repaired and no ledger could
prove what had actually run. That mechanism is the right one when you
cannot be sure a losing migration's effects are already live.

**That precondition does not hold here.** Both original `0058` files —
FDH-3's and Investment Intelligence R6's entire `0058`-`0062` chain — had
ALREADY been independently applied to the SAME shared DEV database, each
under its own original filename, before this reconciliation began (verified
in prior sessions this same day, and re-confirmed directly by query in
`0058_EXPECTED_VS_DEV.md`). There is no missing schema to re-emit. Writing
a "re-emission migration" here would either:

- do nothing (every object already exists — a no-op, adding a file with no
  purpose), or
- risk erroring against already-existing objects if any statement weren't
  perfectly `IF NOT EXISTS`/`CREATE OR REPLACE`-guarded, for zero benefit
  over simply renaming the file.

Instead, R6's five files were `git mv`'d forward one slot each (highest to
lowest, to avoid transient same-commit collisions), preserving git's rename
detection (confirmed via `git show --stat 3e65043`). **This is pure
repository bookkeeping.** DEV was never tracking a filename — Supabase
Dashboard SQL-editor execution (this project's applied-migration mechanism
throughout its history — see the prior ADR's "no migration runner" finding)
never wrote to any `schema_migrations` ledger keyed by filename. DEV only
ever knew the SQL text it ran. That SQL text is byte-identical before and
after the rename (confirmed: only header comments changed). Renaming the
file changes nothing about what DEV has.

## How this avoids DEV ledger fiction

No claim is made anywhere in this repository that "migration `0059`
`_ii_r6_p1_tax_engine.sql` was applied to DEV" as a filename-keyed fact —
because no such ledger exists to make that claim in. What IS claimed, and
independently verified by direct query (`0058_EXPECTED_VS_DEV.md`), is the
only fact that matters: **the SQL effects described in that file's content
are live in DEV.** The file's number is metadata for humans and for a
future clean-rebuild replay, not a claim about DEV's history. This is
identical in spirit to the prior reconciliation's own principle ("the
applied database state is a fact; the repository's representation of it is
what was wrong — we changed the representation and left the facts alone"),
applied to a renumber instead of an archive+re-emit, because the renumber
case's facts didn't need re-emitting in the first place.

## Consequences

- A fresh database rebuilds deterministically from `0001` to `0063` with no
  duplicate versions and no manual intervention (`0058_CLEAN_REBUILD_
  CERTIFICATION.md`: 63/63, 170 tables, 170/170 RLS).
- DEV needs no repair and receives no new DDL from this reconciliation.
- The five renamed files remain fully attributed to Investment Intelligence
  R6 via `git log --follow` (rename history preserved).
- A future occurrence of this collision class is now automatically
  detectable pre-merge via `scripts/check-migration-versions-against-
  branch.mjs` (see the ADR's "Future prevention" section) — the exact gap
  that let this one go undetected until both branches' tips existed
  side-by-side is closed.
