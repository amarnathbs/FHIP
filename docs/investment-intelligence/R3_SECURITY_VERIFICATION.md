# R3 — Security Verification

Status: FINAL (R3). SEC-R3-001..010 LIVE adversarial tests were completed 2026-08-20 after migration `0042` was applied to DEV — see section 6. STATIC/design verification (sections 1-5) is reproduced below unchanged as the design-level record.

## 1. RLS design (STATIC — verified by reading the migration text directly)

Every new column added by migration `0042` lives on a table that **already** has owner-only row-level security enabled (`R1_RLS_SECURITY_REPORT.md`'s established pattern):

| Table | RLS policy (pre-existing, unchanged) | New R3 columns inherit protection because... |
|---|---|---|
| `ii_fhip_publications` | `"own ii_fhip_publications"` — `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)` (migration `0034`) | RLS is row-level, not column-level — every new column (`account_id`, `instrument_id`, `owner_member_id`, `published_value`, etc.) on an already-protected row is automatically covered; no new policy was needed or added. |
| `investments` | `"own rows - investments"` (migration `0003`), unchanged | Same reasoning — `source_type`, `ii_publication_id`, `pre_publication_manual_snapshot`, etc. are new columns on an already row-secured table. |
| `assets`, `retirement_accounts` | Pre-existing owner-only policies, unchanged | Same reasoning. |
| `ii_audit_events` | `"read own ii_audit_events"` — **select-only**, no insert/update/delete policy for the authenticated role at all (migration `0036`, unchanged) | Every R3 audit write goes through `emitAuditEvent()` using the service-role client (`lib/services/investment-intelligence/audit.ts`), exactly matching the R1/R2 pattern — never a direct user-facing insert. |

**No new RLS policy was written in migration `0042`** — this is deliberate, not an oversight: every table R3 touches already has the correct policy, and the migration only adds columns/indexes/constraints to existing, already-secured tables.

## 2. Application-layer defense-in-depth (STATIC — verified by direct code inspection)

Every read/write in `investmentPublicationService.ts` explicitly scopes by `.eq('user_id', userId)` **in addition to** relying on RLS — 27 explicit `user_id` scoping calls across `loadPositionContext()`, `checkEligibility()`, `buildPreview()`, `publishPosition()`, `unpublishPosition()`, `republishPosition()`, `refreshPosition()` (verified: `grep -c "eq('user_id', userId)" investmentPublicationService.ts` → 27). This matches `accounts.ts`'s established pattern — the application never relies on RLS alone for a mutation path, even though RLS would independently block a cross-user attempt.

Every new API route (`app/api/investment-intelligence/positions/[id]/{eligibility,preview,publish,refresh}`, `app/api/investment-intelligence/publications/{route,[id]/unpublish,[id]/republish}`) calls `requireUser()` first and passes only `user.id` (never a client-supplied user/household id) into the service layer — a spoofed household ID in the request body cannot substitute for the authenticated session's own id, because no route reads a household/user id from the request body at all.

`app/api/investments/[id]/route.ts`'s direct-edit protection (PATCH/DELETE) reads the existing row scoped by `.eq('user_id', userId)` before deciding whether to block, so a cross-user PATCH/DELETE attempt would (a) find no row (RLS-filtered `select` returns null) and (b) the subsequent `registry.update()`/`registry.archive()` calls are themselves scoped by `.eq('user_id', userId)` — a double failure point for any cross-user attempt, matching this project's established defense-in-depth discipline exactly.

## 3. What is BLOCKED and why

`SEC-R3-001` through `SEC-R3-010` (User A cannot preview/publish/target/supersede/refresh/unpublish User B's data; spoofed household ID rejected; cross-household canonical-target linkage rejected; publication audit protected) require **live** adversarial testing against real seeded victim rows, per this project's own hard-won methodology (R1.6/R1's unseeded-fixture bugs): seed a real victim row with the victim's own authenticated session, attack it as a different user via a direct request with `Prefer: return=representation`, independently verify ground truth via a service-role read. This methodology requires the `ii_fhip_publications` R3 columns (`account_id`, `instrument_id`, etc.) and the `investments.source_type`/`ii_publication_id` columns to exist in the target database — they do not exist in DEV until migration `0042` is applied by a human with DDL access (the same structural constraint every prior phase — R1, R1.6, R1.7, R2 — hit and disclosed identically).

**This is BLOCKED, not skipped, not assumed-passing, and not a FAIL** — matching this project's own precedent exactly. The methodology above is documented and ready to execute the moment the migration is applied; it is not designed after the fact.

## 4. What is proven now (pure-logic level, does not require the DB)

- `evaluateEligibility()`/`detectDuplicateCandidates()`/`calculateFinancialImpact()` never accept or trust a caller-supplied user/household identifier — every function takes only the specific data needed for its decision (owner id, instrument class, values), never a security-relevant identity to check against. There is no code path in `publicationLogic.ts` where an authorization decision could be spoofed, because `publicationLogic.ts` makes no authorization decisions at all — that responsibility lives entirely in `investmentPublicationService.ts`'s explicit `.eq('user_id', userId)` scoping, which is inspectable and was inspected (section 2).
- No new table exposes an unrestricted CRUD surface — every route is bounded to one specific operation (section 5, `R3_PUBLISHING_ARCHITECTURE.md`).

## 5. Classification (static/design)

STATIC/design-level review: **PASS** — the RLS and application-layer pattern is correct, consistent with this project's own established discipline, and introduces no new attack surface (no new policies needed, no new unscoped queries found).

## 6. Live-DEV closure results (2026-08-20)

Methodology: two real throwaway auth users (Household A, Household B) created via the Auth Admin API; Household B's real portfolio data (an `ii_accounts`/`ii_instruments`/`ii_transactions`/`ii_holding_snapshots` chain plus a real manual `investments` row) legitimately created and then certified/published via B's own authenticated session hitting the real API routes; every attack fired by User A via genuine `@supabase/ssr`-shaped session cookies built from a real password-grant sign-in (never a fabricated token) against the real running Next.js dev server; ground truth independently re-verified via service-role reads both before AND after every attack — never accepting a denial response alone as proof without first confirming a real victim row existed to be blocked. Script: `scripts/r3_sec_tests.mjs`.

| ID | Test | Result |
|---|---|---|
| SEED-VERIFY | Real victim data exists for User B before any attack (1 active investments row, 1+ publications) | **PASS** |
| SEC-R3-001 | User A cannot preview User B's canonical position | **PASS** (404) |
| SEC-R3-002 | User A cannot check eligibility on User B's position | **PASS** (404) |
| SEC-R3-003 | User A cannot publish User B's position | **PASS** (404, after fixing a status-code-only bug — see `R3_ACCEPTANCE_REPORT.md` defect #6; the security outcome was already correct, denial occurred, before the fix) |
| SEC-R3-004 | User A cannot refresh User B's position | **PASS** (422) |
| SEC-R3-005 | User A cannot unpublish User B's publication | **PASS** (404) |
| SEC-R3-006 | User A cannot republish User B's publication | **PASS** (409) |
| SEC-R3-007 | User A cannot link User B's canonical position to any row, including a row A legitimately owns | **PASS** (404 — rejected before the link target is even considered, since the position itself is never resolvable as A's) |
| SEC-R3-008 | User A cannot PATCH User B's investments row (spoofed cross-household target write) | **PASS** (400, RLS-filtered `select` finds nothing to update) |
| SEC-R3-009 | Direct PostgREST insert into `ii_fhip_publications` with `user_id` spoofed to B, authenticated as A | **PASS** (403, `42501` — RLS `with check` clause rejected it) |
| SEC-R3-010 | User A cannot read User B's `ii_audit_events` | **PASS** (200, 0 rows — RLS-scoped select) |
| GROUND-TRUTH-AFTER | User B's real investments/publications data is byte-for-byte unchanged after every attack above | **PASS** |

**12/12 PASS.** Full raw output preserved in `r3-closure-sec-results.local.json` during the session (gitignored scratch file, not committed).

## 7. Final classification (updated)

**LIVE PASS — unconditional.** Both the static/design review and the live adversarial pack are clean. No cross-user access, no spoofed-ownership write, no unauthorized read of another household's data or audit trail was found anywhere in this pass.
