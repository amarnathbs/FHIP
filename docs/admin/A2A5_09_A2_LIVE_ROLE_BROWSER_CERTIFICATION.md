# A2 — Nine-Role Live-DEV Browser Certification

## Status: BLOCKED — named mission stop condition met

Mission §14 lists as an immediate stop condition: **"credentials are unavailable for a mandatory live gate."** This is exactly the situation for this gate.

## 1. What was checked before declaring this blocked (not assumed)

| Check | Result |
|---|---|
| `.env.local` present in this worktree? | No (`test -f .env.local` → false) |
| Any `SUPABASE_*`/`DATABASE_URL` environment variable set in this shell? | No (`env \| grep -i supabase` → empty) |
| `playwright.config.ts`'s own documented requirement | "Next.js's dev-server process loads `.env.local` automatically, but the Playwright test runner is a separate Node process that does not — any spec that talks to Supabase directly (service-role admin grants, etc.) needs it loaded explicitly here." Confirms real Supabase credentials are a hard prerequisite for exactly this kind of test, not merely convenient to have. |
| A pre-existing e2e spec attempting real Supabase signup (`tests/e2e/*.spec.ts`) would run in this environment? | No — every spec that "signs up real Supabase users" (per that same config file's own comment) would fail immediately without `.env.local`. |
| Does a synthetic-fixture creation script already exist for this exact purpose? | Yes — `docs/admin/A2_13_A2_TO_A3_HANDOVER_AND_DEFERRAL_REGISTER.md` §3 preserves the exact Supabase Admin API calls (`admin.auth.admin.createUser`, `admin.from('admin_users').insert`, `admin.from('resource_user_roles').insert`, `admin.auth.admin.generateLink`) needed to create all 9 role fixtures (Analyst/Author/Editor/Compliance Reviewer/Publisher/Resource Admin/Super Admin/role-less/anonymous) against a real DEV project. **This script cannot run without a DEV project's service-role key**, which this environment does not have. |

## 2. What this means, precisely

This is not a case where the work was skipped for convenience — it is a hard technical impossibility in this specific execution environment (no network path to a real Supabase project, no credential of any kind). Per the mission's own instruction: **"Do not downgrade a stop condition into a documentation note merely to reach FULL PASS."** This document does not attempt to manufacture substitute "live" evidence — that would be exactly the prohibited downgrade.

## 3. What non-live evidence exists instead (not a substitute — a different, weaker kind of evidence, clearly labelled as such)

Real, executed, but **hermetic** (mocked-client, no network) test evidence exists for much of what the 9-role matrix would check:

- `tests/unit/adminA2CanonicalShell.test.ts`'s "persona matrix (today state)" describe block exercises `buildAdminAreas()` for exactly the 9 personas (role-less, Analyst, Author, Editor, Compliance Reviewer, Publisher, Resource Admin, Super Admin, Analyst+Resource Admin) and asserts the exact expected visible top-level areas for each — this is the **navigation-visibility** half of what a live walkthrough would check, proven by direct function call rather than a browser session.
- `tests/unit/countryGateAdminAndHousehold.test.ts` and `tests/unit/adminCapabilitySplit.test.ts` prove the **direct-route authorization** half (permitted vs. forbidden route access) for the routes this dispatch touched, again via mocked-client unit tests, not a live HTTP request.
- Neither of these proves: real sign-in, real session/cookie behaviour, real mobile-viewport rendering, real focus management, real breadcrumb DOM output, or real sign-out — all of which genuinely require a live browser against a live app instance, which in turn requires a live authenticated session, which requires the credentials this environment lacks.

## 4. Disposition

**BLOCKED.** Per mission §15.1, A2 cannot receive FULL PASS without this gate. A2's overall verdict is therefore capped at CONDITIONAL PASS (see `A2A5_31_TERMINAL_CERTIFICATION_REPORT.md` for the consolidated verdict), pending either:
(a) a follow-up pass run in an environment with real DEV Supabase credentials, using the preserved fixture script (`A2_13` §3) and the exact 16-step protocol mission §8.4 specifies, or
(b) explicit Product Owner acceptance of this residual risk as bounded, given the hermetic evidence in §3 covers the two highest-value authorization properties (who sees what, who can access what) even though it cannot cover live rendering/session behaviour.
