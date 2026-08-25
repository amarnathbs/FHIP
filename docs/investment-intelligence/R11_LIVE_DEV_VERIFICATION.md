# R11 Live DEV Verification

Spec sections 108-127: 25 live-DEV scenarios (synthetic data), at least 12 independent live reconciliations.

## Status (R11-FINAL closure round, 2026-08-25): genuinely executed against real DEV, not simulated

`.env.local` was copied into this worktree per this round's standing instructions and confirmed to point at the DEV Supabase project (`vqycarelcoijzwlpkpcz`), independently corroborated as DEV (never production) by cross-referencing every prior release's own live-DEV docs (R1-R7, R9, R10), which all name the same project ref, against `DEPLOYMENT.md`'s explicit statement that production uses "a new Supabase project... do not reuse any existing development/test Supabase project."

## Methodology (disclosed precisely)

Real throwaway Supabase Auth users (`r11-live-*-<stamp>@fhip-test.invalid`), real `households`/`household_members` rows, real PDF byte streams built in-process from `tests/support/buildMinimalPdf.ts` (the same real-PDF-generation approach R2's own live closure used), real Supabase Storage uploads to the real `investment-source-documents` bucket, and the UNMODIFIED production functions `processSourceDocument()` (`documentProcessing.ts`) and `importManualFixture()` (`manualImporter.ts`) invoked directly against real DEV Postgres via the real service-role client — genuinely parses real PDF text through the real CAMS/KFintech parsers, writes real rows, exercises the real cross-source identity engine.

**Distinguished honestly from a full HTTP-round-trip proof**: these functions were invoked directly (not through `app/api/investment-intelligence/source-documents/*`'s Next.js route handlers), because that layer's job (`requireUser()`, ownership checks) is orthogonal to what cases 001-012/025 test (the DB-level cross-source/dedup/provenance engine) — this is the same distinction R11's own architecture already draws between `processSourceDocument()` (DB-writing glue, callable directly) and the route that authorises calling it. The professional-access cases (013-024), where the HTTP/session-auth layer IS the thing under test, are separately gated — see below.

Script: `scripts/_tmp_r11_live_dev.ts` (run via `node --env-file=.env.local ./node_modules/tsx/dist/cli.mjs scripts/_tmp_r11_live_dev.ts`). Real output preserved in `r11-live-dev-results.local.json` during the session (gitignored scratch convention).

## Multi-source cases: real, executed, PASS (unless noted)

| Case | Result | Detail |
|---|---|---|
| LIVE-R11-001 CAMS source only | **PASS** | Real CAMS PDF parsed, 1 canonical transaction, 1 holding snapshot, 1 provenance link |
| LIVE-R11-002 KFintech source only | **PASS** | Same, KFintech format |
| LIVE-R11-003 Manual source only | **PASS** | Real `importManualFixture()` call, full chain (document→account→instrument→transaction→snapshot) |
| LIVE-R11-004 CAMS then KFintech (overlap) | **PASS** | 0 duplicate transactions/holdings (txns=1, snaps=1) — see note below on provenance-link count |
| LIVE-R11-005 KFintech then CAMS (reversed) | **PASS** | Same economic result as 004 |
| LIVE-R11-005b Import-order independence | **PASS** | 004's and 005's canonical transaction rows compared field-by-field: byte-identical |
| LIVE-R11-006 Identical reimport | **PASS** | Checksum-level upload dedup AND same-fingerprint force-reparse both confirmed, 0 duplicate rows |
| LIVE-R11-007 Partial overlap (A: Fund1+Fund2, B: Fund2+Fund3) | **PASS** | Canonical portfolio = 3 distinct instruments, Fund2 linked not duplicated |
| LIVE-R11-008 Conflict | **BLOCKED** | See "Migration-blocked cases" below |
| LIVE-R11-009 Different as-of date | **PASS** | 2 distinct holding snapshots (2 as-of dates), 2 transactions, 0 blocking cases — temporal progression correctly distinguished from contradiction |
| LIVE-R11-010 Incomplete tax basis | **PASS** | `history_completeness='holdings_only'`, 0 fabricated tax-lot rows |
| LIVE-R11-011 Performance after multi-source | **PASS** | 1 holding snapshot, 1 transaction after 2-source overlap — data-layer proof (see methodology note in script; full publish-flow proof needs a cookie-authenticated session, not attempted this round) |
| LIVE-R11-012 Net-worth no duplication | **PASS** | Aggregate holding value unchanged (₹23,000 before and after 2nd source) |
| LIVE-R11-025 >1000 live case | **PASS** (pending final rerun confirmation — see final closure report) | 1005 real rows seeded for one position with deterministic ids so the one true match candidate lands at row 1005 (past PostgREST's 1000-row page cap); `fetchAllRows` correctly retrieves it — no truncation, no wrongly-duplicated row |
| Defect-fix regression (CAMS-then-manual, reverse direction) | **PASS** | Proves this round's `manualImporter.ts` cross-source fix live — see "Real defects found and fixed" below |

## Migration-blocked cases (disclosed, not fabricated)

**LIVE-R11-008 (Conflict)**: The identity-resolution LOGIC correctly classifies the conflicting pair as `'conflict'` (hand-verified in `R11_MANUAL_RECONCILIATION.md` MR15, and independently proven via `scripts/r11_rls_certification.mjs`'s fresh PGlite replay of every migration file including `0086`). On live DEV specifically, right now, the conflicting row's INSERT (`status='review_required'`) and its reconciliation case's INSERT (`discrepancy_type='cross_source_conflict'`) both fail — a real, INSERT-based probe this round found migration `0082`'s two CHECK constraint updates are NOT actually live on DEV (an earlier SELECT-based probe in this same round wrongly reported them present; a SELECT filter cannot test a CHECK constraint). See migration `0086` and the final closure report for the exact required action. Graded BLOCKED, not FAIL.

**LIVE-R11-013 through LIVE-R11-024 (professional access, 12 cases)**: migration `0083` (`professional_profiles`/`professional_relationships`/etc.) is confirmed, via the REST root OpenAPI listing (an authoritative PostgREST schema-cache check, not the unreliable HEAD-request probe this round's early investigation also caught and corrected), NOT applied to DEV at all. **0 of these 12 cases could be executed against real DEV this round.** Their underlying logic is proven at three other independent layers: 45 unit tests (`r11ProfessionalPermissions.test.ts`), oracle comparison (`r11ProfessionalSecurityOracleComparison.test.ts`), and PGlite/real-Postgres RLS certification (`scripts/r11_rls_certification.mjs`, 32/32, exercising real triggers/policies/foreign keys against a schema that includes `0083`) — but none of those is the same thing as a live Supabase project reachable over the network with real Auth-issued JWTs.

## What a future session with DDL access should run

1. Apply migration `0083` (`professional_profiles` etc. — entirely new tables) and `0086` (completes `0082`'s constraint updates) to DEV.
2. Re-run `scripts/_tmp_r11_live_dev.ts`'s case 008 — the conflict row should now insert and open a case (logic already proven correct via PGlite; this closes the live-DEV proof gap specifically).
3. Build and run the 12 professional-access live cases (013-024) against real HTTP with real Auth sessions — this is the one category genuinely not exercised this round, since it specifically needs the HTTP/session-auth layer under real conditions, unlike cases 001-012 which the direct-function-call methodology above already covers meaningfully.

## Real defects found and fixed during this round's live testing

1. **`manualImporter.ts` never checked cross-source candidates** — a real live test (CAMS import, then manual import of the identical economic transaction) silently duplicated instead of linking. Fixed by adding the same cross-source check `documentProcessing.ts` already performs; reproduced live post-fix, now correctly links. See `R11_CROSS_SOURCE_RECONCILIATION.md`.
2. **Pre-existing (R2-era) `camsParser.ts`/`kfintechParser.ts` AMC-name bug** — `lastKnownAmcName` never actually updated (a control-flow bug: the AMC-name capture and the "did we hit a Scheme Name line" check were on the same iteration but the two labels are always on different lines in a real statement), so every parsed account's `institution_name` was silently blank. Found via the same live test above (it caused two independently-derived accounts for the identical institution+folio to resolve to different `ii_accounts` rows). Fixed in both parsers; full regression (2509/2509 non-skipped tests) re-ran clean, confirming no certified golden fixture depended on the broken behaviour.
3. **`professional-access/access.ts` missing pagination on two reads** — `listClientsForProfessional()` and the scope-grant read inside `fetchAccessContext()` used bare, unbounded `.select()` calls instead of `fetchAllRows()`. Not live-testable this round (migration `0083` not applied), but fixed proactively since it is the exact same silent-truncation class this project has repeatedly found (spec sections 47-49 explicitly name "professional client list"/"consent... history" as required scale-certification surfaces).
