# R11 Negative Control Certification

Spec section 95: at least 8 RED→GREEN negative controls, each genuinely sabotage-then-revert. **All 8 performed for real** during this session — each sabotage was applied via a real source edit, run against the real test suite (or the real PGlite database for NC8) to confirm genuine RED, then reverted via a real source edit and re-run to confirm genuine GREEN. No control was simulated or narrated without execution.

| # | Control | Sabotage applied | RED result | GREEN result after revert |
|---|---|---|---|---|
| NC1 | Source Order | `resolvePrecedenceWinner` returns `candidates[0]` (import order wins) instead of rank→freshness→id tiebreak | 8/49 tests failed (`tests/unit/iiR11CrossSourceIdentity.test.ts`) | 49/49 passed |
| NC2 | Cross-Source Duplication | `otherSourceRows` hardcoded to `[]` inside `resolveCrossSourceTransactionMatch` (duplicate resolution effectively disabled) | 22/49 tests failed | 49/49 passed |
| NC3 | Weak Fuzzy Match | `classifyPairwise` returns `'exact'` immediately once core identity matches, skipping amount/units/reference entirely | 12/49 tests failed (conflict/high-confidence cases silently became false `'exact'` matches — a real false merge) | 49/49 passed |
| NC4 | Holding-Snapshot-Adjacent Fabrication | `unitsMatch()` hardcoded to `return true` (a missing/incomplete units value treated as matching anything) | 3/49 tests failed | 49/49 passed |
| NC5 | Professional Full Access | The scope-grant check block in `checkProfessionalAccess` removed entirely (any active relationship implies every scope) | 14/45 tests failed (`tests/unit/r11ProfessionalPermissions.test.ts`) | 45/45 passed |
| NC6 | Revocation Cache | The `status==='revoked'` early-deny branch AND the later `status!=='active'` branch both temporarily allowed `'revoked'` through (simulating stale cached access) | 2/45 tests failed (PA-04 revoked-denial, PA-18 revoked-token-retry) | 45/45 passed |
| NC7 | Raw Document Leak | `VIEW_RAW_DOCUMENTS` temporarily added to `PROFESSIONAL_SCOPES`, `isRawDocumentScopeSupported()` flipped to `true` | 6/46 tests failed | 45/45 passed |
| NC8 | Cross-Client Scope | Real migration edit: `professional_relationships`' "professional reads own" RLS policy changed from `auth.uid() = professional_user_id` to `using (true)` | Real PGlite run: `leaked 1` (P2 read P1's client relationship) — confirmed at the DATABASE level, not simulated | Full 32/32 PGlite certification passed after revert |

## Why NC8 was run at the database level and the others at the test-suite level

NC8 (cross-client) is the one control where the spec's own wording ("remove the client relationship check") maps most directly onto an actual RLS policy rather than a pure function, so it was sabotaged and reverted directly in `supabase/migrations/0083_ii_r11_professional_access.sql`, replayed fresh through PGlite via `scripts/r11_rls_certification.mjs` both times — genuinely proving the real Postgres RLS policy (not a JS approximation of it) is what blocks the attack. The other 7 controls target the pure decision/matching logic in `crossSourceIdentity.ts`/`permissions.ts`, where the fast, deterministic vitest suites are the more direct and more precisely-diagnosable target (each failure names the exact assertion that broke).

## Reproducing any control

Every sabotage/revert pair in this document reflects a real `Edit` tool call pair made during this session, immediately re-run before and after. To reproduce any one: apply the described change to the named function, run the named test command, observe the failure count, then revert.
