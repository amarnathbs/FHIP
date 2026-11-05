-- Step 3. Sends ONE dry run request to the app. The app reads RBI (one listing page, the release, and the policy-rate page), decides what it would
-- do, and WRITES NOTHING. The secret never leaves the database. Run once, wait about 60 seconds, then run 4_READ_ONLY_dry_run_response.sql.
select net.http_post(
  url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/nav2-risk-free-refresh',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 90000
) as request_id;
