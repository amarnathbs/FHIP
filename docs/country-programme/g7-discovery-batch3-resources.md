# G7 Discovery Batch 3 — Resources Module (G7.009–G7.013)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff` @ `b7afa72`.

## G7.009 — Resources applicability taxonomy

Every Resources post carries jurisdiction tagging — but it is a **jurisdiction taxonomy of exactly four values**, not a country registry, and it predates G1's country foundation by many migrations.

**Schema** (R1.1 foundation): `resource_posts.jurisdiction` — `text not null default 'global' check (jurisdiction in ('global','australia','india','australia_india_cross_border'))` (`supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql:484`, re-emission of archived `0033_resources_foundation.sql`). Indexed. Same 4-value enum reused on `resource_faqs.jurisdiction` (nullable) and `resource_sources.jurisdiction` (nullable). TS type: `ResourceJurisdiction` (`lib/resources/types.ts:40,67`). Canonical labels: `JURISDICTION_LABELS`/`JURISDICTION_VALUES` (`lib/resources/admin/labels.ts:46-56`).

**What it is NOT:** no `country_code` column anywhere in `resource_*` schema, no FK to the G1 `countries` table, no mapping to GB/US/SG/AE — "global" is the closest concept to "universal," and GENERIC countries have no jurisdiction bucket of their own.

**Classification: live and connected**, but scoped only to AU/IN/global/cross-border, not the G1 country registry — a pre-existing, narrower taxonomy a country-alignment requirement would need to reconcile with, not something newly missing.

## G7.010 — Resources filtering

**No automatic geolocation/IP/session-based filtering exists.** What exists is a manual, reader-operated jurisdiction filter:
- Topic browse: `app/(marketing)/resources/topic/[slug]/page.tsx:47` reads `search.jurisdiction` from the URL query string. UI: `components/resources/public/TopicFilterBar.tsx` — client-side `<select>` rewriting the URL query string, explicit comment: "Use URL state... do not store public filter state only in React memory."
- Search: `app/(marketing)/resources/(browse)/search/page.tsx:36` → `normalizeJurisdictionFilter` → `searchPublicResources` → RPC `search_resource_posts(p_jurisdiction)`. Same URL-state pattern.
- Query logic: `lib/resources/public/queries.ts:118-126` (`applyJurisdictionFilter()`) — explicit design decision: **selected jurisdiction + Global** (not exact-jurisdiction-only).
- Default: `jurisdiction=all` on first load — every visitor sees the full unfiltered list unless they manually pick one.

**Zero IP-geolocation/`Accept-Language`/cookie-based country inference anywhere in Resources.** Verified via repo-wide search for `geoip|geolocation|cf-ipcountry|x-vercel-ip-country|ipapi|maxmind` (zero matches in `app/`, `lib/`, `components/`). The one geolocation-adjacent module, `lib/services/landingCountryContext.ts` (G2's canonical pre-auth **landing**-experience resolver), is never imported anywhere under `app/(marketing)/resources/**`. `[slug]/page.tsx` calls `supabase.auth.getUser()` only for session-state CTA adaptation, never for filtering.

**Classification: live and connected** — a content taxonomy chosen by the reader, explicitly not tied to any authoritative country signal (correctly satisfies "reject client-supplied country as a substitute" since there is no such substitute pretending to be one here — it's an honest, labelled filter).

## G7.011 — Resources admin governance

Jurisdiction tagging is **mandatory and validated** in the editorial workflow, fully wired since R1.1/R1.3:
- Editor UI: `components/resources/editor/MetadataSidebar.tsx:159-167` — required `SelectField label="Jurisdiction"`.
- Server-side gate: `lib/resources/editor/validation.ts:85` — `if (!post.jurisdiction) errors.jurisdiction = 'Jurisdiction is required.'` inside `validateForReview()`, blocking a draft from entering editorial/compliance review without it.
- Admin list filter/search, badges: `ResourceFilters.tsx`, `lib/resources/admin/filters.ts`, `ResourceBadges.tsx`, `ResourceContentTable.tsx`.
- DB grant: `jurisdiction` is an author/editor-writable column (`0049:904-910`), ordinary editorial content, not a workflow-control column.

**What does NOT exist:** no country-registry-driven field (no reference to `countries`/`country_capabilities`), no GB/US/SG/AE option. **Side finding:** the Resources admin dashboard route itself is gated by `countryConfirmationBlockResponse` (`app/api/admin/resources/dashboard/route.ts:5,24-25`) — a staff editor must have an AU/IN-confirmed residence country to access the CMS that manages country-agnostic content aimed at readers worldwide. This is the general app-wide MCC admin gate, not Resources-specific, but a real coupling worth flagging.

**Classification: live and connected** — the review workflow already requires and enforces jurisdiction tagging today, built before G1's country foundation existed, structurally independent of it.

## G7.012 — Recommendation applicability

Country/jurisdiction IS a real matching dimension for the ~542-row `action_recommendation_master` library — a **hybrid**, predominantly financial-metric-based, with a genuine, narrow country-code matching dimension for a specific subset.

**Owner:** `lib/engines/recommendations/matcher.ts`/`types.ts` (pure), `lib/services/recommendationsData.ts` (I/O), `app/api/recommendations/route.ts`.

**Core matching fields:** `forecast_category`, `recommendation_signal`, `forecast_status`, `variance_result` — dominate the seeded condition rows (`supabase/migrations/0020_recommendations_data_import.sql:770-2915`).

**Country IS a real 5th matching field for a subset:** 28 rows at the tail of the seed file (lines 2791-2915) carry an explicit `('<CODE>', 1, 'country_code', 'equals', 'AU'|'IN', ...)` condition — e.g. `AU_RET_SUPER_GUARANTEE_MISSING`, `IN_RET_EPF_CONTRIBUTION_GAP`. Per `matcher.ts:26-56`'s `evaluateCondition()`, a `null` context value never matches (except `is_null`), so a household with no resolved country_code never matches an AU/IN-scoped row.

**Authoritative source (correctly NOT currency/client-derived):** `recommendationsData.ts:100` reads `profile.country_code` off `forecast_profiles`, itself populated from `user_profiles.country_of_residence` (`forecastData.ts:54`, explicit comment: "never re-derived from currency (the defect this replaces)"). `recommendationsData.ts:179-187` queries `country_of_residence` directly for the pillar-signals path too. Both trace to the correct MCC-owned source.

**GENERIC-country reachability: moot in practice** — `app/api/recommendations/route.ts` gates on `requireCountryConfirmedUser`, which delegates to `is_country_confirmed()` joining `countries.is_supported` (still `false` for GB/US/SG/AE post-G3). A GENERIC-experience user can never reach the Recommendations API at all — the AU/IN-scoped condition rows are unreachable for GENERIC by construction, one layer up from the matcher itself.

**appCapability.ts note undersells the finding:** `RECOMMENDATIONS.note` (`appCapability.ts:470-478`) says "not independently re-certified as country-neutral" — but the library demonstrably has AU/IN-only-triggering rows built in by design (28 confirmed rows), a stronger and different statement than "not yet certified."

**Controls:** `tests/unit/recommendationsPillarSignals.test.ts:31-32,47-49` covers `country_code` passthrough. **No dedicated test file exists for `matcher.ts` at all** — zero positive/negative control proving an AU-scoped condition fires only for AU and not IN/null.

**Classification: partially wired** — country is a genuine, already-built matching dimension, correctly sourced, but (a) undocumented as such in the capability manifest, (b) zero direct unit-test coverage of the country-conditional branch, (c) currently moot for GENERIC only because of an unrelated upstream gate, not because the engine was designed with GENERIC in mind.

## G7.013 — Generic-country limitations

**Confirmed: the public Resources site is fully reachable by GENERIC-country users, zero auth/country gate, identical content to everyone else** (subject only to the same manual filter every visitor can operate — G7.010).

Evidence: no `middleware.ts` exists anywhere in the repo. No layout-level auth check (`app/(marketing)/resources/layout.tsx` has only nav/footer chrome). `[slug]/page.tsx`'s `auth.getUser()` call is purely a CTA-personalization touch — never gates rendering (`post` fetched and rendered before the auth check). RLS backstop: `resource_posts` policy `"public read published posts"` has **no `auth.uid()` condition at all** — migration comment states explicitly: "Public/anon AND ordinary authenticated customers get exactly the same read policy — being logged in grants no extra Resources access." Matches `appCapability.ts`'s own framing: the `RESOURCES` capability (`requiredCapability: LOCALISED_RESOURCES`) has **zero consumers anywhere in the codebase** outside its own definition — backend-only, never wired to any actual gate, consistent with there being no authenticated in-app Resources surface for it to gate.

**What a GENERIC visitor sees:** exactly the same list/detail pages as an AU or IN visitor, defaulting to `jurisdiction=all`, with the same four filter choices (Australia/India/Global/Australia-India) available to any visitor regardless of origin — no GB/US/SG/AE bucket exists and none auto-selects.

**Classification: live and connected** — confirmed-correct behaviour, not a gap. One observation: the manifest's `RESOURCES` capability entry describes a hypothetical future in-app Resources feature, since no such surface currently exists.

## Cross-cutting notes for the orchestrator

1. **No canonical country-aware ownership exists for Resources content or Recommendations matching** in the G1/`countries`/`country_capabilities` sense. Resources uses its own older, narrower `jurisdiction` enum (pre-dating G1 entirely); Recommendations uses a raw `country_code` text condition value fed from MCC's `country_of_residence`, also independent of `country_capabilities`. **Reconciling these three vocabularies (G1 `countries.country_code`, Resources' 4-value `jurisdiction`, Recommendations' free-text condition values) is a genuine open design question.**
2. Resources has full workflow history/versioning/audit (`resource_workflow_history`, `resource_post_versions`, `resource_audit_log`) but none currently record jurisdiction *changes* specifically as their own dedicated trail (a jurisdiction edit would show up in a version diff, not a dedicated log).
3. **Cannot verify** the "R1.7D... 76/84 records approved" certification's own docs ever mention "country" — `grep -l country docs/resources/*.md` returns zero hits, only "jurisdiction." Supports the conclusion that the country dimension was genuinely out of scope for whatever certification pass(es) occurred.
