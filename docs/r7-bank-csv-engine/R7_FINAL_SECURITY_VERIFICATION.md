# R7-FINAL — Live DEV Security Verification (spec §24-32)

Script: `scripts/r7final_live_security.mjs`. Two real authenticated DEV users (`r7-live-cert-sec-{a,b}-<timestamp>@test.fhip.internal`, `email_confirm: true`), real victim data seeded through the real app pipeline (one clean processed document + one document containing a genuine within-file duplicate candidate), all attacks run over the real running app (`http://localhost:3199`) or direct PostgREST with the attacker's own real session token — never a fabricated UUID, never a simulated session.

## §25 — Cross-user READ attacks: PASS, 0 leakage

User B, with their own real session, attempted to read User A's document status, reconciliation result, and transaction list via the real app API, plus 6 direct PostgREST reads (`fdh_statement_uploads`, `fdh_transactions`, `fdh_financial_accounts`, `fdh_duplicate_candidates`, `fdh_reconciliation_results`, `fdh_csv_mapping_templates`) using B's own access token against A's real ids. Every app-level attempt returned `404 document not found` / an empty list; every direct read returned `200` with `0` rows. 9/9 checked, 0 leaks.

## §26 — Cross-user WRITE attacks: PASS, denied + ground truth unchanged

User B attempted, via the real app API and A's real resource ids: a correction on A's transaction, a duplicate-resolution on A's real pending candidate, `/process` on A's document, `/map` on A's document. All 4 returned `404` (ownership check via RLS-scoped `getForUser` — B's session literally cannot see the row exists). Ground truth re-read via service role confirmed: A's transaction's `description_clean` was NOT changed to "HACKED BY B", and A's candidate's `status` was still `pending`.

## §27 — Same-user forgery, direct PostgREST, valid own foreign keys

**Methodology correction made mid-run**: the first attempt forged several fields to values the attacked document was *already, genuinely* at (e.g. a cleanly-reconciled document's `certification_status` was already `'certified'`) — a same-value `UPDATE` is `new IS NOT DISTINCT FROM old` and trivially "succeeds" regardless of any trigger, proving nothing. The corrected methodology forges every field **away from its real, independently-known value**, using a second seeded document (`docDup`, genuinely `certification_status='review_required'`, `detection_confidence=0.8`, `reconciliation_status='not_available'` — a within-file-duplicate fixture with no balance column) as the target for the fields that were previously same-valued.

| # | Attempt | Real value → forged to | Result |
|---|---|---|---|
| 1 | `certification_status` | `review_required` → `certified` | **BLOCKED** (`authoritative R7 detection/certification fields...`) |
| 2 | `reconciliation_status` | `not_available` → `reconciled` | **ALLOWED — genuine gap, see below** |
| 3 | `detection_confidence` | `0.8` (real, adapter-scored) → `1` (then re-tested as `0.42`, still genuinely different) | **BLOCKED** |
| 4 | `dedup_status` on the row actually flagged `duplicate_candidate` | `duplicate_candidate` → `unique` | **BLOCKED** (`dedup_status may only move from duplicate_candidate to a user_confirmed_* resolution`) |
| 5 | `fdh_duplicate_candidates.status` on a real, own, pending candidate | `pending` → `auto_confirmed` | **BLOCKED** |
| 6 | INSERT a fabricated `fdh_transactions` row, valid own account+statement FK | n/a | **BLOCKED** (`engine-authoritative: rows may only be created by trusted server-side processing`) |
| 7 | INSERT a second `fdh_reconciliation_results` row, `status='reconciled'` | n/a | **BLOCKED** |
| 8 | INSERT a fabricated `fdh_data_provenance` row (correct schema: `entity_type`/`entity_id`/`source_type`) | n/a | **BLOCKED** |
| 9 | `transaction_type_hint`/`balance_after`/`economic_fingerprint` on own transaction | genuinely different values | **BLOCKED** |

**7 of 8 distinct forgery vectors blocked. One genuine, live-confirmed, unresolved gap: `reconciliation_status`.**

### The `reconciliation_status` forgery — root cause and evidence

`docDup`'s real, engine-computed `reconciliation_status` was `not_available` (the `dup_candidate.csv` fixture has no balance column — genuinely nothing to roll forward from). A direct `PATCH /rest/v1/fdh_statement_uploads?id=eq.<own doc>` with body `{"reconciliation_status":"reconciled"}`, using User A's own real access token, returned **HTTP 200** and the row's `reconciliation_status` was durably changed to `'reconciled'` — confirmed by a separate service-role ground-truth read afterward (`docDup: {"certification_status":"review_required","reconciliation_status":"reconciled","detection_confidence":0.8}` — reconciliation_status is the only one of the three that moved).

**Root cause**: migration 0064's `r7_assert_statement_upload_authoritative_fields()` trigger protects every column *it introduces* (`detection_status`, `detection_confidence`, `certification_status`, the three row-count columns, `adapter_key`/`adapter_version`, `mapping_template_id`, `delimiter_detected`, `encoding_detected`, `header_row_index`) but not `reconciliation_status` — a **pre-existing FDH-1 column** (migration 0046) that R7's reconciliation engine is the first real writer of, exactly parallel to how `fdh_transactions`/`fdh_duplicate_candidates` needed their own new triggers because FDH-1 shipped them with no writer at all.

**Fix drafted, not applied**: `supabase/migrations/0065_r7_final_reconciliation_status_forgery_fix.sql` — a `create or replace function` widening the existing trigger function to also guard `reconciliation_status` (no new trigger, no column change, no data migration; R7's own service-role processing path is completely unaffected since it runs as `service_role`, not `authenticated`). **Not applied to live DEV** — this session has no DDL-execution credential (same documented constraint as every prior phase: service-role REST key only, no `DATABASE_URL`, no linked Supabase CLI, no `exec_sql`-shaped RPC).

**RED→GREEN proof, real PGlite Postgres, not live DEV** (`scripts/r7final_reconciliation_status_forgery_negative_control.mjs`):
```
[RED  (migrations up to 0064 only, matches live DEV today)] forgery attempt: SUCCEEDED (no error); ground truth after = reconciled
[GREEN (migrations up to 0065, the proposed fix)]            forgery attempt: BLOCKED (authoritative R7 detection/certification fields...); ground truth after = not_available
RED (gap reproduced, as on live DEV today): CONFIRMED
GREEN (0065 closes it): CONFIRMED
```
The full 65-migration chain (0001-0065) also replays cleanly against a fresh PGlite database (`node scripts/db-rebuild-check/replay.mjs`): 65/65 applied, 172 tables, 172 RLS-enabled, 0 disabled. The re-run PGlite security certification (`r7_security_certification.mjs`, with 0065 present) still passes 45/45 — the widening breaks nothing.

## §28 — Legitimate user actions still work

- **Correction**: User A corrected their own transaction's `description_clean` via the real API. Result: `200`, the value changed, `user_override=true`, and a real `fdh_transaction_corrections` row was written (audit trail intact).
- **Duplicate resolution**: User A resolved their own real pending candidate (`resolution: 'kept_both'`) via the real API. On the FIRST attempt this silently failed to persist on the candidate row (API returned `{resolved:true}` but the candidate stayed `pending`) — this is defect #3 below, now fixed. After the fix: `200`, and the candidate row itself now genuinely shows `status='not_duplicate'`, `user_resolution='kept_both'`.

### Defect found: duplicate-resolution silently no-op'd (fixed)

`lib/financial-data-hub/repositories/base.ts`'s generic `update()` unconditionally added `updated_at: new Date().toISOString()` to every UPDATE payload. `fdh_duplicate_candidates` (FDH-1, migration 0047) and `fdh_transaction_corrections` (R7, migration 0064) have no `updated_at` column at all. The resulting PostgREST `PGRST204` error was never checked by the calling code (`resolveDuplicateCandidate()` awaited the repository call but discarded its `{data,error}` result), so the API kept reporting success while the candidate row was never actually resolved — a genuine, silent, live-only-discoverable defect (this table had no real caller of `.update()` until R7's `resolveDuplicateCandidate()`). Meanwhile the two transactions' `dedup_status` DID update (that table genuinely has `updated_at`), leaving a **permanently inconsistent state**: transactions correctly marked `user_confirmed_distinct`, but the candidate row stuck at `pending` forever with no way to resolve it.

**Fixed**: `makeUserOwnedRepository()` now accepts a `hasUpdatedAtColumn` option (default `true`, preserving every other table's existing behaviour); `duplicateCandidatesRepository` and `transactionCorrectionsRepository` now pass `false`. Re-verified live: the exact same resolution flow now genuinely persists (see above). Full vitest suite re-run clean (1938/1943) after this fix; `tsc --noEmit` clean.

## §29 — Forgery negative control

Reused/re-run this session: `scripts/r7_security_certification.mjs` (PGlite, real Postgres) — 45/45, including its own 2 negative-control pairs (authoritative-field trigger dropped → the previously-blocked `detection_confidence` forgery succeeds → trigger restored → blocked again; RLS disabled on 3 tables → cross-tenant leak observed → re-enabled → isolation restored). Live DEV's own security was **not** deliberately weakened to reproduce this a third time (unacceptable risk to real tenant isolation); the RED→GREEN pair specific to this session's own new finding (§27's `reconciliation_status` gap) is instead proven directly, per above.

## §30 — Bounded storage-security regression: PASS

Reused FDH-3's `fdh-source-documents` bucket verbatim (R7 introduces no new storage mechanism). Live probes against the real storage object for User A's real uploaded document (`storage/v1/object/authenticated/fdh-source-documents/{userId}/{docId}/{docId}.bin`):

| Actor | Result |
|---|---|
| Owner (User A's own token) | `200` — reads |
| Other user (User B's own token) | `400` (denied) |
| Anonymous (anon key only) | `400` (denied) |
| Public endpoint (`/object/public/...`) | `400` (no public access) |

## §31 — Admin operational-metadata boundary: PASS

Re-confirmed live: no ad-hoc admin RPC/table surface exists (`404` on a hypothetical admin probe endpoint). Carried forward from the PGlite cert's own `pg_roles` query (0 matches for any `admin`/`fdh_admin`/`r7_admin` role) — unchanged by anything in this session.

## §32 — Service-role processing regression: PASS

After every lockdown check above, a fresh document was uploaded and processed through the REAL app pipeline as the legitimate owning user: `200`, `certification_status='certified'`, 5 transactions created, reconciled — trusted server-side processing is completely unaffected by any of the RLS/trigger hardening being tested against.

## Cleanup

Both security-test users' rows deleted from every touched table, re-queried as 0; both users deleted via admin API, re-queried as `404`. Verified on the final run.

## Summary

| Item | Result |
|---|---|
| Cross-user read attacks | 9/9 blocked |
| Cross-user write attacks | 4/4 blocked |
| Same-user forgery (valid own FKs) | 7/8 blocked, **1 genuine gap (reconciliation_status), fix drafted+proven, not yet applied** |
| Legitimate actions | 2/2 work (1 required a genuine app-layer fix, now applied and re-verified) |
| Storage security | 4/4 as expected |
| Admin boundary | held |
| Service-role regression | held |
| Negative control | 45/45 PGlite re-run + a dedicated RED→GREEN pair for the new finding |
