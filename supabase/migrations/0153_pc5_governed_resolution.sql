-- PC5 (M4) — governed user resolution of AIE unresolved ownership /
-- reconciliation items.
--
-- NUMBERING. `scripts/check-migration-versions.mjs` reports 147 active
-- migrations on this branch and "next version is 0153";
-- `scripts/check-migration-versions-against-branch.mjs` reports no
-- cross-branch collision against `origin/main`. Independently re-probed
-- against BOTH live databases by `scripts/pc5_migration_baseline_probe.mjs`
-- on 2026-09-15 (read-only, structural: PostgREST `PGRST205` = relation
-- absent, `42703` = column absent):
--   * Every object THIS file creates -- `ii_ownership_allocation` and the
--     three new `aie_review_decision` columns -- is ABSENT on DEV and
--     ABSENT on production. 0153 collides with nothing live.
--   * The 0149-0152 block IS live-applied on BOTH databases while still
--     unmerged to `main` (`aie_document_intake.purge_status` and
--     `.purge_due_at` from 0149, and `aie_ai_cost_ledger` from 0150, all
--     probe PRESENT on DEV and on production). 0151 and 0152 replace
--     0150's RPC bodies and so cannot be told apart by a read-only
--     structural probe; that does not affect this file, which claims
--     version 0153 and touches none of their objects.
-- So 0153 sits cleanly ON TOP of live 0149-0152 state, rather than
-- underneath state this branch cannot see.
--
-- (An earlier draft of this header asserted the opposite. It was wrong:
-- the first probe run asked for `aie_document_intake.binary_purged_at` and
-- `aie_cost_admission`, neither of which 0149/0150 ever create, and read
-- the resulting "absent" as evidence those migrations had not run. The
-- probe script now names the objects those migrations actually create,
-- read from the migration files themselves.)
--
-- PRODUCTION AUTHORITY: NONE. This file is held on
-- `mission/m4-pc5-2026-09-15` and is applied to DEV only, for PC5's own
-- live-DEV proof. No production application, no backfill, no user
-- migration.
--
-- ===========================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO
-- ===========================================================================
-- It creates NO second unresolved-item table, NO second status vocabulary,
-- NO PC5 exception queue and NO PC5 open-counter. That is the binding
-- boundary contract PC5 inherits (AIE-1.0 `AIE10-CTX-05`, `AIE10-EXC-08/09/
-- 10`, restated as Part K.3 of this mission's dispatch and as architectural
-- constraint P7 of `docs/aie-programme/AIE_1_MASTER_PLAN.md`).
-- `aie_unresolved_item` remains the single source of exception truth and
-- `aie_review_decision` remains the single immutable decision trail; every
-- PC5 status change goes through `recordReviewDecision`'s existing
-- version-checked path, exactly as AIE's own review UI and its own
-- system-actor revalidation already do.
--
-- Accordingly this file makes exactly two kinds of change:
--   (1) THREE ADDITIVE, NULLABLE COLUMNS on the EXISTING
--       `aie_review_decision` table, so K.12's required correction-overlay
--       provenance has somewhere typed to live instead of being smuggled
--       into `rationale` as an ad-hoc JSON blob. This is the identical
--       additive move migration 0144 already made on the same table for
--       AIE-1.5's correction columns, for the identical reason.
--   (2) ONE NEW TABLE, `ii_ownership_allocation` — which is NOT an
--       exception/review table at all. It is Investment Intelligence DOMAIN
--       data: the owner breakdown of an economic position. Nothing in the
--       repository can express "this folio is 50/50 between two household
--       members" today (see the inventory in the PC5 certification report:
--       every register carries a single scalar `owner` role enum, and
--       `ii_accounts.owner_member_id` is a single nullable member pointer),
--       so K.6 cannot be satisfied by reusing an existing shape. It is
--       modelled on `ii_goal_allocations` (migration 0034) rather than
--       invented: same `status in ('active','superseded','removed')` +
--       `effective_from`/`effective_to` lifecycle, same user-scoped RLS
--       shape, same "supersede, never edit in place" discipline.

-- ===========================================================================
-- SECTION 1 — aie_review_decision: K.12 correction-overlay provenance.
-- ===========================================================================
-- K.12 requires a user correction to record, alongside the decision itself:
-- the ORIGINAL extracted value, the parser/provider version that produced
-- it, and the resulting reconciliation version. Two of those three had
-- nowhere to live.
--
-- `original_value_at_decision` IS THE MASKED/TOKENISED FORM ONLY, NEVER A
-- RECOVERABLE ORIGINAL. The Product Owner's 2026-09-15 tokenisation
-- decision (one-way HMAC, no reveal — see `lib/aie/review/reveal.ts`'s
-- header) means no reversible escrow exists anywhere in this system: the
-- token map's crypto module was DELETED, not disabled. Whatever this column
-- holds is therefore either (a) a value that was never sensitive enough to
-- mask, or (b) an already-irreversible masked/partial form. It exists so a
-- reviewer can see WHAT THEY OVERRODE at the moment they overrode it, and
-- so a later auditor can tell a correction of a real extracted value apart
-- from a correction of a null — not so anyone can recover a protected
-- identifier. It is deliberately NOT a foreign key to
-- `aie_field_candidate`: candidates are immutable, but a correction must
-- remain legible even if its run's candidate rows are later purged with the
-- document lifecycle.
--
-- `parser_version_at_decision` snapshots `aie_parser_attempt.parser_version`
-- (or the AI provider/model string, for an AI-sourced candidate) as it stood
-- when the decision was taken. A later reprocess legitimately changes the
-- live value; the decision's own provenance must not silently change with
-- it.
--
-- `resulting_reconciliation_at` is the timestamp of the re-reconciliation
-- this decision triggered (K.19). It is a timestamp rather than a FK
-- because one decision fans out to MANY `aie_reconciliation_run` rows (one
-- per rule) — `aie_reconciliation_run.created_at >= this value` for the same
-- run is the join. Null means "no re-reconciliation ran", which is itself a
-- meaningful, queryable state (e.g. a `defer`, or a re-reconciliation that
-- was refused because the document is password-protected).
alter table aie_review_decision
  add column original_value_at_decision text,
  add column parser_version_at_decision text,
  add column resulting_reconciliation_at timestamptz;

comment on column aie_review_decision.original_value_at_decision is
  'PC5/K.12: the MASKED or otherwise already-irreversible extracted value this decision overrode, captured at decision time. NEVER a recoverable original — one-way HMAC masking (PO decision 2026-09-15) means no reversible form exists anywhere. Null when the decision overrode nothing (e.g. the field was absent).';
comment on column aie_review_decision.parser_version_at_decision is
  'PC5/K.12: aie_parser_attempt.parser_version (or provider/model, for an AI-sourced candidate) as it stood when this decision was taken. Frozen here so a later reprocess cannot retroactively change a decision''s provenance.';
comment on column aie_review_decision.resulting_reconciliation_at is
  'PC5/K.19: when the re-reconciliation this decision triggered ran. Join to aie_reconciliation_run on (run_id, created_at >= this). Null = no re-reconciliation ran (a defer, or a refusal such as a password-protected document that cannot be re-extracted).';

-- ===========================================================================
-- SECTION 2 — ii_ownership_allocation: K.6 joint-ownership breakdown.
-- ===========================================================================
-- ONE ECONOMIC POSITION, ONE NET-WORTH CONTRIBUTION (global invariant D.2).
-- This table records HOW an already-counted economic position is SPLIT
-- between household members. It is deliberately NOT a value/amount table
-- and carries no currency: it stores basis points of ownership and nothing
-- else, so it is structurally incapable of adding a second contribution to
-- net worth. Net worth continues to read the position exactly once from its
-- canonical II/register row; this table is read only to ATTRIBUTE that one
-- number, never to re-derive it.
--
-- BASIS POINTS, NOT PERCENT. `allocation_basis_points` is an integer out of
-- 10000. A three-way split is 3333/3333/3334 — exact, and summing to
-- exactly 10000 is checkable in integer arithmetic. `numeric(5,2)` percent
-- (the shape `business_entities.ownership_percentage` uses) cannot express
-- one third without either rounding to 33.33 (sum 99.99) or carrying a
-- repeating decimal, and "the allocations must total 100%" is a hard K.6
-- requirement, not a tolerance. The application enforces the SUM across a
-- group; the CHECK below enforces the per-row bound.
--
-- SCOPE KEY. An allocation belongs to an (account, instrument?) position:
-- `ii_account_id` is required and `ii_instrument_id` is nullable, so an
-- allocation can be recorded at whole-account grain (the normal case for a
-- jointly-held folio) or narrowed to one holding if evidence ever warrants
-- it. `allocation_group_id` ties the rows of ONE decision together — that
-- is the unit the "must total 10000" rule applies to, and the unit a
-- supersession replaces atomically.
create table ii_ownership_allocation (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- The position being attributed.
  ii_account_id uuid not null references ii_accounts(id) on delete cascade,
  ii_instrument_id uuid references ii_instruments(id),

  -- The owner this row attributes a share to. EXACTLY ONE of these two is
  -- populated (enforced below): a household member, or — where the owner is
  -- a registered non-person entity — a business entity. `owner_role` is the
  -- canonical 8-value FHIP owner enum (`lib/constants.ts` OWNER_VALUES,
  -- mirrored by the CHECK on all seven registers since migration 0004),
  -- reproduced here verbatim rather than widened: PC5 introduces NO new
  -- ownership vocabulary.
  owner_member_id uuid references household_members(id) on delete restrict,
  owner_business_entity_id uuid references business_entities(id) on delete restrict,
  owner_role text not null check (owner_role in ('self', 'spouse', 'joint', 'child', 'family_trust', 'company', 'smsf', 'other')),

  allocation_basis_points integer not null check (allocation_basis_points > 0 and allocation_basis_points <= 10000),

  -- Every row of one decision shares this id; the application enforces that
  -- the active rows of a group sum to exactly 10000.
  allocation_group_id uuid not null,

  -- Provenance: which governed decision produced this allocation. A
  -- system-defaulted equal split (K.6's "default equal ownership where no
  -- better evidence exists") records source 'system_default' and a null
  -- decision id; a user's own explicit split records 'user' and the
  -- `aie_review_decision` row that carries its audit.
  source text not null check (source in ('user', 'system_default')),
  aie_review_decision_id uuid references aie_review_decision(id),
  aie_run_id uuid references aie_extraction_run(id) on delete set null,

  status text not null default 'active' check (status in ('active', 'superseded', 'removed')),
  superseded_by_group_id uuid,
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Exactly one owner identity per row.
  constraint chk_ii_ownership_allocation_one_owner check (
    (owner_member_id is not null and owner_business_entity_id is null)
    or (owner_member_id is null and owner_business_entity_id is not null)
  ),
  -- An open-ended effective range, or a well-ordered closed one.
  constraint chk_ii_ownership_allocation_effective_range check (
    effective_to is null or effective_to >= effective_from
  ),
  -- A still-active row cannot already name its successor.
  constraint chk_ii_ownership_allocation_superseded check (
    status <> 'active' or superseded_by_group_id is null
  )
);

create index idx_ii_ownership_allocation_user on ii_ownership_allocation(user_id);
create index idx_ii_ownership_allocation_account on ii_ownership_allocation(ii_account_id);
create index idx_ii_ownership_allocation_group on ii_ownership_allocation(allocation_group_id);
create index idx_ii_ownership_allocation_active on ii_ownership_allocation(user_id, ii_account_id) where status = 'active';
-- One owner may appear at most once per allocation group.
create unique index uidx_ii_ownership_allocation_group_member
  on ii_ownership_allocation(allocation_group_id, coalesce(owner_member_id, owner_business_entity_id));

-- RLS: READ-ONLY for the owning user, deliberately UNLIKE `ii_goal_allocations`
-- (which grants `for all`). An ownership allocation is AUTHORITATIVE FINANCIAL
-- EVIDENCE attached to a governed decision — K.20 requires that a browser
-- cannot forge an owner id or an allocation, and K.6 requires every change to
-- be audited. Granting the browser a direct write would defeat both. This
-- matches the discipline `aie_unresolved_item` (migration 0140) already
-- applies to the same class of data: SELECT for the owner, every mutation
-- through the service-role-backed decision service after ownership, version
-- and total-basis-points have been checked server-side.
alter table ii_ownership_allocation enable row level security;
create policy "select own ii_ownership_allocation" on ii_ownership_allocation
  for select using (user_id = auth.uid());

comment on table ii_ownership_allocation is
  'PC5/K.6: how ONE already-counted economic position is split between household members or registered entities. Basis points out of 10000; the active rows of an allocation_group_id must total exactly 10000. Never adds a second net-worth contribution (global invariant D.2) — it attributes the single existing one. Service-role write only; SELECT-only under RLS.';

-- Cross-tenant guard, mirroring the shape `aie_assert_child_owner()`
-- (migration 0140) and `aie_ii_adapter_link_assert_ii_owner()` (migration
-- 0141) already apply: a valid foreign key is NOT proof that the referenced
-- row belongs to the same tenant. K.20's "same-user valid-FK forgery is
-- blocked for authoritative fields" is exactly this check — a caller who
-- supplies a real, existing `household_members.id` or `ii_accounts.id` that
-- belongs to somebody else is refused at the database, not merely in
-- application code.
create or replace function public.ii_ownership_allocation_assert_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select user_id into v_owner from ii_accounts where id = new.ii_account_id;
  if v_owner is null or v_owner <> new.user_id then
    raise exception 'ii_ownership_allocation.ii_account_id does not belong to user_id %', new.user_id
      using errcode = 'check_violation';
  end if;

  if new.owner_member_id is not null then
    select user_id into v_owner from household_members where id = new.owner_member_id;
    if v_owner is null or v_owner <> new.user_id then
      raise exception 'ii_ownership_allocation.owner_member_id does not belong to user_id %', new.user_id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.owner_business_entity_id is not null then
    select user_id into v_owner from business_entities where id = new.owner_business_entity_id;
    if v_owner is null or v_owner <> new.user_id then
      raise exception 'ii_ownership_allocation.owner_business_entity_id does not belong to user_id %', new.user_id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.aie_run_id is not null then
    select user_id into v_owner from aie_extraction_run where id = new.aie_run_id;
    if v_owner is null or v_owner <> new.user_id then
      raise exception 'ii_ownership_allocation.aie_run_id does not belong to user_id %', new.user_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_ii_ownership_allocation_owner
  before insert or update of user_id, ii_account_id, owner_member_id, owner_business_entity_id, aie_run_id
  on ii_ownership_allocation
  for each row execute function public.ii_ownership_allocation_assert_owner();

-- ===========================================================================
-- SECTION 3 — ii_audit_events vocabulary: PC5 resolution events.
-- ===========================================================================
-- Reuses Investment Intelligence's OWN existing audit table rather than
-- adding a PC5 one. Every prior value is reproduced verbatim from migration
-- 0067 section 3; nothing is removed.
alter table ii_audit_events drop constraint ii_audit_events_event_type_check;
alter table ii_audit_events add constraint ii_audit_events_event_type_check check (event_type in (
  -- R1 (migration 0036)
  'upload', 'parse', 'parse_completed', 'reconciliation_opened', 'reconciliation_resolved',
  'user_correction', 'admin_correction', 'publication', 'republishing', 'nav_price_update',
  'calculation', 'rule_change', 'goal_allocation', 'export', 'permission_grant',
  'permission_revoke', 'professional_access', 'archive', 'deletion',
  -- R2 (migration 0039)
  'document_uploaded', 'source_detected', 'parse_started', 'parse_failed',
  'parser_version_used', 'account_resolved', 'instrument_resolved',
  'reconciliation_case_created', 'reconciliation_case_resolved',
  'portfolio_certified', 'portfolio_certified_with_warnings', 'portfolio_failed',
  'document_superseded', 'document_processing_failed',
  -- R3 (migration 0042)
  'publication_previewed', 'publication_created', 'publication_confirmed',
  'manual_duplicate_linked', 'manual_record_superseded', 'publication_refreshed',
  'publication_superseded', 'publication_unpublished', 'publication_republished',
  'publication_failed', 'conflict_detected', 'conflict_resolved',
  -- R9 (migration 0067)
  'goal_allocation_created', 'goal_allocation_changed', 'goal_allocation_removed',
  'forecast_integration_run', 'review_item_created', 'review_item_resolved',
  'review_acknowledged', 'review_dismissed',
  -- PC5 (migration 0153) — governed resolution of AIE unresolved items.
  'pc5_resolution_decision_recorded',
  'pc5_ownership_allocation_recorded',
  'pc5_ownership_allocation_superseded',
  'pc5_statement_discarded',
  'pc5_re_reconciliation_triggered'
));
