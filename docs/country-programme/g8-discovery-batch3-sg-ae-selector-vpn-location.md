# G8 Discovery — Batch 3: SG/AE Accounts, Manual Overrides, VPN/Travel, Missing-Location (G8.011–G8.015)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff` @ `838c542` at capture time.

## 1. SG generic account

SG is registry-seeded `experience_level='GENERIC'`, `is_supported=false`, `default_currency_code='SGD'`. A confirmed-SG user's reachable surface today (G4/G5B both off): `/global-setup`, `/profile` (genuinely universal — no country gate on that route at all), cross-border-relationship declaration (`requireCountryConfirmedUserAllowingGeneric`), and the primary-country preview/confirm workflow. Reporting currency is locked to AUD/INR only — SGD, SG's own registry currency, is never reachable. Billing-country confirmation is explicitly **blocked** for SG (`app/api/user/billing-country/confirm/route.ts` uses the strict, non-`AllowingGeneric` gate).

**Findings**: no SG-specific special-casing exists anywhere (grepped `lib/`/`app/` for `'SG'` — only the shared six-country vocabulary array, never a conditional branch). A **stale evidence-trail finding**: `appCapability.ts:522`'s `AI_INSIGHTS` manifest note claims an unfixed gap that was actually already fixed in an earlier commit (`0f6ee4e`) predating the note's own commit (`5af5150`) — the manifest is currently wrong about its own history, worth a one-line correction before this file is cited as authoritative evidence again.

## 2. AE generic account

Registry-seeded identically in structure to SG/GB/US, same single cross-country migration statement. Checked specifically for a hardcoded "UAE has no personal income tax" claim (a plausible temptation) — **none found**; `countryDisclosure.ts`'s GENERIC copy is the single shared string for all four generic countries, with no country-specific tax-system claim anywhere. **Findings**: none — same clean result as GB/US/SG.

## 3. Manual selector overrides

Traced every write path to `country_of_residence`/`country_confirmed_at`. The anonymous landing cookie (`POST /api/landing/country`) is the only writer of the presentation bucket, is `httpOnly`, validated to 3 values, and `isAuthoritative:false` hardcoded on every branch. The confirm-country page reads it only to pre-select a dropdown option (a value already on the account always outranks it; `GLOBAL` preselects nothing) — the actual write RPC (`confirm_country_of_residence()`) never reads the cookie at all, and independently re-validates server-side regardless of client input. **The stated master rule holds by construction**, not just by convention.

**Findings**: `confirm_country_of_residence()` has no re-confirmation friction for an already-confirmed user calling the API directly with a genuinely *different* country — no cooling-off, no "are you sure." Not currently exploitable (the UI never re-presents the form to an already-confirmed user, and the destination requires a real disclosure acknowledgement for GENERIC), but worth naming as a hardening candidate for a compromised-session scenario.

## 4. VPN and travel scenarios

**There is no IP-based geolocation anywhere in this codebase**, confirmed by exhaustive grep (ip-api, geoip, MaxMind, ipinfo, x-forwarded-for, cf-ipcountry — zero real hits; the one "hit" is a comment documenting defensive handling of MaxMind pseudo-codes in a **country header**, not an IP lookup). The only detection signal (`cloudfront-viewer-country`) is a header, not an IP; unconfirmed to even be live in production (Batch 1 finding); presentation-only, `isAuthoritative:false`; and outranked by both authenticated-confirmed and anonymous-manual-selection tiers.

**Findings**: VPN/travel scenarios are a non-issue **by construction** — there is nothing for a VPN or genuine travel to fool, since nothing infers location from IP at all. Worth stating explicitly as the finding (the absence itself is the security property being verified), not marking "N/A."

## 5. Missing-location behavior

At signup, `country_of_residence` has no DB default and is genuinely `NULL` (not `'AU'`). `OnboardingWizard.tsx` was previously found and fixed for exactly this pattern (comment at `:66-71` documents the historical `'AU'`-prefill defect it replaced) — the wizard blocks progression until a country is chosen. `assertCountryConfirmedForUser()` on a `NULL` residence correctly classifies `COUNTRY_MISSING`, and every downstream layer (UI redirect, ~241 API routes' 403, the DB trigger backstop) fails closed to `/confirm-country` with **no silent default anywhere** in the path.

**Findings**: `POST /api/onboarding/complete` has **no server-side check** that a country was ever actually set before flipping `onboarding_completed=true` — only client-side wizard validation prevents reaching this call without one. A direct call to this endpoint (skipping the wizard) would leave `onboarding_completed=true` with `country_of_residence=NULL` simultaneously — a reachable, unvalidated DB state. Does **not** currently produce an unsafe outcome (the downstream `COUNTRY_MISSING` gate still fails closed everywhere), but relies entirely on a different module's correctness rather than being prevented at the point of writing — worth a defensive `assertCountryConfirmedForUser`-style check at this endpoint too.

## Cross-cutting: currency/locale/IP inference

No violation found across any of the five topics. Two now-fixed historical exceptions cited as useful precedent: `resilienceStress.ts`'s `applyCurrencyShock()` and `retirementMemberData.ts`'s `=== 'IN' ? 'IN' : 'AU'` defects (both G0-JA-1/G5-D1, both confirmed fixed). No `Accept-Language`/browser-locale reference exists anywhere in the country/currency resolution code.
