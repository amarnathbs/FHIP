-- Public marketing-site "Contact" page (components/marketing/LandingPage.tsx's
-- footer link, previously a dead "#" placeholder). Submissions come from an
-- unauthenticated visitor via app/api/contact/route.ts, which uses the
-- service-role client — so there is no INSERT policy for the anon/authenticated
-- roles below; RLS is enabled with zero policies, meaning only the service
-- role (which bypasses RLS entirely) can touch this table. A real signed-in
-- user's session must never be able to read or write another visitor's
-- contact submission.
create table contact_submissions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  message text not null,
  email_sent boolean not null default false,
  created_at timestamptz not null default now()
);

alter table contact_submissions enable row level security;
