-- Investment Intelligence -- ii_holding_snapshots same-user authoritative-
-- forgery hotfix. STANDALONE SECURITY FIX, extracted from migration 0092.
--
-- WHY THIS EXISTS AS ITS OWN MIGRATION, SEPARATE FROM 0092:
-- 0092 ("II R12 -- Wider India Assets") bundles this genuine security fix
-- together with unrelated R12 feature schema (a widened
-- ii_transactions.transaction_type constraint, a new
-- ii_holding_snapshots.price_source column, a widened
-- ii_scheme_tax_classification.basis constraint). R12's own feature
-- certification is not yet complete (41/200 deterministic cases, 6/25 live
-- DEV cases at time of writing) and R12's application code is not yet
-- production-ready. The security defect below, by contrast, is fully
-- certified (PGlite negative control + live-DEV reproduction against the
-- real DEV database, both independently reproduced) and affects an
-- ALREADY-LIVE production table -- shipping it should not wait on R12's
-- unrelated feature timeline. This migration is the exact security-only
-- subset of 0092's section 1, verbatim, with no dependency whatsoever on
-- 0092's other three sections (does not read/write price_source, does not
-- reference the widened transaction_type or basis constraints -- confirmed
-- by inspection, this file touches only ii_holding_snapshots' policy).
--
-- 0092 itself is NOT modified, edited, or renumbered by this file -- it
-- remains exactly as committed (already merged to main). Applying 0092 in
-- full at a later date (when R12 ships) will re-run this same
-- drop-policy/create-policy pair -- both statements are idempotent
-- (`drop policy if exists`, unconditional `create policy`), so re-applying
-- it is safe and produces byte-identical end state, not a conflict.
--
-- THE DEFECT (found live during R12's own P0 architecture discovery, not
-- hypothetical -- the same defect class 0087 fixed on ii_transactions/
-- ii_reconciliation_cases, 0069 fixed on ii_review_items, 0065 fixed on
-- fdh_statement_uploads): ii_holding_snapshots' original RLS policy was
-- `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)`
-- -- row ownership was enforced, but every column on an owned row was
-- freely writable by the owning user, including current_value/units, which
-- are meant to be exclusively system/engine-authoritative (derived from
-- statement parsing or admin-client recomputation, never a direct user
-- edit). Live-DEV reproduction (today, real synthetic users, real JWTs,
-- real PostgREST, cleaned up after): an authenticated owner PATCHed their
-- own holding snapshot's value to 999999999 -- HTTP 200, genuinely
-- persisted, then restored via service role.
--
-- THE FIX: a full grep of app/ + lib/ for .insert(/.update(/.upsert(
-- against 'ii_holding_snapshots' finds ZERO authenticated-client call
-- sites -- every real write goes through createAdminClient() in
-- manualImporter.ts / documentProcessing.ts / investmentPublicationService.ts.
-- There is no legitimate authenticated write path to carve an exception
-- for (unlike ii_reconciliation_cases in 0087, which needed a narrower
-- UPDATE policy for one real user-facing resolution action). Replaced with
-- SELECT-only for the owner -- no INSERT/UPDATE/DELETE policy for
-- authenticated at all, matching 0087's ii_transactions shape exactly.

begin;

drop policy if exists "own ii_holding_snapshots" on ii_holding_snapshots;
create policy "read own ii_holding_snapshots" on ii_holding_snapshots
  for select using (auth.uid() = user_id);
-- No insert/update/delete policy for authenticated at all -- every write is
-- exclusively via the service-role admin client, verified above; RLS
-- refuses any authenticated write outright, matching ii_transactions'
-- identical post-0087 write model.

commit;
