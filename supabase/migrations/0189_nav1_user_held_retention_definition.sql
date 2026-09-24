-- NAV 1 Stage D (D.1 + D.2) — one shared definition of "held by a user",
-- used by BOTH retention and hydration.
--
-- THE DEFECT THIS FIXES. Up to and including 0172, pc6_nav_row_is_candidate()
-- protected an instrument's history only if it had a CERTIFIED portfolio-
-- truth statement (status in 'certified', 'certified_with_warnings'). In
-- production no statement has ever certified: on 2026-09-24 all 51 rows sat
-- at 'reconciliation_required'. Calling the function on production for each
-- of the 17 instruments that real users hold returned CANDIDATE for all 17 --
-- a Stage E deletion would have removed 77,039 rows of history that those
-- users' XIRR, TWR and rolling returns read.
--
-- The hydration job's dependency query carried the identical filter, so the
-- other half was broken the same way: after a deletion, a user uploading a
-- statement containing a deleted scheme would never have had its history
-- fetched back.
--
-- THE RULE NOW (PO decision, 2026-09-24): keep the ENTIRE pre-changeover
-- history of any instrument a user holds or has ever held, regardless of
-- statement status. Delete everything else before the changeover date.
-- Fetch history on demand when a user brings a scheme not already stored.
--
-- WHY THE WHOLE HISTORY, NOT A WINDOW. 0172 kept only a history_completeness-
-- derived window (e.g. from the first transaction onward). That window was
-- only ever computed for certified statements, and a user's returns can need
-- history from before their own first transaction (rolling-return lookbacks,
-- benchmark comparison). Keeping everything for held instruments costs
-- ~77k rows across 17 instruments in production today -- negligible -- and
-- matches hydration, which already fetches from inception when no window is
-- given.
--
-- WHAT "HELD" MEANS. An instrument appears in ANY user-scoped ii_* table that
-- carries instrument_id. As of this migration that is exactly seven tables,
-- and they are the only tables anywhere in the schema that reference
-- ii_instruments on a user's behalf (all 28 references to ii_instruments are
-- inside ii_*):
--   ii_transactions, ii_holding_snapshots, ii_portfolio_truth_status,
--   ii_tax_lots, ii_sip_series, ii_capital_gains_computations,
--   ii_fhip_publications
-- Deliberately inclusive: a REVERSED transaction still counts, and so does a
-- statement in any status. Over-keeping a few rows is cheap and recoverable;
-- under-keeping deletes a user's history.
--
-- TWO FUNCTIONS, ONE DEFINITION. Retention needs a per-row boolean that is
-- cheap over ~22M rows (EXISTS probes, index-backed); hydration needs the
-- set. They are written separately for that reason, and
-- scripts/nav1_0189_pglite_verification.mjs asserts that (a) they agree for
-- every instrument, and (b) the set of user-scoped ii_* tables derived from
-- information_schema is exactly the set both functions consult -- so adding
-- a new user-scoped table later fails that check until it is included here.
--
-- WHAT IS UNCHANGED. Every row on/after the changeover date is still KEEP
-- (daily collection). Benchmark mappings, report pins and open retention
-- holds still protect exactly as in 0172.
--
-- SECURITY. Both functions are SECURITY INVOKER, like 0172's. Retention and
-- hydration run with the service role, which sees every user's rows. Any
-- other caller is bounded by RLS and learns only about its own holdings.

create or replace function pc6_instrument_is_user_held(p_instrument_id uuid)
returns boolean
language sql stable as $$
  select exists (select 1 from ii_transactions               where instrument_id = p_instrument_id)
      or exists (select 1 from ii_holding_snapshots          where instrument_id = p_instrument_id)
      or exists (select 1 from ii_portfolio_truth_status     where instrument_id = p_instrument_id)
      or exists (select 1 from ii_tax_lots                   where instrument_id = p_instrument_id)
      or exists (select 1 from ii_sip_series                 where instrument_id = p_instrument_id)
      or exists (select 1 from ii_capital_gains_computations where instrument_id = p_instrument_id)
      or exists (select 1 from ii_fhip_publications          where instrument_id = p_instrument_id);
$$;

comment on function pc6_instrument_is_user_held(uuid) is
  'NAV 1 (0189). True if any user holds or has ever held this instrument, in any user-scoped ii_* table, '
  'regardless of statement status. The single definition retention and hydration share; must agree with '
  'pc6_user_held_instrument_ids().';

-- Returns a NAMED column (not a bare setof uuid) so PostgREST callers can
-- order by it and page through it with fetchAllRows(). PostgREST caps every
-- read -- set-returning RPCs included -- at db-max-rows (1000) and reports
-- truncation only in a header; an unpaged read of this set would silently
-- drop held instruments once more than 1000 exist, and hydration would then
-- never fetch their history. Column references are table-qualified because
-- the output column shares the name instrument_id.
create or replace function pc6_user_held_instrument_ids()
returns table (instrument_id uuid)
language sql stable as $$
  select t.instrument_id from ii_transactions t               where t.instrument_id is not null
  union
  select t.instrument_id from ii_holding_snapshots t          where t.instrument_id is not null
  union
  select t.instrument_id from ii_portfolio_truth_status t     where t.instrument_id is not null
  union
  select t.instrument_id from ii_tax_lots t                   where t.instrument_id is not null
  union
  select t.instrument_id from ii_sip_series t                 where t.instrument_id is not null
  union
  select t.instrument_id from ii_capital_gains_computations t where t.instrument_id is not null
  union
  select t.instrument_id from ii_fhip_publications t          where t.instrument_id is not null;
$$;

comment on function pc6_user_held_instrument_ids() is
  'NAV 1 (0189). Every instrument any user holds or has ever held. Consumed by selective hydration to decide '
  'what history to fetch on demand. Must agree with pc6_instrument_is_user_held().';

-- The retention decision. Identical to 0172 except that the certified-only,
-- windowed truth-status block is replaced by pc6_instrument_is_user_held().
create or replace function pc6_nav_row_is_candidate(p_instrument_id uuid, p_price_date date, p_changeover_date date)
returns boolean
language sql stable as $$
  select not (
    p_price_date >= p_changeover_date
    or pc6_instrument_is_user_held(p_instrument_id)
    or exists (
      select 1 from ii_instrument_benchmarks ib where ib.instrument_id = p_instrument_id
    )
    or exists (
      select 1 from ii_report_nav_dependencies d
      where d.instrument_id = p_instrument_id
        and p_price_date <= d.nav_date_to
        and (d.nav_date_from is null or p_price_date >= d.nav_date_from)
    )
    or exists (
      select 1 from ii_nav_retention_holds h
      where h.instrument_id = p_instrument_id and h.released_at is null
        and (h.expires_at is null or h.expires_at > now())
    )
  );
$$;

comment on function pc6_nav_row_is_candidate(uuid, date, date) is
  'NAV 1 (0189). True if a NAV row may be deleted: before the changeover date AND its instrument is not '
  'user-held (any status), benchmark-mapped, report-pinned, or under an open hold. 0172''s certified-only '
  'rule protected nothing in production.';
