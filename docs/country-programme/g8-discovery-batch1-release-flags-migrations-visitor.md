# G8 Discovery — Batch 1: Release Baseline, Feature Flags, Migrations, AU/India Anonymous-Visitor Paths (G8.001–G8.005)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff`, branch `feature/lr-1-upload-security-lifecycle` @ `73f1229` at capture time (moved from `838c542` to `73f1229` mid-investigation — see §1 finding 4). `origin/main` @ `12d4ba5` at capture time (both branch heads have since advanced further via the LR-12R reconciliation hotfixes — see [[LR12R_FINAL_CLOSURE_CERTIFICATION]]; the divergent-lineage finding below (§1.1) is independent of that and remains accurate in kind, though the specific commit list has grown).

---

## 1. Release baseline and lineage

**What defines "current"**: `package.json:3` has `"version": "0.1.0"` — grepping the whole app/lib/components tree (excluding `node_modules`) for `npm_package_version`, `require(...package.json...)`, or any import of the version field returns **zero hits**. It exists only in `package.json`/`package-lock.json` and is never surfaced anywhere: no `/api/health` or `/api/version` route, no footer build tag, no admin "About" panel. `AGENTS.md`/`CLAUDE.md`/`DEPLOYMENT.md` never mention it. There is no `CHANGELOG.md` at repo root and no `version.json`. `git tag -l` returns nothing — **zero git tags exist in this repository**. The only notion of "current" is `main`'s HEAD, and even that is contested (see below). Amplify auto-deploys `main` on push (`docs/live-recovery/LR1_PHASE_REPORT.md:3`: "Code merged to `main`, live via Amplify auto-deploy"; `amplify.yml:1-32` confirms the build pipeline with no build-ID injection into the artifact at all — no `NEXT_PUBLIC_BUILD_ID`/`GIT_COMMIT`/`VERCEL_GIT_*` pattern exists anywhere in the codebase).

**"DEV" is not a second hosted deployment.** `DEPLOYMENT.md:3-16` describes exactly one AWS Amplify app (`app.financialhealthplatform.com`) and one production Supabase project. Every LR report's "Live DEV" cell means: a local `next dev` process pointed at a *separate DEV Supabase project* (`NEXT_PUBLIC_SUPABASE_URL` in this worktree's `.env.local`, vs `PRODUCTION_SUPABASE_URL`), not a second deployed web app.

**Findings — real discrepancies between what's on `main`/this branch and each other:**

1. **This working branch and `origin/main` had diverged from a common ancestor at capture time, each independently replaying the same fixes as different commits** (`19e4db8`/`27f3f5d`, `29489a6`/`0333501`, `5447fac`/`6dc14b4`, `f2af007`/`9e4d46e`, `ab94d1f`/`1d1cec2` — same author, same timestamps, same commit messages, byte-identical diffs). Two parallel lines of history contained duplicate copies of the same patches under different SHAs. **Note (2026-09-11, post-LR12R): this pattern is structural to this session's own cherry-pick-to-main hotfix workflow** (feature branch commit → separate cherry-picked commit on `main`) — every LR-12R hotfix (self-execution guard, SMSF DTI/DSR fix, Family Trust) follows the identical dual-SHA pattern by design, confirmed intentional and disclosed at each hotfix's own commit message, not a lineage-integrity defect per se — but it does mean **there is still no single canonical commit ID for any of these fixes**, only a verified-identical pair.
2. **At capture time, `origin/main` was missing migration `0136` and its Family Trust application code** — independently confirmed and **fixed** during the LR-12R reconciliation pass the same day (see [[LR12R_FINAL_CLOSURE_CERTIFICATION]] §2 item 9 and §5). This finding is now resolved; it is preserved here as the discovery record that led to the fix.
3. **The migration registry doc (`docs/architecture/MIGRATION_REGISTRY.md`) does not track any migration past ~`0120`** — 17+ migrations behind the actual head, self-flagged as "historically stale on almost every round."
4. **The repository is not a static artifact even within a single investigation** — `HEAD` advanced mid-session from a concurrent push, illustrating live-fungibility of "the current commit" with 140+ active worktree/feature branches, no tags, and no version endpoint.
5. **Known-unapplied migrations exist by their own admission**: `0124_module11_4_standard_question_library.sql:4`, `0126_module11_5_contextual_explanations.sql:4`, `0129_g5b_generic_universal_module_write_enablement.sql:2-3` — all three explicitly state "NOT APPLIED to DEV or production by this pass."

---

## 2. Feature-flag inventory

**Env-var-gated flags** (exhaustive grep for `process.env.[A-Z_]*ENABLED|FLAG|KILL` across `app/`/`lib/`):

| Flag | File | Default | Current state (this worktree) | Gates |
|---|---|---|---|---|
| `G4_APP_CAPABILITY_LAYER_ENABLED` | `lib/services/appCapabilityFlag.ts:15,27-30` | OFF | Not set → **OFF** | Whether `requireModuleCapability()` uses the new per-module resolver, vs. falling back byte-identically to `requireCountryConfirmedUser()` |
| `G5B_GENERIC_WRITE_ENABLED` | `lib/services/g5bWriteFlag.ts:20,41-44` | OFF | Not set → **OFF** | CREATE/UPDATE for GENERIC-country users on Income/Expenses/Insurance, only when G4 is also on |
| `G2_LANDING_LOCALISATION_ENABLED` | `lib/services/landingLocalisationFlag.ts:14-16` | OFF | Not set → **OFF** | Whether the public landing page runs country resolution at all |
| `FDH_DOCUMENT_UPLOAD_ENABLED` | `lib/financial-data-hub/constants/featureFlags.ts:36-40` | ON | Not set → ON, but gated by a structural hard check below | Whether FDH document-upload API routes accept new uploads |

Plus one **structural, non-overridable hard gate**: `isKnownNonProductionSupabaseProject()` (`featureFlags.ts:29-34`) refuses document uploads unconditionally outside the one certified DEV Supabase project ref, regardless of the env-var flag's value. **Independently re-confirmed live against real production during the LR-12R reconciliation pass** (2026-09-11): a real upload attempt against production returned `403 "Statement uploads are not currently enabled in this environment"`.

Also: **`G2_ALLOW_TEST_DETECTION_HEADER`** (`landingCountryContext.ts:281-283`) — must never be `'true'` in production; lets a test-only header substitute for the real `cloudfront-viewer-country` header.

**DB-row-based flags** (`ai_platform_controls`, singleton row, migrations `0115`/`0126`): `ai_globally_enabled`, `custom_ai_enabled`, `live_provider_enabled`, `batch_generation_enabled` all default `true`; `scenario_ai_enabled` defaults `false` (a switch for a feature that doesn't exist yet); `contextual_explanations_enabled` defaults `true`.

**Findings:**

1. **None of the four env-var flags are documented in `ENVIRONMENT_VARIABLES.md`**, which lists only 5 variables and even omits some Amplify build-time ones. A real, repeated process gap.
2. **`G2_LANDING_LOCALISATION_ENABLED` was not previously catalogued in memory** — off by default, and its one activation prerequisite (CloudFront viewer-country header injection) is explicitly recorded as unconfirmed on the real Amplify distribution.
3. All flags examined correctly fail closed when unset/misconfigured (string-exact comparisons, never truthy coercion) — a consistently well-executed defensive pattern across independently-authored flags.

---

## 3. Migration inventory

132 files at capture time (`0001`–`0137`, gaps at `0079`-`0081`, `0103`, `0128` — all documented, deliberate renumbering/reservation events). 131 on `origin/main` at capture time (missing `0136` — now fixed, see §1 finding 2).

**Most recent, detailed (`0122`–`0137`, the G1-G8/LR programme era):** `0122` G1 Country Foundation (canonical `countries`/`country_capabilities` registry) · `0123` Module 11.3 null-safety fix · `0124` Module 11.4 (NOT APPLIED per its own header) · `0125` Admin A0.2 Wave 4 (the renumbered collision target for `0124`) · `0126` Module 11.5 (NOT APPLIED per its own header) · `0127` G3 registration-country expansion (GB/US/SG/AE → GENERIC) · `0129` G5B generic-write enablement (DEV ONLY per its own header) · `0130` G5B MCC-14 delete-cascade exemption fix · `0131` LR-3 bank-import surplus bridge · `0132` LR-9 account closure · `0133` LR-10 payment operationalisation · `0134` LR-11 business-entity registry (Company only) · `0135` LR-1 document-purge scheduler (renumbered from `0128`) · `0136` LR-13 Family Trust entity type · `0137` SMSF recompute `SECURITY DEFINER` fix.

**Findings:**

1. Two migrations (`0124`, `0126`) and one whole feature migration (`0129`) are, by their own header text, **not applied anywhere** as of authorship, with no later doc confirming subsequent application.
2. Prior G6 discovery already found only ~5% of migrations carry rollback documentation, clustered at `0049` and `0129`-onward — `0131`/`0135` in that same recent cluster have **no** rollback comment at all.
3. The one migration-collision guard tool (`scripts/check-migration-versions-against-branch.mjs`) is manual, not CI-wired, and — as directly demonstrated by the `0136`-missing-from-`main` finding — **cannot detect a migration silently absent from a target branch**, only two files claiming the same number.

---

## 4. AU visitor (anonymous, unauthenticated)

**Landing page**: `app/(marketing)/page.tsx` → `LandingRoute()`. Country resolution only runs `if (isG2LandingLocalisationEnabled())` — off by default, in which case the page renders its pre-G2 static-AUD markup unconditionally.

**When the flag is on**, resolution is a strict 5-tier waterfall (`computeLandingCountryContext()`, `landingCountryContext.ts:351-436`): (1) authenticated primary country, (2) anonymous manual-selection cookie (`fhip_landing_country`, validated to `{AU,IN,GLOBAL}` only, HttpOnly/Secure/SameSite=Lax), (3) the `cloudfront-viewer-country` header (AWS's own IP-geolocation, bucketed AU/IN/GLOBAL/null), (4) an unconfigured platform default (always null today), (5) neutral fallback.

**Findings:**

1. **The one real detection signal (CloudFront header) is unconfirmed to actually work in production** — its own merge commit states this explicitly as a "mandatory G8 activation prerequisite, not a merge blocker," and nothing since has confirmed it. **No `docs/g8*` directory existed prior to this discovery pass.** If the header isn't actually injected, tier 3 always resolves null and no visitor is ever geo-detected — fails safe, but means the "for Australian/Indian households" copy and country-appropriate pricing currently reach **zero anonymous visitors via automatic detection**, only via manual selection.
2. The mechanism correctly avoids every forbidden signal (no currency, no `Accept-Language`, no client-supplied raw value) — confirmed by direct inspection of every branch.
3. This presentation bucket never leaks into an authoritative field — `isAuthoritative` hardcoded `false`, type-disjoint from `CountryCode`, and the one bridge function (`toAuthoritativeCountryCodeOrNull()`) maps `GLOBAL`→`null` only, never called from any live write path.

## 5. India visitor (anonymous, unauthenticated)

Identical mechanism to §4 — India is simply the other named bucket. All findings in §4 apply equally (same unconfirmed CloudFront prerequisite, same non-authoritative isolation).

**Asymmetries found (minor/cosmetic only, none structural)**: none at the G2 landing layer (AU/IN are coequal buckets); one genuine asymmetry one layer deeper in the authoritative G1 registry — `DOMESTIC_RETIREMENT=true` only for AU, `false` for IN (no certified India retirement-product engine, by explicit registry design, invisible to an anonymous visitor of either country).

## Cross-cutting: currency/locale/IP-derived country inference

**No violation found anywhere in this batch.** The authoritative resolution path is unusually well-defended by explicit design comments (`countryGate.ts`'s own header: "Deliberately never infers country from currency, IP, browser locale, language, timezone... Deliberately never defaults an unresolved/invalid/unsupported value to AU or IN"). The one real open item is not a violation but an **unconfirmed infrastructure prerequisite** (CloudFront header injection) — its absence fails safe to neutral, never substituting currency or locale in its place.
