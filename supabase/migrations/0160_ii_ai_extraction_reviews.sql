-- Investment Intelligence — AI-fallback document extraction, staged for
-- human review (2026-09-17 Product Owner addendum to the Performance-tab
-- Holdings drilldown task).
--
-- When the deterministic parser cannot recognize a document's format at all
-- ('format_unrecognized') or recognizes it but its own validation rejects
-- the result ('parse_failed'), documentProcessing.ts now tries the SAME
-- AI-fallback mechanism already built for per-scheme reconciliation
-- failures, before ever showing the user an "unrecognised format" message.
--
-- A successful AI extraction is NEVER auto-written into canonical holdings
-- (hard requirement, not a suggestion) — it is staged here with
-- status='pending_review' and shown to the user for explicit accept/reject.
-- Only accept() (aiExtractionReviewApply.ts) writes ii_transactions/
-- ii_holding_snapshots rows, reusing the exact same fingerprint-dedup,
-- certification and missing-transaction-detection logic the deterministic
-- import path already uses — never a second, parallel write path.
--
-- Not applied to DEV or production by this task — this sandbox has no
-- DDL-execution mechanism (same standing wall as every migration in this
-- repo's history since R1; see e.g. 0086/0159's own headers).

create table ii_ai_extraction_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_document_id uuid not null references ii_source_documents(id) on delete cascade,
  parse_run_id uuid references ii_document_parse_runs(id),
  trigger_reason text not null check (trigger_reason in ('format_unrecognized', 'parse_failed')),
  status text not null default 'pending_review' check (status in ('pending_review', 'accepted', 'rejected')),
  -- Array of {schemeName, isin, amcName, folioNumber, costValue, marketValue,
  -- units, asOfDateIso, transactions: [...]} — see
  -- aiFallbackDocumentExtraction.ts's AieExtractedHolding for the exact shape.
  extracted_holdings jsonb not null,
  provider_confidence numeric(5, 4) check (provider_confidence is null or (provider_confidence between 0 and 1)),
  -- Nullable: only set when the extraction can honestly state the
  -- statement's own coverage window. Drives the same "no period, no
  -- missing-transaction comparison" gate as
  -- missingTransactionDetection.ts's own principle for the deterministic
  -- path (see aiExtractionReviewApply.ts).
  statement_period_start date,
  statement_period_end date,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid -- actor id; app-validated against the authenticated user, not a hard FK (same polymorphic-reference discipline as ii_reconciliation_cases.resolved_by)
);
create index idx_ii_ai_extraction_reviews_user on ii_ai_extraction_reviews(user_id);
create index idx_ii_ai_extraction_reviews_document on ii_ai_extraction_reviews(source_document_id);

alter table ii_ai_extraction_reviews enable row level security;
create policy "own ii_ai_extraction_reviews" on ii_ai_extraction_reviews
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ii_source_documents.status — a document awaiting AI-extraction review is
-- neither 'unsupported'/'parse_failed' (the deterministic path hasn't
-- given up yet) nor 'parsed' (nothing has been written to canonical tables
-- yet) — it needs its own honest status.
alter table ii_source_documents drop constraint if exists ii_source_documents_status_check;
alter table ii_source_documents add constraint ii_source_documents_status_check check (status in (
  'uploaded', 'parsing', 'parsed', 'parse_failed', 'superseded', 'archived',
  'password_required', 'reconciliation_required', 'unsupported',
  'ai_review_pending'
));
