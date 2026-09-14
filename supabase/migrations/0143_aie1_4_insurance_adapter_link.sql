-- AIE-1.4 — Insurance adapter: provenance/amendment-lineage link table.
--
-- NUMBERING NOTE: highest migration on `origin/main` at the time this file
-- was written is 0137. `feature/aie-1-1-document-gateway` (this branch's
-- own base) claims 0140. The two sibling AIE adapters built concurrently
-- off the same base claim 0141 (`feature/aie-1-2-investment-adapter`) and
-- 0142 (`feature/aie-1-3-fdh-bank-adapter`, itself renumbered once already
-- after a real collision with 0141 — see that branch's own commit
-- 83eb0cd). This file is numbered 0143 to leave no gap and avoid a
-- collision with any of the three. Confirmed by fetching all three
-- branches directly (not guesswork) and running
-- `npx node scripts/check-migration-versions.mjs` and
-- `npx node scripts/check-migration-versions-against-branch.mjs` against
-- `origin/main`, `origin/feature/aie-1-1-document-gateway`,
-- `origin/feature/aie-1-2-investment-adapter` and
-- `origin/feature/aie-1-3-fdh-bank-adapter` — see
-- AIE_1_4_IMPLEMENTATION.md for the exact commands/output.
--
-- PRODUCTION AUTHORITY: NONE. Held locally on
-- feature/aie-1-4-other-modules, NOT applied to any DEV or production
-- database — AIE-1.4 grants no production/migration authority (spec
-- section 4, restated from AIE-1.1's P9).
--
-- SCOPE. AIE-1.4's own non-negotiable prohibitions forbid a second
-- exception-tracking system and any direct-to-canonical-table write path.
-- This table is neither of those: it is a thin, append-only PROVENANCE
-- record of the moment an already-reconciled, already-accepted AIE run's
-- evidence was handed to Insurance's OWN existing write service
-- (`makeRegistry('insurance_policies').save()`,
-- lib/services/registry.ts — the SAME function
-- app/api/insurance/route.ts's manual-entry POST handler already calls) to
-- create or amend one `insurance_policies` row. It stores no financial
-- data of its own and makes no reconciliation decision.
--
-- AMENDMENT LINEAGE (AIE14-INS-12). Unlike AIE-1.2's `aie_ii_adapter_link`
-- (one AIE run <-> one immutable ii_source_documents row, both directions
-- unique), a single `insurance_policies` row is legitimately updated over
-- time by successive documents (a policy schedule, then a later renewal
-- notice, then a later premium notice for the SAME policy, all sharing the
-- caller-supplied `master_item_key` `lib/services/registry.ts`'s `save()`
-- upserts on). So this table intentionally has NO
-- `unique (insurance_policy_id)` constraint — many AIE runs may point at
-- the same policy row over its lifetime, and querying this table by
-- `insurance_policy_id` (indexed below) IS the amendment-lineage trail:
-- which AIE-processed documents, in what order, produced or updated this
-- policy row. Only `aie_run_id` is unique — the idempotency invariant
-- AIE-1.4 section 5/AIE14-INS-12 requires ("idempotent canonical write":
-- one run can never be written twice).

create table aie_insurance_adapter_link (
  id uuid primary key default gen_random_uuid(),
  aie_intake_id uuid not null references aie_document_intake(id) on delete cascade,
  aie_run_id uuid not null references aie_extraction_run(id) on delete cascade,
  user_id uuid not null,
  insurance_policy_id uuid not null references insurance_policies(id) on delete cascade,
  accepted_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  -- One AIE run may only ever produce/amend one insurance_policies write —
  -- the idempotency invariant AIE-1.4 section 5 requires.
  unique (aie_run_id)
);

create index idx_aie_insurance_adapter_link_intake on aie_insurance_adapter_link (aie_intake_id);
create index idx_aie_insurance_adapter_link_user on aie_insurance_adapter_link (user_id);
create index idx_aie_insurance_adapter_link_policy on aie_insurance_adapter_link (insurance_policy_id);

alter table aie_insurance_adapter_link enable row level security;

-- SELECT-only for everyone, matching AIE-1.1/1.2/1.3's own established
-- discipline (lib/aie/db/repository.ts's header: every write here goes
-- through the service-role client after the caller has independently
-- verified ownership — no authenticated INSERT/UPDATE/DELETE policy
-- exists).
create policy "select own aie_insurance_adapter_link" on aie_insurance_adapter_link
  for select using (user_id = auth.uid());

-- Cross-tenant integrity, reusing AIE-1.1's own trigger function (migration
-- 0140) rather than defining a second one — it already resolves
-- aie_document_intake ownership generically off `new.intake_id`/`new.user_id`.
create trigger trg_aie_insurance_adapter_link_owner
  before insert or update of aie_intake_id, user_id on aie_insurance_adapter_link
  for each row execute function aie_assert_child_owner();

-- Defence in depth: the linked insurance_policies row must actually belong
-- to the same user this link row claims (aie_assert_child_owner above only
-- checks the AIE side of the join) — same pattern as AIE-1.2's
-- `aie_ii_adapter_link_assert_ii_owner()`.
create or replace function aie_insurance_adapter_link_assert_policy_owner()
returns trigger as $$
declare
  policy_owner uuid;
begin
  select user_id into policy_owner from insurance_policies where id = new.insurance_policy_id;
  if policy_owner is null then
    raise exception 'aie_insurance_adapter_link: insurance_policies % does not exist', new.insurance_policy_id;
  end if;
  if new.user_id is distinct from policy_owner then
    raise exception 'aie_insurance_adapter_link: cross-tenant reference — insurance_policies % belongs to a different user', new.insurance_policy_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_aie_insurance_adapter_link_policy_owner
  before insert or update of insurance_policy_id, user_id on aie_insurance_adapter_link
  for each row execute function aie_insurance_adapter_link_assert_policy_owner();
