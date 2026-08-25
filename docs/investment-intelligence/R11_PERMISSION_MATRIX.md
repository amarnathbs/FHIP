# R11 Permission Matrix

Spec sections 48-55. Full independent verification: `R11_INDEPENDENT_ORACLE_REPORT.md`.

## The 8 frozen scopes (`PROFESSIONAL_SCOPES`, `lib/services/professional-access/permissions.ts`)

`VIEW_FINANCIAL_SUMMARY`, `VIEW_INVESTMENTS`, `VIEW_GOALS`, `VIEW_FORECASTS`, `VIEW_REPORTS`, `VIEW_TAX_SUMMARY`, `VIEW_SOURCE_PROVENANCE`, `COMMENT_OR_NOTE`. No 9th scope, no `VIEW_RAW_DOCUMENTS`, no `FULL_ACCESS`. Every scope is independently checkable — granting one never implies another (proven exhaustively: `tests/unit/r11ProfessionalPermissions.test.ts`'s `PA-scope-*` block grants each scope alone and asserts every OTHER scope is still denied, for all 8 scopes = 56 pairwise assertions in that one describe block).

## Decision function

`checkProfessionalAccess()` — the single function every access-gated API route calls. Inputs: `now`, `relationship` (or `null`), the asserted `(clientUserId, professionalUserId)` pair, the requested `scope`, and every live scope-grant row. Never trusts a cached decision; the caller (`checkAccessLive`) re-fetches from the database on every call.

## Denial codes (exhaustive)

| Code | Condition |
|---|---|
| `NO_RELATIONSHIP` | No relationship row found for the pair |
| `WRONG_CLIENT` | A real relationship exists, but it does not match the asserted `(client, professional)` pair — the cross-client/cross-tenant guard |
| `NOT_ACTIVE` | Status is `pending_invite`, `revoked`, or `declined` |
| `EXPIRED` | `expiresAt` has passed (evaluated live, independent of the `status` column) |
| `PROFESSIONAL_DEACTIVATED` | `professional_profiles.is_active = false` |
| `SCOPE_NOT_GRANTED` | No live grant row for this exact `(relationship, scope)` |
| `SCOPE_REVOKED` | A grant existed but was revoked |

## Write access — default read-only

No R11 code path allows a professional to write to `ii_transactions`, `ii_holding_snapshots`, `ii_tax_lots`, `ii_portfolio_truth_status`, `ii_reconciliation_cases`, goal/forecast/review/Financial-Health-Score tables, or report content. The ONE professional-writable table, `professional_notes`, is explicitly typed and documented as professional-authored content, never canonical financial truth — enforced structurally (it is a separate table from every canonical table, joined only by `subject_type`/`subject_id` references for display, never merged into canonical rows).

## Hard exclusions (spec section 55) — verified absent by construction

- No buy/sell/switch/redeem/trade-execution endpoint exists anywhere under `app/api/professional-access/`.
- No relationship automatically enables anything resembling `PERSONALISED_ADVICE` — the scope vocabulary contains no such value, and `lib/advice-boundary/`'s existing non-advice guard is untouched by R11 (a distinct, pre-existing mechanism for a related but separate concern).
- No `PROPOSED`-correction workflow was built in R11 (no professional write path to canonical data exists to correct in the first place) — if a future release adds professional-suggested corrections, `professional_notes`' pattern (bounded, DB-checked, clearly non-canonical) is the template, not a new architecture.

## Report access (spec section 65)

`checkReportAccess()` is `checkProfessionalAccess` with `scope` pinned to `'VIEW_REPORTS'` — there is no separate `VIEW_REPORTS_PROFESSIONAL` scope and no professional-specific report computation; a professional who reaches a report reaches the identical R10 report snapshot the client owns. `professional_report_access_log` records `(professional, client, report_id, action, timestamp)` only — never report contents.
