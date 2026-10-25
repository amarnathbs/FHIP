-- WP-J / Document2 (4) -- UNDO of 08, only if you need it. Puts the saved status, time and reason back on exactly the rows 08 saved.
-- Run on its own, on purpose. Needs the backup table made by block A of 08.

update ii_document_parse_runs r
   set run_status = b.run_status,
       completed_at = b.completed_at,
       errors = b.errors
  from ii_document_parse_runs_backup_wpj_20261025 b
 where b.id = r.id;

select r.run_status, count(*) as runs
  from ii_document_parse_runs r
  join ii_document_parse_runs_backup_wpj_20261025 b on b.id = r.id
 group by r.run_status;
