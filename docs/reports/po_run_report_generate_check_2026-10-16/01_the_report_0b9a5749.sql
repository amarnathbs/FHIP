-- READ ONLY. Run in the production SQL editor. Nothing here changes data.
-- Question answered: was report 0b9a5749-64a5-4268-9f00-c55228424836 saved complete, or is it a cover page with no sections?
-- Each statement is run on its own (select it, then Run). No personal data is returned.

-- 1. The report row: status, version, the month it covers, and whether a failure was recorded.
select r.id, r.status, r.version_number, r.revises_report_id, r.report_month, r.as_of_date,
       r.created_at, r.generated_at, r.failure_code, r.data_completeness_pct, r.reporting_currency
  from reports r
 where r.id = '0b9a5749-64a5-4268-9f00-c55228424836';

-- 2. How many sections were saved for it, and how big each one is (bytes of stored data, no content shown).
--    ZERO rows here means the report was saved as an empty shell.
select s.display_order, s.section_code, s.section_status,
       pg_column_size(s.section_data_json) as data_bytes,
       length(coalesce(s.narrative_text, '')) as narrative_characters
  from report_sections s
 where s.report_id = '0b9a5749-64a5-4268-9f00-c55228424836'
 order by s.display_order;

-- 3. The same, as one line: number of sections and total stored bytes.
select count(*) as section_count,
       coalesce(sum(pg_column_size(s.section_data_json)), 0) as total_data_bytes,
       coalesce(max(pg_column_size(s.section_data_json)), 0) as largest_section_bytes
  from report_sections s
 where s.report_id = '0b9a5749-64a5-4268-9f00-c55228424836';
