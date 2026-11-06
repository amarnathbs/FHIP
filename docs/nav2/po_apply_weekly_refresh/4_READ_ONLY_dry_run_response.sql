-- READ ONLY. Step 4: the answer to the dry run. Wait about 60 seconds after step 3. Paste the whole row back to me (it holds counts, outcomes and
-- reasons only: no page text, no secret). Several other scheduled jobs write to the same response table every minute, so this picks out ONLY the
-- answer of the refresh job by its version text. If it returns no row, wait another 30 seconds and run it again.
-- Expected: status_code 200, mode dry_run, and for the T-bill either the 04-11-2026 auction result as a publish or no_release_yet, with nothing
-- written. mode skipped_kill_switch means step 2 has not been run. A 401 means the vault secret and the app secret differ: do NOT go on.
select id, status_code, timed_out, error_msg, content
  from net._http_response
 where strpos(content, 'nav2-risk-free-refresh-job') > 0
 order by created desc
 limit 1;
