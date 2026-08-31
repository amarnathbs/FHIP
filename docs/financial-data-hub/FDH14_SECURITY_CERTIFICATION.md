# FDH-14 — Security Certification

## 1. FRESH FDH-14 execution: live-DEV cross-tenant + same-tenant authority-forgery matrix

Script: `scripts/fdh14_cross_domain_security_certification.mjs`. Run 2026-08-31 against the real hosted DEV
Supabase project (`vqycarelcoijzwlpkpcz`) referenced by this worktree's `.env.local`. Two fresh synthetic
tenants were created per domain (6 total across the run), fully deleted afterwards, and cleanup was
independently re-verified by re-querying every seeded row id and every created auth user id.

**Result: 28/28 PASS.**

For each of Income (`income_sources`), Liabilities (`liabilities`), Retirement (`retirement_accounts`):

- Owner forges `source_type` → **BLOCKED** (`P0001`, the domain's own provenance-write trigger fires).
- Owner forges `last_import_application_id` → **BLOCKED**.
- Owner forges `last_imported_at` → **BLOCKED**.
- **Positive control**: owner's legitimate own-field rename → succeeds (the guard does not over-lock the row).
- Cross-tenant READ (tenant B selecting tenant A's row by id) → **0 rows returned** (RLS `USING` silently
  filters, not a 403 — the correct PostgREST RLS behaviour).
- Cross-tenant WRITE (tenant B patching tenant A's row) → **0 rows affected**, value unchanged on re-query.
- Cross-tenant **impersonating INSERT** (tenant B attempting to insert a row with `user_id = tenant A`) →
  **BLOCKED**, real `42501` ("new row violates row-level security policy") from Postgres.
- Cross-tenant DELETE → **0 rows affected**, row still present on re-query.

This directly and freshly re-proves spec §64 (cross-tenant reads=0, cross-tenant writes=BLOCKED), §65
(same-tenant authority forgery BLOCKED with a positive control for legitimate fields), and the provenance-guard
half of §60/§66, on the **current** state of live DEV, for three separate domains in one run — not merely
citing each domain's own historical certification.

## 2. REUSED evidence: per-module security certification

| Module | Verdict (as re-derived by this pass's research, not merely quoted) | Fresh re-run this pass? |
|---|---|---|
| FDH-1 | 14-point review, zero unresolved critical FDH-created issues; one disclosed LOW residual (FDH1-F1, see §5). | No — REUSED. |
| FDH-2 | 61/61 RLS checks (PGlite) incl. write-denial on 11 master tables. | No — REUSED. |
| FDH-3 | 15-threat model, 11 fully closed, 4 disclosed residual (malware scan, orphan-report-live, log-PII manual review, concurrency-under-load). Storage isolation PASS live. | No — REUSED. |
| R7/FDH-4 | Cross-user read 9/9 blocked, write 4/4 blocked, same-user forgery 9/9 blocked (after the `reconciliation_status` fix in migration `0065`). | No — REUSED. |
| FDH-5 | Live tenant isolation 4/4; password never persisted (static + live artifact-absence sweep). | No — REUSED. |
| FDH-6 | Zero new tables/RLS/routes; live tenant tests 7/7. | No — REUSED. |
| R8 | PGlite security 30/30 incl. RED→GREEN authoritative-write proof. Live-DEV run "not performed" at the time of R8's own report — **this pass's fresh schema probe confirms the underlying migration (`0067`) is now present in live DEV**, but a full live-DEV *behavioural* re-run of R8's specific 30 checks was not repeated in this pass (see Residual Register). | Partial — schema presence FRESH, full behavioural re-run not repeated. |
| FDH-7 | 35/35 PGlite; FDH1-F1 re-confirmed (allocation FK not owner-checked, mitigated at app layer); one open residual (purge-before-genuine-review). | No — REUSED. |
| FDH-8 | Live 44/45 PASS (1 info); tenant isolation PGlite 12/12 + live 6/6. | No — REUSED. |
| FDH-9 | Cross-tenant proposal/application/payroll forgery all blocked live at the time of its own round; **this pass's fresh script independently re-confirms the `income_sources` provenance guard specifically is still active today**. | Partial — provenance guard FRESH, full battery not repeated. |
| FDH-10 | 18/18 PGlite security incl. forged-liability-target and forged-bank-match blocked; **this pass's fresh script independently re-confirms the `liabilities` provenance guard specifically is still active today**. | Partial — provenance guard FRESH. |
| FDH-11 | Live DEV 43/43 incl. same-tenant forgery, cross-tenant isolation, foreign investment account/bank transaction. | No — REUSED. |
| FDH-12 | Live round 3, 262/262, incl. the two real defects (FDH12-LD-1, FDH12-LD-2) found, fixed and live-reproven; **this pass's fresh script independently re-confirms the `retirement_accounts` provenance guard (the fix for FDH12-LD-2) is still active today**, closing the loop per rule 4 ("SQL-editor success is not sufficient evidence") on this specific guard as of the actual current DEV state, not just at the time it was written. | Partial — provenance guard FRESH. |

## 3. FDH1 tenant-FK residual (spec §69) — reviewed, not assumed

**Current status: STILL OPEN, LOW severity, unchanged in nature since FDH-1.** Postgres does not enforce RLS
on foreign-key *validation* — a user can insert a row they own that references another tenant's UUID via a
plain FK column (e.g. an allocation naming a transaction id that isn't theirs). FDH-7's own re-confirmation
found this is **not practically exploitable** in the one place it re-checked it (`fdh_transaction_allocations`)
because the application layer (`splitTransaction()`) independently re-verifies ownership before trusting the
reference, and all *downstream reads* remain RLS-scoped regardless (the foreign-owned FK value can be stored
but never surfaces another tenant's data). No new instance of this class of issue was found by this pass's own
fresh cross-tenant matrix (all three canonical tables tested block cross-tenant write/insert outright via RLS,
not merely via FK). **Not fixed in this pass** (no new exploitable instance was demonstrated; a defensive
schema-wide FK-audit/refactor was explicitly out of scope per spec §5/§69 — "do not undertake a giant schema
refactor merely to make the residual disappear unless a real vulnerability is demonstrated").

## 4. Bundle security (fresh, post-build)

`.next/static` and `.next/server` were grepped for the literal values of every secret in `.env.local`
(service-role key, production service-role key, Resend API key) after a fresh production build — **zero
matches**. One benign match was found and inspected: the Supabase JS SDK's own key-format-detection helper
(`e.startsWith("sb_secret_")`) — this is library code checking key *shape*, not a leaked value, confirmed by
reading the 160-character context around the match.

## 5. Verdict (original CONDITIONAL PASS round)

- Cross-tenant: **PASS** (fresh + reused).
- Same-tenant authority forgery: **BLOCKED** (fresh, 3 domains, 28/28).
- Foreign canonical targets: **BLOCKED** (reused per-module evidence; not independently re-attempted for
  Income/Liability/Investment/Retirement targets specifically in this pass beyond the provenance-column proof
  above — see Residual Register item R-14-6). **Closed by GAP 2 below.**
- FDH1 tenant-FK residual: **OPEN, LOW, reviewed and re-classified this pass, not newly discovered**.
- Bundle security: **PASS**, 0 secrets, freshly re-checked.
- P0/P1 security defects found in this pass: **0**.

## 6. GAP 2 closure (2026-08-31) — fresh foreign-canonical-target certification

Script: `scripts/fdh14_foreign_canonical_target_certification.ts` (`npx tsx --env-file=.env.local scripts/...`).
Two fresh synthetic tenants (A, B), all rows + both auth users deleted afterwards, cleanup independently
re-verified. **13/13 PASS.**

This is a different, more specific claim than §1 above: not "can B read/write A's row" but "can A's OWN
evidence/proposal row point AUTHORITATIVELY at B's canonical target." Results:

| # | Attack | Target domain | Result | Mechanism |
|---|---|---|---|---|
| 1 | A's own `fhip_import_proposals` row, `target_entity_id` = B's `income_sources.id` | Income | **BLOCKED at INSERT** | Real DB trigger `fdh9_assert_proposal_owner` (migration 0091), genuine `P0001` "cross-tenant reference" exception. B's row confirmed untouched by re-query. |
| 2 | Same, `target_entity_id` = B's `liabilities.id` | Liability | **BLOCKED at INSERT** | Same trigger, widened by migration 0096 ("forged liability target — spec section 91"). |
| 3 | Same, `target_entity_id` = B's `retirement_accounts.id` | Retirement | **BLOCKED at INSERT** | Same trigger, widened by migration 0112 ("forged retirement target — spec section 98"). |
| 4a | Same, `target_domain='investment'`, `target_entity_id` = B's `ii_accounts.id` | Investment (generic bridge) | **STRUCTURALLY UNREACHABLE** | The trigger's own `else` branch rejects ANY non-null `target_entity_id` under `target_domain='investment'` outright ("no implemented target guard") — FDH-11 never uses this bridge table for targeting at all, by design (confirmed by reading migration 0106's own header comment). |
| 4b | A's own `fdh_investment_statements` row, `canonical_account_id` forged to B's `ii_accounts.id` (the REAL FDH-11 targeting column) | Investment (real mechanism) | **DB layer accepts the forgery** (no trigger polices this column) — **but the real `applyAuStatementActivity()` function, invoked directly (the same code path the production Apply route uses), rejects it at runtime with `FOREIGN_ACCOUNT`** before any canonical write. Ground truth: zero `ii_transactions` rows created against B's account. | Application-layer guard, not a DB trigger — a disclosed architectural difference, not a live defect (both stop the same outcome). |
| 5 | A's own proposal cites B's `fdh_payroll_events.id` as its evidence source (`source_payroll_event_id`) | Foreign EVIDENCE link | **BLOCKED at INSERT** | Same trigger family checks evidence-source ownership, not just target ownership. |
| — | Positive control: A targeting A's own `income_sources` row via the identical bridge | — | **SUCCEEDS normally** | Confirms the guard is tenant-specific, not over-broad. |

**Verdict: foreign canonical targets are BLOCKED for all four named domains** — three by a real, live-fired DB
trigger, and the fourth (investment) by a combination of "structurally unreachable via the generic bridge" plus
a live-confirmed application-layer runtime guard on its actual targeting mechanism. Zero P0/P1 findings.
Closes Residual Register item R-14-6.
