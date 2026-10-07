-- ---------------------------------------------------------------------------
-- PART D starts here: hash only promo codes, columns and privileges
-- ---------------------------------------------------------------------------
-- Design (PO ruling, item 1): a code is looked up by a keyed digest (HMAC SHA 256 with a dedicated
-- versioned secret that never reaches the database). The plain code column stays for the migration window
-- only: part by part the backfill script digests every existing row, verifies the copy, and the finalise
-- function then blanks the plain value for verified rows. New codes never store a plain value.

alter table public.promo_codes add column if not exists code_digest text;
alter table public.promo_codes add column if not exists code_digest_version int;
alter table public.promo_codes add column if not exists code_digest_verified_at timestamptz;
alter table public.promo_codes add column if not exists anonymised_at timestamptz;
alter table public.promo_codes alter column code drop not null;

do $fn$
begin
  if not exists (select 1 from pg_constraint where conname = 'promo_codes_digest_shape' and conrelid = 'public.promo_codes'::regclass) then
    alter table public.promo_codes add constraint promo_codes_digest_shape
      check (code_digest is null or (code_digest ~ '^[0-9a-f]{64}$' and code_digest_version is not null and code_digest_version >= 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'promo_codes_has_identity' and conrelid = 'public.promo_codes'::regclass) then
    alter table public.promo_codes add constraint promo_codes_has_identity
      check (code is not null or code_digest is not null or anonymised_at is not null);
  end if;
end $fn$;

create unique index if not exists uq_promo_codes_digest on public.promo_codes (code_digest) where code_digest is not null;

comment on column public.promo_codes.code is
  'Hardening 0264: LEGACY plain code. Null for every code created after 0264 and blanked by promo_codes_finalise_hash_only() once the digest copy is verified. Not readable by API roles.';
comment on column public.promo_codes.code_digest is
  'Hardening 0264 item 1: hex HMAC SHA 256 of the normalised code under the versioned PROMO_CODE_DIGEST_SECRET (domain prefix promo-code:v then the version). The secret never reaches the database. Not readable by API roles.';
comment on column public.promo_codes.code_digest_version is
  'Hardening 0264 item 1: which key version produced code_digest. Used for the dual verify window during key rotation.';
comment on column public.promo_codes.code_digest_verified_at is
  'Hardening 0264 item 1: set only by the backfill script after it recomputed the digest of the plain value and compared. Required before the plain value can be blanked.';
comment on column public.promo_codes.anonymised_at is
  'Hardening 0264 item 7: set by the retention job when an old disabled or expired code was stripped of its note and digest. The row stays for the audit trail.';

-- API roles must not read the plain code, the digest or the bound address hash through the table.
-- (The admin functions are SECURITY DEFINER and are unaffected.)
revoke select on public.promo_codes from anon, authenticated;
grant select (id, code_hint, duration_days, max_redemptions, redemption_count, expires_on, note, status, created_by,
              created_at, disabled_by, disabled_at, disable_reason, anonymised_at)
  on public.promo_codes to authenticated;
