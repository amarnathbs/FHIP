-- LR-13 — Family Trust entity (LR-11 fast-follow). Widens business_entities'
-- entity_type CHECK constraint, planned and disclosed from LR-11's own day
-- one (migration 0134's own header: "Constrained to 'company' only for this
-- phase -- Family Trust is a planned forward migration widening this
-- CHECK, not a design unknown").
--
-- Reuses the exact literal 'family_trust' already used elsewhere in this
-- codebase (lib/constants.ts's OWNER_VALUES, migration 0004) -- no new
-- vocabulary introduced.
--
-- Deliberately does NOT add any trustee/beneficiary/distribution-rule
-- column or table. Per the original LR-11 spec's own Product Owner locks
-- ("Do not invent legal advice or beneficial-ownership rules not
-- approved"), a Family Trust here is modelled with the EXACT SAME
-- ownership_percentage-based consolidation Company already uses -- this
-- user's own declared economic share of the entity's net asset value,
-- however that share is legally structured. No RLS change: the existing
-- policies (migration 0134) are entity_type-agnostic. No data backfill:
-- every existing row is already 'company'.

alter table business_entities drop constraint business_entities_entity_type_check;
alter table business_entities add constraint business_entities_entity_type_check
  check (entity_type in ('company', 'family_trust'));

-- ROLLBACK: `alter table business_entities drop constraint
-- business_entities_entity_type_check; alter table business_entities add
-- constraint business_entities_entity_type_check check (entity_type in
-- ('company'));` -- safe only if no 'family_trust' rows exist yet.
