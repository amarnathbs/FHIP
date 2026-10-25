-- WP-H3 pack 07 (ROLLBACK). Puts every row that pack 05 retired back to the status it had in the backup. Nothing else is touched.
-- Run it only if the verification shows a problem. Press Re-evaluate all positions afterwards.
begin;

do $wph3$
declare
  v_expected int;
  v_changed int;
begin
  select count(*) into v_expected
  from ii_transactions_backup_wph3_20261025 b
  join ii_transactions c on c.id = b.id
  where b.id in (select e.subject_id from ii_audit_events e where e.event_type = 'admin_correction' and e.metadata ->> 'kind' = 'wph3_duplicate_retired')
    and b.status <> 'reversed' and c.status = 'reversed';
  update ii_transactions t
     set status = b.status
    from ii_transactions_backup_wph3_20261025 b
   where t.id = b.id and t.status = 'reversed' and b.status <> 'reversed'
     and b.id in (select e.subject_id from ii_audit_events e where e.event_type = 'admin_correction' and e.metadata ->> 'kind' = 'wph3_duplicate_retired');
  get diagnostics v_changed = row_count;
  if v_changed <> v_expected then
    raise exception using message = 'WP-H3 rollback: restored ' || v_changed::text || ' rows but expected ' || v_expected::text || ', rolled back';
  end if;
  insert into ii_audit_events (user_id, event_type, subject_type, subject_id, actor_type, metadata)
  select t.user_id, 'admin_correction', 'ii_transactions', t.id, 'admin', jsonb_build_object('kind', 'wph3_duplicate_rollback', 'backup_table', 'ii_transactions_backup_wph3_20261025')
  from ii_transactions t
  where t.id in (select e.subject_id from ii_audit_events e where e.event_type = 'admin_correction' and e.metadata ->> 'kind' = 'wph3_duplicate_retired');
end
$wph3$;

commit;

select count(*) as rows_restored from ii_audit_events where metadata ->> 'kind' = 'wph3_duplicate_rollback' and created_at > now() - interval '5 minutes';
