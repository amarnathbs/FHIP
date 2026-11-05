-- READ ONLY. Step 4: the answer to the dry run. Wait about 60 seconds after step 3. Paste the whole row back to me (it holds counts, outcomes and
-- reasons only: no page text, no secret). Expected: status_code 200, mode dry_run, and for the T-bill either the 04-11-2026 auction result as a
-- publish or no_release_yet, with nothing written. A 401 means the vault secret and the app secret differ: do NOT go on, send it to me.
select id, status_code, timed_out, error_msg, content
  from net._http_response
 order by created desc
 limit 1;
