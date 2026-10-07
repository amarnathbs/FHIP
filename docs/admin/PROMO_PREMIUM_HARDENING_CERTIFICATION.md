# Premium and promo code hardening: certification report (release branch)

Branch `feat/promo-hardening-release-20261007`, from `origin/main` e829a8b with the hardening work of `feat/promo-premium-hardening-20261005` merged in. Dates are written day first. **Nothing is pushed, merged or applied anywhere.**

**Verdict at this point: CODE AND TEST COMPLETE, DEV CERTIFICATION PENDING (the PO applies the migrations on DEV, then the DEV proof, the browser pass and the DEV residue cleanup run). Not certified for production until the DEV rows below are filled in.** This file is updated in place when the DEV run is done.

## 0. Evidence labels

| Label | Meaning |
|---|---|
| **unit** | hermetic application tests (injected mailer, clock, random source, fake database) |
| **PGlite** | proven on an isolated real Postgres replay of the whole migration ledger, as the real roles, with named negative controls that are shown to go red |
| **source contract** | tests that read the source or the documents |
| **DEV-real** | run against the real DEV Supabase project or the real mail provider, from this worktree |
| **DEV-pending** | needs the PO to apply the migrations on DEV first |
| **UNVERIFIED** | cannot be known from the repository or from this machine |

## 1. The 14 review items

| # | Item (PO ruling) | Code and tests | DEV | Remaining |
|---|---|---|---|---|
| 1 | Plain codes (hash only, shown once, hint 2+2, rotation) | **CLOSED** (PGlite, unit, source contract). Existing codes: Admin button **Prepare existing codes** (verified backfill), separate finalise, tested end to end on a seeded old-world database | DEV-pending | the backfill and finalise runs on DEV, then production |
| 2 | Duration (30 days = 30 calendar days counting both ends) | **CLOSED** (SQL and TypeScript share one definition; 1, 30, 365 and leap-year vectors; grant ceiling today plus 364) | DEV-pending (proof group 3) | existing entitlements keep their old end dates (one day longer): PO acknowledged |
| 3 | Extension cap bypass by revoke and re-grant (lifetime ceiling 10, override a separate capability granted to nobody) | **CLOSED** (PGlite; cross-capability checks for entitlement-only, promo-only, both, override-only and a no-flag admin) | DEV-pending (groups 1, 4, 5) | nobody holds the override until the PO names someone |
| 4 | Four mandatory dedicated secrets, no fallback, at least 32 characters, fail closed with an Admin-visible message | **CLOSED** (unit; the Admin **Setup check** names each missing, short or reused variable and the actions switched off; ordinary Premium use never reads them: source contract) | DEV-real (seen in a browser against the old DEV database) | the PO sets the production values |
| 5 | Bound redemption needs a verified account address (one normalisation) | **CLOSED** (shared test vectors for SQL and TypeScript; unverified, other, absent and changed address all read as the generic refusal) | DEV-pending (group 6) | none |
| 6 | X-Forwarded-For (right-hand entry, hop count from configuration, a DEV probe) | **CODE CLOSED** (unit). The probe is built: Admin button **Check my network address** | the deployed Amplify hop count is **UNVERIFIED** from here (my local server is not behind CloudFront) | PO presses the button on the deployed site (runbook step 6c); until then only the per-user limit is certain |
| 7 | Retention and cleanup (disabled by default, approved periods) | **CLOSED** (PGlite: ships disabled, evidence on every run, holds, anonymise instead of delete, account-deletion orphans) | DEV-pending | the PO switches the job on only when he decides |
| 8 | Multi-recipient partial failure | **CLOSED** (unit: shared and bound codes, retry with the same key, refresh, lost response, replacement) | DEV-pending (group 8) | none |
| 9 | E-mail abuse controls (100 per admin per day, 300 per platform per day, 3 replacements per code per day, breaker) | **CLOSED** (PGlite and unit) | DEV-pending (concurrent limits, group 8) | none |
| 10 | Production marker and cron hardening | **CLOSED** (0268; `premium_cron_verify`; the retention job registers only with the marker) | DEV-pending (group 9) | whether the one marker row is truthful is the operator's input |
| 11 | Real Resend path | sender name, delivery, idempotency, failure and timeout: **DEV-real** (section 3) | partly done | the PO reads SPF, DKIM and DMARC in "Show original". **Finding: the sending domain has no DMARC record** |
| 12 | Browser testing (desktop and 390, keyboard, axe, positive and negative operators) | script ready (`scripts/promo_hardening_browser_certification.mjs`) | DEV-pending (one browser look done on the old DEV database) | run after the apply |
| 13 | Lineage and migration correctness (no old overload, no collision, nothing edited) | **CLOSED** (the old shapes are byte for byte unchanged and every call reaches one function; applied ancestors pinned by hash; numbers 0264 to 0268 and 0279 unique and above every number on every ref and worktree) | the detection pack D1 compares the five live functions with the repository text on DEV and production | PO runs D1 |
| 14 | Full clean verification | `tsc` clean; ESLint clean on every changed file; 40 test files run one at a time (section 2); a production build (section 2) | DEV proof pending | a clean `npm ci` was not run (the shared `node_modules` was used) |

## 2. Verification run (this worktree, 07-10-2026)

See `docs/admin/ADMIN_PROMO_CODES_AND_REMINDERS_REPORT.md` section 19 for what each test proves.

| Check | Result | Label |
|---|---|---|
| `tsc --noEmit`, `NODE_OPTIONS=--max-old-space-size=8192` | 0 errors | |
| ESLint on every changed and new `.ts`, `.tsx`, `.mjs` file (73 files) | 0 errors, 0 warnings | |
| 42 test files, one at a time (hardening suites, promo, grant and reminder suites, the guards: back link, day-first date text, sidebar, admin navigation and capability tests, migration versions) | about 1,200 tests, all passed. The first run showed one failure (a hand-over document heading the old test expected); fixed and re-run green | unit, PGlite, source contract |
| Old-world deploy safety (a seeded production-like database, five phases) | 30 passed | PGlite |
| Additive migrations, byte-for-byte old shapes, no ambiguity, with controls NC-O1 and NC-O2 | 17 passed | PGlite |
| Rollback R1 and R2 with controls NC-R1 and NC-R2 | 10 passed | PGlite |
| Check packs D1, V0264 to V0279, emergency stop and resume | 21 passed | PGlite |
| The DEV proof itself, both stages, four controls NC-X1 to NC-X4 each shown to turn its named check red, and the DEV-only residue cleanup | 11 passed | PGlite |
| New and old application against old and new database (setup check, backfill button, network probe, 503 behaviour, ordinary Premium use independent of the secrets) | 25 passed | unit |
| Production build: `next build --webpack` | the compile step succeeded (3.8 minutes). The Next route type validator then stopped on `app/api/admin/recommendations/gaps/route.ts`, a file on `main` untouched since 03-09-2026 that exports a constant from a route file (the build Amplify runs uses Turbopack, which does not run that check; Turbopack could not be run here because this worktree links `node_modules` from another folder). Treat the build as **partly verified** | DEV-real tooling |
| A browser look at the Promo Codes page against the OLD DEV database | the page renders, the Setup check shows the four secrets, the list says "This feature is not available on this database yet. Nothing was changed.", the back link is present | DEV-real |
| `scripts/promo_hardening_browser_certification.mjs` (Playwright, Chromium, real login with fixture users) against the OLD DEV database, without the journeys | 41 of 43 passed on the first full run, and the two failures were the Next.js development overlay counted as a keyboard stop (excluded since). Passed: axe finds no WCAG 2.0/2.1 A or AA violation on Promo Codes and Premium Access at 1280 and 390 pixels, no horizontal scroll, no year-first date text, the back link is before the first control in keyboard order and shows a focus ring, and the cross-capability negative controls (promo-only, entitlement-only, a no-flag admin and a plain user are each sent away from the page they lack, get 403 from its APIs, and an anonymous request gets 401) | DEV-real (old database) |
| `a clean npm ci` | not run (the shared `node_modules` was used) | |

## 3. Real e-mail on DEV (mailbox owned by the PO only)

Through the application's own mailer and message builder, `tests/live-dev/promoHardeningRealEmailLiveDev.test.ts`, sample code `ZZZZZZZZZZ` (no admin created it, it cannot be redeemed):

- the provider accepted the message; its record shows subject `Your FHIP Premium access code`, sender display name `FHIP`, one recipient, last event `delivered`;
- a second send with the same idempotency key returned the SAME message id (no second message);
- a wrong API key is an explicit `resend_http_401`; a black-holed provider ends as `resend_timeout` after 10.0 seconds;
- the date in the message is `4 January 2027` (the unambiguous English form); no numeric date, no code in the subject;
- DNS (operating system resolver): SPF `v=spf1 include:amazonses.com ~all` on `send.auth.financialhealthplatform.com`, DKIM at `resend._domainkey.auth.financialhealthplatform.com`, **no DMARC record**. The PO should publish `_dmarc.financialhealthplatform.com` as a TXT record with the value `v=DMARC1; p=none; rua=mailto:<a mailbox he reads>` and tighten it later.

Three test messages arrived in the PO's mailbox (three runs of the test). SPF, DKIM and DMARC results as the receiving provider judged them: **UNVERIFIED** (read "Show original").

## 4. Deploy safety (the crux): what is proven and how

See `ADMIN_PROMO_CODES_AND_REMINDERS_REPORT.md` section 19.2 and `po_apply_promo_hardening_release/PRODUCTION_RUNBOOK.md`.

## 5. Production runbook and hand-over

`docs/admin/po_apply_promo_hardening_release/PRODUCTION_RUNBOOK.md` (order, failure behaviour of each step, post-deploy checks, instant stop, rollback) and `README.md` (the DEV steps). Secrets: the PowerShell line that puts one random value at a time on the clipboard without showing it is in runbook section 3.
