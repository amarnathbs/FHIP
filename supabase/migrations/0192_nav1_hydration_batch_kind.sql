-- NAV 1 Stage D (D.9 follow-up) — give selective hydration its own batch kind.
--
-- WHY. Hydration is about to open a 'running' row in ii_reference_import_batches
-- at the start of each run and update it as each instrument completes, so a run
-- the platform kills still leaves a record of how far it got, and so two runs
-- cannot overlap.
--
-- But both "is anything still running?" checks are scoped by batch kind: the
-- PC6 ingest job reconciles and refuses on 'running' rows matching its own
-- source_key + batch_kind (referenceIngestJob.ts), and since D.4 hydration has
-- logged under source_key 'amfi', batch_kind 'nav_history' -- exactly the scope
-- of the ingest job's AMFI history backfills. The moment hydration wrote a
-- 'running' row, the two jobs would block each other, or each would mark the
-- other's live run as a stale failure. A distinct kind keeps the two scopes
-- disjoint.
--
-- STRICT SUPERSET. This constraint is dropped and recreated, so the list below
-- is the constraint currently in force -- 0157's six values, NOT 0155's
-- original five -- plus exactly one new value. A recreated constraint that
-- omitted a value would silently refuse every future batch of that kind.
-- scripts/nav1_0192_pglite_verification.mjs derives the predecessor from the
-- migration ledger and asserts this.

alter table ii_reference_import_batches drop constraint if exists ii_reference_import_batches_batch_kind_check;
alter table ii_reference_import_batches
  add constraint ii_reference_import_batches_batch_kind_check
  check (batch_kind in (
    'scheme_master',
    'daily_nav',
    'nav_history',
    'benchmark_level',
    'risk_free_rate',
    'fund_holdings_disclosure',
    -- NAV 1 Stage D (this migration). One batch == one selective-hydration
    -- run, which may fetch history for several instruments, from AMFI or the
    -- TIGZIG fallback; each row's own data_version names its provider.
    'nav_hydration'
  ));
