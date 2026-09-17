-- M4B — HUF (Hindu Undivided Family) as a business_entities entity_type,
-- restricted to users whose authoritative home jurisdiction is India.
--
-- PRODUCT OWNER DECISION (2026-09-15), verbatim: *"it is similar to family
-- trust, create this in similar line for only Indian users. All features of
-- family trust need to adopt for HUF which is similar in nature."*
--
-- This closes PO-PC5-1, the open decision PC5 raised and deliberately
-- refused to close itself
-- (`docs/investment-intelligence/PC5_IMPLEMENTATION_CERTIFICATION_2026-09-15.md`
-- §9). PC5 offered three options; the Product Owner chose option (a) —
-- *"accept that an HUF-held folio is recorded as a `business_entities` row,
-- which requires widening `entity_type` beyond `('company','family_trust')`"*
-- — which is exactly and only what PART 1 below does.
--
-- NUMBERING. `scripts/check-migration-versions.mjs` reports 148 active
-- migrations on this branch and "next version is 0154";
-- `scripts/check-migration-versions-against-branch.mjs` reports no
-- cross-branch collision against `origin/main`. Independently re-probed
-- FRESH against BOTH live databases on 2026-09-15 by
-- `scripts/pc5_migration_baseline_probe.mjs` (read-only, structural) and by
-- `scripts/m4b_huf_migration_baseline_probe.mjs` (this phase's own,
-- behavioural): 0149-0152 are live-applied on DEV and production while still
-- absent from `main`'s folder (the mission's standing finding, so the
-- tooling's own count is not trusted on its own); 0153's objects are ABSENT
-- on both databases, so 0153 is genuinely still unapplied; and a real
-- `entity_type = 'huf'` insert is REFUSED by
-- `business_entities_entity_type_check` (SQLSTATE 23514) on both databases,
-- proving this migration has not somehow already run. 0154 therefore sits
-- cleanly on top of live 0149-0152 state, alongside the still-unapplied
-- 0153, and collides with nothing.
--
-- PRODUCTION AUTHORITY: NONE. Held on `mission/m4b-huf-2026-09-15`. No
-- production application, no backfill, no user migration.

-- ===========================================================================
-- PART 1 — widen the entity_type CHECK. Additive and non-destructive,
-- identical in shape to the move migration 0136 (LR-13, Family Trust) made
-- to migration 0134's original 'company'-only CHECK.
-- ===========================================================================
-- Every prior value is reproduced verbatim; nothing is removed. No data
-- backfill: every existing row is 'company' or 'family_trust' and is
-- untouched. No RLS change: migration 0134's policies are entity_type-
-- agnostic and stay exactly as they are.
--
-- Deliberately does NOT add any coparcener / karta / HUF-deed / partition
-- column or table, and does NOT touch `lib/constants.ts`'s `OWNER_VALUES`
-- or the `owner` CHECK on any of the seven financial-data-grid registers.
-- This is the SAME restraint migration 0136 exercised for Family Trust, for
-- the same two reasons:
--
--   (1) LR-11's Product Owner lock — *"Do not invent legal advice or
--       beneficial-ownership rules not approved"* — so an HUF here is
--       modelled with the EXACT SAME `ownership_percentage`-based
--       consolidation Company and Family Trust already use: this user's own
--       declared economic share of the entity's net asset value, however
--       that share is legally structured under Hindu law.
--
--   (2) `entity_type` and the registers' `owner` column are SEPARATE
--       vocabularies. `'company'`/`'family_trust'` appear in BOTH only by
--       historical accident: they were added to `OWNER_VALUES` by migration
--       0004 as cosmetic free-text owner TAGS years before any entity
--       workspace existed, backed nothing, and were subsequently RETIRED
--       from new rows by LR-11B (`LEGACY_ENTITY_OWNER_RESTRICTIONS`,
--       `lib/constants.ts`) precisely because they created a double-counting
--       trap. When FHIP shipped the REAL Family Trust feature, migration
--       0136 added the value to `entity_type` ONLY and to nothing else.
--       Adding `'huf'` to `OWNER_VALUES` would mean minting a NINTH owner
--       tag with no valuation, consolidation or net-worth semantics behind
--       it, widening the `owner` CHECK on all seven registers plus
--       `ii_fhip_publications.published_owner` — the mistake LR-11B had to
--       clean up, repeated a third time. PC5's own certification called that
--       option "indefensible" and the Product Owner did not ask for it.
--       See `docs/investment-intelligence/PC5_HUF_ADDENDUM_2026-09-15.md`
--       §4 for the full evidence trail.

alter table business_entities drop constraint business_entities_entity_type_check;
alter table business_entities add constraint business_entities_entity_type_check
  check (entity_type in ('company', 'family_trust', 'huf'));

-- ===========================================================================
-- PART 2 — India-only gate (defence in depth).
-- ===========================================================================
-- THIS IS THE ONE THING FAMILY TRUST DID NOT NEED. Company and Family Trust
-- are deliberately jurisdiction-AGNOSTIC (migration 0134's own header, and
-- `app/api/business-entities/route.ts`'s own comment: WP-09's lesson that
-- Company/Trust must NOT copy SMSF's AU-only assumption without evidence).
-- A Hindu Undivided Family is different in kind: it is a creature of Indian
-- personal law with no analogue in any other jurisdiction this platform
-- serves, and the Product Owner scoped it "for only Indian users".
--
-- WHY A DATABASE TRIGGER AND NOT JUST THE API ROUTE. `business_entities`'
-- RLS policy (migration 0134) is `for all using (auth.uid() = user_id)`:
-- an authenticated user can INSERT into this table DIRECTLY through
-- PostgREST with their own token, never touching
-- `app/api/business-entities/route.ts`. An application-layer check alone
-- would therefore be bypassable by anyone who can read the network tab.
-- This is exactly the situation GEO-2 faced for SMSF, and this trigger is
-- deliberately a near-verbatim reuse of its answer —
-- `retirement_accounts_smsf_au_gate()`, migration
-- `0084_geo_jurisdiction_smsf.sql` PART 2 — rather than a new pattern.
--
-- NOT `security definer`, for the same reason 0084 is not: the function's
-- own SELECT against `user_profiles` runs as the INVOKING role and is
-- itself RLS-scoped to `auth.uid()`, so a caller who forges `new.user_id`
-- to another tenant's id sees zero rows, `is_in` stays NULL, and
-- `coalesce(is_in, false)` rejects them — identically to a genuine non-India
-- resident. It fails closed in both directions.
--
-- WHAT IS GATED, AND WHAT IS NOT. Only the transition INTO an active HUF
-- row: a fresh INSERT, an UPDATE that reactivates an archived HUF, or an
-- UPDATE that converts an existing row's `entity_type` TO 'huf'. Editing an
-- ALREADY-active HUF's other fields (name, net asset value, ownership
-- percentage, notes) is NEVER blocked, whatever the user's current country
-- — that is legitimate maintenance of a preserved historical holding, and
-- matches 0084's own explicit rule that a jurisdiction change must never
-- freeze or hide an existing legitimate record. Archiving is never blocked
-- either.
--
-- The authoritative field is `user_profiles.country_of_residence`, the
-- canonical home-jurisdiction field this codebase already treats as
-- authoritative (`lib/services/jurisdiction.ts`'s `getUserHomeCountry`,
-- whose own header forbids the `?? 'AU'` fallback for a security-relevant
-- gate). It is NEVER `households.primary_country`, never a currency-derived
-- guess, and never a client-supplied value.

create or replace function business_entities_huf_india_gate() returns trigger as $$
declare
  is_in boolean;
begin
  if new.entity_type = 'huf' and new.is_active = true
     and (
       tg_op = 'INSERT'
       or (tg_op = 'UPDATE' and (
             coalesce(old.is_active, false) = false
             or old.entity_type is distinct from 'huf'
           ))
     ) then
    select (p.country_of_residence = 'IN') into is_in
    from user_profiles p
    where p.user_id = new.user_id;

    if coalesce(is_in, false) is not true then
      raise exception 'huf: a Hindu Undivided Family can only be created by users whose home jurisdiction (country_of_residence) is India'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_business_entities_huf_india_gate on business_entities;
create trigger trg_business_entities_huf_india_gate
  before insert or update of entity_type, is_active, user_id on business_entities
  for each row execute function business_entities_huf_india_gate();

comment on function business_entities_huf_india_gate() is
  'M4B server-side jurisdiction gate for entity_type = ''huf'' (PO decision 2026-09-15, closing PO-PC5-1). Modelled verbatim on retirement_accounts_smsf_au_gate() (migration 0084 PART 2). Runs as the invoking role (NOT security definer): its own SELECT against user_profiles is RLS-scoped to auth.uid(), so a forged new.user_id belonging to another tenant sees zero rows (is_in stays NULL) and is rejected exactly as a genuine non-India resident -- fails closed either way. Gates only the transition INTO an active HUF row; editing or archiving an already-active HUF is never blocked, matching 0084''s own rule that a jurisdiction change must not freeze an existing legitimate holding.';

-- ROLLBACK:
--   `drop trigger if exists trg_business_entities_huf_india_gate on
--    business_entities; drop function if exists
--    business_entities_huf_india_gate(); alter table business_entities drop
--    constraint business_entities_entity_type_check; alter table
--    business_entities add constraint business_entities_entity_type_check
--    check (entity_type in ('company', 'family_trust'));`
-- The CHECK half is safe only if no 'huf' rows exist yet; the trigger half
-- is safe at any point.
