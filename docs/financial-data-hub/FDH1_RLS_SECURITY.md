# FDH-1 — RLS & Security

---

## 1. Tenancy

FDH inherits the tenancy model FDH-0 **verified**, rather than a model it
assumed.

FDH-0 found (`FDH0_RLS_BASELINE.md` §5.1, `FDH0_IMPLEMENTATION_READINESS_REPORT.md`
Q7) that all 77 existing tables key on `user_id uuid references auth.users(id)`,
that `households` is itself a `user_id`-owned descriptor row, that
`household_members` is referenced by no register, and that **no cross-user or
shared-household read path exists anywhere in the schema**.

Therefore:

* **`user_id` is the tenancy boundary on every user-owned FDH table.** No
  parallel identity system was introduced.
* **`household_id` is carried as optional, nullable, non-authoritative
  context.** It is deliberately **not part of any RLS predicate**. Making it one
  today would be a security change to a sharing model that does not exist —
  precisely the assumption FDH-0 rated AMBER.
* Child tables carry `user_id` **explicitly** rather than resolving ownership
  through a join, per FDH-0 Q8. Only two tables in the whole existing schema use
  the join-based pattern, and it is slower and easier to get subtly wrong.
* Support for multiple accounts, multiple statements, Australia and India, and
  future connected sources is structural. Support for multiple household members
  sharing data is **not** claimed, because the platform does not have it.

## 2. Policy matrix

| Table | RLS | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- | --- |
| `fdh_source_types` | on | all | — | — | — |
| `fdh_financial_institutions` | on | all | — | — | — |
| `fdh_categories` | on | all | — | — | — |
| `fdh_subcategories` | on | all | — | — | — |
| `fdh_merchants` | on | all | — | — | — |
| `fdh_merchant_aliases` | on | all | — | — | — |
| `fdh_classification_rules` | on | all | — | — | — |
| `fdh_parser_registry` | on | all | — | — | — |
| `fdh_parser_versions` | on | all | — | — | — |
| `fdh_financial_accounts` | on | own | own | own | own |
| `fdh_statement_uploads` | on | own | own | own | own |
| `fdh_ingestion_jobs` | on | own | own | own | own |
| `fdh_transactions` | on | own | own | own | own |
| `fdh_transaction_allocations` | on | own | own | own | own |
| `fdh_transaction_links` | on | own | own | own | own |
| `fdh_duplicate_candidates` | on | own | own | own | own |
| `fdh_user_classification_rules` | on | own | own | own | own |
| **`fdh_classification_history`** | on | own | own | **denied** | **denied** |
| `fdh_recurring_transactions` | on | own | own | own | own |
| `fdh_review_items` | on | own | own | own | own |
| `fdh_reconciliation_results` | on | own | own | own | own |
| `fdh_data_quality_results` | on | own | own | own | own |
| `fdh_data_provenance` | on | own | own | own | own |
| `fdh_evidence_links` | on | own | own | own | own |

"own" is the byte-identical house expression first defined at
`supabase/migrations/0001_foundation.sql:93-100`:

```sql
for all using (auth.uid() = user_id) with check (auth.uid() = user_id)
```

The `with check` half is what stops tenant spoofing on INSERT and UPDATE: a
session cannot write a row carrying somebody else's `user_id`, and cannot patch
a row into another user's ownership.

"—" means **no policy exists for that verb**. With RLS enabled and no policy,
Postgres denies the verb outright to `anon` and `authenticated`. This is the
existing precedent (`benchmark_update_runs`, `contact_submissions`,
`forecast_report_render_tokens`), and it is what makes the master-data tables
genuinely write-protected rather than merely un-routed.

### The one deliberate deviation

`fdh_classification_history` splits SELECT and INSERT and grants **no UPDATE and
no DELETE policy**. The owner can append and read their own audit trail but
cannot rewrite or erase it. An audit trail a user can edit is not an audit
trail. This is a strict tightening of the house pattern, not a loosening, and
it is asserted by test.

## 3. Master-data write protection

`fdh_financial_institutions`, `fdh_categories`, `fdh_subcategories`,
`fdh_merchants`, `fdh_merchant_aliases`, `fdh_classification_rules`,
`fdh_parser_registry`, `fdh_parser_versions` and `fdh_source_types` are
**read-only to every end user**. Writes go through the service-role client
behind `requireAdmin()` — exactly how `master_financial_items`, `goal_types`
and the `benchmark_*` tables already work.

This is also the **structural enforcement of the rule that a user correction
must never automatically become a global rule.** It is not a code convention
that a future phase might forget: an ordinary session's INSERT into
`fdh_merchants` is refused by Postgres. A user's preference is stored in
`fdh_user_classification_rules` (user-owned) and recorded in
`fdh_classification_history` (append-only), and promotion to a global rule
requires the `proposed → admin_review → approved` governance lifecycle driven by
an administrator.

## 4. Read exposure of master data

The FDH master-data read policies use the house expression
`for select using (true)`, which grants read to `anon` as well as
`authenticated`. This matches the 22 existing world-readable reference tables.

**Honest assessment:** none of these tables contains personal data — they hold
institution names, category labels, merchant names and which parsers exist. A
tighter `to authenticated` policy was considered and rejected because no
role-targeted policy exists anywhere in this schema, and introducing one for FDH
alone would be a new pattern for no security gain. This is recorded as a
deliberate choice rather than an oversight.

## 5. The admin financial-data boundary (Product Owner Decision 3)

**Hard rule: a normal administrator has NO standing access to raw user
financial documents.**

### What FDH-1 does not build

There is no admin route, no admin page, no document viewer, no download
endpoint, no signed-URL issuer, no storage bucket and no storage policy in
FDH-1. `tests/unit/fdh1Isolation.test.ts` asserts that no FDH source file
mentions `requireAdmin`, `adminRoute`, `createSignedUrl` or `storage.from`, and
that the migrations create no `storage.objects` policy.

### Why RLS alone is not the answer

`adminClient()` uses the service-role key and **bypasses RLS entirely**
(`lib/supabase/admin.ts`), and `admin_users` is a single unscoped boolean
(`0011_module8_financial_twin.sql:33-38`). An RLS policy therefore cannot stop
an admin route that chooses to use the service role. FDH-0 rated this AMBER for
exactly this reason.

FDH's answer is **to own no code path that can bypass RLS at all.** The module
never imports `@/lib/supabase/admin`, never references
`SUPABASE_SERVICE_ROLE_KEY`, and its repositories are built exclusively on the
RLS-scoped session client. This is asserted by test.

### What a future admin surface may see

`lib/financial-data-hub/constants/adminBoundary.ts` defines the boundary as an
**allowlist**, so a column added later is invisible to admins until somebody
deliberately adds it — the safe default.

**Visible (operational metadata only, 20 columns):** `id`, `institution_id`,
`document_type`, `source_type`, `country_code`, `processing_status`,
`review_status`, `parser_id`, `parser_version_id`, `processing_method`,
`reconciliation_status`, `overall_quality_status`, `error_code`,
`raw_document_purge_status`, `raw_document_purge_due_at`,
`raw_document_purged_at`, `purge_attempt_count`, `created_at`, `updated_at`,
`approved_at` — plus a **pseudonymous** `owner_reference`.

**Forbidden, with the reason recorded in code:** `user_id`, `household_id`
(direct identity), `financial_account_id` (joins to household financial data),
`original_filename_sanitised` (a filename frequently carries the account
holder's name), `file_hash` (content-derived — permits confirming whether a
specific known document was uploaded), `raw_document_storage_reference` (a
pointer to the document itself), the three statement dates (reveal the shape of
a person's financial history), `currency_code`, `mime_type`, `file_size_bytes`,
`purge_reason`, `last_purge_error_sanitised` (free text).

**No standing access at all** to the twelve household-financial tables listed in
`ADMIN_NO_STANDING_ACCESS_TABLES` — including every transaction, allocation,
link, rule, review item, reconciliation result, provenance record and account.

`toAdminOperationalMetadata()` is the single correct way to build the
projection. A test feeds it a row containing a real user id, a real household
id, a filename `jane-smith-march-statement.pdf`, a file hash and a storage path
`private/real-user-uuid/doc-1.pdf`, then asserts none of those strings appears
anywhere in the JSON output — while the operational facts an admin genuinely
needs (processing status, parser version, reconciliation status, purge status)
all survive.

### Temporary support access

A future mechanism letting an administrator view a specific document with the
user's explicit, time-boxed, logged consent needs **its own consent
architecture and its own approved phase**. It is not implemented in FDH-1 and
must not be improvised on top of this allowlist.

## 6. Pre-completion security review

Conducted against the FDH-created surface. Findings are FDH's own; pre-existing
platform issues recorded by FDH-0 are noted where relevant but are not FDH's to
fix in this phase.

| # | Area | Finding | Status |
| --- | --- | --- | --- |
| S-1 | RLS coverage | 24/24 FDH tables have RLS enabled; 15/15 user-owned tables have an owner-scoped policy | **PASS** — asserted by test |
| S-2 | Foreign-key ownership | Every user-owned child carries its own `user_id`; no ownership resolves through a join | **PASS** — asserted by test |
| S-3 | Tenant spoofing (insert) | `with check (auth.uid() = user_id)` on every owner policy | **PASS** at schema level; live proof pending migration application (see §7) |
| S-4 | Tenant spoofing (update) | `with check` covers UPDATE; the repository additionally strips `user_id` from any patch | **PASS** |
| S-5 | Service-role misuse | FDH imports no service-role client anywhere; no FDH secret is referenced in client code | **PASS** — asserted by test |
| S-6 | Master-data write exposure | No INSERT/UPDATE/DELETE policy on any of the 9 master tables | **PASS** — asserted by test |
| S-7 | Plaintext sensitive identifiers | No `full_account_number` / `bsb` / `ifsc` / `iban` column exists; `masked_identifier` is rejected by a DB check if it carries 7+ consecutive digits | **PASS** |
| S-8 | Raw PII persistence | Every raw field is nullable and covered by the purge contract; `chk_fdh_uploads_purged_reference` makes a false "purged" claim impossible | **PASS** |
| S-9 | Dangerous JSON | Three JSON columns, all shape-constrained in SQL and vocabulary-constrained in Zod; no regex/expression/SQL rule member; review context is a `.strict()` closed shape with no free-text field | **PASS** |
| S-10 | Admin access leakage | Allowlist projection, tested against a row seeded with real identifiers; no admin route exists | **PASS** |
| S-11 | Error-message leakage | 14-value controlled error taxonomy in SQL; `error_message_sanitised` bounded to 500 chars; no stack trace is persistable | **PASS** |
| S-12 | Path traversal via filename | Path separators, `..` and control characters are rejected, not stripped | **PASS** |
| S-13 | Regex denial of service | No user- or admin-supplied regex is accepted by any rule type | **PASS** |
| S-14 | Anonymous access | No user-owned table grants `anon` anything; probe included in the live script | **PASS** at schema level; live proof pending |

**Zero critical unresolved FDH-created security issues.**

### Pre-existing issues inherited, not introduced

Recorded honestly, from `FDH0_SECURITY_THREAT_SURFACE.md`: `admin_users` is a
single unscoped boolean; `adminRoute()` returns raw error text to the client;
`audit_events` and `financial_records_audit` are never written by any code.
FDH-1 neither worsens nor fixes these. FDH's response to the first is to own no
service-role path at all (S-5).

## 7. Live verification status — read this before accepting §6

**The FDH migrations have NOT been applied to the DEV database.** A read-only
probe on 2026-08-21 confirmed **0 of 24** FDH tables exist in project
`vqycarelcoijzwlpkpcz`.

This environment has no `psql`, no Docker, no local Postgres and no
SQL-execution RPC on the Supabase project, so DDL cannot be applied
programmatically from here. Migrations `0045`–`0048` must be applied through the
Supabase SQL editor by someone with console access.

**Consequently, every claim in §6 marked "PASS" is a claim about the migration
SQL and the application code as written, verified by parsing the real files —
not a claim about live database behaviour.** No live cross-household RLS
exploitation attempt has been run, because there is nothing to attempt it
against.

`scripts/fdh1_live_dev_verification.mjs` is ready to close that gap. Run
`node scripts/fdh1_live_dev_verification.mjs --rls` once the migrations are
applied. It signs up two throwaway users and attempts, for real:

1. A creates an account; A reads it back.
2. B reads A's account — must return zero rows.
3. B updates A's account — must affect zero rows.
4. B deletes A's account — must affect zero rows.
5. B inserts a row carrying **A's `user_id`** — must be refused (403/401).
6. An authenticated user reads master data — must succeed.
7. An authenticated user writes `fdh_financial_institutions`, `fdh_merchants`,
   `fdh_categories`, `fdh_classification_rules` — all four must be refused.
8. UPDATE against `fdh_classification_history` — must affect zero rows.
9. `anon` reads each of the 15 user-owned tables — all must return zero rows.

The script cleans up its probe row and never applies DDL.
