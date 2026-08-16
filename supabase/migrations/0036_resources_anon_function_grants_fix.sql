-- =============================================================================
-- Resources — R1.1 closure-pass fix: missing `anon` EXECUTE grants
-- =============================================================================
-- GENUINE DEFECT found during live R1.1 closure-pass testing, not a design
-- change: `anon` was never granted EXECUTE on private.is_resource_staff or
-- private.can_manage_resources. Postgres requires the querying role to hold
-- EXECUTE on every function referenced in ANY RLS policy attached to a
-- table it queries — even a policy that evaluates false for that role — so
-- every anonymous SELECT against resource_posts (and every table joined to
-- it) was failing outright with "permission denied for function
-- is_resource_staff" instead of correctly returning the public rows. This
-- broke the single most basic public-read case (§13 of the closure brief).
--
-- The RLS policy logic itself was already correct — anon was never at risk
-- of seeing a draft or unpublished row; the bug made public reads fail
-- closed (an outage-class bug) rather than fail open (a security bug), but
-- it is still a genuine defect that must be fixed before FULL PASS.

grant execute on function private.can_manage_resources(uuid) to anon;
grant execute on function private.is_resource_staff(uuid) to anon;
