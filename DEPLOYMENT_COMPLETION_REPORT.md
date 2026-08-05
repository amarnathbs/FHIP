# FHIP Deployment — Completion Report

**Date:** 5 August 2026
**Status: Live in production.** `https://app.financialhealthplatform.com`

## What's live

| Component | Detail |
|---|---|
| Source | [github.com/amarnathbs/FHIP](https://github.com/amarnathbs/FHIP) — `main` branch, 10 commits |
| Hosting | AWS Amplify, app `FHIP` (ID `d3iiacugdm5tup`), region `ap-southeast-2` |
| Domain | `app.financialhealthplatform.com`, HTTPS via a manually-issued ACM certificate (see "Issues encountered" below) |
| Database | New, dedicated Supabase production project (not the dev/test project) — full schema (22 migrations) + reference data seeded and verified |
| Email | Resend, custom domain `auth.financialhealthplatform.com` — verified and confirmed sending real confirmation emails |
| DNS | Cloudflare — `app` subdomain delegated via NS records to a Route 53 hosted zone; root domain and mail records untouched |

## What was verified end-to-end, live, in production

- Signup → confirmation email delivery (Resend) → email-link confirmation → login → onboarding wizard → dashboard.
- Dashboard calculations against real production data: income, expenses, surplus, savings rate, and Health Score all computed correctly.
- Free-tier report generation: correct title ("Current Baseline" for a true first report), correct data-confidence flagging, no raw category-code leaks.
- HTTPS certificate valid and serving correctly.

## What was not tested in production (and why)

- **Premium report PDF export.** No payment/entitlement system exists yet to upgrade a test account to premium, so this couldn't be exercised against the live database. The underlying Playwright/Chromium PDF pipeline itself is confirmed working — it's what the `amplify.yml` `yum install` fix (below) made possible, and it was verified separately in this session against 50 synthetic households on the dev environment (see the Consolidated Forecasting Report PDF delivered earlier).
- **Broad multi-user RLS isolation check** (two accounts confirming they can't see each other's data) — not done against production; only ever verified against the dev project earlier in the project's history. Worth doing before onboarding real users, per SECURITY.md's pre-launch checklist.

## Issues encountered and how they were resolved

1. **Amplify build failure**: `npx playwright install --with-deps` assumes an apt-based (Debian/Ubuntu) image; Amplify's build image is Amazon Linux. Fixed by installing Chromium's dependencies via `sudo yum install` instead, then a plain (non `--with-deps`) Playwright install. This was a real, previously-undocumented risk flagged in `DEPLOYMENT.md` before it happened — confirmed and fixed on the first real build.
2. **Signup returning an empty `{}` error**: root cause was the production Supabase project issuing the newer `sb_publishable_`/`sb_secret_` API key format, which the pinned `@supabase/supabase-js@2.45.4` predates. Fixed by upgrading `@supabase/supabase-js` and `@supabase/ssr` to current versions.
3. **Confirmation-email "page not found"**: expected — the custom domain wasn't live yet when the email was sent. Not a bug; resolved once the domain went live.
4. **Signup succeeding but silently landing on a blank login page**: real UX gap (not previously testable pre-deployment) — a signup requiring email confirmation gave no explanation. Fixed by adding a "Check your email" state to the signup page.
5. **Amplify custom-domain automatic SSL setup failing repeatedly** with `AWSAmplifyDomainRole ... cannot be found`, even after removing and re-adding the domain — a genuine, reproducible AWS-account-side bug in Amplify's automatic domain-role provisioning, not something in this app's control. Worked around by requesting the SSL certificate manually via AWS Certificate Manager and selecting "Custom SSL certificate" in Amplify instead of "Amplify managed certificate."
6. **`/forecast/report` returning a 404** in the dev environment after the dev server had been running continuously for ~2 days under heavy load — Turbopack's dev-time route cache had gotten into a bad state (Next.js itself flagged a "slow filesystem" warning in this environment). Fixed by restarting the dev server; the route file was correct and unmodified.

None of these were application logic bugs discovered late — items 2-4 were genuine, previously-unknown issues; items 1 and 6 were exactly the kind of environment risk already flagged as open items before deployment began; item 5 is an AWS platform issue outside this codebase.

## Known, deliberately deferred items

- **Report page count**: Premium report is still ~28 physical pages against a target of 16-18 (Free is within target at ~5-7). Deliberately deprioritized during the earlier report-correction pass in favor of the larger volume of correctness fixes; would need a dedicated page-layout consolidation pass.
- **6 lint findings** (`react-hooks/set-state-in-effect` ×5, `react-hooks/refs` ×1) — real, modern-rule findings on pre-existing patterns, none of which block the build. Listed in the Phase 2 report; not fixed.
- **Forecasting E2E suite**: 139/210 automated checks passed on the last full run; the 71 failures were traced to a specific, evidenced pattern (async Server Component pages timing out under a 1.5-hour sustained single-worker dev-mode run) rather than confirmed as application bugs — but this diagnosis was not proven with a clean production-build re-run. Recommended as a follow-up if certainty is wanted.
- **Resend sending restriction**: the Resend account is still in a mode that only sends to the account owner's own verified email address. Full production email sending (to any real user) requires completing Resend's account verification/upgrade — not something this session could do, since it requires account-level action on Resend's own dashboard.
- **`dependantBand` in Financial Twin cohort matching**: flagged mid-session as a possibly-real gap (a computed value that's never used in the cohort-matching filter chain) — spun off as its own follow-up suggestion, not investigated further here.

## Recommended next steps

1. Complete Resend's account verification so auth emails can reach any real user, not just the account owner.
2. Decide on and build a payment/entitlement path for the Premium tier (currently only settable directly in the database), then do the deferred premium-report production PDF test.
3. Run the two-user RLS isolation check against production before onboarding real users.
4. The previously-scoped **UX/visual redesign project** (full design-system overhaul per the benchmark review pack) can now start, since deployment is complete — see project memory `ux_redesign_decision.md` for the locked-in scope and sequencing.
