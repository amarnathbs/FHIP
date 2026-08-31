# FDH-15 — Residual Risk Register

## Defects found and fixed this round

### FDH15-DEF-001

- **Severity**: P1 (security/financial-integrity — same-tenant authority forgery)
- **Domain**: Income (FDH-9)
- **Reproduction**: Create Self-owned and Spouse-owned `income_sources` rows for one tenant. Create
  a payslip-sourced proposal (`fhip_import_proposals`, `target_domain='income'`) whose
  `target_entity_id` names the Spouse's row. Call the real `fdh9_apply_income_proposal` RPC as the
  tenant's own authenticated user, decision `update_existing`.
- **Live DEV**: Reproduced twice, consistently, using a real authenticated JWT (never
  service-role) — `scripts/fdh15_bridge_governance_live_dev_certification.mjs`, check `INC-6`.
  Result pre-fix: `{"ok":true,"outcome":"applied",...}`, Spouse's `income_sources.amount` silently
  changed to the Self payslip's proposed value.
- **Financial/security impact**: An ordinary user's own action (uploading their own payslip) could
  silently mutate a DIFFERENT household member's income record within the same tenant, with no
  forgery required beyond how `target_entity_id` came to be set — either an organic
  matching-algorithm mistake (employer-name collision across members) or a direct client PATCH of
  the proposal row (RLS permits an owner to PATCH their own proposal's columns generally).
- **Why existing domain certification missed it**: FDH-9's own security certification tested
  cross-TENANT forgery (Tenant B targeting Tenant A) exhaustively, but never tested same-tenant,
  cross-MEMBER forgery — a narrower, easy-to-overlook case because RLS's `auth.uid()=user_id` check
  passes for both members (they share one `user_id`).
- **Negative control**: `scripts/fdh15_member_mismatch_guards_certification.mjs` §2 proves the
  identical forged request SUCCEEDS on a PGlite copy of the chain with migration `0120` excluded —
  i.e. this harness would have caught the regression, not merely reported PASS by construction.
- **Root cause**: Neither `incomeAdapter.ts`'s candidate-matching query nor
  `fdh9_apply_income_proposal()` filtered/checked the target's `owner` column. The RPC's only
  ownership check was `target.user_id = auth.uid()`.
- **Fix**: Migration `0120` (`CREATE OR REPLACE FUNCTION fdh9_apply_income_proposal`) adds: for
  `update_existing`/`apply_selected_fields` on a `source_kind='payslip'` proposal, refuse with
  `MEMBER_MISMATCH` unless the target's `owner = 'self'` (the only owner value this bridge's own
  `add_new` path has ever produced). Companion fix:
  `lib/import-bridge/incomeProposalService.ts`'s candidate query now filters `.eq('owner','self')`,
  closing the gap at the recommendation layer too.
- **Regression**: Full 113/113 PGlite migration replay clean; `tsc --noEmit` 0 errors; 154/154
  relevant vitest unit tests pass; production build succeeds; positive control (legitimate
  Self→Self Apply) still succeeds after the fix (PGlite-proven).
- **Final live re-proof**: **NOT YET PERFORMED** — migration `0120` has not been applied to hosted
  DEV (standing rule 1: no direct SQL execution against DEV; migrations are handed to the Product
  Owner for manual application). The fix is PGlite-proven only. This is disclosed honestly, not
  asserted as a live fix, per standing rule 4.

### FDH15-DEF-002

- **Severity**: P1 (security/financial-integrity — same-tenant Self/Spouse authority forgery)
- **Domain**: Retirement (FDH-12)
- **Reproduction**: Create Self and Spouse `retirement_members` + `retirement_accounts` (each
  linked via `retirement_member_id`) for one tenant. Approve a retirement statement resolved to the
  Self member. Create a proposal (`source_retirement_statement_id` → the Self statement) whose
  `target_entity_id` names the Spouse's account. Call the real `fdh12_apply_retirement_proposal`
  RPC as the tenant's own authenticated user.
- **Live DEV**: Reproduced live using a real authenticated JWT — check `RET-2`. Result pre-fix:
  `{"ok":true,"outcome":"applied",...}`, Spouse's `retirement_accounts.current_balance` silently
  overwritten from the Self statement's evidence.
- **Financial/security impact**: Identical class to FDH15-DEF-001, explicitly named by the
  governing spec as a required negative control (§30, §197) precisely because this project's
  history (FDH-12) already proved this failure class is real for a different column set.
- **Why existing domain certification missed it**: FDH-12's own security certification tested
  cross-tenant forgery and provenance forgery exhaustively (migrations `0113`/`0114`), but the
  Self/Spouse separation was only ever enforced at proposal-GENERATION time
  (`accountMatching.ts`'s member-narrowing filter) — the authoritative Apply RPC itself had no
  independent check, an asymmetry not caught because generation-time correctness was mistaken for
  Apply-time authority.
- **Negative control**: `scripts/fdh15_member_mismatch_guards_certification.mjs` §2 proves the
  identical forged request SUCCEEDS on a PGlite copy of the chain with migration `0119` excluded.
- **Root cause**: `fdh12_apply_retirement_proposal()` computed the source statement's resolved
  member (`v_member_id`) only AFTER the compare-and-swap claim, and used it only for the `add_new`
  insert path — `update_existing` never compared it against the target account's own
  `retirement_member_id`/`owner`.
- **Fix**: Migration `0119` resolves `v_member_id` BEFORE the target lookup and, for
  `update_existing`/`apply_selected_fields` only, refuses with `MEMBER_MISMATCH` if the source
  statement's member differs from the target account's `retirement_member_id` (checked when both
  are non-null).
- **Regression**: Same as FDH15-DEF-001 — 113/113 replay, 0 tsc errors, unit tests pass, build
  succeeds, positive control (legitimate Self→Self Apply, and the pre-existing SMSF refusal /
  `target_retirement_age` FORBIDDEN_FIELD checks) all still pass after the fix.
- **Final live re-proof**: **NOT YET PERFORMED** — same pending-DEV-activation disclosure as
  FDH15-DEF-001.

## Non-blocking residuals (P2/P3), carried forward or newly disclosed

| # | Residual | Severity | Status |
|---|---|---|---|
| 1 | AU Investment's real Apply path was not exercised via a real HTTP call to its actual Next.js API route this round (no user-invoked RPC exists for this domain — the API route itself is the authorization boundary). FDH-15's live proof for Investment relies on FDH-11's own prior live certification (unchanged source). | P2 (scope gap, not a demonstrated defect) | OPEN — recommend a dedicated live-DEV HTTP-level re-proof for Investment Apply in a follow-up pass |
| 2 | No single combined "golden bridge household" spanning Income+Liability+AU-Investment+Retirement via real RPCs/API in one user context was built this round. | P2 (coverage-composition gap) | OPEN — FDH-14's service-role-based golden household remains the closest existing multi-domain evidence, explicitly flagged as not meeting §215 for bridge claims |
| 3 | Concurrent (simultaneous in-flight) Apply, raw HTTP replay, and mid-function forced-failure atomicity were not fault-injected fresh against real hosted DEV this round (would require constructing damaging race conditions against shared DEV). | P3 | OPEN, architecturally reasoned (row-lock + compare-and-swap), consistent with FDH-14's own equivalent disclosed residual (R-14-3) |
| 4 | Liability and Retirement idempotency (double-Apply) were not independently double-applied live this round — Income's identical RPC shape WAS live-proven, and Liability/Retirement's RPC bodies are structurally identical (row-lock + compare-and-swap + `UNIQUE(proposal_id)`), confirmed by direct code reading. | P3 | OPEN, low risk given structural identity |
| 5 | **FDH-9's (`fdh9_certification.mjs`), FDH-10's (`fdh10_security_certification.mjs`), and FDH-12's (`fdh12_certification.mjs`) own PGlite certification scripts, as currently written, fail partway through fixture setup against the CURRENT migration chain** — they insert a test user without marking `user_profiles` country-confirmed, and migration `0104`'s (Mandatory Country Confirmation) trigger now rejects that insert (`COUNTRY_CONFIRMATION_REQUIRED`). Independently reproduced this round on the current chain (both with and without migrations 0119/0120 — not caused by FDH-15). | P3 (test-hygiene/traceability gap, not a live product defect — the actual RPCs work correctly for country-confirmed users, as this round's own live-DEV script proves) | **NEWLY DISCLOSED this round** (rule 5's "re-run actual current tests" requirement surfaced it). Not fixed here per rule 8/§12 (no speculative modification of already-certified modules' own test suites outside FDH-15's own decisive scope). Recommend a small follow-up: each script's tenant-seeding helper should call the same `user_profiles` country-confirmation upsert this round's scripts use. |
| 6 | Scale (1000/1001/5000-row proposal/position lists) not freshly tested this round. | P3 | OPEN |
| 7 | Migration numbers `0116`–`0118` are correctly reserved/unavailable on this branch — claimed by unmerged sibling worktrees (`fhip-a02-wave2`: 0116, 0118; `fhip-module11-2`: 0117) at the time of this round's collision scan. FDH-15's own new migrations correctly used `0119`/`0120`. | N/A (process note, not a defect) | Will need re-scanning again immediately before any future migration allocation on this branch, per standing rule 3 |

## Carried-forward FDH-0 through FDH-14 residuals

Not re-litigated in full here — see `FDH14_RESIDUAL_RISK_REGISTER.md` (items 1–29), all of which
remain in the same state this round found them (no FDH-15 activity touched PDF timeout, OCR scope,
secondary-adapter coverage, malware scanning, or any other FDH-14-disclosed item). None of them
are bridge-governance-specific, so none are re-assessed as part of FDH-15's own P0/P1 gate.

## P0/P1 gate (spec §212)

Two P1 defects were found this round (FDH15-DEF-001/002). Both have a smallest-correct fix,
PGlite-certified with anti-vacuity proof, ready for the Product Owner's standard migration-
application workflow. **Neither is confirmed closed on live hosted DEV yet** — this is the
determining factor in this round's verdict (see `FDH15_COMPLETION_REPORT.md`).
