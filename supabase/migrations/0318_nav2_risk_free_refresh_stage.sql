-- 0318 -- NAV2 weekly RBI refresh: a small scratch table so the refresh can run as three short requests instead of one long one.
--
-- WHY. The first real production dry run of the weekly refresh (09-11-2026) answered HTTP 504 with no body. Amplify ends every request at
-- 28 seconds whatever the route declares, and one run of robots.txt plus the month listing plus the release plus the weekly page, paced politely
-- over a slow site, does not fit. The job now runs as three steps, each its own short request (listing, then release, then decide). Each step
-- remembers what it read here so the next one does not need the page again.
--
-- WHAT IS KEPT. One row per expected auction date. The evidence column holds numbers and pointers only: where the release is, the figures read
-- off it, the robots.txt rules, request counts. No page text is ever stored.
--
-- Forward-only, additive, idempotent. No rate row, review item or setting is touched. The table is only ever read and written by the service
-- role (the cron route): row level security is on and no policy is created, and anon and authenticated have no rights on it.
--
-- EDITOR SAFETY. ASCII only. No bare dollar quote. No semicolon or quote inside a comment. No percent sign.
--
-- ROLLBACK: drop table ii_risk_free_refresh_stage. Nothing else depends on it.

create table if not exists ii_risk_free_refresh_stage (
  expected_auction_date date primary key,
  -- the last step that finished: the listing step, or the release step (which also covers a week with nothing to fetch)
  step text not null check (step in ('listing_done', 'release_done')),
  evidence jsonb not null,
  -- no RBI request is made for this auction before this time (after a refusal, or when the release is not out yet)
  retry_not_before timestamptz,
  -- set only by a live decide step that finished: the week is done and later runs do nothing
  decided_live_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ii_risk_free_refresh_stage enable row level security;
revoke all on ii_risk_free_refresh_stage from anon, authenticated;
