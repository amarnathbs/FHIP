# R11 Professional Access Model

Spec sections 43-71. Genuinely new capability — R11-P0 confirmed no reusable invitation/delegation/shared-account construct exists anywhere in the pre-R11 schema.

## Identity model (freeze from R11-P0)

Platform Admin (`lib/services/adminAuth.ts::requireAdmin`) ≠ Professional (new `professional_profiles`, an ordinary `auth.users` row) ≠ Household Member (existing `household_members` — a profile record owned by the primary account holder, not a separate authenticated principal) ≠ End User (the primary `auth.uid()`).

A professional authenticates as an ordinary Supabase user. There is no service-role or platform-admin code path a professional can reach — every professional-facing read (e.g. `app/api/professional-access/proxy/investments-summary/route.ts`) uses the service-role client only AFTER an application-level `checkAccessLive()` call gates it; the professional's own session never carries elevated DB privileges.

## Tables (migration `0083`)

- `professional_profiles` — factual attributes (`display_name`, `organisation`, `professional_type`, `jurisdiction`, `registration_details`). Never platform-verified; there is no verification workflow in R11 (spec section 71 — "Provided by professional", never "platform-verified").
- `professional_relationships` — the canonical delegated-access relationship. Lifecycle: `pending_invite → active → revoked|expired|declined`, enforced terminal-state-irreversible by a `BEFORE UPDATE` trigger that fires for every role including service role (defense in depth beyond RLS).
- `professional_permission_scopes` — one row per granted scope, `revoked_at` marks history rather than deleting. At most one LIVE grant per `(relationship, scope)`.
- `professional_consent_audit` — append-only, written EXCLUSIVELY by `SECURITY DEFINER` triggers on the two tables above. No authenticated-role INSERT/UPDATE policy exists at all.
- `professional_notes` — the one direct-write path granted to the professional role, fully bounded in the INSERT policy's `WITH CHECK` (active relationship + live `COMMENT_OR_NOTE` scope, both re-checked at the DB level on every insert).
- `professional_report_access_log` — auditable report access without logging report contents; service-role-write-only.

## Invitation lifecycle (spec section 45)

`createInvitation` (client, via `POST /api/professional-access/invitations`) → `acceptInvitation`/`declineInvitation` (professional, via the professional's own session) → `active` → `revokeRelationship` (client only) → `revoked`. A professional can never self-activate (no UPDATE policy at all on `professional_relationships` for the authenticated role — proven in `scripts/r11_rls_certification.mjs` Section 5).

## Write model — why every security-critical table has NO authenticated write policy

`professional_relationships`, `professional_permission_scopes`, `professional_consent_audit`, `professional_report_access_log` are all SELECT-only for `authenticated`. Every mutation goes through a Next.js API route using the service-role client (`lib/services/professional-access/access.ts`), after the route verifies the caller's own session and checks the transition is legal in TypeScript. This is a deliberate, disclosed architecture choice, not an oversight — see `R11_SCOPE_AND_ARCHITECTURE_RECONCILIATION.md` section "Write model". It was chosen over a fully RLS-enforced multi-actor state machine because Postgres RLS cannot cleanly express "only THIS actor may transition FROM state X TO state Y, and no other transition" without either (a) a large number of narrow per-transition policies with brittle `USING`/`WITH CHECK` pairs, or (b) a trigger — and once a trigger is required anyway for the hard invariants (irreversibility of `revoked`/`expired`/`declined`, identity-column immutability), the same trigger-plus-service-role-mediation pattern is simpler and more auditable than mixing both. The trigger is the defense-in-depth backstop that holds even if the TypeScript layer has a bug (proven directly: `scripts/r11_rls_certification.mjs` Section 6 shows even the SERVICE ROLE cannot un-revoke a revoked relationship).

## Dashboard scope

The one professional-facing read endpoint built in R11 (`GET /api/professional-access/clients`, backed by `listClientsForProfessional`) returns strictly the caller's OWN active/pending relationships — there is no parameter or code path that widens this to any other professional's clients or to an arbitrary-user search surface (spec section 62). A full professional workspace UI is out of the frozen R11 scope (see P0's "Required freeze") — this release ships the access-control data model and API surface a future UI consumes, not the UI itself.

See also `R11_CONSENT_AND_REVOCATION.md`, `R11_PERMISSION_MATRIX.md`, `R11_RAW_DOCUMENT_GOVERNANCE.md`, `R11_SECURITY_MODEL.md`.
