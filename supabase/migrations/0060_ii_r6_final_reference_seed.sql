-- Investment Intelligence R6-FINAL — production reference-data seed
-- (spec Sections 13, 16). Forward-only, idempotent (on conflict do nothing).
--
-- RENUMBERED 0059 -> 0060 (2026-08-23, FDH-3 + Investment Intelligence R6
-- lineage reconciliation) — see 0059's own header for the full reasoning
-- (this file's whole 5-migration chain shifted forward by one slot each
-- after FDH-3's independent, unrelated 0058 collided with R6's original
-- 0058). SQL content unchanged.
--
-- This migration captures, for reproducibility in a fresh environment, the
-- SAME rows that scripts/ii_r6_final_reference_seed.mjs inserted directly
-- into DEV during the R6-FINAL live-DEV certification pass (2026-08-22) via
-- the service-role key — pure DML into already-existing tables did not
-- require this session's (absent) DDL capability, so the live insert
-- happened first and this migration mirrors it for the migration history.
-- See that script's own header comment for the full sourcing rationale
-- behind every classification/exit-load row below.
--
-- ONE NEW INSTRUMENT: DEV's existing India instrument set (as of this
-- dispatch) contained zero debt/specified mutual funds, and Section 13
-- requires a debt/specified reference example. 'ICICI Prudential Corporate
-- Bond Fund - Growth (Direct Plan)' is a REAL, named, SEBI-recognised
-- scheme (ISIN INF109KA1Z62) — populating the reference/master instrument
-- table with real-world data, not inventing a fictional instrument.
--
-- This migration does NOT touch ii_scheme_tax_classification's schema, only
-- inserts rows — no ALTER/CREATE beyond the plain inserts below.

-- ---------------------------------------------------------------------------
-- 1. New real debt-fund instrument (idempotent on isin).
-- ---------------------------------------------------------------------------
insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency, status, isin)
select 'ICICI Prudential Corporate Bond Fund - Growth (Direct Plan)', 'mutual_fund', 'IN', 'INR', 'verified', 'INF109KA1Z62'
where not exists (select 1 from ii_instruments where isin = 'INF109KA1Z62');

-- ---------------------------------------------------------------------------
-- 2. ii_fund_holdings — real NSE large-cap constituent names, illustrative/
--    approximate weights (not a live AMFI/factsheet feed; disclosed as such
--    in the classification notes below), for the three real equity funds
--    already present in ii_instruments before this migration.
--
-- NOTE: these inserts reference instrument rows by instrument_name lookup
-- (not hardcoded ids) so this migration is portable across environments
-- whose ii_instruments ids differ from DEV's. Underlying-equity instrument
-- rows are created inline the same way, keyed by name uniqueness within
-- this insert only (best-effort de-dup via NOT EXISTS; a small risk of a
-- second, differently-cased duplicate is accepted here exactly as the R2
-- instrument-resolution precedent already does for first-observed names).
-- ---------------------------------------------------------------------------
do $$
declare
  v_nifty50 uuid;
  v_bluechip_direct uuid;
  v_bluechip_regular uuid;
  v_disclosure_date date := '2026-07-31';
  v_manual_source uuid;
  v_underlying uuid;
  rec record;
begin
  select id into v_nifty50 from ii_instruments where instrument_name = 'ICICI Prudential Nifty 50 Index Fund - Growth (Direct Plan)' limit 1;
  select id into v_bluechip_direct from ii_instruments where instrument_name = 'SBI Bluechip Fund - Growth (Direct Plan)' and isin is null limit 1;
  select id into v_bluechip_regular from ii_instruments where instrument_name = 'SBI Bluechip Fund - Growth (Regular Plan)' and isin = 'INF200K01UP0' limit 1;
  select id into v_manual_source from ii_sources where source_key = 'manual' limit 1;

  if v_nifty50 is null or v_bluechip_direct is null or v_bluechip_regular is null then
    raise notice 'ii_r6_final_reference_seed: one or more expected real equity fund instruments not found in this environment — skipping ii_fund_holdings/classification seed for them.';
  else
    for rec in
      select * from (values
        (v_nifty50, 'HDFC Bank Ltd', 12.5), (v_nifty50, 'Reliance Industries Ltd', 9.0), (v_nifty50, 'ICICI Bank Ltd', 8.5),
        (v_nifty50, 'Infosys Ltd', 6.0), (v_nifty50, 'Larsen & Toubro Ltd', 4.0), (v_nifty50, 'Tata Consultancy Services Ltd', 4.0),
        (v_nifty50, 'ITC Ltd', 3.5), (v_nifty50, 'Bharti Airtel Ltd', 3.5), (v_nifty50, 'Axis Bank Ltd', 3.0), (v_nifty50, 'State Bank of India', 2.8),
        (v_bluechip_direct, 'HDFC Bank Ltd', 9.5), (v_bluechip_direct, 'ICICI Bank Ltd', 8.0), (v_bluechip_direct, 'Reliance Industries Ltd', 7.0),
        (v_bluechip_direct, 'Infosys Ltd', 5.5), (v_bluechip_direct, 'Larsen & Toubro Ltd', 4.5),
        (v_bluechip_regular, 'HDFC Bank Ltd', 9.5), (v_bluechip_regular, 'ICICI Bank Ltd', 8.0), (v_bluechip_regular, 'Reliance Industries Ltd', 7.0),
        (v_bluechip_regular, 'Infosys Ltd', 5.5), (v_bluechip_regular, 'Larsen & Toubro Ltd', 4.5)
      ) as t(fund_id, underlying_name, weight_pct)
    loop
      select id into v_underlying from ii_instruments where instrument_name = rec.underlying_name and instrument_class = 'equity' limit 1;
      if v_underlying is null then
        insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency, status)
        values (rec.underlying_name, 'equity', 'IN', 'INR', 'verified') returning id into v_underlying;
      end if;
      insert into ii_fund_holdings (fund_instrument_id, underlying_instrument_id, underlying_name, disclosure_date, weight_pct, source_id)
      values (rec.fund_id, v_underlying, rec.underlying_name, v_disclosure_date, rec.weight_pct, v_manual_source)
      on conflict (fund_instrument_id, underlying_instrument_id, disclosure_date) do nothing;
    end loop;

    -- Aggregate "remainder" + cash lines (domestic-equity mandate rationale in
    -- ii_r6_final_reference_seed.mjs's header comment).
    insert into ii_fund_holdings (fund_instrument_id, underlying_instrument_id, underlying_name, disclosure_date, weight_pct, source_id)
    values
      (v_nifty50, null, 'Remaining Nifty 50 index constituents (all domestic equity, by index-replication mandate)', v_disclosure_date, 42.7, v_manual_source),
      (v_nifty50, null, 'Cash & money market instruments', v_disclosure_date, 0.5, v_manual_source),
      (v_bluechip_direct, null, 'Remaining large/mid-cap domestic equity holdings (SEBI Large Cap Fund mandate: >=80% in top-100 by market cap)', v_disclosure_date, 62.5, v_manual_source),
      (v_bluechip_direct, null, 'Cash & money market instruments', v_disclosure_date, 3.0, v_manual_source),
      (v_bluechip_regular, null, 'Remaining large/mid-cap domestic equity holdings (SEBI Large Cap Fund mandate: >=80% in top-100 by market cap) — identical underlying portfolio to the Direct plan', v_disclosure_date, 62.5, v_manual_source),
      (v_bluechip_regular, null, 'Cash & money market instruments', v_disclosure_date, 3.0, v_manual_source)
    on conflict (fund_instrument_id, underlying_instrument_id, disclosure_date) do nothing;

    -- Classification: computed to match what classifyScheme() produces from
    -- the holdings above (99.5% / 97% / 97% domestic equity — all
    -- comfortably equity_oriented against the 65% threshold).
    insert into ii_scheme_tax_classification (instrument_id, classification, domestic_equity_pct, basis, disclosure_date, engine_version, note)
    values
      (v_nifty50, 'equity_oriented', 99.5, 'computed_from_holdings', v_disclosure_date, 'r6-final-reference-seed-v1', 'Domestic equity allocation 99.5% vs 65% threshold, as disclosed 2026-07-31. Illustrative top-holding weights, not a live AMFI/factsheet feed.'),
      (v_bluechip_direct, 'equity_oriented', 97.0, 'computed_from_holdings', v_disclosure_date, 'r6-final-reference-seed-v1', 'Domestic equity allocation 97.0% vs 65% threshold, as disclosed 2026-07-31. Illustrative top-holding weights, not a live AMFI/factsheet feed.'),
      (v_bluechip_regular, 'equity_oriented', 97.0, 'computed_from_holdings', v_disclosure_date, 'r6-final-reference-seed-v1', 'Domestic equity allocation 97.0% vs 65% threshold, as disclosed 2026-07-31. Illustrative top-holding weights, not a live AMFI/factsheet feed.')
    on conflict (instrument_id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Debt/specified classification (category-based, no holdings needed).
-- ---------------------------------------------------------------------------
insert into ii_scheme_tax_classification (instrument_id, classification, domestic_equity_pct, basis, disclosure_date, engine_version, note)
select id, 'debt_specified', null, 'known_debt_specified_category', null, 'r6-final-reference-seed-v1',
  'SEBI ''Corporate Bond Fund'' category (Oct-2017 mutual fund categorisation circular) mandates minimum 80% investment in AA+-and-above-rated corporate bonds — a debt scheme by category definition; the Finance Act 2023 ''specified mutual fund'' always-short-term rule applies by acquisition date, not an allocation test.'
from ii_instruments where isin = 'INF109KA1Z62'
on conflict (instrument_id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Deliberately unresolved: NPS Tier I - Equity (E) is a different tax
--    regime entirely (Sections 80CCD/10(12A)-(12B)), out of this engine's
--    mutual-fund-capital-gains scope. Guessing here would be worse than
--    leaving unresolved.
-- ---------------------------------------------------------------------------
insert into ii_scheme_tax_classification (instrument_id, classification, domestic_equity_pct, basis, disclosure_date, engine_version, note)
select id, 'unresolved', null, 'unresolved_no_data', null, 'r6-final-reference-seed-v1',
  'National Pension System (NPS) Tier I follows an entirely different tax regime (Sections 80CCD / 10(12A)-(12B), EEE-style) unrelated to mutual-fund Section 111A/112A capital-gains taxation. This engine is scoped to mutual-fund capital gains only. Deliberately left unresolved, not guessed.'
from ii_instruments where instrument_name = 'National Pension System Tier I - Equity (E)' and country_of_domicile = 'IN'
on conflict (instrument_id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Exit-load schedules — general industry-typical structures (explicitly
--    NOT any one specific scheme's actual current SID — see the .mjs
--    script's header for the disclosed basis), including one
--    historical+current pair on SBI Bluechip (Direct) so the
--    historical-vs-current effective-dating path has real data.
-- ---------------------------------------------------------------------------
do $$
declare
  v_nifty50 uuid;
  v_bluechip_direct uuid;
  v_bluechip_regular uuid;
  v_manual_source uuid;
begin
  select id into v_nifty50 from ii_instruments where instrument_name = 'ICICI Prudential Nifty 50 Index Fund - Growth (Direct Plan)' limit 1;
  select id into v_bluechip_direct from ii_instruments where instrument_name = 'SBI Bluechip Fund - Growth (Direct Plan)' and isin is null limit 1;
  select id into v_bluechip_regular from ii_instruments where instrument_name = 'SBI Bluechip Fund - Growth (Regular Plan)' and isin = 'INF200K01UP0' limit 1;
  select id into v_manual_source from ii_sources where source_key = 'manual' limit 1;

  if v_bluechip_direct is not null then
    insert into ii_exit_load_schedules (instrument_id, tiers, effective_from, effective_to, source_id) values
      (v_bluechip_direct, '[{"uptoDays": 90, "loadPct": 1.0}, {"uptoDays": 365, "loadPct": 0.5}]'::jsonb, '2016-01-01', '2019-03-31', v_manual_source),
      (v_bluechip_direct, '[{"uptoDays": 365, "loadPct": 1.0}]'::jsonb, '2019-04-01', null, v_manual_source)
    on conflict (instrument_id, effective_from) do nothing;
  end if;
  if v_bluechip_regular is not null then
    insert into ii_exit_load_schedules (instrument_id, tiers, effective_from, effective_to, source_id) values
      (v_bluechip_regular, '[{"uptoDays": 365, "loadPct": 1.0}]'::jsonb, '2019-04-01', null, v_manual_source)
    on conflict (instrument_id, effective_from) do nothing;
  end if;
  if v_nifty50 is not null then
    insert into ii_exit_load_schedules (instrument_id, tiers, effective_from, effective_to, source_id) values
      (v_nifty50, '[{"uptoDays": 15, "loadPct": 0.25}]'::jsonb, '2018-01-01', null, v_manual_source)
    on conflict (instrument_id, effective_from) do nothing;
  end if;
end $$;
