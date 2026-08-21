# RLS final certification — pre-application pass

**Scope:** Independent re-run of the RLS certification originally produced in
the `b1e8ccf` pass, reproduced from scratch this pass (not copied). Covers the
three lineages whose migration versions collided and were reconciled by
`0049`: Investment Intelligence, Phase 0C, Resources.
**Method:** `scripts/db-rebuild-check/rls.mjs`, run against a PGlite instance
rebuilt from the repository's own `0001`-`0049` migration chain (never
against live DEV — no DEV credentials are given to this script; this is an
offline structural/policy proof, not a live-DEV penetration test).
**Result:** **25 passed, 0 failed** — exact match to the previously-reported
25/25, no discrepancy.
**Date:** 2026-08-21

---

## Why this is not vacuous

The single biggest risk in any RLS test harness is asserting "tenant A cannot
see tenant B's row" when the harness never actually authenticated as anyone —
in which case `auth.uid()` reads `NULL`, every policy that checks
`auth.uid() = user_id` denies everyone equally, and the "cross-tenant denial"
test would pass even with RLS completely broken.

Two independent defenses against this are present and were both verified live
this pass:

1. **Session-scoped JWT context, not transaction-local.** The harness calls
   `select set_config('request.jwt.claims', $1, false)` — the third argument
   `false` means `is_local => false`, i.e. session-scoped. PGlite autocommits
   each statement, so a transaction-local (`is_local => true`) setting would
   be silently discarded before the very next query ran, and `auth.uid()`
   would read `NULL` for the rest of the test. The code comment in
   `scripts/db-rebuild-check/rls.mjs` (around line 46) documents this exact
   failure mode as the reason `false` was chosen deliberately, not by
   accident.
2. **A self-check before every trust decision.** Immediately after setting
   the JWT claim, the harness runs `select auth.uid()::text u` and compares it
   to the UUID it just claimed to be. If they don't match, it prints `FAIL
   harness: auth.uid() is X, expected Y — tests would be vacuous` and
   increments the failure counter — *before* running a single isolation
   check. This assertion passed for every tenant/table pairing exercised in
   this run (12 `asTenant()` calls across the suite).
3. **Explicit negative controls**, described below, which independently prove
   the comparison logic itself is capable of detecting a real leak.

## Tenants and tables seeded

Two synthetic tenants (`auth.users` rows, never real user data):

- Tenant A: `11111111-1111-1111-1111-111111111111`
- Tenant B: `22222222-2222-2222-2222-222222222222`

One representative, user-scoped table from each of the three lineages the
migration-numbering collision touched, seeded with one real row per tenant:

| Table | Lineage | Rows seeded |
|---|---|---|
| `ii_accounts` | Investment Intelligence (active `0031`-`0044`) | 1 per tenant (AU broker / IN AMC folio) |
| `user_financial_section_status` | Phase 0C (re-emitted by `0049`) | 1 per tenant (`liabilities`/`reviewed_zero`, `insurance`/`not_applicable`) |
| `resource_user_roles` | Resources (re-emitted by `0049`) | 1 per tenant (`author`, `editor`) |

## Full result breakdown (25/25)

### Positive access — 6/6 PASS
Each tenant reads exactly its own row (never 0, never 2) in all three tables.

### Cross-tenant read denial — 3/3 PASS
Tenant A queries all three tables while impersonating itself; in every case
Tenant B's row is invisible (`leaked 0`).

### Cross-tenant write denial — 9/9 PASS
For each of the three tables: Tenant A cannot `INSERT` a row claiming to be
owned by Tenant B (RLS `WITH CHECK` blocks the forge), cannot `UPDATE`
Tenant B's existing row (0 rows affected), and cannot `DELETE` it (0 rows
affected).

### Negative controls — 6/6 PASS
For each of the three tables, RLS was deliberately disabled
(`ALTER TABLE ... DISABLE ROW LEVEL SECURITY`), Tenant A's read was repeated
and **correctly showed the leak** (`saw 1, expected 1 — proves the test is
not vacuous`), then RLS was re-enabled and the leak correctly disappeared
again (`saw 0`). This is the proof that the "denial" assertions above are not
trivially true — the harness demonstrably can and does fail when isolation is
genuinely broken.

### RLS coverage — 1/1 PASS
Every one of the 155 public tables in the fresh-rebuilt schema (`0001`
through `0049`) has RLS enabled; 0 have it disabled.

## Raw output (this pass)

```
fresh rebuild complete

  seeded ii_accounts (Investment Intelligence): 2 rows (1 per tenant)
  seeded user_financial_section_status (Phase 0C): 2 rows (1 per tenant)
  seeded resource_user_roles (Resources): 2 rows (1 per tenant)

=== POSITIVE ACCESS (tenant sees its own populated rows) ===
  PASS  Tenant A reads own ii_accounts [Investment Intelligence] (saw 1, expected 1)
  PASS  Tenant A reads own user_financial_section_status [Phase 0C] (saw 1, expected 1)
  PASS  Tenant A reads own resource_user_roles [Resources] (saw 1, expected 1)
  PASS  Tenant B reads own ii_accounts [Investment Intelligence] (saw 1, expected 1)
  PASS  Tenant B reads own user_financial_section_status [Phase 0C] (saw 1, expected 1)
  PASS  Tenant B reads own resource_user_roles [Resources] (saw 1, expected 1)

=== CROSS-TENANT READ DENIAL (must never see the other tenant) ===
  PASS  Tenant A cannot read Tenant B ii_accounts [Investment Intelligence] (leaked 0)
  PASS  Tenant A cannot read Tenant B user_financial_section_status [Phase 0C] (leaked 0)
  PASS  Tenant A cannot read Tenant B resource_user_roles [Resources] (leaked 0)

=== CROSS-TENANT WRITE DENIAL ===
  PASS  Tenant A cannot forge a ii_accounts row owned by Tenant B [Investment Intelligence]
  PASS  Tenant A cannot update Tenant B ii_accounts (updated 0)
  PASS  Tenant A cannot delete Tenant B ii_accounts (deleted 0)
  PASS  Tenant A cannot forge a user_financial_section_status row owned by Tenant B [Phase 0C]
  PASS  Tenant A cannot update Tenant B user_financial_section_status (updated 0)
  PASS  Tenant A cannot delete Tenant B user_financial_section_status (deleted 0)
  PASS  Tenant A cannot forge a resource_user_roles row owned by Tenant B [Resources]
  PASS  Tenant A cannot update Tenant B resource_user_roles (updated 0)
  PASS  Tenant A cannot delete Tenant B resource_user_roles (deleted 0)

=== NEGATIVE CONTROLS (isolation deliberately removed -> leak MUST appear) ===
  PASS  control: RLS off on ii_accounts -> Tenant A DOES see Tenant B [Investment Intelligence] (saw 1, expected 1 — proves the test is not vacuous)
  PASS  control: isolation restored on ii_accounts (saw 0)
  PASS  control: RLS off on user_financial_section_status -> Tenant A DOES see Tenant B [Phase 0C] (saw 1, expected 1 — proves the test is not vacuous)
  PASS  control: isolation restored on user_financial_section_status (saw 0)
  PASS  control: RLS off on resource_user_roles -> Tenant A DOES see Tenant B [Resources] (saw 1, expected 1 — proves the test is not vacuous)
  PASS  control: isolation restored on resource_user_roles (saw 0)

=== RLS COVERAGE ===
  PASS  every public table has RLS enabled (0 without RLS)
  (155 public tables, all RLS-enabled)

RLS CERTIFICATION: 25 passed, 0 failed
```

## Scope note — what this certification does and does not prove

This is a certification of the **reconciled migration chain's** RLS policies,
proven against a freshly-built database that has never diverged from
`0001`-`0049`. It is the correct evidence for "does `0049`'s re-emitted RLS
match what was originally applied to DEV" (yes — also independently confirmed
by the order-equivalence run in `DEV_0049_PRE_APPLICATION_SNAPSHOT.md` §9,
which found the RLS flag set byte-identical between the historical
0031-0040 ordering and the reconciled 0049 chain).

It is **not** a live-DEV penetration test — this sandbox has no DDL path to
DEV to run adversarial `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` /
re-enable cycles against the shared environment, nor should it: that would be
a destructive, non-read-only action against shared infrastructure, explicitly
out of scope for this sandbox regardless of migration status. Once `0049` is
applied to DEV, a live-DEV RLS re-certification (matching the format used for
Investment Intelligence R4/R5/R6 in this project's history) is one of the
post-application items the orchestrating session will run — it is out of
scope for this pass by the dispatch instructions (spec §19-33).

## Verdict

**RLS certification: PASS, 25/25, reproduced independently, zero
discrepancy from the previously-reported baseline, negative controls
genuine.** This is pre-application (offline chain) evidence; it supports, but
does not replace, a live-DEV re-certification after `0049` is actually
applied.
