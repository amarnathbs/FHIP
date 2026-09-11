# G8 Discovery — Batch 4: Confirmed-Account Precedence, Existing-User Backfill, Country-Change, Cross-Border Reconciliation, Multi-Currency Integrity (G8.016–G8.020)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff` @ `838c542` at capture time.

## 1. Confirmed-account precedence

**Verified: yes, unconditionally.** `computeLandingCountryContext()`'s Tier 1 (authenticated confirmed primary country) is checked before the anonymous cookie or any detected geography. The anonymous cookie is never written to `user_profiles`; the one write RPC (`confirm_country_of_residence()`) never reads it. An explicit adversarial scenario is named in the code itself ("G3-14 — a forged AU landing cookie against a user whose account says IN"). **Findings**: none — the strongest-defended of all topics in this batch, with a structural (not just conventional) guarantee.

## 2. Existing missing-country users (pre-MCC accounts)

Migration `0104` deliberately leaves `country_confirmed_at=NULL` for every pre-existing row ("provenance for historical AU/IN values could not be established"). `assertCountryConfirmedForUser()` classifies such a user `COUNTRY_UNCONFIRMED`, and `app/(app)/layout.tsx` redirects on **every** route including `/admin` — no admin exemption. A DB-level `BEFORE INSERT` trigger backstops 8 foundational tables against a forged direct write.

**Findings**: the DB backstop is **explicitly scoped to only 8 tables**, not every table added since — not independently re-verified against every one of 130+ later migrations (a "cannot verify," not a confirmed gap). Separately: 4 of 5 AI Insights routes resolve auth via a helper that imports plain `requireUser()` (auth-only), not `requireCountryConfirmedUser()` — a country-**unconfirmed** authenticated user can reach those specific API routes today, disclosed in-repo as a real, unremediated completeness gap.

## 3. Country-change workflow (residence, not billing)

Changing `country_of_residence` via `PUT /api/user/profile` resets `country_confirmed_at`/`country_source` to null in the same update, forcing re-confirmation via `/confirm-country`. Historical financial data is confirmed untouched (no register table is read/written by this route).

**Findings — a real, previously-undetected gap**: `user_profiles.primary_country` is a **structurally separate** column from `country_of_residence`, and `confirm_country_of_residence()` (the RPC the residence-reconfirmation flow calls) **never touches `primary_country`**. Since every previously-confirmed user already has `primary_country` populated by a one-time historical backfill, changing and reconfirming `country_of_residence` (e.g. AU→IN) leaves `primary_country` silently stale at the old value — and `primary_country`, not `country_of_residence`, is what actually drives `resolveCountryContext()`'s experience level/capabilities/currency, which in turn drives every G4 module-gating decision. **No UI surface exists at all** for the compensating action (`primary_country`'s own preview/confirm API pair is real and correctly built, but has zero consumers — the same "built, no consumer" pattern G6 found for `cross_border_relationships`). No test covers this specific interaction.

## 4. Cross-border reconciliation

**Still accurate as of G6: `cross_border_relationships` is purely declarative; no reconciliation/merge/compare logic consumes it.** What's genuinely new since G6: `resolveCountryContext()` (which reads the table) now has real, wired consumers via `requireModuleCapability()` — 21 production routes — but gated behind `G4_APP_CAPABILITY_LAYER_ENABLED` (confirmed off). The specific `crossBorderCountries` field itself remains completely unconsumed even by that new capability layer — only `primaryCountry`/`experienceLevel`/`capabilities` are read. Self-disclosed as declaration-only in three independent places (migration comment, manifest note, UI copy).

**Findings**: no reconciliation logic exists anywhere, matching G6 — the nuance added this batch is that the *service function* now has real (non-cross-border) consumers, while the *table/field* itself still has zero.

## 5. Multi-currency integrity

The FK-only ceiling G6 disclosed is **confirmed still open**: `assets`/`liabilities`/`investments`/`retirement_accounts.currency_code` are FK-constrained to `currencies`, not CHECK-constrained to `{AUD,INR}` — and since G1, `currencies` legitimately holds 6 rows (AUD/INR/GBP/USD/SGD/AED), making the FK a genuine 6-value allowlist, not an accidentally-narrow one. Only the application-layer Zod schema (`z.enum(['AUD','INR'])`, no DB mirror) prevents a non-AUD/INR write today.

**Findings — sharper evidence than G6 had**: `convertToReportingCurrency()` (`lib/engines/fx.ts:14-22`) is typed `'AUD'|'INR'` only at compile time; at runtime, a `'GBP'` `currency_code` reaching this function would be **silently treated as AUD** in its `else` branch (no fail-closed path for an unrecognised currency) — a real, demonstrable miscalculation path, not just a theoretical constraint gap. A second, independently-disclosed instance of the identical class exists at the G5B GENERIC-write boundary: even once G4+G5B are turned on, `income.ts`/`expense.ts`/`insurance.ts`'s own Zod schemas still hardcode AUD/INR only, so a GBP/USD/SGD/AED household still cannot submit a schema-valid payload — confirming this is a systemic Zod-schema-vs-registry drift pattern, not a one-off oversight on the four G6-named tables.

## Cross-cutting: currency/locale/IP inference

No violation found in the authenticated/authoritative path across any of the five topics — `countryGate.ts`'s and `confirm_country_of_residence()`'s own headers explicitly state the rule and their parameter lists structurally cannot accept currency/locale/IP as substitutes. The one genuine residual risk found this batch (Topic 5) is a **currency-mislabelling** defect once a non-AUD/INR value reaches `fx.ts`, not a country-inference bug — country is never the value being guessed in that path, only the exchange-rate direction.
