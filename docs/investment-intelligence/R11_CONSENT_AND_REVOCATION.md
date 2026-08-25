# R11 Consent & Revocation

Spec sections 47, 66-70.

## Consent record

Every `professional_relationships` row carries: who granted (`client_user_id`), who received (`professional_user_id`), scope (`professional_permission_scopes`, separately per-scope), purpose (`purpose` free text), time (`created_at`/`accepted_at`), terms version acknowledged (`terms_version`, defaulted `'r11-terms-v1'`), expiry if applicable (`expires_at`), revocation (`revoked_at`/`revoked_by`). Every state change is independently, automatically recorded in `professional_consent_audit` by a trigger — never by a direct client-supplied audit row (see `R11_SECURITY_MODEL.md`'s audit-forgery section).

## Revocation — the mandatory hard requirement

**Mechanism**: `checkAccessLive()` (`lib/services/professional-access/access.ts`) reads `professional_relationships`/`professional_permission_scopes`/`professional_profiles` fresh from the database on every single call — there is no cache, no session-embedded permission claim, no JWT custom claim carrying access state. This is the entire mechanism behind immediate revocation: the moment `revokeRelationship()` writes `status='revoked'`, the very next call to `checkAccessLive()` (from any request, any endpoint) reads that row and denies.

**Mandatory revoked-token-retry test** — proven at three independent levels, not just asserted:

1. **Pure-logic level** (`tests/unit/r11ProfessionalPermissions.test.ts`, PA-18): the identical `RelationshipRecord` object that produced `allow: true` a moment ago produces `allow: false` the instant its `status` field is flipped to `'revoked'` — no separate cache object exists to invalidate.
2. **Real-database level** (`scripts/r11_rls_certification.mjs`, Section 6): a real relationship row, read by the real professional's authenticated session BEFORE revocation, is re-read by that SAME session immediately after a service-role revoke — the second read genuinely returns `status='revoked'`.
3. **Irreversibility level** (same script, Section 6): an attempt to revert `status` from `'revoked'` back to `'active'` — even performed AS THE SERVICE ROLE — is rejected by the `enforce_professional_relationship_transition()` trigger. This closes the "attacker convinces the trusted service to undo a revoke" gap that RLS alone cannot close (RLS is bypassed by the service role by design; the trigger is not).

**Expiry behaves identically to revocation**: `checkProfessionalAccess` evaluates `expiresAt <= now` live against wall-clock time on every call (PA-11 through PA-17) — an expired relationship denies immediately even if no background sweep has yet flipped its `status` column, closing the "we forgot to run the expiry cron" gap.

**Scope reduction takes effect immediately**: `revokeScope()` sets `revoked_at` on the specific scope row; `checkProfessionalAccess`'s `grantsForScope.some(g => g.revokedAt === null)` check means the very next `checkAccessLive()` call for that scope denies (PA-07).

**Deactivated professional loses ALL access**: `professionalIsActive` is read fresh from `professional_profiles.is_active` on every `fetchAccessContext()` call and gates access independently of relationship status (PA-19/PA-20) — a deactivated professional cannot use even an otherwise-perfectly-valid, unexpired, correctly-scoped relationship.

**Legitimate account deletion**: `professional_relationships.client_user_id`/`professional_user_id` both `references auth.users(id) on delete cascade` — deleting either party's account cascades to delete their relationships (and, transitively, scopes/notes/audit/report-access-log via each table's own `on delete cascade` to `professional_relationships`), matching existing FHIP retention conventions rather than inventing a new one.
