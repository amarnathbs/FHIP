# G6 Threat Model and Misuse Analysis (G6.085–G6.091)

Covers the 7 topics this phase of the master spec scopes a threat model for (canonical country relationships, NRI eligibility, cross-border holdings, source/reporting currencies, exchange-rate lineage, domestic/overseas classification, consolidated net worth) — the document's own structure stops threat-modelling at G6.091 and moves to G7 from page 106, so retirement/SMSF/FDH/etc. do not get a dedicated threat-model pass in this master spec; their security posture is covered by the discovery phase's own inventory (`g6-discovery-batch3/4.md`) and by each topic's "unchanged, reaffirmed" ownership decision, which by construction inherits whatever threat model already applies to the untouched mechanism.

Each threat below is stated as: **attack** → **why it's blocked (or not) today** → **whether G6's own changes (per `g6-data-contracts.md`) introduce, close, or leave the exposure unchanged.**

## G6.085 — Canonical country relationships

| Attack | Blocked today? | G6 effect |
|---|---|---|
| Forge another tenant's `cross_border_relationships` row via direct PostgREST | **Yes** — live-DEV certified (`scripts/g1_country_foundation_live_dev_certification.mjs`): cross-tenant SELECT/UPDATE/DELETE all rejected, forged `user_id` rejected. | Unchanged — G6 adds consumers (Contract 7/10), never touches this table's RLS. |
| Declare a relationship with a non-offered/self-referential country | **Yes** — `enforce_cross_border_country_is_foreign()` trigger (migration 0127) rejects both. | Unchanged. |
| Create a second "active" relationship with the same country to bypass a later uniqueness assumption | **Yes** — unique-active-index already certified per discovery. | Unchanged. |
| Rely on the primary-country preview's `cross_border_relationships_retained: true` as a security guarantee it never actually checked | **No** — this was a genuine, exploitable-by-confusion gap (a hardcoded claim, not a verified one) rather than a bypassable control, since nothing downstream actually trusted the field for enforcement. | **Closed by Contract 8** — the field becomes a real, computed count. |

## G6.086 — NRI eligibility

| Attack | Blocked today? | G6 effect |
|---|---|---|
| Self-declare `taxpayerType: 'RESIDENT_INDIVIDUAL'` while actually being a cross-border AU resident, to suppress the NRI disclaimer and see India-resident tax figures | **No** — confirmed live gap: the field is explicit-only by design and never cross-checked against `country_of_residence`. This is a **disclosure-suppression** risk, not a calculation-forgery risk (the underlying CGT numbers are still computed correctly for whatever inputs are given; only the caveat text is affected). | **Partially closed by Contract 9** — the disclaimer re-appears whenever `country_of_residence !== 'IN'`, regardless of the self-declared type. The self-declaration itself remains user-controlled (deliberately, per the UI's own promise) — G6 does not and should not prevent a user from declaring whatever taxpayer type they want; it only prevents the caveat from being silently hidden. |
| Access another user's `ii_tax_profiles` row | **Yes** — RLS `auth.uid()=user_id`, plus a documented forgery-fix migration (0062). Not independently re-verified this pass (disclosed). | Unchanged — G6 doesn't touch this table. |
| Use a GENERIC-country account to reach the NRI/tax UI at all | **Yes, blocked** — `requireCountryConfirmedUser()` refuses GENERIC users before the route is reached. | Unchanged. |

## G6.087 — Cross-border holdings

| Attack | Blocked today? | G6 effect |
|---|---|---|
| Set a register row's `country_code` to a value the user has no confirmed relationship with (e.g., tag an asset `SG` with no SG declaration at all) | **Not blocked today, and still not blocked after G6.** The `country_code` column on assets/liabilities/investments/retirement was never gated on "must match a confirmed relationship" — it's free-text-select from a country list. Widening the enum (Contract 1) **does not introduce a new exposure**, since no such gate existed before either; it widens the same ungated field to more values. This is disclosed here rather than silently left unexamined: a genuine future hardening opportunity (require an active `cross_border_relationships` row before a non-home country_code is accepted) is **out of scope for this phase**, matching the ownership decision's "additive, minimal" boundary. |
| Forge a direct PostgREST write setting `country_code`/`currency_code` to an unsupported combination | **Partially blocked** — Zod enforces the app-layer enum, but discovery found **no DB-level CHECK constraint mirrors it** on these four tables (unlike `preferred_currency`, which migration 0127 specifically hardened after a proven live exploit of exactly this class). **This is a real, disclosed residual risk G6 does not close** — widening the Zod enum (Contract 1) doesn't make it worse (the FK to `countries`/`currencies` already permits all 6/2 values respectively at the DB layer), but the underlying "Zod-only, no DB backstop" gap pre-dates and survives this phase. Flagged for a dedicated future hardening pass mirroring 0127's own precedent. |
| Cross-tenant read of `assetsByCountry`/etc. | **Yes, blocked** — these are computed server-side from the caller's own RLS-scoped rows only; no cross-tenant read path exists. | Unchanged. |

## G6.088 — Source and reporting currencies

| Attack | Blocked today? | G6 effect |
|---|---|---|
| Direct PostgREST PATCH setting `preferred_currency` to an unsupported value | **Blocked** — migration 0127's own `user_profiles_preferred_currency_supported_check`, added specifically after a proven live exploit. | Unchanged — G6 doesn't touch `preferred_currency`. |
| Same attack against a register row's `currency_code` (assets/liabilities/investments/retirement) | **Not blocked at the DB layer** — same residual gap as G6.087 above (Zod-only). | Unchanged by G6 (out of scope, disclosed, not silently ignored). |
| A goal's linked funding source, in a different currency, silently inflates/deflates the goal's progress with no conversion | **Not blocked today** — the exact gap Contract 6 fixes. | **Closed by Contract 6.** |

## G6.089 — Exchange-rate lineage

| Attack | Blocked today? | G6 effect |
|---|---|---|
| A user switches `preferred_currency` mid-month specifically to overwrite an inconvenient historical `financial_snapshots` figure (e.g., hiding a bad month) | **Not currently preventable, and this is a genuine, if narrow, integrity concern** — the existing upsert-by-`(user_id, snapshot_month)` behaviour means a currency switch's side effect (silent overwrite) could, in principle, be exploited deliberately, not just triggered accidentally. **G6 does not close the overwrite itself** (Contract 3 only adds the rate/rate-date columns for future auditability of *why* a figure looks the way it does) — a full fix (e.g., versioning snapshot rows instead of upserting) is a larger data-model change explicitly out of this phase's "additive, minimal" scope. Disclosed as a residual risk, not silently left unexamined. |
| Forge a direct write to `forecast_global_assumptions.fx_rate_aud_inr` to manipulate every user's calculations | **Out of scope for this topic** — that table's own RLS/write-permission model is unrelated to G6 and not touched here; not independently re-verified this pass. |

## G6.090 — Domestic and overseas classification

| Attack | Blocked today? | G6 effect |
|---|---|---|
| Exploit `applyCurrencyShock`'s or `applicabilityNote`'s private inline domestic/overseas comparison logic diverging subtly from each other over time (a maintenance risk, not a live exploit) | N/A — no live exploit exists, since both are private, correct, independently-written comparisons today. | **Reduced by Contract 4** — extracting `isDomesticRecord()` into one shared function means both call sites can never silently drift apart in the future; this is a hardening-by-construction change, not a response to a live vulnerability. |
| Supply a client-side `homeCountryCode` override to `isDomesticRecord()` to misclassify records | **Not applicable** — per Contract 4's own signature, `homeCountryCode` is always the caller's already-server-resolved `country_of_residence`, never a request-body parameter; the new function accepts no client input at all. |

## G6.091 — Consolidated net worth

| Attack | Blocked today? | G6 effect |
|---|---|---|
| Forge a `country_code` on a personal asset row to inflate the new `netWorthByCountryConverted` breakdown for a country the user doesn't actually reside in or use to make the multi-country view look more favourable/complete | **Same residual gap as G6.087/088** (no DB-level country_code CHECK) — the new field (Contract 5) is a read-side aggregation over the same rows `netWorth` already trusts, so it inherits, not worsens, that existing gap. No new attack surface is created; the existing one is merely made visible through one more lens. |
| Cross-tenant read of another user's consolidated or per-country net worth | **Blocked** — same RLS-scoped query pattern as every other dashboard field; the new field is computed server-side from the same already-scoped `input.assets`/etc. arrays, never a new query. |
| Double-count a business entity's value in both the blended `netWorth` and the new per-country breakdown | **Blocked by construction** — `businessEntityOwnershipValue` (LR-11) has no `country_code` field at all (confirmed in discovery), so it cannot appear in `netWorthByCountryConverted`'s per-country grouping; it only ever appears once, in the blended total, exactly as today. |

---

## Cross-cutting residual risks disclosed by this threat model (not fixed in G6, named explicitly)

1. **No DB-level CHECK constraint mirrors the Zod `currency_code`/`country_code` enums on `assets`/`liabilities`/`investments`/`retirement_accounts`** — the same class of gap migration 0127 fixed for `preferred_currency` after a proven live exploit, never extended to these four tables. Recommended as a dedicated future hardening migration, explicitly out of G6's own additive/minimal scope.
2. **`financial_snapshots`' upsert-by-month behaviour allows a currency switch to silently overwrite a prior month's figures** — Contract 3 adds provenance (rate/rate-date) but does not prevent the overwrite itself. A full fix requires snapshot versioning, a larger change than this phase's boundary permits.
3. **Neither of the two risks above is introduced by G6** — both are pre-existing, and G6's own changes (widening enums, adding read-side fields) do not make either worse; they are disclosed here because this phase's own threat-model pass is the first place either has been formally named as a security/integrity consideration rather than left implicit in code comments.
