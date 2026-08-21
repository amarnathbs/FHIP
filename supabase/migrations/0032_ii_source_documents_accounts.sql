-- Investment Intelligence R1 — Migration B: source-document provenance
-- anchor + account/folio foundation. Both user-owned, owner-only RLS,
-- identical to every existing FHIP table (R0_SECURITY_RLS_ARCHITECTURE.md).
--
-- Governing docs: R0_CANONICAL_DATA_CONTRACT.md (ii_source_documents,
-- ii_accounts), R0_SOURCE_PROVENANCE_CONTRACT.md, ADR-003.

-- ---------------------------------------------------------------------------
-- ii_source_documents — one row per uploaded/ingested evidence document (a
-- CAS PDF, a broker contract note, a manual-entry event record). The root
-- of the provenance chain. Immutable once uploaded: a revised statement is
-- a NEW row (superseded_by_document_id), never an edit to this one
-- (R0_SOURCE_PROVENANCE_CONTRACT.md section 2 — never mutated to make
-- reconciliation appear successful).
-- ---------------------------------------------------------------------------
create table ii_source_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  owner_member_id uuid references household_members(id), -- nullable: statement may cover an unconfirmed member
  country_code char(2) not null references countries(country_code),
  source_id uuid references ii_sources(id),
  status text not null default 'uploaded' check (status in ('uploaded', 'parsing', 'parsed', 'parse_failed', 'superseded', 'archived')),
  checksum text, -- content hash — de-duplication key for "is this file already uploaded"
  superseded_by_document_id uuid references ii_source_documents(id),
  storage_path text not null, -- private-bucket object key, service-role-write-only (never client-generated path)
  original_filename text not null,
  mime_type text not null,
  file_size bigint not null check (file_size >= 0),
  uploaded_at timestamptz not null default now(),
  document_type text check (document_type in ('cas_statement', 'demat_statement', 'contract_note', 'manual_entry_record', 'other')),
  statement_period_start date,
  statement_period_end date,
  statement_as_of_date date,
  parser_version text,
  parse_completed_at timestamptz,
  parse_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_ii_source_documents_user on ii_source_documents(user_id);
create index idx_ii_source_documents_status on ii_source_documents(status); -- picked up by any future background parser worker
-- Re-upload detection (R1_IMPLEMENTATION_SPEC.md section 2): the identical
-- file, re-uploaded by the same user, resolves deterministically rather than
-- silently duplicating (PROV-008/DB-006).
create unique index uidx_ii_source_documents_user_checksum
  on ii_source_documents(user_id, checksum)
  where checksum is not null;

alter table ii_source_documents enable row level security;
create policy "own ii_source_documents" on ii_source_documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ii_accounts — the account/folio/demat container a holding sits inside.
-- account_number_masked only (never the full unmasked provider number —
-- R0_SECURITY_RLS_ARCHITECTURE.md). folio_number kept as a nullable core
-- column since "folio" is common enough across countries' managed-fund
-- concepts to justify it (R0_CANONICAL_DATA_CONTRACT.md).
-- ---------------------------------------------------------------------------
create table ii_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  owner_member_id uuid references household_members(id), -- nullable until confirmed (R0_FHIP_PUBLISHING_CONTRACT.md OWNER gate)
  country_code char(2) not null references countries(country_code),
  currency_code char(3) not null references currencies(currency_code),
  source_document_id uuid references ii_source_documents(id), -- nullable: an account can be manually declared before any statement
  status text not null default 'active' check (status in ('active', 'closed', 'archived')),
  account_type text not null check (account_type in ('demat', 'mf_folio', 'broker', 'retirement', 'bank_linked', 'other')),
  institution_name text not null,
  account_number_masked text,
  folio_number text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_ii_accounts_user on ii_accounts(user_id);
create index idx_ii_accounts_source_document on ii_accounts(source_document_id) where source_document_id is not null;

alter table ii_accounts enable row level security;
create policy "own ii_accounts" on ii_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
