-- =============================================================================
-- Resources / Financial Knowledge & Insights — R1.5 public settings read
-- =============================================================================
-- R1.5 spec §57: "Use the centrally managed Resources disclaimer/settings
-- where implemented. Do not copy/paste separate disclaimer wording into each
-- public component." resource_settings already carries a seeded
-- `default_disclaimer` value (migration 0034) plus the @GKTC channel handle/
-- URL — but migration 0033 only ever granted it a staff-only SELECT policy
-- ("staff read settings", private.is_resource_staff(auth.uid())). An
-- anonymous/ordinary-authenticated public visitor genuinely cannot read it
-- today, which would force R1.5 to hard-code a duplicate copy of the
-- disclaimer string instead of reading the one real source of truth — this
-- is the one genuine, narrow schema gap R1.5 found (spec §131 D: "expected
-- None unless a genuine gap requires a narrow migration").
--
-- Kept intentionally narrow: an explicit fixed allowlist of three known-safe
-- keys (not "any settings row"), so nothing sensitive/internal that might
-- later be added to resource_settings (e.g. workflow tuning values) is
-- silently exposed to anon by this policy. All three values are already
-- either publicly visible elsewhere (the @GKTC handle/URL are shown in every
-- public video's attribution and R1.4's own YouTube embed component) or
-- explicitly meant for public display (the disclaimer itself).
create policy "public read safe settings" on resource_settings for select
  using (key in ('default_disclaimer', 'youtube_channel_handle', 'youtube_channel_url'));

-- resource_settings already has a blanket SELECT grant to anon/authenticated
-- from migration 0033 (`grant select on resource_categories, ...,
-- resource_settings, ... to anon, authenticated;`) — RLS (the policy above)
-- is what actually narrows the visible rows, so no grant change is needed
-- here, matching the same pattern every other R1.1 public-read policy uses.
