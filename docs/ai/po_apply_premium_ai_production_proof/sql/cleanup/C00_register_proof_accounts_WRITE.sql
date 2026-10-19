-- C00 WRITE (tiny). Register the proof accounts that the cleanup may touch. This is the ONLY list the cleanup files use.
-- Production has no managed backups, so nothing is deleted before C01 has copied the rows and C02 has shown equal counts.
-- Edit the values list: one row per proof account, with its user id (Authentication, Users, copy the id) and a label.
-- Never register a real customer. Replace the three sample ids (all zeros ending 1, 2 and 3) with your own. A wrong id here is the only way this cleanup can reach a real account,
-- so C03 also requires the account e-mail to end with the synthetic domain you type there.

create schema if not exists private;

create table if not exists private.aiproof_ids (
  user_id uuid primary key,
  label text not null,
  registered_at timestamptz not null default now()
);
alter table private.aiproof_ids enable row level security;
revoke all on private.aiproof_ids from public, anon, authenticated;

insert into private.aiproof_ids (user_id, label) values
  ('00000000-0000-0000-0000-000000000001', 'P1 premium outside the former pilot'),
  ('00000000-0000-0000-0000-000000000002', 'P2 second premium'),
  ('00000000-0000-0000-0000-000000000003', 'F1 free')
on conflict (user_id) do nothing;
