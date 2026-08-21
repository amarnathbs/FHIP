# FDH2_RLS_SECURITY

## 1. The pattern

Every new FDH-2 master-data table (`fdh_source_registry`,
`fdh_economic_transaction_types`, `fdh_mcc_master`,
`fdh_mcc_category_map`, `fdh_institution_capabilities`,
`fdh_institution_aliases`, `fdh_payment_rail_master`) follows FDH-1's
established master-data pattern exactly: `for select using (true)`, and no
insert/update/delete policy for `anon`/`authenticated` at all — writes are
service-role-only, behind `requireAdmin()`, matching every existing
master-data table in this schema.

`fdh_global_learning_candidates` is deliberately STRICTER: RLS enabled,
ZERO policies of any kind — see `FDH2_GLOBAL_LEARNING_GOVERNANCE.md` §3 for
why. It has no `for select using (true)` and no write policy either.

No FDH-2 table is user-owned in the FDH-1 `user_id`-scoped sense — FDH-2
adds zero new user-owned tables. `fdh_user_classification_rules`
(FDH-1's existing user-owned table) is widened (rule_type check constraint
only) but its RLS policy is completely unchanged.

## 2. Real live-DEV-equivalent certification (not vacuous)

`scripts/fdh2_rls_certification.mjs` — rebuilds a fresh PGlite database from
the full active migration chain, seeds REAL populated data for two real
tenants (`auth.users` rows A and B) plus real global master data (25
categories, 123 merchants, 87 MCCs, 47 institutions, 20 payment rails, 60
classification rules — the actual FDH-2 seed, not synthetic placeholder
rows), then runs 61 checks. **Last run: 61 passed, 0 failed.**

### Positive access (13 checks)
Tenant A can read all 13 FDH-2-visible master-data tables (RLS correctly
grants read, does not accidentally deny it).

### Write denial (33 checks)
Tenant A's INSERT is blocked on all 11 relevant master-data tables (11
checks), and Tenant A's blanket UPDATE/DELETE (no WHERE clause — the
strongest possible forgery attempt) affects **zero rows** on every one of
the 11 tables (22 checks) — RLS filters the visible-for-write set to
nothing for an ordinary session, not merely rejecting a crafted statement.

### `fdh_global_learning_candidates` (3 checks)
Tenant A sees **zero** rows (proving the "no policy" design actually
denies read, not merely "happens to allow" it); Tenant A's INSERT is
blocked; the SERVICE ROLE, by contrast, sees the row that is genuinely
there — proving the zero-row result above is a real RLS effect, not an
artifact of missing data (a negative control).

### Tenant isolation on personal rules (3 checks)
Tenant A reads exactly its own 1 `fdh_user_classification_rules` row, reads
zero of Tenant B's, and cannot forge an INSERT carrying Tenant B's
`user_id` — reusing FDH-1's exact, already-certified isolation pattern,
re-run here specifically against the FDH-2-widened `rule_type` vocabulary
to prove the widening did not weaken anything.

### Precedence proof (2 checks)
The specification's own worked example, proved live against real rows: the
global `costco_au` merchant's `default_category_id` is read, both tenants
write a personal COSTCO rule, and the global row is re-read and asserted
BYTE-IDENTICAL — a real database-level proof that a user rule can never
touch global master data, not merely an assertion in a comment.

### Negative controls (3 checks)
RLS is deliberately disabled on `fdh_user_classification_rules`; the
cross-tenant leak that SHOULD then appear DOES appear (proving the
isolation test above is not vacuous); RLS is re-enabled and the leak
disappears; every `fdh_%` table (FDH-1's 24 plus FDH-2's 8 new ones, 32
total) is independently re-confirmed to have RLS enabled.

## 3. FDH1-F1 — tracked, not made worse

FDH-1's disclosed LOW-severity finding (Postgres does not apply RLS to FK
validation, so a cross-tenant FK reference can be inserted even though the
referenced row is not independently readable) is unchanged by FDH-2. No new
FDH-2 foreign key introduces a NEW instance of this pattern beyond what
FDH-1 already established — every new FK in migrations `0050`-`0052`
references either a public master-data table (already universally
readable, so FDH1-F1 does not even apply) or `auth.users`/`countries`
(pre-existing patterns). FDH-2 does not opportunistically refactor FDH-1's
foreign keys to "fix" FDH1-F1 — that remains explicitly out of scope,
tracked for resolution before production user-facing financial-data write
functionality, per the FDH-1 finding's own disclosed remediation timeline.

## 4. Coverage

163 public tables in the full schema after FDH-2's migrations, **all 163
RLS-enabled, zero exceptions** — confirmed by both
`scripts/db-rebuild-check/replay.mjs`'s manifest and
`scripts/fdh2_rls_certification.mjs`'s explicit `fdh_%`-scoped re-check.
