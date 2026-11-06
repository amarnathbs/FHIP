-- READ ONLY. Step 4b: the answer to ONE request, found by the number that step 3 returned. Change the 0 on the last line to that number and run it.
-- With the 0 left as it is, this returns no row and is harmless. Wait about 90 seconds after step 3 first. Paste the whole row back to me.
-- A row with mode dry_run is the answer. A row with timed_out true or a status above 299 is a failure: paste it as it is.
-- No row yet means the answer has not arrived: wait 30 seconds and run it again.
select id, status_code, timed_out, error_msg, left(content, 2500) as content_start
  from net._http_response
 where id = 0;
