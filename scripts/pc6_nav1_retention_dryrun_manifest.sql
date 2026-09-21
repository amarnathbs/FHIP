-- NAV 1.42 — retention dry run and candidate manifest.
--
-- READ-ONLY. Every statement below is a SELECT. There is no UPDATE, DELETE,
-- or DDL anywhere in this file. Running it against DEV or production is
-- safe at any time and changes nothing.
--
-- PREREQUISITE: migration 0166_nav1_selective_retention_foundation.sql must
-- be applied first (it creates pc6_nav_row_is_candidate() and the
-- ii_nav_retention_holds/ii_nav_retention_policy tables this query reads).
--
-- PURPOSE: produce the bounded candidate manifest the workbook's Stage D
-- requires ("Generate a bounded candidate manifest and independently prove
-- zero overlap with protected data") BEFORE any deletion is proposed. This
-- is evidence to review, not an execution step. Per the explicit scope
-- boundary of this dispatch: do not proceed to any DELETE statement based on
-- this manifest without a separate, later, explicit go-ahead — see
-- docs/investment-intelligence/NAV1_PROGRESS_LEDGER.md, NAV 1.42/1.43.
--
-- USAGE:
--   1. Run section 1 first (total row/instrument counts) to size the
--      problem before running the heavier per-row scan in section 2.
--   2. Confirm the changeover date literal below (:changeover_date) matches
--      the actual ii_nav_retention_policy row for the target environment
--      before trusting the output — this file hard-codes 2026-09-21 (the PO
--      decision recorded in this programme) as a safety default, not a
--      substitute for reading the live policy row.
--   3. Section 3's zero-overlap check MUST show zero rows before Stage E is
--      even discussed. A non-zero result there means the candidate set
--      overlaps a protected row and the manifest is not safe to act on.

-- ---------------------------------------------------------------------------
-- 0. Confirm the active policy row this manifest should be evaluated against.
-- ---------------------------------------------------------------------------
select policy_version, changeover_date, environment, activated_at
from ii_nav_retention_policy
order by activated_at desc;

-- ---------------------------------------------------------------------------
-- 1. Headline sizing: total ii_prices_nav rows vs. candidate rows, and how
--    many distinct instruments are affected. Run this BEFORE section 2 on
--    production — section 2 evaluates the policy function per row and will
--    be slow at tens of millions of rows without the instrument-level
--    pre-filter section 1 gives you.
-- ---------------------------------------------------------------------------
with policy as (
  select coalesce(
    (select changeover_date from ii_nav_retention_policy where environment = current_setting('nav1.target_env', true) order by activated_at desc limit 1),
    date '2026-09-21' -- safety default; see USAGE note 2 above
  ) as c
)
select
  count(*) as total_nav_rows,
  count(*) filter (where pc6_nav_row_is_candidate(instrument_id, price_date, (select c from policy))) as candidate_rows,
  count(distinct instrument_id) as total_instruments,
  count(distinct instrument_id) filter (where pc6_nav_row_is_candidate(instrument_id, price_date, (select c from policy))) as instruments_with_any_candidate_row
from ii_prices_nav;

-- ---------------------------------------------------------------------------
-- 2. Per-instrument candidate manifest: how many candidate rows per
--    instrument, and their date span, joined back to the scheme identity so
--    a human reviewer can recognise what is actually being proposed for
--    cleanup (never just an opaque instrument_id list).
-- ---------------------------------------------------------------------------
with policy as (
  select coalesce(
    (select changeover_date from ii_nav_retention_policy where environment = current_setting('nav1.target_env', true) order by activated_at desc limit 1),
    date '2026-09-21'
  ) as c
),
candidate_rows as (
  select instrument_id, price_date
  from ii_prices_nav p, policy
  where pc6_nav_row_is_candidate(p.instrument_id, p.price_date, policy.c)
)
select
  sm.amfi_scheme_code,
  sm.scheme_name,
  sm.lifecycle_status,
  count(*) as candidate_row_count,
  min(cr.price_date) as candidate_earliest_date,
  max(cr.price_date) as candidate_latest_date,
  exists (select 1 from ii_portfolio_truth_status pts where pts.instrument_id = cr.instrument_id) as has_any_portfolio_truth_row,
  exists (select 1 from ii_instrument_benchmarks ib where ib.instrument_id = cr.instrument_id) as has_any_benchmark_mapping
from candidate_rows cr
left join ii_scheme_master sm on sm.instrument_id = cr.instrument_id and sm.effective_to is null
group by cr.instrument_id, sm.amfi_scheme_code, sm.scheme_name, sm.lifecycle_status
order by candidate_row_count desc;

-- ---------------------------------------------------------------------------
-- 3. Zero-overlap proof: candidate rows that ALSO satisfy a protected
--    condition would indicate a bug in pc6_nav_row_is_candidate() or a data
--    change since the function was evaluated (a TOCTOU race — see the
--    workbook's "Race prevention" and ii_nav_retention_holds). This MUST
--    return zero rows before any manifest is trusted.
-- ---------------------------------------------------------------------------
with policy as (
  select coalesce(
    (select changeover_date from ii_nav_retention_policy where environment = current_setting('nav1.target_env', true) order by activated_at desc limit 1),
    date '2026-09-21'
  ) as c
)
select p.instrument_id, p.price_date, 'post_changeover' as would_be_protected_reason
from ii_prices_nav p, policy
where pc6_nav_row_is_candidate(p.instrument_id, p.price_date, policy.c)
  and p.price_date >= policy.c
union all
select p.instrument_id, p.price_date, 'has_certified_portfolio_truth_row'
from ii_prices_nav p, policy
where pc6_nav_row_is_candidate(p.instrument_id, p.price_date, policy.c)
  and exists (
    select 1 from ii_portfolio_truth_status pts
    where pts.instrument_id = p.instrument_id and pts.status in ('certified', 'certified_with_warnings')
  )
union all
select p.instrument_id, p.price_date, 'active_retention_hold'
from ii_prices_nav p, policy
where pc6_nav_row_is_candidate(p.instrument_id, p.price_date, policy.c)
  and exists (
    select 1 from ii_nav_retention_holds h
    where h.instrument_id = p.instrument_id and h.released_at is null and (h.expires_at is null or h.expires_at > now())
  );
-- Expected result: 0 rows. (The last two checks are deliberately redundant
-- with pc6_nav_row_is_candidate()'s own logic -- this section exists to
-- catch a REGRESSION in that function, not to re-derive its answer.)
