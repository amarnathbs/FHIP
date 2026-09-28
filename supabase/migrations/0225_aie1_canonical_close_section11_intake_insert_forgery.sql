-- 0225 -- AIE-1 + Approved Upload -> Canonical Data FINAL PRODUCTION CLOSURE
-- MISSION, part 3, mission section 11 (AIE security controls): close the one
-- concrete, currently-open gap found this pass in the malware-scan-verdict
-- integrity control.
--
-- BACKGROUND. Migration 0196 added `aie_guard_malware_scan_verdict_columns()`,
-- a BEFORE INSERT OR UPDATE trigger that stops an `authenticated`-role caller
-- from setting/clearing `malware_scan_status` / `malware_scan_object_ref` /
-- `malware_scan_admission_deadline_at` / `malware_scan_decided_at` on
-- `fdh_statement_uploads` and `ii_source_documents`. 0196's own header
-- explicitly excludes `aie_document_intake`, reasoning only about the UPDATE
-- path: "the same live probe showed the authenticated role already cannot
-- update it (zero rows affected)". That reasoning is correct as far as it
-- goes (there genuinely is no UPDATE policy for `authenticated` on
-- `aie_document_intake` -- see 0140) but it never considered the INSERT path.
--
-- THE GAP (independently re-verified this session by reading 0140's own
-- INSERT policy, not merely re-asserted): `aie_document_intake`'s INSERT
-- policy is `with check (user_id = auth.uid())` only -- no column
-- restriction. An authenticated caller can therefore INSERT a brand-new row
-- directly via PostgREST with `malware_scan_status: 'clean'` (or any other
-- value in the vocabulary) from the very first write, which the sibling
-- tables' 0196 guard already prevents for an INSERT on THEM ("a row must
-- start as malware_scan_status 'not_required' with no object reference or
-- decision -- a client cannot create a row that claims to be pre-scanned").
-- `aie_document_intake` has never had that same protection.
--
-- SCOPE OF THIS FIX, HONESTLY STATED. This migration closes the verdict-forgery
-- gap on `aie_document_intake` at INSERT (and, matching 0196's own
-- defense-in-depth choice for its two tables, at UPDATE too, even though the
-- lack of an authenticated UPDATE policy already blocks that path today --
-- applying the trigger there as well costs nothing and survives a future
-- accidental policy widening). It does NOT independently re-derive or widen
-- the separate `storage_key`/`status` forgery question raised during this
-- session's investigation: `aie_document_intake.storage_key` already carries
-- its own table-level `unique` constraint (0140), which independently
-- prevents a second row from ever claiming another row's still-live storage
-- key (a duplicate insert would fail with `23505 unique_violation`), and
-- legitimate application code (`lib/aie/db/repository.ts`'s `createIntake`)
-- never sets `status` to anything but the column's own default ('received')
-- at insert time. Locking `status`/`storage_key` down further at the
-- database layer was considered and deliberately NOT done here to keep this
-- fix narrowly scoped to the one gap this session actually re-derived and
-- confirmed (the malware-verdict columns), matching the same one-fix-per-
-- confirmed-gap discipline as 0224's own two parts -- a broader
-- `status`/`storage_key` insert lockdown remains a disclosed, not-yet-acted-on
-- follow-up if a future session wants defense-in-depth there too.
--
-- WHY REUSE THE EXISTING FUNCTION. `aie_guard_malware_scan_verdict_columns()`
-- already contains a `TG_TABLE_NAME`-keyed branch for the one column
-- (`error_code`) that differs between `fdh_statement_uploads` and
-- `ii_source_documents`. `aie_document_intake` has no `error_code` column at
-- all, so no new branch is needed for that check -- the shared malware-column
-- INSERT/UPDATE guard applies unchanged. `CREATE OR REPLACE FUNCTION` here
-- is behaviour-preserving for the two tables 0196 already wired: the function
-- body is identical, only a third trigger attachment is added.
--
-- COLLISION CHECK: 0224 is the highest migration in this repo's
-- `supabase/migrations/` at the time this file was written; a full
-- `git ls-tree` sweep of every remote branch cached in this environment
-- found no `0225`-or-higher migration on any branch. Re-run that sweep
-- before this migration is ever applied, per this repo's own standing
-- migration-collision discipline.
--
-- PRODUCTION AUTHORITY: NONE. Drafted this session; NOT applied to DEV or
-- production. See the closure register / handoff for the exact apply
-- instructions.

CREATE OR REPLACE FUNCTION aie_guard_malware_scan_verdict_columns() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.malware_scan_status IS DISTINCT FROM 'not_required'
      OR NEW.malware_scan_object_ref IS NOT NULL
      OR NEW.malware_scan_admission_deadline_at IS NOT NULL
      OR NEW.malware_scan_decided_at IS NOT NULL
    THEN
      RAISE EXCEPTION '%: the malware-scan verdict may only be set by the server', TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.malware_scan_status IS DISTINCT FROM OLD.malware_scan_status
    OR NEW.malware_scan_object_ref IS DISTINCT FROM OLD.malware_scan_object_ref
    OR NEW.malware_scan_admission_deadline_at IS DISTINCT FROM OLD.malware_scan_admission_deadline_at
    OR NEW.malware_scan_decided_at IS DISTINCT FROM OLD.malware_scan_decided_at
  THEN
    RAISE EXCEPTION '%: the malware-scan verdict may only be changed by the server', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_NAME = 'fdh_statement_uploads' THEN
    IF OLD.error_code IN ('malware_detected','malware_scan_suspicious','malware_scan_failed','malware_scan_timeout','malware_scan_unknown')
      AND NEW.error_code IS DISTINCT FROM OLD.error_code
    THEN
      RAISE EXCEPTION 'fdh_statement_uploads: a malware-scan rejection may only be changed by the server'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION aie_guard_malware_scan_verdict_columns() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_aie_guard_malware_scan_verdict ON aie_document_intake;
CREATE TRIGGER trg_aie_guard_malware_scan_verdict
  BEFORE INSERT OR UPDATE ON aie_document_intake
  FOR EACH ROW EXECUTE FUNCTION aie_guard_malware_scan_verdict_columns();
