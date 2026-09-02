-- Admin A0.2 Wave 4 — Authorization, Audit and Result-State Consistency.
--
-- Real, high-risk audit gap found and closed this Wave (spec §9, priorities
-- 2 and 4: "publication/unpublication/approval/suspension/reinstatement";
-- "Benchmark approval/suspension/reinstatement/material source changes").
--
-- PUT /api/admin/benchmarks/sources/[id] (Wave 3, commit 31f6437) lets a
-- Super Admin approve, suspend or reinstate a benchmark_sources row (any
-- status transition in ('draft','under_review','approved','active',
-- 'superseded','suspended','archived')) but never wrote any audit evidence
-- for it — unlike the sibling dataset lifecycle (activate/retire), which
-- already inserts a benchmark_update_runs row on every outcome (migration
-- 0011). benchmark_update_runs already has a nullable `source_id` column
-- (references benchmark_sources(id)) that was defined in 0011 but has never
-- actually been populated by any INSERT in this codebase — it was added
-- ahead of a write path that was never built until now.
--
-- This migration does not create a new audit table (Standard §10: prefer
-- integrating into an existing structure over a parallel one; this Wave's
-- own §9 instruction: "do not duplicate an existing complete event; add
-- narrowly scoped evidence only where needed"). It only widens
-- benchmark_update_runs.approval_status's CHECK constraint so the table can
-- honestly record a benchmark_sources status transition using the actual
-- resulting status (draft/under_review/approved/active/superseded/
-- suspended/archived) rather than force-fitting it into the dataset-import
-- vocabulary of 'pending'/'approved'/'rejected' the column was originally
-- scoped for. 'pending' and 'rejected' are retained for backward
-- compatibility with the existing dataset-activation-failure write path
-- (app/api/admin/benchmarks/datasets/[id]/activate/route.ts) — nothing
-- already written to this table is invalidated or reinterpreted.
--
-- No RLS change: benchmark_update_runs already has RLS enabled with zero
-- SELECT/INSERT/UPDATE/DELETE policies for `authenticated` (0011's own
-- comment: "service-role only") — this migration does not alter that; the
-- application-layer route continues to write through the service-role
-- client only, identical to every existing write path into this table.

alter table benchmark_update_runs
  drop constraint if exists benchmark_update_runs_approval_status_check;

alter table benchmark_update_runs
  add constraint benchmark_update_runs_approval_status_check
  check (approval_status in (
    'pending', 'approved', 'rejected',
    'draft', 'under_review', 'active', 'superseded', 'suspended', 'archived'
  ));
