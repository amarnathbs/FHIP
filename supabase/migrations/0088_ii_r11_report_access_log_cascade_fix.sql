-- Investment Intelligence R11 -- close a real user-deletion failure on
-- professional_report_access_log, found live during R11's terminal-closure
-- professional-access live-DEV test cleanup (2026-08-25).
--
-- FINDING: migration 0083 declared professional_report_access_log.
-- professional_user_id and client_user_id as
-- `references auth.users(id)` WITHOUT `on delete cascade` (every other
-- user-scoped column across every professional_* table in 0083 DOES carry
-- the cascade -- this was a genuine oversight on these two columns only,
-- inconsistent with the rest of the same migration file). The row's OTHER
-- foreign key, relationship_id -> professional_relationships(id), DOES
-- cascade, and professional_relationships' own client_user_id/
-- professional_user_id also cascade from auth.users -- so in the common
-- case a full user deletion cascades relationship -> log row correctly.
-- The failure mode reproduced live here is narrower but real: attempting
-- to delete an auth.users row directly while a professional_report_access_
-- log row still names that user as professional_user_id/client_user_id
-- (regardless of whether its relationship_id parent has already been
-- independently deleted, or the deletion ordering means the direct FK
-- check runs before the transitive cascade completes) raises a genuine
-- foreign-key violation and the deletion fails outright -- reproduced via
-- Supabase's admin deleteUser() API returning a wrapped 500
-- AuthRetryableFetchError for two real test users in this exact scenario.
-- This would affect any REAL account-deletion flow (e.g. a future GDPR
-- "delete my account" feature) for any client or professional who ever had
-- a report access logged.
--
-- FIX: add the same `on delete cascade` every other user-scoped column in
-- 0083 already carries. Purely additive (drop + re-add both FK
-- constraints); no data loss, no column/table shape change, no RLS change.
-- Does not touch 0082/0083/0086/0087 (all frozen/already-shipped).

alter table professional_report_access_log
  drop constraint professional_report_access_log_professional_user_id_fkey,
  add constraint professional_report_access_log_professional_user_id_fkey
    foreign key (professional_user_id) references auth.users(id) on delete cascade;

alter table professional_report_access_log
  drop constraint professional_report_access_log_client_user_id_fkey,
  add constraint professional_report_access_log_client_user_id_fkey
    foreign key (client_user_id) references auth.users(id) on delete cascade;
