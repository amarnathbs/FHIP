# R3 — Security Verification

Status: FINAL (R3) for STATIC/design verification; SEC-R3-001..010 LIVE adversarial tests are **BLOCKED** pending migration `0042` application to DEV — stated plainly per this project's own testing discipline (never claim LIVE for something only reasoned about from SQL).

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

## 5. Classification

STATIC/design-level review: **PASS** — the RLS and application-layer pattern is correct, consistent with this project's own established discipline, and introduces no new attack surface (no new policies needed, no new unscoped queries found). **LIVE adversarial SEC-R3-001..010: BLOCKED pending migration application** — this must be independently re-run with real seeded victim rows before R3 can be called a full, unconditional security PASS; the orchestrating session or a human operator must complete this step in DEV.
