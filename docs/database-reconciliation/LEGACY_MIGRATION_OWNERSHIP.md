# Legacy migration ownership map

Determined from git history (introducing commits), migration SQL contents,
branch ancestry, and live DEV behavioural probing — **not** from filenames and
not from prior discussion.

## Method

- **Ownership:** `git log --all --diff-filter=A -- <path>` for each colliding
  file, then reading the SQL to confirm what it actually defines. Filenames were
  never trusted (see the `financial_section_status` note below).
- **"Actually applied in DEV":** the PostgREST OpenAPI schema
  (`GET /rest/v1/` with the service-role key) for object existence and column
  shape, plus targeted `INSERT` probes to confirm constraints that schema
  introspection cannot reveal.

## Ownership map

| Legacy version | Investment Intelligence migration | Counterpart migration | Counterpart module | Which applied in DEV | Canonical active legacy owner | Re-emission needed |
|---|---|---|---|---|---|---|
| 0031 | `0031_ii_reference_foundation.sql` | `0031_financial_section_status.sql` | Phase 0C (core) | **Both** | Investment Intelligence | Yes → 0049 |
| 0032 | `0032_ii_source_documents_accounts.sql` | `0032_section_status_reviewed_with_data.sql` | Phase 0C (core) | **Both** | Investment Intelligence | Yes → 0049 |
| 0033 | `0033_ii_transactions_holdings.sql` | `0033_resources_foundation.sql` | Resources R1.1 | **Both** | Investment Intelligence | Yes → 0049 |
| 0034 | `0034_ii_publishing_goal_allocations.sql` | `0034_resources_seed.sql` | Resources R1.1 | **Both** | Investment Intelligence | Yes → 0049 |
| 0035 | `0035_ii_analytics_insights_reconciliation.sql` | `0035_resources_analyst_role_delta.sql` | Resources R1.4 | **Both** | Investment Intelligence | Yes → 0049 |
| 0036 | `0036_ii_audit_events.sql` | `0036_resources_anon_function_grants_fix.sql` | Resources R1.5 | **Both** | Investment Intelligence | Yes → 0049 |
| 0037 | `0037_ii_storage_policy.sql` | `0037_resources_editor_support.sql` | Resources R1.3 | **Both** | Investment Intelligence | Yes → 0049 |
| 0038 | `0038_ii_india_adapter_seed.sql` | `0038_resources_specialist_content_support.sql` | Resources R1.4 | **Both** | Investment Intelligence | Yes → 0049 |
| 0039 | `0039_ii_r2_audit_and_document_lifecycle.sql` | `0039_resources_public_settings_read.sql` | Resources R1.5 | **Both** | Investment Intelligence | Yes → 0049 |
| 0040 | `0040_ii_r2_transaction_lineage_and_dedup.sql` | `0040_resources_discovery_context_support.sql` | Resources R1.6 | **Both** | Investment Intelligence | Yes → 0049 |

Versions 0041-0044 (Investment Intelligence R2-R5) and 0045-0048 (FDH-1) are
uncollided and unchanged.

## Introducing commits

| File | Introducing commit |
|---|---|
| `0031_financial_section_status.sql` | `10bf196` — *Phase 0C step 1-8: canonical section-status + score eligibility engine* |
| `0032_section_status_reviewed_with_data.sql` | `10bf196` lineage (Phase 0C.1) |
| `0031_ii_reference_foundation.sql` … `0038_ii_india_adapter_seed.sql` | `0917939` — *feat(investment-intelligence-r1): migrations 0031-0038* |
| `0033_resources_foundation.sql`, `0034_resources_seed.sql` | `9bf45c6` — *feat(resources): complete R1.1 database RBAC workflow and security foundation* |

## Two findings that change the picture

**1. 0031 and 0032 are not Resources migrations.** They originate from the
Phase 0C score-eligibility work (`phase-0c-score-eligibility`, commit
`10bf196`) and define core per-user section-review status for household /
income / expenses / assets / liabilities / investments / retirement /
insurance. They travel on the Resources branches only because Resources
branched from a lineage that already contained them. The collision therefore
spans **three** streams, not two.

**2. `financial_section_status` was never missing — it never existed.**
`0031_financial_section_status.sql` creates a table named
**`user_financial_section_status`**. The earlier "missing from DEV" finding
inferred the object name from the migration filename. Live DEV evidence:

- `GET /rest/v1/financial_section_status` → `404 PGRST205`, with PostgREST's own
  hint *"Perhaps you meant the table 'public.user_financial_section_status'"*.
- `GET /rest/v1/user_financial_section_status` → `200`, returning real rows
  (e.g. `section=liabilities, status=reviewed_zero`, `updated_at` 2026-08-15).
- Primary key `(user_id, section)`, FK to `auth.users`, and the CHECK constraint
  are all present.

**Migration 0032's constraint widening is also live**, proven by a differential
probe with a negative control:

| Probe | Result | Interpretation |
|---|---|---|
| insert `status='reviewed_with_data'` | `409` / `23503` FK violation | passed the CHECK — 0032's widened constraint **is** applied |
| insert `status='BOGUS_VALUE'` | `400` / `23514` CHECK violation | the CHECK is real and does reject invalid values |

Had only 0031's narrower constraint been present, `reviewed_with_data` would
have failed with `23514` exactly as `BOGUS_VALUE` did. It did not.

## Why Investment Intelligence is the canonical active owner

Not because it is "more important" — by the criteria the reconciliation
required:

1. **Reflects applied history.** Both lineages were applied to DEV, so applied
   history does not discriminate; the tie is broken on the remaining criteria.
2. **Avoids re-running historical logic.** Keeping the longer chain in place
   means fewer statements are re-emitted (10 archived files rather than 14).
3. **Lets clean environments rebuild deterministically.** Achieved either way,
   but only this direction preserves the already-certified FDH-1 `0045`-`0048`,
   which were written against Investment Intelligence's numbering. Renumbering
   Investment Intelligence would have invalidated four certified migrations.
4. **Preserves both modules' intended final schema.** Guaranteed by the
   order-equivalence proof: the two lineages are schema-disjoint, so re-emitting
   the Resources/Phase 0C effects at 0049 produces a byte-identical schema.
