# FDH-8 — Production Certification

**STATUS: PENDING HUMAN ACTION.** Nothing in this document was performed against the production environment — no production database or deployment access exists for this task, per the standing orchestration constraints, and no push/merge/deploy was attempted.

## What is true today

- No migration was added by FDH-8 (confirmed: `git status --short supabase/migrations/` empty on this branch; see `FDH8_REUSE_AND_GAP_AUDIT.md` "Genuinely new schema/migration" section). This means, unusually for an FHIP phase, **there is no production migration-application step required for FDH-8 specifically** — production's schema already has everything FDH-8 reads (`fdh_transactions.approval_status` etc. shipped with FDH-7's migration 0076, already noted elsewhere as pending production application from that earlier phase, not a new gap FDH-8 creates).
- FDH-8 ships only application code (new files under `lib/financial-data-hub/analytics/`, `app/api/financial-data-hub/activity/`, `app/(app)/financial-data-hub/activity/`, plus one additive nav entry). No existing file's production behaviour changes unless a human deploys this branch.

## What remains, in order, before FDH-8 can be considered production-certified

1. **Human review and merge approval.** This branch is not merged to `main` by this task, per standing constraint.
2. **Deploy.** Per the established process (Amplify auto-deploys on push to `main`), a push to `main` triggers deployment — not performed here.
3. **Production verification**, only after step 2, by a human or a subsequent task with production access:
   - Confirm the new routes (`/financial-data-hub/activity`, `/financial-data-hub/activity/{transactions,spending,income,recurring,accounts}`, and the 8 new API routes) resolve in production.
   - Because FDH-7's own migration 0076 (`approval_status` etc.) was, as of the last recorded closure, still pending production application in some earlier account of this program's state — verify that column set is actually live in production BEFORE relying on FDH-8's production behaviour; if it is not yet applied, FDH-8's production API routes would fail rather than silently miscompute (they select `approval_status` explicitly and would error on an unknown column, not return wrong totals) — a human should confirm this ordering.
   - Re-run the `.next/static` service-role-key/admin-client scan against the actual production build artifact.
   - Spot-check one real (or synthetic, with the user's consent) approved statement's Overview totals against the existing FDH-7 Approved Financial Summary UI for the same statement, to confirm the two agree exactly (they should, since FDH-8 calls the same oracle function).

## Explicit non-claim

This document does **not** assert production correctness. It exists to make the remaining steps concrete and checkable, per spec section 137-140's instruction to prepare — not perform — this certification.
