-- R1 complete rollback of migrations 0272, 0273 and 0274: removes every database object the bulk upload added.
-- It touches NO existing table. Drafts that were already created stay, because they are ordinary Resources.
-- Only the upload history and the staged rows are lost. Run R2 first if you only want to stop uploads.
-- Order matters: functions first, then the child table, then its parent, then the helper.

drop function if exists public.apply_resource_content_import_as_actor(uuid, uuid);
drop function if exists public.apply_resource_content_import(uuid);
drop function if exists private.apply_resource_content_import_core(uuid, uuid);
drop function if exists public.resource_content_import_lookup(text[], text[], text[]);
drop function if exists public.purge_expired_resource_content_import_staging();
drop table if exists public.resource_content_import_rows;
drop table if exists public.resource_content_import_runs;
drop function if exists private.can_bulk_import_resource_content(uuid);
