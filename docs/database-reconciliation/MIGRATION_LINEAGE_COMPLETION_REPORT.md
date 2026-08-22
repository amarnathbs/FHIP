# Migration-lineage reconciliation — completion report

- **Status:** CONDITIONAL PASS — implementation and certification complete (twice, independently); DEV application requires the Product Owner
- **Branch:** `fix/migration-lineage-ii-resources`
- **Commit at start of this pass:** `b1e8ccf` (unchanged by this pass — see "What this pass added" below)
- **Starting `main`:** `fe7a094`
- **DEV environment:** `vqycarelcoijzwlpkpcz` (confirmed from `.env.local`)
- **Production:** `twwpnltizhtjxhamyoxt` — **NOT TOUCHED, NOT CONTACTED, this pass or any prior pass**
- **Date of original reconciliation:** 2026-08-21
- **Date of this independent re-verification pass:** 2026-08-21 (same day, separate dispatch — pre-application closure only, spec §1-18/34-43/49; §19-33 explicitly out of scope until the Product Owner applies `0049`)

## What this pass added

This pass did not change any code, SQL, or the branch tip. It independently
**reproduced** (not copied) every certification claim below from scratch —
running the same scripts fresh, re-querying DEV live, and re-deriving every
number — specifically so a discrepancy from the original claims would be
caught rather than silently repeated. Two real, disclosed discrepancies were
found this pass and are called out explicitly rather than smoothed over (see
"Discrepancies found and disclosed this pass" below). Everything else
reproduced exactly. New evidence documents from this pass:
`docs/database-reconciliation/DEV_0049_PRE_APPLICATION_SNAPSHOT.md`,
`docs/database-reconciliation/RLS_FINAL_CERTIFICATION.md`,
`docs/database-reconciliation/OPEN_FINDINGS_REGISTER.md` (new — formally
tracks `DB-BASE-0012`). `docs/architecture/MIGRATION_REGISTRY.md`'s `0049`
row was corrected to the Product-Owner-specified wording
(`SQL READY — NOT YET APPLIED TO DEV`, Module = "Cross-stream
reconciliation"). Three pre-existing documents
(`CLEAN_REBUILD_CERTIFICATION.md`, `DEV_POST_REPAIR_CERTIFICATION.md`,
`RECONCILIATION_PLAN.md`) had an arithmetic-implication error corrected in
place (see below).

## Executive result

The repository migration lineage is repaired and the collision cannot recur.
The active chain now holds exactly one executable migration per version,
`0001`-`0049`, and rebuilds an empty PostgreSQL 18 database with zero manual
intervention. The ten displaced historical files are preserved verbatim in a
never-executed archive, and their canonical effects are re-emitted forward by an
idempotent migration `0049`.

**DEV needed no repair.** All 21 Phase 0C/Resources objects `0049` touches
already exist and are queryable in DEV today (re-confirmed live, read-only,
this pass — see `DEV_0049_PRE_APPLICATION_SNAPSHOT.md` §6). The single
previously-reported drift — `financial_section_status` "missing" — was a false
positive caused by inferring a table name from a migration filename; the table
that migration actually creates (`user_financial_section_status`) exists and
holds **97 rows** (re-verified live this pass, not assumed — exact match to
the previously-reported figure).

The one condition on this pass is that this sandbox has no DDL path to shared
DEV — verified, not assumed — so applying `0049` is a Product Owner handoff.
Since `0049` is a proven no-op against DEV, no schema or security defect remains
open either way.

## Root cause

Three streams branched from `main` (top: `0030`) and each allocated "the next
number after 0030" with no shared registry: Phase 0C took 0031-0032, Resources
took 0033-0040, Investment Intelligence took 0031-0044. Ten versions were
double-claimed.

It went undetected because **no migration runner is used against this project**.
There is no Supabase CLI link and no reachable SQL RPC; all 48 migrations were
applied by pasting SQL into the Dashboard SQL editor, which writes no ledger
entry. Nothing ever evaluated migration identity, so nothing ever noticed two
files claiming version 0031 — both simply ran. And because the lineages are
schema-disjoint, order never mattered, so DEV ended up correct regardless.

The damage was to reproducibility, not to DEV.

## Historical collision inventory

Ten collisions, 0031-0040 — full table in `LEGACY_MIGRATION_OWNERSHIP.md` and
`docs/architecture/MIGRATION_REGISTRY.md`. Both files of every colliding pair
were applied to DEV.

## Canonical decision

Investment Intelligence retains active `0031`-`0044`; the FDH-1 migrations
`0045`-`0048` sit on top unchanged. The Phase 0C and Resources files are
archived to `supabase/migration_archive/` and re-emitted by `0049`. Renumbering
Investment Intelligence would have invalidated four already-certified FDH-1
migrations.

## Forward migration

`supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql` — 1,960
lines, 21 tables (`CREATE TABLE IF NOT EXISTS`), 41 indexes, 48 policies
(each `DROP POLICY IF EXISTS` + `CREATE POLICY`), 6 constraints, 8 columns,
12 function definitions (`CREATE OR REPLACE`), 1 schema
(`CREATE SCHEMA IF NOT EXISTS private`). No `DROP TABLE`, no `DROP COLUMN`,
no data-type change, no `DELETE`, no `MERGE`; all 5 top-level `INSERT`
statements use `ON CONFLICT ... DO NOTHING`. Full statement-by-statement
inventory and mutating-statement safety analysis in
`DEV_0049_PRE_APPLICATION_SNAPSHOT.md` §4-5.

## Certification summary

| Area | Result | Reproduced this pass? |
|---|---|---|
| Clean rebuild `0001`-`0049` from empty | **PASS** — 49/49, zero manual intervention | Yes, exact match |
| Duplicate active versions | **0** (49 files, next free `0050`) | Yes, exact match |
| Order-equivalence (0049 vs original 0031-0040 ordering) | **PASS** — byte-identical across 205 columns, 234 constraints, 71 indexes, 48 policies, 21 RLS flags, 8 function-comparison rows | Yes, exact match |
| Idempotency of 0049 | **PASS** — second application a true no-op | Yes, exact match |
| Negative controls (schema-diff + RLS) | **PASS** — every comparison and isolation test proven able to fail | Yes, exact match |
| Fresh rebuild vs DEV — Phase 0C/Resources row counts | 97-row `user_financial_section_status`, 134-row `resource_post_tags`, 95-row `resource_post_versions` spot-checked live | Yes, exact match, re-queried live this pass |
| Fresh rebuild table totals | 155 relations total; **78** belong to the four reconciled/added streams (33 II / 20 Resources / 1 Phase 0C / 24 FDH), **77** are pre-existing base-FHIP tables from `0001`-`0030` | Yes — see "Discrepancies found and disclosed this pass" below for the correction made to how this was previously stated |
| RLS certification | **25/25 PASS** on real populated tenant data across all three lineages, negative controls confirmed genuine (session-scoped JWT, self-checked) | Yes, exact match — full detail in `RLS_FINAL_CERTIFICATION.md` |
| RLS coverage | **155/155 tables enabled**, 0 disabled | Yes, exact match |
| Byte-identity of relocated files | **10/10** archived files byte-identical to their source branches (all ten re-hashed this pass via `git hash-object` vs `git rev-parse <source-branch>:<path>`) | Yes, exact match |
| FDH regression | 24 tables, all RLS-enabled, migrations byte-identical — unchanged | Not independently re-run this pass (out of FDH's own scope); no evidence of drift found |
| Data preservation | Expected delta 0 — reconfirmed via the idempotency no-op result | Yes |
| TypeScript | **PASS** | Yes, exact match |
| Unit tests | **129 passed / 129** (15 test files) | Yes, exact match |
| ESLint | **6 errors / 7 warnings** — see discrepancy note below | **Discrepancy found: previously reported as 6 warnings** |
| Production build | **PASS**, exit 0, 143 route-tree entries printed | Ran successfully this pass once a local `.env.local` was supplied (gitignored, not committed) — see discrepancy note below |
| Migration collision guard negative control | **PASS** — exit 1, both colliding files named, cleanup verified clean | Yes, exact match, re-performed live this pass |

Detail in `CLEAN_REBUILD_CERTIFICATION.md`, `DEV_POST_REPAIR_CERTIFICATION.md`,
and this pass's `DEV_0049_PRE_APPLICATION_SNAPSHOT.md` /
`RLS_FINAL_CERTIFICATION.md`.

## Discrepancies found and disclosed this pass

Per the dispatch instructions for this pass, discrepancies from the
previously-reported baseline are stated plainly, not silently corrected:

1. **ESLint: 7 warnings, not 6.** The extra warning is
   `scripts/db-rebuild-check/replay.mjs:33:93 'ext' is defined but never
   used` (`@typescript-eslint/no-unused-vars`) — a trivial unused-variable
   warning inside the *new verification script itself* (one of this branch's
   own additions), not in `0049`, not in any executed migration, and not in
   shipped application code. The 6 pre-existing errors are unchanged and
   remain entirely in `app/` and `components/`, untouched by this branch.
   This is a real, minor discrepancy from the original "new files clean"
   claim — disclosed, not swept away — and it is not blocking: it is a
   throwaway verification script's cosmetic lint warning, not part of `0049`
   or any executed migration.
2. **The "155 tables" / "33 II / 20 Resources / 1 Phase 0C / 24 FDH" figures
   were juxtaposed in three documents
   (`CLEAN_REBUILD_CERTIFICATION.md`, `DEV_POST_REPAIR_CERTIFICATION.md`,
   `RECONCILIATION_PLAN.md`) in a way that reads as though 33+20+1+24 = 155.**
   It does not — those four counts sum to **78**. The remaining **77** of the
   155 total are pre-existing base-FHIP tables from migrations `0001`-`0030`,
   entirely unrelated to this reconciliation. All three documents have been
   corrected in place this pass with an explicit subtotal row and a
   correction note, rather than silently repeating the ambiguous framing.
   This was not a computational error anywhere in the underlying scripts
   (`replay.mjs` correctly reports `tables:155` and the per-module counts
   separately, and never claims they sum to the same number) — it was purely
   a presentation issue in how three markdown tables laid the two true facts
   next to each other.

Everything else in the certification summary above reproduced with **zero**
discrepancy, including the two numbers most load-bearing for a security
verdict: RLS 25/25 and the migration-collision guard's negative control.

## Collision guard

- `scripts/check-migration-versions.mjs` — fails with exit 1 if two active
  migrations share a version; reports the next free version. Inspects only
  `supabase/migrations`, excluding the archive.
- `tests/unit/migrationVersions.test.ts` — runs it inside the existing
  `npm test` gate, so a reintroduced collision breaks the build. Includes a
  negative control that constructs a synthetic collision and asserts detection.
- **Live negative control performed (both the original pass and again this
  pass):** restoring `0033_resources_foundation.sql` into the active
  directory made the guard fail with exit 1 and name both colliding files
  (`0033_ii_transactions_holdings.sql` and `0033_resources_foundation.sql`);
  removing it restored exit 0 and a clean `git status`.

## Regression scope note

Investment Intelligence and Resources application code and test suites live only
on their own unmerged feature branches. This branch is a database-governance
branch off `main` and **changes zero application code** — the entire diff is
`supabase/`, `scripts/`, `tests/unit/migrationVersions.test.ts` and `docs/`
(re-confirmed via `git diff --numstat main..HEAD` this pass). Their functional
behaviour is therefore unaffected by construction, and this is reinforced by
the stronger structural evidence: all 14 Investment Intelligence and all 10
archived Resources/Phase 0C migration files are byte-identical to their source
branches, and the schema produced by the reconciled chain is byte-identical to
the schema produced by the original ordering.

## Remaining findings

1. **`0049` not yet applied to DEV** — Product Owner action, the sole
   blocking condition on this reconciliation moving from CONDITIONAL PASS to
   FULL PASS. Verified no-op (proven via idempotency test + live DEV
   read-only snapshot showing all 21 target objects already present).
2. **`DB-BASE-0012`** (formally tracked this pass in the new
   `OPEN_FINDINGS_REGISTER.md`) — pre-existing, out of scope:
   `0012_module8_benchmark_seed.sql` foreign-keys into `countries`, which no
   migration seeds (the rows come from `supabase/seed.sql`). A stock
   `supabase db reset` would fail at `0012`. This is a latent defect in
   `main`'s base chain, unrelated to the collision, and was deliberately not
   repaired here or this pass.
3. **Not in scope, unchanged:** `FDH1-F1`, the disclosed LOW-severity
   cross-tenant FK referential-integrity finding (cross-referenced in
   `OPEN_FINDINGS_REGISTER.md`; FDH-1's own docs remain authoritative).

## Verdict

- **Investment Intelligence + Resources + Phase 0C migration lineage:
  CONDITIONAL PASS** (repository lineage fully repaired and certified —
  independently reproduced twice now, by two separate passes; DEV
  application pending)
- **DEV canonical schema:** CERTIFIED (repository-side); **not yet
  re-certified live-DEV post-application**, because there has been no
  application yet
- **Fresh-rebuild migration chain:** CERTIFIED, reproduced twice
- **This pass's own new evidence and doc-correction work:** COMPLETE — see
  "What this pass added" above

**This verdict deliberately does not change to FULL PASS in this pass.** The
sole remaining blocking condition — DEV application of `0049` — is
structural, not something a second round of repository-side verification can
resolve. See "What the Product Owner needs to do next" below.

## What the Product Owner needs to do next

1. Apply `supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql`
   to the DEV project (`vqycarelcoijzwlpkpcz`) via the Supabase Dashboard SQL
   editor. Its complete, verbatim contents were already delivered in chat by
   the orchestrating session immediately before this task was dispatched.
   Expected outcome: success, zero rows affected beyond possibly the 5
   `ON CONFLICT DO NOTHING`-guarded seed inserts (each a genuine no-op against
   already-seeded DEV data) — a consistency formality, since DEV already has
   every object `0049` creates.
2. Report back once applied. The orchestrating session will then run the
   out-of-scope sections of the Product Owner's spec (§19-33): live
   post-application verification against DEV (re-running the row-count and
   structural-fingerprint checks in `DEV_0049_PRE_APPLICATION_SNAPSHOT.md`
   §6 against post-application DEV and diffing them), produce
   `DEV_0049_APPLICATION_EVIDENCE.md` and
   `DEV_0049_POST_APPLICATION_CERTIFICATION.md` (deliberately not created by
   this pass — they require the application to have actually happened), and
   move this reconciliation's verdict from CONDITIONAL PASS to FULL PASS.
3. `DB-BASE-0012` and `FDH1-F1` remain open findings requiring a separate
   Product Owner decision on whether/when to fix — not part of this
   reconciliation's scope.

## FDH-2 gate

**HOLD REMAINS** pending the Product Owner applying `0049` to DEV and
confirming this reconciliation reaches FULL PASS. The blocking condition —
the unresolved II/Resources/Phase 0C migration-numbering collision — is
technically resolved in the repository (reproduced twice now), so the gate is
expected to release to GREEN on DEV-application confirmation.

FDH-2 (Australia & India Category / MCC / Institution / Merchant Intelligence
Foundation) was **not** started and must not begin without an explicit
instruction.
