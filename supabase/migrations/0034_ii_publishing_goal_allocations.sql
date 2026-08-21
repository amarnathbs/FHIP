-- Investment Intelligence R1 — Migration D: the FHIP publishing bridge and
-- the goal-allocation mirror. ii_fhip_publications is the ONLY entity with a
-- direct FK relationship to existing FHIP register tables — deliberately:
-- Investment Intelligence has exactly one write path into the rest of FHIP
-- (R0_DOMAIN_ARCHITECTURE.md section 5). R1 creates this table as a
-- structural foundation only — no production publishing is activated
-- (spec section 33; see lib/services/investment-intelligence/publishing.ts
-- for the explicit "not wired to any UI/cron in R1" note).
--
-- Governing docs: R0_FHIP_PUBLISHING_CONTRACT.md, R0_NET_WORTH_DEDUP_CONTRACT.md,
-- R0_GOAL_INTEGRATION_CONTRACT.md, ADR-004, ADR-006.

-- ---------------------------------------------------------------------------
-- ii_fhip_publications — records exactly which canonical Investment
-- Intelligence position was published into which assets/investments/
-- retirement_accounts row. unique(canonical_position_id) is the
-- database-level dedup guarantee (ADR-004): a refresh UPDATEs this row's
-- linkage in place, it never INSERTs a second publication for the same
-- position. published_row_id is a plain uuid (not a single FK) since it
-- points at one of three different tables — same pattern as
-- goal_funding_sources' three nullable linked-id columns, enforced at the
-- application layer (R1_IMPLEMENTATION_SPEC.md section 1 item 17).
-- ---------------------------------------------------------------------------
create table ii_fhip_publications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  canonical_position_id uuid not null references ii_holding_snapshots(id),
  publication_target text not null check (publication_target in ('assets', 'investments', 'retirement_accounts')),
  published_row_id uuid, -- app-validated pointer into assets/investments/retirement_accounts; never enforced as a single FK
  status text not null default 'published' check (status in ('published', 'unpublished', 'superseded')),
  include_in_net_worth boolean not null default true, -- the explicit, auditable dedup off-switch (ADR-004)
  published_at timestamptz not null default now(),
  last_republished_at timestamptz,
  unique (canonical_position_id)
);
create index idx_ii_fhip_publications_user on ii_fhip_publications(user_id);
create index idx_ii_fhip_publications_published_row on ii_fhip_publications(published_row_id) where published_row_id is not null;

alter table ii_fhip_publications enable row level security;
create policy "own ii_fhip_publications" on ii_fhip_publications
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ii_goal_allocations — the Investment-Intelligence-side mirror of
-- goal_funding_sources, anchored to the PRE-publication canonical position
-- so allocation history survives a republish/relink (R0_GOAL_INTEGRATION_CONTRACT.md
-- section 1). investment_position_id deliberately has no single hard FK: it
-- may point at an ii_holding_snapshots.id (pre-publication) or an
-- ii_fhip_publications.id (post-publication) depending on when the
-- allocation was created — app-validated, same polymorphic-reference
-- discipline as ii_fhip_publications.published_row_id above.
-- goal_id IS a direct, enforced FK — Goals remains canonical (design
-- principle 10); on delete cascade matches goal_funding_sources.goal_id's
-- existing semantics exactly (removes only the allocation row, never the
-- underlying published position).
-- ---------------------------------------------------------------------------
create table ii_goal_allocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  investment_position_id uuid not null,
  goal_id uuid not null references user_goals(id) on delete cascade,
  allocation_type text not null check (allocation_type in ('percentage', 'fixed_amount', 'residual')),
  allocation_value numeric(18, 4), -- percentage or fixed amount; nullable for 'residual'
  source text not null check (source in ('user', 'system_suggested')),
  status text not null default 'active' check (status in ('active', 'superseded', 'removed')),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_ii_goal_allocations_user on ii_goal_allocations(user_id);
create index idx_ii_goal_allocations_goal on ii_goal_allocations(goal_id);
create index idx_ii_goal_allocations_position on ii_goal_allocations(investment_position_id);

alter table ii_goal_allocations enable row level security;
create policy "own ii_goal_allocations" on ii_goal_allocations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
