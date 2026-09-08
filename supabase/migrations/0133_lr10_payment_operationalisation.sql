-- LR-10 — AU/India/Global Payment Operationalisation.
--
-- Extends the previously static user_entitlements.plan_tier flag (migration
-- 0010: no subscription lifecycle columns at all, no write path except
-- manual SQL -- see this phase's own discovery) with real subscription
-- state, and adds a webhook-event idempotency table. Both are additive --
-- no existing column, constraint, or row is altered; plan_tier itself keeps
-- its exact meaning and every existing reader of it (lib/services/
-- entitlements.ts's getPlanTier()/canExportReports()) is untouched.
--
-- WHY user_entitlements, not a new table: this IS the canonical entitlement
-- register (Report exports, WP-05 gating in LR-8, already read it) -- adding
-- a second "subscriptions" table with its own plan_tier-equivalent would be
-- exactly the "duplicate source of truth" this programme's own cross-cutting
-- failure-mode table warns against. provider_subscription_id is the FK-like
-- link back to the provider's own record; plan_tier remains the single
-- boolean-ish gate every existing consumer already reads.

alter table user_entitlements
  add column if not exists provider text check (provider in ('stripe', 'razorpay')),
  add column if not exists provider_customer_id text,
  add column if not exists provider_subscription_id text,
  add column if not exists subscription_status text
    check (subscription_status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid')),
  add column if not exists price_id text,
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false;

comment on column user_entitlements.provider is
  'LR-10: which payment provider owns this subscription -- stripe (AU/Global) or razorpay (India), per the Product Owner''s explicit two-provider decision. NULL for every free-tier user (no subscription exists).';
comment on column user_entitlements.provider_subscription_id is
  'LR-10: the provider''s own subscription/order identifier -- the join key used by both webhook handlers (lib/services/payments/entitlementSync.ts) to find which row a verified event applies to. Never client-supplied; only ever set from a verified webhook payload or the server-side checkout-session creation response.';
comment on column user_entitlements.price_id is
  'LR-10: the canonical internal plan-catalogue ID (lib/services/paymentPlanCatalogue.ts), not a raw provider price/plan ID -- lets a future catalogue re-point which provider ID backs a given plan without rewriting every entitlement row.';
comment on column user_entitlements.subscription_status is
  'LR-10: the provider''s own subscription lifecycle state, mirrored verbatim (not reinterpreted) from its webhook vocabulary. NULL for free-tier users. plan_tier itself is still the one field every existing consumer reads for Premium/Free gating -- see entitlementSync.ts for exactly which subscription_status values keep plan_tier=''premium'' vs. revert it to ''free''.';

-- WP-06 (webhook security) -- idempotency and replay protection. Providers
-- explicitly document that the SAME webhook event may be delivered more
-- than once (retry-on-timeout, at-least-once delivery); this table is the
-- single source of truth both webhook routes consult before ever touching
-- user_entitlements, so a duplicate delivery is a no-op, not a double-apply
-- (NEG-04 "duplicate entitlement").
create table payment_webhook_events (
  provider text not null check (provider in ('stripe', 'razorpay')),
  provider_event_id text not null,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received' check (processing_status in ('received', 'processed', 'ignored', 'failed')),
  failure_reason text,
  primary key (provider, provider_event_id)
);

comment on table payment_webhook_events is
  'LR-10 WP-06: webhook-delivery idempotency ledger. No raw card/payment-instrument data is ever stored here or anywhere in this schema -- only the provider''s own event id/type and this application''s processing outcome. Written only by the two webhook routes using the service-role client (server-to-server, signature-verified before any write) -- see this table''s own RLS below.';

alter table payment_webhook_events enable row level security;
-- Deliberately NO policies and no grants to authenticated/anon -- identical
-- discipline to migration 0129's mcc_generic_write_capabilities: this table
-- is never read or written by any client-side/authenticated-role call, only
-- by the service-role webhook handlers, which bypass RLS as table owner.

-- ROLLBACK: `alter table user_entitlements drop column provider, drop column
-- provider_customer_id, drop column provider_subscription_id, drop column
-- subscription_status, drop column price_id, drop column current_period_end,
-- drop column cancel_at_period_end;` and `drop table payment_webhook_events;`.
-- Safe at any point before a real subscription has been created through
-- this schema -- no other table has a foreign key into either new object.
