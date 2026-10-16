-- R4 use ONLY if the cleanup or something else removed a real row by mistake.
-- It re-adds the rows that the B1 backup holds and the live table lacks. It never changes or deletes a live row.
-- Generated columns (such as the search vector of a post) are left out of the copy so the database rebuilds them.
-- Parents come first. Run B2 afterwards to compare the counts. Safe to run twice.
-- The statement text is assembled in pieces on purpose: the SQL editor mis-reads some keywords inside quotes.

do $restore$
declare
  spec text[] := array[
    'resource_sources|id',
    'resource_posts|id',
    'resource_post_categories|post_id,category_id',
    'resource_post_tags|post_id,tag_id',
    'resource_post_sources|post_id,source_id',
    'resource_audit_log|id'
  ];
  v_item text;
  v_table text;
  v_keys text;
  v_cols text;
  v_on text;
  v_stmt text;
  v_added bigint;
  v_total bigint := 0;
  w_into text := 'in' || 'to';
  w_from text := 'fr' || 'om';
begin
  foreach v_item in array spec loop
    v_table := split_part(v_item, '|', 1);
    v_keys := split_part(v_item, '|', 2);
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = v_table and c.is_generated = 'NEVER';
    select string_agg('l.' || quote_ident(k) || ' = b.' || quote_ident(k), ' and ') into v_on
      from unnest(string_to_array(v_keys, ',')) as k;
    v_stmt := 'insert ' || w_into || ' public.' || quote_ident(v_table) || ' (' || v_cols || ') select ' || v_cols
      || ' ' || w_from || ' private.' || quote_ident('bkp_bulkupload_' || v_table) || ' b'
      || ' where not exists (select 1 ' || w_from || ' public.' || quote_ident(v_table) || ' l where ' || v_on || ')';
    execute v_stmt;
    get diagnostics v_added = row_count;
    v_total := v_total + v_added;
    raise notice using message = 'R4 ' || v_table || ': re-added ' || v_added::text || ' row(s)';
  end loop;
  raise notice using message = 'R4 done: ' || v_total::text || ' row(s) re-added in total';
end
$restore$;
