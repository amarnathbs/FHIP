-- 0311 -- Exactly-once at the database level for a statement's imported lines (Document2 (4) F15, PO-D24-03).
--
-- The background import job (0310) inserts a statement's lines over several short slices and decides what is still missing by
-- reading what already exists. This index is the safety net underneath that rule: a statement can never hold two lines with the
-- same source row number, even if two slices ever raced. A violation fails the write loudly instead of silently duplicating a
-- transaction.
--
-- Plain unique index on (statement_upload_id, source_row). A NULL in either column never conflicts, so manually entered
-- transactions (no statement) and any legacy row without a row number are unaffected.
--
-- ADDITIVE AND SAFE ON EXISTING DATA. If any statement ALREADY holds two lines with the same source row number (not expected: the
-- importers number lines 1..N and key a map on that number), the index is NOT created, a notice says so, and the job still works
-- (it checks before it inserts). Nothing is deleted or changed. The read-only check in docs/reviews/po_apply_wp_g lists such rows.

do $$
begin
  if exists (
    select 1
      from fdh_transactions
     where statement_upload_id is not null and source_row is not null
     group by statement_upload_id, source_row
    having count(*) > 1
  ) then
    raise notice '0311: some statements already hold duplicate (statement_upload_id, source_row) pairs; the unique index was NOT created. Run the read-only check in docs/reviews/po_apply_wp_g first.';
  else
    create unique index if not exists uq_fdh_transactions_statement_source_row
      on fdh_transactions (statement_upload_id, source_row);
  end if;
end $$;
