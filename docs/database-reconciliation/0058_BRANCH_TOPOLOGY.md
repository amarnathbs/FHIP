# 0058 reconciliation — branch topology

Confirmed live via `git merge-base` / `git merge-base --is-ancestor` against
this worktree's actual history (reproduced 2026-08-23; commands shown so
this is independently re-checkable, not asserted).

## The four fixed points

| Ref | Commit | What it is |
| --- | --- | --- |
| `origin/main` | `c868de6` | Canonical main, certified chain through `0057` (FDH-2 closure). |
| `d18c4ac` | `d18c4ac` | Common ancestor of FDH-3's branch and R6-security-final's branch. Also an ancestor of `origin/main` itself (`git merge-base --is-ancestor d18c4ac origin/main` → true) — i.e. it is a ancestor commit on main's own history, just an earlier one than `c868de6`. |
| FDH-3 HEAD | `a471a1b` | `feature/financial-data-hub-fdh-3-document-lifecycle`, never pushed. |
| R6 HEAD | `3af02e3` | `feature/investment-intelligence-r6-security-final`, pushed to `origin`. |

## Fork points (measured, not assumed)

```
git merge-base a471a1b 3af02e3        -> d18c4ac   (common ancestor of the two feature branches)
git merge-base a471a1b origin/main    -> c868de6   (FDH-3 forked from main's CURRENT tip)
git merge-base 3af02e3 origin/main    -> d18c4ac   (R6 forked from an EARLIER point on main)
git merge-base --is-ancestor d18c4ac origin/main -> true (exit 0)
```

This proves, rather than assumes, the asymmetry the Product Owner decision
rests on: **FDH-3 is built directly on top of canonical `main`'s own current
tip** (its merge-base with `origin/main` IS `origin/main`'s tip), whereas
**R6-security-final's fork point (`d18c4ac`) is a strictly earlier commit on
that same main line** — main advanced past `d18c4ac` to `c868de6` (through
the Resources R1.1-R1.5 commits, Phase 0C, and more) while R6's branch was
being developed independently and never rebased.

## Ancestry diagram

```
main:  ... d18c4ac ─────────────────────────────────────────► c868de6 (origin/main tip, 0001-0057)
                │                                                  │
                │ (R6 branch forks here, never rebased)            │ (FDH-3 branch forks here)
                ▼                                                  ▼
       feature/investment-intelligence-       feature/financial-data-hub-
       r6-security-final                      fdh-3-document-lifecycle
       ... → 3af02e3 (pushed to origin)       ... → a471a1b (never pushed)
       allocates "0058" for                   allocates "0058" for
       ii_r6_p1_tax_engine.sql                fdh3_document_lifecycle_
       (+ 4 more R6-FINAL migrations,         upload_storage.sql
        0059-0062 originally)

                │                                                  │
                └──────────────────┬───────────────────────────────┘
                                    ▼
                    feature/r7-baseline-integration
                    (this worktree)
                    merge origin/main (c868de6) +
                    merge feature/investment-intelligence-r6-security-final (3af02e3) +
                    merge feature/financial-data-hub-fdh-3-document-lifecycle (a471a1b)
                    -> zero unresolved conflicts
                    -> R6's 0058-0062 renamed forward to 0059-0063 (git mv, preserving rename history)
                    -> FDH-3 keeps 0058 unchanged
                    HEAD = 3e65043 "chore(db): reconcile FDH-3 + Investment
                            Intelligence R6 migration-0058 collision"
                    (+ this reconciliation's own doc/tooling commits on top)
```

## Why neither branch's own guard run could have caught this

Both branches ran `node scripts/check-migration-versions.mjs` before their
own commits — it is wired into `npm test` and has been since the prior
(Investment Intelligence + Resources + Phase 0C) reconciliation. That guard
inspects only the ONE checked-out working tree. FDH-3's checkout never
contained `0058_ii_r6_p1_tax_engine.sql`; R6's checkout never contained
`0058_fdh3_document_lifecycle_upload_storage.sql`. Each branch, in
isolation, genuinely had "one file per version" — the collision only exists
across the pair. This is exactly the gap the new
`scripts/check-migration-versions-against-branch.mjs` tool closes (see
`docs/architecture/ADR_0058_FDH3_II_R6_RECONCILIATION.md`, "Future
prevention").
