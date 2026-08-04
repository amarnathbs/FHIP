-- Module 1 reuses foundation tables (user_profiles, households, user_goals).
-- Auto-create an empty profile row whenever a new auth.users row is created.
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_profiles (user_id) values (new.id)
  on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
