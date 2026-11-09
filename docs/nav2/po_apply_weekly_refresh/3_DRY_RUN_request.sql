-- Step 3. Sends ONE dry run request to the app. The app does ONE of its three short steps per request (listing, then release, then decide), so run
-- this file THREE times, each time in a new tab or after a wait of at least a minute, and look at each answer with 4b before sending the next one.
-- A dry run reads RBI politely and writes NO rate and NO review item. Its only write is a scratch row that hands the readings to the next step.
-- The secret never leaves the database.
select net.http_post(
  url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/nav2-risk-free-refresh',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 90000
) as request_id;
