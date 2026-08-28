-- G0-JA-1 Wave 2: catalogue applicability realignment for the 20 approved
-- Australian-flavoured catalogue items (docs/jurisdiction-applicability/
-- 03-catalogue-matrix.md / .csv, Decision PO-2, Product Owner approved
-- 2026-08-27).
--
-- Two independent things happen here, kept deliberately distinct per the
-- architecture rule "country is a SEPARATE attribute from applicability
-- class" (01-canonical-architecture.md S7):
--
--   1. `applicability_class` -- a NEW, purely additive metadata column
--      recording which of the five Product-Owner-approved canonical classes
--      (GLOBAL, HOME_JURISDICTION, HOME_OR_CROSS_BORDER_COUNTRY,
--      GLOBAL_WITH_JURISDICTION_VARIANT, EXISTING_RECORD_ONLY) an item
--      belongs to. Nothing in the app currently *requires* this column for
--      enforcement (country_applicability + isItemAvailableForCountry()
--      remain the sole enforcement path, unchanged) -- it exists so the
--      12 HOME_OR_CROSS_BORDER_COUNTRY items can be told apart from a plain
--      HOME_JURISDICTION item (today: only 'smsf') by future code (e.g. the
--      cross-border-context-not-yet-supported messaging added in
--      lib/services/jurisdiction.ts this same wave), without a second
--      applicability engine and without a compound country value like
--      'HOME_OR_CROSS_BORDER_COUNTRY(AU)' ever being stored anywhere.
--
--   2. `country_applicability` backfill -- ONLY the 12
--      HOME_OR_CROSS_BORDER_COUNTRY items move from NULL (globally offered
--      for new creation, today's live state per 03-catalogue-matrix.md's
--      explicit confirmation) to ['AU']. The 8 GLOBAL_WITH_JURISDICTION_VARIANT
--      items keep country_applicability = NULL -- per Decision PO-2b they
--      are a universal concept wearing Australian terminology, not a
--      restricted item, and must stay creatable by every user regardless of
--      home jurisdiction (03-catalogue-matrix.md line 69's explicit
--      instruction: "these 8 items keep country_applicability=NULL").
--
-- Targets the exact 20 immutable (category, item_key) identifiers reconciled
-- against the live seed (supabase/seed_master_items.sql) -- never fuzzy name
-- matching. SMSF ('retirement','smsf') is explicitly NOT touched by this
-- migration (out of Wave 2's authorised scope) -- its own country_applicability
-- and applicability_class (conceptually HOME_JURISDICTION, left NULL here,
-- not stored) are unchanged; migration 0084 remains the sole source of
-- SMSF's restriction.
--
-- Forward-only, idempotent: safe to run more than once (UPDATE by exact key
-- tuple is naturally idempotent; the affected-row-count assertions below
-- check rows *matched*, which stays constant on replay, not rows *changed*).
-- Never edits an already-applied migration file, never deletes a catalogue
-- row, never touches user data in any table other than
-- master_financial_items (a shared reference table, not a user table).
--
-- Row-count assertions below tolerate TWO valid states, mirroring migration
-- 0084's own SMSF backfill + supabase/seed_master_items.sql's tail
-- convention ("both orderings independently converge on the same result"):
-- (a) the catalogue is completely empty at apply time (this migration
-- running before supabase/seed_master_items.sql's one-off out-of-band
-- application to a brand-new environment -- e.g. a from-scratch DEV/CI
-- rebuild) -- every UPDATE below then legitimately matches 0 rows; or
-- (b) the catalogue is already populated (the real DEV/production case --
-- confirmed live: all 20 target rows already exist in
-- supabase/seed_master_items.sql today) -- every UPDATE must then match
-- its exact expected count. Any OTHER count (a partial match) means real
-- catalogue drift and still aborts the migration.


-- ===========================================================================
-- PART 1 -- applicability_class metadata column
-- ===========================================================================

alter table master_financial_items
  add column if not exists applicability_class text;

comment on column master_financial_items.applicability_class is
  'Which of the five Product-Owner-approved canonical applicability classes (01-canonical-architecture.md S7, G0-JA-1) this item belongs to: GLOBAL, HOME_JURISDICTION, HOME_OR_CROSS_BORDER_COUNTRY, GLOBAL_WITH_JURISDICTION_VARIANT, EXISTING_RECORD_ONLY. NULL = not yet classified (legacy default, functionally equivalent to GLOBAL wherever country_applicability is also NULL). This column is metadata only -- actual creation enforcement is entirely driven by country_applicability + isItemAvailableForCountry()/assertItemCreationAllowedForUser() (lib/services/jurisdiction.ts); this column exists only to let HOME_JURISDICTION and HOME_OR_CROSS_BORDER_COUNTRY items be told apart even when they currently share the same country_applicability value, and to record GLOBAL_WITH_JURISDICTION_VARIANT items for a future label-override mechanism (G0-JA-1 Wave 2, RI-9-style residual -- no such mechanism exists yet, see docs/jurisdiction-applicability/03-catalogue-matrix.md). Country is always a separate attribute from this class -- never a compound value.';

alter table master_financial_items drop constraint if exists chk_mfi_applicability_class_valid;
alter table master_financial_items
  add constraint chk_mfi_applicability_class_valid check (
    applicability_class is null
    or applicability_class in (
      'GLOBAL',
      'HOME_JURISDICTION',
      'HOME_OR_CROSS_BORDER_COUNTRY',
      'GLOBAL_WITH_JURISDICTION_VARIANT',
      'EXISTING_RECORD_ONLY'
    )
  );

-- ===========================================================================
-- PART 2 -- 11 of the 12 HOME_OR_CROSS_BORDER_COUNTRY(AU) items: genuine AU
-- structures (PO-2 clause (a)) that DO require AU-home-or-verified-cross-
-- border-context to create new.
-- (03-catalogue-matrix.md S"Class: HOME_OR_CROSS_BORDER_COUNTRY -- 12 items")
-- ===========================================================================

do $$
declare affected int; catalogue_total int;
begin
  select count(*) into catalogue_total from master_financial_items;
  update master_financial_items
  set applicability_class = 'HOME_OR_CROSS_BORDER_COUNTRY',
      country_applicability = array['AU']::char(2)[]
  where (category, item_key) in (
    ('income', 'age_pension'),
    ('income', 'family_tax_benefit'),
    ('liability', 'smsf_property_loan'),
    ('liability', 'hecs_help'),
    ('liability', 'ato_payment_plan'),
    ('retirement', 'industry_super'),
    ('retirement', 'retail_super'),
    ('retirement', 'government_co_contribution'),
    ('retirement', 'transition_to_retirement'),
    ('retirement', 'allocated_pension'),
    ('retirement', 'account_based_pension')
  );
  get diagnostics affected = row_count;
  if catalogue_total > 0 and affected <> 11 then
    raise exception 'G0-JA-1 Wave 2: expected exactly 11 rows matched for the AU-structure HOME_OR_CROSS_BORDER_COUNTRY backfill (catalogue already has % rows), got %. Catalogue drift since 03-catalogue-matrix.md reconciliation -- STOP, do not proceed.', catalogue_total, affected;
  end if;
  if catalogue_total = 0 and affected <> 0 then
    raise exception 'G0-JA-1 Wave 2: unexpected % row(s) matched against an empty catalogue -- impossible state, aborting.', affected;
  end if;
end $$;

-- ===========================================================================
-- PART 2b -- the 12th HOME_OR_CROSS_BORDER_COUNTRY(AU) item: `australian_shares`
-- (PO-2 clause (c) -- a cross-border HOLDING, not an AU-resident-only
-- structure). 03-catalogue-matrix.md's own rationale for this item is
-- explicit and singular: "must remain creatable by a non-AU-home user who
-- holds Australian shares as a cross-border asset (does not require AU to
-- be the user's home country)". Unlike the 11 items above, this item's
-- country_applicability is deliberately left untouched (NULL, i.e. globally
-- creatable) -- only its applicability_class is recorded, for future
-- reporting/labelling. Setting country_applicability=['AU'] here would
-- directly contradict the approved disposition by blocking exactly the
-- non-AU-home users the matrix says must remain able to create it.
-- ===========================================================================

do $$
declare affected int; catalogue_total int;
begin
  select count(*) into catalogue_total from master_financial_items;
  update master_financial_items
  set applicability_class = 'HOME_OR_CROSS_BORDER_COUNTRY'
  where (category, item_key) = ('investment', 'australian_shares');
  get diagnostics affected = row_count;
  if catalogue_total > 0 and affected <> 1 then
    raise exception 'G0-JA-1 Wave 2: expected exactly 1 row matched for australian_shares classification, got %. Catalogue drift -- STOP, do not proceed.', affected;
  end if;
  if catalogue_total = 0 and affected <> 0 then
    raise exception 'G0-JA-1 Wave 2: unexpected % row(s) matched against an empty catalogue -- impossible state, aborting.', affected;
  end if;
end $$;

-- ===========================================================================
-- PART 3 -- the 8 GLOBAL_WITH_JURISDICTION_VARIANT items
-- (03-catalogue-matrix.md S"Class: GLOBAL_WITH_JURISDICTION_VARIANT -- 8 items")
-- country_applicability is deliberately NOT touched here -- stays NULL,
-- exactly as it is today, per Decision PO-2b (universal concept, must
-- remain globally creatable; only presentation/terminology varies, and no
-- code change implements a label variant in this wave -- see the migration
-- header and 03-catalogue-matrix.md's own explicit statement).
-- ===========================================================================

do $$
declare affected int; catalogue_total int;
begin
  select count(*) into catalogue_total from master_financial_items;
  update master_financial_items
  set applicability_class = 'GLOBAL_WITH_JURISDICTION_VARIANT'
  where (category, item_key) in (
    ('expense', 'body_corporate'),
    ('expense', 'council_rates'),
    ('retirement', 'defined_benefit'),
    ('retirement', 'employer_contributions'),
    ('retirement', 'salary_sacrifice'),
    ('retirement', 'personal_concessional'),
    ('retirement', 'non_concessional'),
    ('retirement', 'spouse_contribution')
  );
  get diagnostics affected = row_count;
  if catalogue_total > 0 and affected <> 8 then
    raise exception 'G0-JA-1 Wave 2: expected exactly 8 rows matched for GLOBAL_WITH_JURISDICTION_VARIANT backfill (catalogue already has % rows), got %. Catalogue drift since 03-catalogue-matrix.md reconciliation -- STOP, do not proceed.', catalogue_total, affected;
  end if;
  if catalogue_total = 0 and affected <> 0 then
    raise exception 'G0-JA-1 Wave 2: unexpected % row(s) matched against an empty catalogue -- impossible state, aborting.', affected;
  end if;
end $$;

-- ===========================================================================
-- PART 4 -- guard rails: confirm nothing else moved
-- ===========================================================================

do $$
declare
  catalogue_total int;
  total_classified int;
  unexpected_restricted int;
  restricted_home_or_cross_border int;
  australian_shares_still_global int;
begin
  select count(*) into catalogue_total from master_financial_items;
  select count(*) into total_classified from master_financial_items where applicability_class is not null;
  if catalogue_total > 0 and total_classified <> 20 then
    raise exception 'G0-JA-1 Wave 2: expected exactly 20 rows carrying a non-null applicability_class after this migration (catalogue has % total rows), got %.', catalogue_total, total_classified;
  end if;
  if catalogue_total = 0 and total_classified <> 0 then
    raise exception 'G0-JA-1 Wave 2: unexpected % classified row(s) against an empty catalogue -- impossible state, aborting.', total_classified;
  end if;

  -- Confirm this migration did not accidentally restrict any row outside
  -- the approved 11 (SMSF's own pre-existing ['AU'] restriction from
  -- migration 0084 is explicitly excluded from this count -- it is
  -- untouched by this file).
  select count(*) into unexpected_restricted
  from master_financial_items
  where country_applicability is not null
    and not (category = 'retirement' and item_key = 'smsf')
    and applicability_class is distinct from 'HOME_OR_CROSS_BORDER_COUNTRY';
  if unexpected_restricted <> 0 then
    raise exception 'G0-JA-1 Wave 2: % row(s) outside the approved 11 ended up with a non-null country_applicability -- aborting.', unexpected_restricted;
  end if;

  -- Exactly 11 HOME_OR_CROSS_BORDER_COUNTRY rows are actually restricted to
  -- ['AU'] -- australian_shares (the 12th) must NOT be among them.
  select count(*) into restricted_home_or_cross_border
  from master_financial_items
  where applicability_class = 'HOME_OR_CROSS_BORDER_COUNTRY'
    and country_applicability = array['AU']::char(2)[];
  if catalogue_total > 0 and restricted_home_or_cross_border <> 11 then
    raise exception 'G0-JA-1 Wave 2: expected exactly 11 HOME_OR_CROSS_BORDER_COUNTRY rows restricted to AU, got %.', restricted_home_or_cross_border;
  end if;

  select count(*) into australian_shares_still_global
  from master_financial_items
  where category = 'investment' and item_key = 'australian_shares'
    and applicability_class = 'HOME_OR_CROSS_BORDER_COUNTRY'
    and country_applicability is null;
  if catalogue_total > 0 and australian_shares_still_global <> 1 then
    raise exception 'G0-JA-1 Wave 2: australian_shares must be classified HOME_OR_CROSS_BORDER_COUNTRY with country_applicability still NULL (globally creatable) -- found % matching rows.', australian_shares_still_global;
  end if;
end $$;
