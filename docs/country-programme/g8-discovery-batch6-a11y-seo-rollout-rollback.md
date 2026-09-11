# G8 Discovery — Batch 6: Country-Programme Accessibility, SEO/Canonical Identity, Controlled Cohort Rollout, Flag Reversibility (G8.021–G8.024, final batch — completes G8 discovery 001–028)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff` @ `b4d6c91` at capture time. Not a repeat of `LR_CONSOLIDATED_ACCESSIBILITY_MOBILE_SWEEP.md`/FDH's own accessibility docs — this batch covers country-programme-specific surfaces those never touch (confirm-country, global-setup, billing-country, the G2 selector), which live in different route groups.

## 1. Accessibility of country-programme-specific UI

**No flag/emoji iconography exists anywhere in the country programme** (exhaustive grep) — every country control is a plain `<select>` with text-only options, eliminating one entire risk class the topic asked about. `ConfirmCountryForm.tsx` is the best-executed a11y surface in the programme: real `aria-required`/`aria-invalid`/`aria-describedby` wiring to a `role="alert"` error, a `role="region" aria-live="polite"` coverage disclosure, and a never-pre-checked, properly-validated generic-disclosure acknowledgement.

**Findings — genuine gaps:**

1. **The G2 landing selector's own explanatory hint is unreachable to a mobile screen reader by construction.** `CountrySelector.tsx`'s `aria-describedby` points at a hint paragraph that `CountrySelector.module.css` sets `display:none` on at `max-width:640px` — `display:none` removes it from the a11y tree entirely (not a visually-hidden pattern). On any phone, a screen-reader user gets the bare label with none of the "this doesn't confirm your account" reassurance a desktop screen-reader user gets. A CLS-avoidance CSS rule with an undisclosed accessibility side effect, not a reasoned tradeoff.
2. **`BillingPanel.tsx`'s country-confirm error has no `role="alert"`/`aria-live`**, unlike every comparable error elsewhere in the programme (`ConfirmCountryForm.tsx` uses `role="alert"` for the equivalent case) — a screen-reader user gets no announcement when a billing-country change is rejected. The billing-country `<select>` also lacks the `aria-describedby` link to its own helper text that the equivalent `ConfirmCountryForm` select has.
3. **`OnboardingWizard.tsx`'s pre-MCC country select is less accessible than the reporting-currency select six lines below it in the same step, same file** — no `required`/`aria-required`/`aria-invalid`/`aria-describedby` despite having both a helper paragraph and a `role="alert"` error it could point to; the currency field right after it does wire this correctly.

No currency/locale/IP-based country inference in any of these surfaces (confirmed by grep — zero hits for `navigator.language`/`Accept-Language`/IP headers anywhere in `app/`, `components/`, `lib/`).

## 2. SEO and canonical identity

**Metadata is completely static and shared across all three AU/IN/Global variants.** One `Metadata` export, no `generateMetadata()`, `alternates.canonical` is the literal `'/'` regardless of bucket. No `hreflang` tag exists anywhere in the codebase. `app/layout.tsx` hardcodes `openGraph.locale: 'en_AU'` invariantly — an India-bucket page would still claim `en_AU`. The sitemap lists exactly one URL for the landing page — no `/au`/`/in`/`/global` paths exist for a crawler to discover.

**Findings**: **no duplicate-content risk exists, but only because there is no differentiation to begin with — SEO localisation is a complete no-op at the crawlable-document level.** Since all three buckets render at the same URL gated by a cookie/header a crawler essentially never carries, Googlebot indexes exactly one version — the neutral tier-5 fallback. This means the "for Australian/Indian households" copy can **never appear in a Google-indexed snapshot or search-result snippet**, even once the CloudFront-header prerequisite (Batch 1) is fixed, because that only changes what a real visitor's browser sees post-click-through, not what was crawled and cached. The entire G2 localisation effort is structurally invisible to search engines by design, not merely unconfirmed like the CloudFront prerequisite.

## 3. Controlled production cohort / percentage rollout mechanism

**No user-scoped rollout mechanism of any kind exists in this codebase.** Exhaustive search (`beta_users`, `rollout_percentage`, `canary`, `cohort`-as-targeting, `allowlist`/`waitlist`/`ab_test`) finds exactly one near-miss: `ai_model_registry.rollout_percentage` (migration `0110`, `int 0-100`) — writable via an admin API route, but **zero read sites anywhere** (`aiModelGateway.ts`, the actual model-dispatch code, never references it, `Math.random()`, or any user-hash selection). A column with a check constraint and an admin write path and no consumer at all.

Every real feature flag in this programme (`G4`, `G5B`, `G2`) is a pure, global, all-or-nothing env var — one string comparison, no per-user/session/percentage/cohort branch anywhere. The only per-user-scoped grant table in the whole access-control stack (`admin_users`) is exclusively about admin privilege, never available or repurposed for a beta cohort.

**Findings**: **this is a real, nameable gap, not a false negative.** G8's own name — "Certification and Controlled Rollout" — presumes a mechanism to expose a certified feature to a controlled production subset before full release. None exists. Every flag examined across this whole G8 discovery phase goes from "verified in DEV" straight to "100% of production simultaneously," with no gradual exposure, no canary, no kill-percentage. `ai_model_registry.rollout_percentage` shows a percentage-rollout concept was anticipated once (for AI models specifically) and never finished, rather than never considered. This is squarely a G8 ownership-decision item: either accept "apply to DEV, verify, flip a global flag" as what "controlled rollout" means in this programme, or build an actual per-user targeting primitive before certifying G8 complete.

## 4. Full rollout and rollback — are G4/G5B/G2 truly reversible?

**`G2_LANDING_LOCALISATION_ENABLED`**: trivially, completely reversible — flag off means the page falls back to the exact pre-G2 static behaviour; the one thing "on" writes (a non-authoritative client cookie) is simply never read again once off. No DB writes under this flag at all.

**`G4_APP_CAPABILITY_LAYER_ENABLED`**: reversible by construction — only changes which gate function a request is evaluated against, never performs a DB write itself. Turning it off instantly reverts every GENERIC user to G3's containment behaviour.

**`G5B_GENERIC_WRITE_ENABLED` — a real, disclosed asymmetry, the most significant finding in this batch.** Two independently-controlled layers exist: the **app-layer flag** (cosmetic once the migration below is applied) and the **database-layer grant** (migration `0129`'s `is_write_permitted()`/`mcc_generic_write_capabilities`). Postgres cannot read a Node.js `process.env` value — the instant migration `0129` is applied to an environment, GENERIC-user writes to Income/Expenses/Insurance become **permanently, unconditionally permitted at the database layer**, independent of the app flag's state, for **any** client authenticated as that user, including a direct PostgREST call outside the Next.js app entirely. **Flipping the env var back to `false` does not revoke this — it only stops FHIP's own API routes from constructing such a request.** The migration ships a manual, commented-out rollback SQL block as the *actual* kill switch (no down-migration runner exists in this repo) — but nothing anywhere (the flag's own doc comment, the migration's header) cross-references this asymmetry as an operational risk. If the PO's own rollback runbook for G5B is "just flip the env var," that runbook is incomplete and leaves a live database write surface open for as long as migration `0129` stays applied.

**A secondary, related gap inside G5B itself**: `app/api/financial-data-hub/income-proposals/[proposalId]/apply/route.ts` still imports the pre-G3 `requireCountryConfirmedUser` gate, not `requireModuleCapability` — even with G4+G5B both fully on, a GENERIC user still cannot apply an FDH-derived income proposal; only the manual grid-entry CREATE path is actually reachable. Not a rollback defect, but a real functional gap versus what G5B's own manifest justification claims as its "real, exercised write path."

**Findings**: G2 and G4 verified as genuinely one-way-side-effect-free. **G5B is not a single reversible kill switch — it is two independently-controlled gates, one of which is soft/cosmetic once the other has been applied**, and this asymmetry is undocumented anywhere it would matter operationally.

## Cross-cutting: currency/locale/IP inference

No violation found across any of the four topics. The one place a controlled-cohort mechanism might plausibly use IP/locale (e.g. "enable G5B for GB-detected IPs first") doesn't exist — because no cohort mechanism of any kind exists, per finding 3.
