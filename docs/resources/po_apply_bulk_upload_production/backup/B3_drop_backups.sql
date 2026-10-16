-- B3 remove the manual backup copies made by B1. Run it only when you are satisfied that the verification and the
-- cleanup are finished and B2 shows equal counts (the copies take space and the database is over its plan size).
drop table if exists private.bkp_bulkupload_resource_posts;
drop table if exists private.bkp_bulkupload_resource_post_categories;
drop table if exists private.bkp_bulkupload_resource_post_tags;
drop table if exists private.bkp_bulkupload_resource_sources;
drop table if exists private.bkp_bulkupload_resource_post_sources;
drop table if exists private.bkp_bulkupload_resource_audit_log;
