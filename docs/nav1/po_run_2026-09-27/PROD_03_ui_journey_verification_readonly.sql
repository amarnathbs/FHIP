-- =============================================================================
-- NAV 1 (2026-09-27) -- PRODUCTION, READ-ONLY verification for the 18-point UI
-- journey (docs/nav1/NAV1_Production_Final_Certification_2026-09-27.md, P4).
-- Every statement is a SELECT (V18 runs inside a transaction that ROLLS BACK).
--
-- BEFORE RUNNING: replace every occurrence of the token
--     nav1-p4-user-a@fhip-synthetic.test   (the dedicated synthetic user A)
--     nav1-p4-user-b@fhip-synthetic.test   (the second synthetic user B, V18)
-- with the addresses you actually registered, if different. These queries
-- only ever return the synthetic users' own synthetic data.
-- Statement files: lib/fixtures/investment-intelligence/nav1-p4-ui-journey/
--   nav1-p4-main.pdf        (PPFAS 122639 current holding + SBI 103504 fully redeemed)
--   nav1-p4-unresolved.pdf  (AMFI 999999 / INF999Z99ZZ9 -- exists nowhere)
-- =============================================================================

-- V0 baseline, run BEFORE the upload: holds / floors / attempts / held count.
select (select count(*) from ii_nav_retention_holds) as holds_total,
       (select count(*) from ii_nav_history_floors) as floors_total,
       (select count(*) from ii_nav_hydration_attempts) as attempts_total,
       (select count(*) from pc6_user_held_instrument_ids()) as held_instruments,
       now() as at;

-- V3/V4/V8 documents: one row per distinct upload; scan / admission columns shown generically.
with u as (select id from auth.users where email = 'nav1-p4-user-a@fhip-synthetic.test')
select d.id, d.status, d.document_type, d.source_detected, d.source_confidence, left(d.checksum, 12) as checksum12,
       d.uploaded_at, d.parse_completed_at, left(d.parse_error, 120) as parse_error,
       (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(d)) where k like '%scan%' or k like '%admission%' or k like '%malware%') as scan_columns
from ii_source_documents d join u on d.user_id = u.id
order by d.uploaded_at;

-- V5 the PRODUCTION parser ran (parser_code is a real CAMS parser, not a stub).
with u as (select id from auth.users where email = 'nav1-p4-user-a@fhip-synthetic.test')
select r.source_document_id, r.parser_code, r.parser_version, r.run_status, r.source_detected, r.source_confidence,
       r.accounts_found, r.schemes_found, r.transactions_found, r.holdings_found, r.errors
from ii_document_parse_runs r join u on r.user_id = u.id
order by r.started_at;

-- V6/V7 resolution + interpretation: each transaction resolved to the genuine
-- instrument (AMFI code + ISIN agree with the scheme master), with the
-- statement's date / units / NAV / amount. Expect 9 rows (6 PPFAS + 3 SBI) for
-- the main statement: 122639/INF879O01027 and 103504/INF200K01180.
with u as (select id from auth.users where email = 'nav1-p4-user-a@fhip-synthetic.test')
select t.source_reference, t.transaction_type, t.transaction_date, t.units, t.price_per_unit, t.gross_amount, t.status,
       sm.amfi_scheme_code, sm.isin_growth_or_payout, i.status as instrument_status
from ii_transactions t join u on t.user_id = u.id
left join ii_scheme_master sm on sm.instrument_id = t.instrument_id
left join ii_instruments i on i.id = t.instrument_id
order by t.source_reference;

-- V8/V11 written exactly once: expect zero rows.
with u as (select id from auth.users where email = 'nav1-p4-user-a@fhip-synthetic.test')
select t.source_reference, count(*) from ii_transactions t join u on t.user_id = u.id
group by t.source_reference having count(*) > 1;

-- V9 the deliberately unresolved row: a reconciliation case / review item, or a
-- provisional instrument -- never a silent resolution to a real scheme.
with u as (select id from auth.users where email = 'nav1-p4-user-a@fhip-synthetic.test')
select c.subject_type, c.status, c.discrepancy_type, c.severity, c.opened_at, c.resolved_at
from ii_reconciliation_cases c join u on c.user_id = u.id
order by c.opened_at;

-- V10/V12/V13 certification and the 0168 hold: one OPEN hold per CERTIFIED
-- instrument (reason statement_reconciliation_in_progress, ~30 days), and no
-- hold on an instrument this user has not certified.
with u as (select id from auth.users where email = 'nav1-p4-user-a@fhip-synthetic.test'),
ts as (select s.instrument_id, s.status, s.history_completeness from ii_portfolio_truth_status s join u on s.user_id = u.id)
select sm.amfi_scheme_code, ts.status, ts.history_completeness,
       (select count(*) from ii_nav_retention_holds h where h.instrument_id = ts.instrument_id and h.released_at is null) as open_holds,
       (select max(h.reason) from ii_nav_retention_holds h where h.instrument_id = ts.instrument_id) as hold_reason,
       (select round(extract(epoch from max(h.expires_at) - now()) / 86400) from ii_nav_retention_holds h where h.instrument_id = ts.instrument_id and h.released_at is null) as hold_days_left
from ts left join ii_scheme_master sm on sm.instrument_id = ts.instrument_id
order by 1;

-- V14 publication / recompute: FHIP publications for the user's positions.
with u as (select id from auth.users where email = 'nav1-p4-user-a@fhip-synthetic.test')
select p.publication_target, p.status, p.include_in_net_worth, p.published_value, p.published_at, left(p.failure_reason, 120) as failure_reason
from ii_fhip_publications p join u on p.user_id = u.id
order by p.published_at;

-- V15 hydration picked the new schemes up (next :00/:30 tick after certification):
-- floors recorded at each fund's first AMFI NAV (122639 -> 2013-05-28 expected;
-- 103504 -> 2006-04-03 expected), attempts recorded, 0 NAV rows written.
select sm.amfi_scheme_code, f.floor_date, f.confirmed_at, a.last_outcome, a.attempts_total, a.last_attempted_at
from ii_scheme_master sm
left join ii_nav_history_floors f on f.instrument_id = sm.instrument_id
left join ii_nav_hydration_attempts a on a.instrument_id = sm.instrument_id
where sm.amfi_scheme_code in ('122639', '103504');

-- V16 the stored NAV range covers the first transaction to today (XIRR/TWRR input).
select sm.amfi_scheme_code, min(p.price_date) as first_nav, max(p.price_date) as last_nav, count(*) as nav_rows,
       count(*) filter (where p.price_date between date '2023-04-03' and date '2026-09-18') as rows_in_holding_period
from ii_scheme_master sm join ii_prices_nav p on p.instrument_id = sm.instrument_id
where sm.amfi_scheme_code in ('122639', '103504')
group by 1;

-- V17 report pinning: a finalized report for user A writes NAV dependencies.
with u as (select id from auth.users where email = 'nav1-p4-user-a@fhip-synthetic.test')
select d.basis, sm.amfi_scheme_code, d.nav_date_from, d.nav_date_to, d.created_at
from ii_report_nav_dependencies d
join ii_scheme_master sm on sm.instrument_id = d.instrument_id
where sm.amfi_scheme_code in ('122639', '103504')
order by d.created_at;

-- V18 isolation at the database layer (the UI/API half is checkpoint 18 in the
-- runbook): as user B, row-level security must show ZERO of user A's rows.
-- Runs as the 'authenticated' role with B's JWT subject, then ROLLS BACK.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'nav1-p4-user-b@fhip-synthetic.test')::text, 'role', 'authenticated')::text, true);
set local role authenticated;
select (select count(*) from ii_source_documents) as docs_visible_to_b,
       (select count(*) from ii_transactions) as txns_visible_to_b,
       (select count(*) from ii_portfolio_truth_status) as truth_visible_to_b,
       (select count(*) from ii_document_parse_runs) as parse_runs_visible_to_b;
rollback;
-- Expected: every count 0 (user B has uploaded nothing).
