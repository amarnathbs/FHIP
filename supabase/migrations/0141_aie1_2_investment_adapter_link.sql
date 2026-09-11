-- AIE-1.2 — Investment Intelligence adapter: provenance link table.
--
-- NUMBERING NOTE: highest migration on `origin/main` at the time this file
-- was written is 0137. `feature/lr-1-upload-security-lifecycle` (unmerged)
-- claims 0138/0139. `feature/aie-1-1-document-gateway` (this branch's own
-- base) claims 0140. This file is numbered 0141 to leave no gap and avoid a
-- collision with any of the three. Confirmed with
-- `npx node scripts/check-migration-versions.mjs` and
-- `npx node scripts/check-migration-versions-against-branch.mjs
-- --against=origin/main` (both pass — see AIE_1_2_IMPLEMENTATION.md).
--
-- PRODUCTION AUTHORITY: NONE. Held locally on
-- feature/aie-1-2-investment-adapter, NOT applied to any DEV or production
-- database — AIE-1.2 grants no production/migration authority (spec
-- section 4, restated from AIE-1.1's P9).
--
-- SCOPE. AIE-1.2's own non-negotiable prohibitions forbid a second
-- exception-tracking system and any direct-to-canonical-table write path.
-- This table is neither of those: it is a thin, append-only PROVENANCE
-- record of the one moment an already-reconciled, already-accepted AIE
-- run's evidence was handed to Investment Intelligence's OWN existing write
-- service (`processSourceDocument`, lib/services/investment-intelligence/
-- documentProcessing.ts) to create one `ii_source_documents` row. It stores
-- no financial data of its own and makes no reconciliation decision — it
-- only answers "has this AIE run already been written once" (the
-- idempotency guard `write.ts` checks before ever creating a new
-- `ii_source_documents` row for a given run).

create table aie_ii_adapter_link (
  id uuid primary key default gen_random_uuid(),
  aie_intake_id uuid not null references aie_document_intake(id) on delete cascade,
  aie_run_id uuid not null references aie_extraction_run(id) on delete cascade,
  user_id uuid not null,
  ii_source_document_id uuid not null references ii_source_documents(id) on delete cascade,
  accepted_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  -- One AIE run may only ever produce one ii_source_documents row — the
  -- idempotency invariant AIE-1.2 section 11 requires ("atomic, idempotent
  -- canonical write").
  unique (aie_run_id),
  -- One ii_source_documents row is only ever the target of one AIE
  -- acceptance (defence in depth against a future caller accidentally
  -- reusing an ii_source_documents id across two different AIE runs).
  unique (ii_source_document_id)
);

create index idx_aie_ii_adapter_link_intake on aie_ii_adapter_link (aie_intake_id);
create index idx_aie_ii_adapter_link_user on aie_ii_adapter_link (user_id);

alter table aie_ii_adapter_link enable row level security;

-- SELECT-only for everyone, matching AIE-1.1's own established discipline
-- (lib/aie/db/repository.ts's header: every write here goes through the
-- service-role client after the caller has independently verified
-- ownership — no authenticated INSERT/UPDATE/DELETE policy exists).
create policy "select own aie_ii_adapter_link" on aie_ii_adapter_link
  for select using (user_id = auth.uid());

-- Cross-tenant integrity, reusing AIE-1.1's own trigger function (migration
-- 0140) rather than defining a second one — it already resolves
-- aie_document_intake ownership generically off `new.intake_id`/`new.user_id`.
create trigger trg_aie_ii_adapter_link_owner
  before insert or update of aie_intake_id, user_id on aie_ii_adapter_link
  for each row execute function aie_assert_child_owner();

-- Defence in depth: the linked ii_source_documents row must actually belong
-- to the same user this link row claims (aie_assert_child_owner above only
-- checks the AIE side of the join).
create or replace function aie_ii_adapter_link_assert_ii_owner()
returns trigger as $$
declare
  ii_owner uuid;
begin
  select user_id into ii_owner from ii_source_documents where id = new.ii_source_document_id;
  if ii_owner is null then
    raise exception 'aie_ii_adapter_link: ii_source_documents % does not exist', new.ii_source_document_id;
  end if;
  if new.user_id is distinct from ii_owner then
    raise exception 'aie_ii_adapter_link: cross-tenant reference — ii_source_documents % belongs to a different user', new.ii_source_document_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_aie_ii_adapter_link_ii_owner
  before insert or update of ii_source_document_id, user_id on aie_ii_adapter_link
  for each row execute function aie_ii_adapter_link_assert_ii_owner();
