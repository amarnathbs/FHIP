-- NAV 1 -- PO decisions #2 and #5 (2026-09-27 dispatch): historical depth
-- policy compliance, and absorbed fund-house history integrity.
--
-- BACKGROUND. The 2026-09-25 Stage-E readiness canary found that one of 5
-- sampled instruments -- HSBC Short Term Fund, AMFI scheme code 151069,
-- instrument_id 003c7324-14e7-47a2-b842-64aeb9cdcbc1 -- has a genuine
-- rehydration gap: of its 3,199 pre-changeover stored NAV rows (2013-01-28
-- to 2026-09-18), only 925 (2022-09-20 onward) can be re-fetched from either
-- approved source (AMFI, filtered by the scheme's CURRENT fund-house code
-- 37 = HSBC Mutual Fund; TIGZIG fallback). The other 2,274 rows (2013-01-28
-- to 2022-09-19) return `not_found` from BOTH sources, re-confirmed live on
-- 2026-09-27 with the identical split (925 exact matches, 0 mismatches,
-- 2,274 not returned by either source). Root cause: this scheme was
-- formerly filed by L&T Mutual Fund; AMFI's NAV History Report groups
-- history by fund house, and does not appear to carry a merged AMC's
-- pre-transition records forward under the surviving AMC's fund-house code.
-- 2022-09-20 is the EMPIRICALLY OBSERVED boundary from this replay, not an
-- asserted legal/corporate-action date -- recorded that way deliberately,
-- per this programme's standing rule to never state a fact this session has
-- not itself verified.
--
-- THIS IS NOT A SCHEME MERGER. ii_instruments.merged_into_instrument_id and
-- ii_scheme_master.merged_into_instrument_id (0189/0200's "merge family")
-- model a SCHEME absorbed into a DIFFERENT scheme (two AMFI codes, two
-- instrument rows). HSBC Short Term Fund kept its OWN AMFI code (151069)
-- throughout; there is no second "L&T Short Term Fund" instrument row to
-- link. Verified today (2026-09-27, read-only production check): zero rows
-- in either table have a non-null merged_into_instrument_id, unchanged
-- since 2026-09-25 -- the merge-family mechanism has never protected a real
-- case. That mechanism is architecturally correct for its own scenario and
-- is left as-is; it is simply the wrong lever for an AMC/fund-house
-- ownership change on a continuing scheme, which is what actually happened
-- here and is the more common real-world event in the Indian MF industry
-- (L&T -> HSBC, Principal -> Sundaram, IDFC -> Bandhan, etc.). This
-- migration adds the mechanism that DOES fit that scenario.
--
-- PART A -- PREDECESSOR LINEAGE (PO decision #5.3). ii_scheme_master already
-- has `merger_date` (a per-scheme timestamp column, always null in
-- production today) but nothing records WHO the predecessor sponsor was.
-- Add `predecessor_amc_name`, and populate both columns for the one
-- confirmed real case, so the lineage fact is first-class and queryable
-- rather than living only in a report's prose.
--
-- PART B -- SOURCE COVERAGE GAPS (PO decision #2's exact wording: "record
-- the earliest reliably available date, missing range, provider and
-- limitation"). `ii_nav_history_floors` (0190) already records "history
-- starts here" for hydration's own fetch-window optimisation, but conflates
-- two different situations under one row: a fund that genuinely launched
-- later, and a fund whose source coverage has a gap for an unrelated reason
-- (here, an AMC transition). Recording an AMC-transition gap as a plain
-- floor would misreport it as "this scheme launched on 2022-09-20", which
-- is false and exactly the kind of manufactured/implied fact this
-- programme's own N.8 principle forbids. `ii_nav_source_coverage_gaps` is a
-- new, explicitly reasoned ledger for this: which instrument, which date
-- range, which providers were checked, and why. Seeded with the one
-- confirmed case. `pc6_nav_row_is_candidate()` is extended (additively) to
-- treat any row inside an unresolved coverage gap as never a deletion
-- candidate, regardless of held status -- deleting the ONE COPY of
-- irreplaceable history is the actual risk PO decision #5 is about, and
-- held-status alone does not capture it (this scheme is not held by
-- anyone in production today, so it would otherwise be a candidate).
--
-- Verification: scripts/nav1_0219_pglite_verification.mjs.

alter table ii_scheme_master add column if not exists predecessor_amc_name text;
comment on column ii_scheme_master.predecessor_amc_name is
  'NAV 1 (0219). The prior sponsoring AMC name, when this scheme continued under the same AMFI scheme '
  'code through an AMC/fund-house ownership change (e.g. L&T -> HSBC). NULL for a scheme with no known '
  'prior sponsor. Distinct from merged_into_instrument_id, which is for a DIFFERENT scheme (a different '
  'AMFI code) being absorbed into this one -- an AMC ownership change on a continuing scheme has no '
  'second instrument to link.';

create table if not exists ii_nav_source_coverage_gaps (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  gap_from date not null,
  gap_to date not null,
  providers_checked text[] not null,
  reason_code text not null check (reason_code in (
    'fund_house_transition', 'presumed_pre_launch', 'provider_outage_unresolved', 'other'
  )),
  detail text not null,
  discovered_by text not null,
  discovered_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_detail text,
  created_at timestamptz not null default now(),
  constraint ii_nav_source_coverage_gaps_valid_range check (gap_from <= gap_to)
);
-- Lookup index for the still-open rows (this IS the index
-- pc6_nav_row_is_candidate()'s EXISTS check uses); made UNIQUE below in the
-- same breath, since it also serves as this table's seed-idempotency key --
-- one index, not two redundant ones over the same columns/predicate.
create unique index if not exists idx_ii_nav_source_coverage_gaps_dedup_open
  on ii_nav_source_coverage_gaps(instrument_id, gap_from, gap_to) where resolved_at is null;

alter table ii_nav_source_coverage_gaps enable row level security;
drop policy if exists "admin read ii_nav_source_coverage_gaps" on ii_nav_source_coverage_gaps;
create policy "admin read ii_nav_source_coverage_gaps" on ii_nav_source_coverage_gaps
  for select using (is_pc6_reference_data_admin());

comment on table ii_nav_source_coverage_gaps is
  'NAV 1 (0219), PO decision #2/#5. A reasoned, queryable record of a date range where an instrument''s '
  'NAV history exists in ii_prices_nav but has been CONFIRMED unrecoverable from every approved source '
  '(never a claim about missing storage -- see reason_code). Feeds pc6_nav_row_is_candidate() (never a '
  'deletion candidate while unresolved) and is the source for render-time disclosure of unrecoverable '
  'periods. Never populated by inference -- only after an explicit source replay confirms not_found '
  'from every provider checked. Admin-read-only via RLS; written only by service-role application code '
  'or migration seed data.';
comment on column ii_nav_source_coverage_gaps.reason_code is
  'fund_house_transition = a continuing scheme''s pre-transition history is not served under its current '
  'AMC''s provider code (see predecessor_amc_name on ii_scheme_master). presumed_pre_launch = the '
  'ordinary ii_nav_history_floors case (recorded here too only if it needs render-time disclosure). '
  'provider_outage_unresolved = a transient-looking gap that has not yet been confirmed structural. '
  'other = anything not yet categorised; must not stay in this state -- see detail.';
comment on column ii_nav_source_coverage_gaps.resolved_at is
  'Set only if a later, real re-fetch (scripts/nav1_report_dependency_restoration_attempt.ts or '
  'equivalent) actually recovers the range from an approved source. Never set to silence a disclosure '
  'without a real recovery.';

-- Seed: the one confirmed real case. Idempotent via the partial unique
-- index above (kept among the still-open rows only -- a resolved gap must
-- never silently collide with fresh seed data).
update ii_scheme_master
  set merger_date = '2022-09-20', predecessor_amc_name = 'L&T Mutual Fund'
  where amfi_scheme_code = '151069' and merger_date is null and predecessor_amc_name is null;

insert into ii_nav_source_coverage_gaps
  (instrument_id, gap_from, gap_to, providers_checked, reason_code, detail, discovered_by)
select sm.instrument_id, date '2013-01-28', date '2022-09-19', array['amfi', 'tigzig'], 'fund_house_transition',
  'HSBC Short Term Fund (AMFI 151069, formerly L&T Mutual Fund). Re-confirmed live 2026-09-27 via '
  'scripts/nav1_d11_source_fidelity_check.ts against production: of 3,199 stored pre-changeover rows, '
  '925 (2022-09-20 to 2026-09-18) match AMFI exactly across 2 chunks; the other 2,274 (2013-01-28 to '
  '2022-09-19, 5 chunks of up to 730 days) return not_found from both AMFI (fund house 37, HSBC''s '
  'current code) and TIGZIG. Not currently held, benchmarked, report-pinned or under a hold in '
  'production as of 2026-09-27, so this range is presently unprotected except by this row and the '
  'global no-Stage-E-deletion-yet decision.',
  'nav1-po-decision-5-2026-09-27'
from ii_scheme_master sm
where sm.amfi_scheme_code = '151069'
on conflict do nothing;

-- ===========================================================================
-- Harden pc6_nav_row_is_candidate(): additive OR branch, same signature as
-- 0200. A row inside an unresolved coverage gap is never a candidate,
-- independent of held/benchmark/pin/hold status -- deleting the only copy
-- of history nothing can restore is the harm this migration exists to
-- prevent, and it must not depend on the instrument happening to be held.
-- ===========================================================================
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
      select 1 from ii_nav_source_coverage_gaps g
      where g.instrument_id = p_instrument_id and g.resolved_at is null
        and p_price_date between g.gap_from and g.gap_to
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
          or exists (
            select 1 from ii_nav_source_coverage_gaps g
            where g.instrument_id = m.instrument_id and g.resolved_at is null
          )
        )
    )
  ), false);
$$;

comment on function pc6_nav_row_is_candidate(uuid, date, date) is
  'NAV 1 (0189, hardened 0200, hardened 0219). True only if a NAV row may be deleted: before the '
  'changeover date AND neither its instrument nor any instrument in its merge family is user-held (any '
  'status), benchmark-mapped, report-pinned, under an open hold, or inside an unresolved '
  'ii_nav_source_coverage_gaps range (0219 -- irreplaceable history, independent of held status). Never '
  'returns NULL (NULL input = keep). EXECUTE is service_role only: under RLS any other caller would see '
  'no holdings and get TRUE.';

revoke execute on function pc6_nav_row_is_candidate(uuid, date, date) from public, anon, authenticated;
grant execute on function pc6_nav_row_is_candidate(uuid, date, date) to service_role;
