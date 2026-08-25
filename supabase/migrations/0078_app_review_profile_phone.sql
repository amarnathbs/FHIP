-- App Review spec §16 (Profile Page). Adds the one column user_profiles was
-- genuinely missing for the new Profile page's "Contact number" field.
-- Name/DOB/country/currency/employment_status all already exist
-- (0001_foundation.sql); Email is intentionally NOT duplicated here — it
-- lives solely in auth.users and is displayed/changed via Supabase Auth's
-- own updateUser({ email }) flow (spec §16.1), never mirrored into this
-- table, to avoid a second, driftable copy of a security-sensitive field.
alter table user_profiles
  add column if not exists phone text;
