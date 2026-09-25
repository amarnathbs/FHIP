-- NAV 1 completion (2026-09-25), brief P5 -- close three fail-open paths in the
-- retention predicate before any production cleanup manifest is trusted.
--
-- 1. AN UNPRIVILEGED CALLER GETS "DELETABLE" FOR A HELD FUND.
--    pc6_nav_row_is_candidate / pc6_instrument_is_user_held /
--    pc6_user_held_instrument_ids are SECURITY INVOKER and read RLS-protected
--    tables. Supabase grants EXECUTE on public functions to anon and
--    authenticated by default, and no NAV 1 migration revoked it. Called by
--    anyone but a role that bypasses RLS, every user's holdings, pins and holds
--    are invisible, so the predicate answers TRUE for a user-held instrument.
--    Verified live on DEV 2026-09-25: for a user-held instrument and a 2020
--    date, service_role got false and the PUBLIC anon key got true (and an
--    empty user-held list). Nothing leaks -- the caller learns nothing about
--    other users -- but a deletion driven by a non-service caller would delete
--    held history. Fix: EXECUTE for service_role only. A wrong caller now gets
--    "permission denied" instead of a wrong answer. No application code calls
--    these functions except selective hydration, which uses the service role.
--
-- 2. A NULL CHANGEOVER RETURNS NULL, NOT FALSE.
--    `p_price_date >= NULL` is NULL, so for an unprotected instrument the
--    predicate returned NULL. `WHERE fn(...)` treats that as not-a-candidate,
--    but `coalesce(fn, true)`, `is not false` or a client testing `!== false`
--    would read it as deletable. Fix: the predicate never returns NULL; any
--    NULL input yields FALSE (keep).
--
-- 3. A SCHEME MERGER COULD STRAND HISTORY.
--    Protection was by instrument_id alone. If scheme A is merged into B
--    (ii_instruments.merged_into_instrument_id or
--    ii_scheme_master.merged_into_instrument_id) and a user's rows are held
--    under B, A's history -- which the user's pre-merger performance, XIRR and
--    tax history need -- was a deletion candidate. Fix: an instrument is kept
--    if any instrument in its merge family (followed both ways, transitively,
--    to a bounded depth) is user-held, benchmarked, report-pinned or under an
--    open hold. Production has ZERO merge links today (verified 2026-09-25:
--    0 non-null merged_into_instrument_id in both tables), so this changes no
--    current verdict; it closes the path before the first merger arrives.
--
-- UNCHANGED: the four protection terms of 0189 (user-held in any of the seven
-- user-scoped ii_* tables, benchmark mapping, report NAV dependency by date
-- range, open unexpired hold) and the changeover rule. A missing table or
-- function still raises an error (language sql, no exception handler), which
-- stops any deletion rather than approving it -- proven in the PGlite script.
--
-- NOT A CONSTRAINT CHANGE: no CHECK constraint is dropped or recreated.
-- Verification: scripts/nav1_0200_pglite_verification.mjs (negative controls
-- against the 0189 definition, then the fix).

create index if not exists idx_ii_instruments_merged_into
  on ii_instruments(merged_into_instrument_id) where merged_into_instrument_id is not null;
create index if not exists idx_ii_scheme_master_merged_into
  on ii_scheme_master(merged_into_instrument_id) where merged_into_instrument_id is not null;

create or replace function pc6_nav_row_is_candidate(p_instrument_id uuid, p_price_date date, p_changeover_date date)
returns boolean
language sql stable as $$
  with recursive merge_family(instrument_id, depth) as (
    select p_instrument_id, 0
    union
    select x.other, f.depth + 1
    from merge_family f
    cross join lateral (
      select i.merged_into_instrument_id as other from ii_instruments i
        where i.id = f.instrument_id and i.merged_into_instrument_id is not null
      union all
      select i.id from ii_instruments i where i.merged_into_instrument_id = f.instrument_id
      union all
      select s.merged_into_instrument_id from ii_scheme_master s
        where s.instrument_id = f.instrument_id and s.merged_into_instrument_id is not null
      union all
      select s.instrument_id from ii_scheme_master s
        where s.merged_into_instrument_id = f.instrument_id and s.instrument_id is not null
    ) x
    where f.depth < 8
  )
  select coalesce(not (
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
    or exists (
      select 1 from merge_family m
      where m.instrument_id is distinct from p_instrument_id
        and (
          pc6_instrument_is_user_held(m.instrument_id)
          or exists (select 1 from ii_instrument_benchmarks ib where ib.instrument_id = m.instrument_id)
          or exists (select 1 from ii_report_nav_dependencies d where d.instrument_id = m.instrument_id)
          or exists (
            select 1 from ii_nav_retention_holds h
            where h.instrument_id = m.instrument_id and h.released_at is null
              and (h.expires_at is null or h.expires_at > now())
          )
        )
    )
  ), false);
$$;

comment on function pc6_nav_row_is_candidate(uuid, date, date) is
  'NAV 1 (0189, hardened 0200). True only if a NAV row may be deleted: before the changeover date AND '
  'neither its instrument nor any instrument in its merge family is user-held (any status), '
  'benchmark-mapped, report-pinned or under an open hold. Never returns NULL (NULL input = keep). '
  'EXECUTE is service_role only: under RLS any other caller would see no holdings and get TRUE.';

revoke execute on function pc6_nav_row_is_candidate(uuid, date, date) from public, anon, authenticated;
revoke execute on function pc6_instrument_is_user_held(uuid) from public, anon, authenticated;
revoke execute on function pc6_user_held_instrument_ids() from public, anon, authenticated;
grant execute on function pc6_nav_row_is_candidate(uuid, date, date) to service_role;
grant execute on function pc6_instrument_is_user_held(uuid) to service_role;
grant execute on function pc6_user_held_instrument_ids() to service_role;
