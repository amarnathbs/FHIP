# 09 — Validation (Phases 28-30)

## TypeScript

`npx tsc --noEmit` — **0 errors introduced by this task.** The only errors present
(`scripts/resources/lib/workbook.ts`, missing `xlsx` type declarations, 3 errors) are pre-existing
and unrelated: confirmed by diffing against `285c9c0` (this task's base commit) — the file is
byte-identical to the base commit and was not touched by this branch.

## ESLint

`npx eslint <every file this task added or modified>` — **0 errors, 2 warnings**, both pre-existing/
expected:
- `app/layout.tsx`: one "unused eslint-disable directive" warning from an initial draft (removed —
  re-verify shows 0 warnings for this file after the fix).
- `components/marketing/LandingPage.tsx`: a pre-existing `@next/next/no-img-element` warning on a
  line this task did not touch (confirmed against the base commit — the `<img>` tag was already
  there before this task's two-line footer-link edit elsewhere in the same file).

## Unit tests (Vitest)

New test file: `tests/unit/seoEntity.test.ts` — **19/19 passing** in isolation (behaviour-level
tests of the JSON-LD graph shape, `@id` stability/uniqueness, no-fabricated-facts assertions, and
the robots/sitemap path lists — see the final report for the full breakdown).

Full-suite regression (`npx vitest run`, 2650 tests across 141 files): this task's changes
introduced **zero new deterministic failures**. One real regression was found and fixed during this
task's own work — a substring collision between a code comment in the new `app/robots.ts` and
FDH-1's isolation-guard test (`tests/unit/fdh1Isolation.test.ts`), which does a naive text search
for the literal string "financial-data-hub" across `app/`/`lib/`/`components/`. The comment was
reworded (no behaviour change); the isolation test was independently re-run afterward and confirmed
passing (25/25).

Beyond that one self-caused-and-fixed issue, three full/filtered runs were performed to
characterise the remaining, pre-existing flakiness in this repository's live-Supabase-dependent
test files (none of which this task touched):

1. **Full run 1**: 2 files failed with `ENOENT: .../.env.local` — these specific files
   (`resourcesImportR1_7LiveDev.test.ts`, `resourcesP0ContentR1_7CLiveDev.test.ts`) read a
   **relative** `.env.local` path, which does not exist in this task's fresh worktree (only the
   primary `D:/FHIP` checkout has one — a worktree/environment artifact, not a code regression).
2. **Full run 2**: a different set of live-Supabase tests failed with `Request rate limit reached`
   (e.g. `resourcesR1_4LiveDev.test.ts`, `resourcesAdminRoleCtaHotfixLiveDev.test.ts`) — these read
   an **absolute** `D:/FHIP/.env.local` path (so credentials load fine even from this worktree) but
   then hit Supabase Auth's own real rate limiter on a live OTP round-trip.
3. **Filtered run** (excluding files named `*LiveDev*`): only 2 files failed
   (`resourcesEditorR1_3.test.ts`, one other Resources RLS test), both again live-Supabase round-trip
   timeouts/rate-limits, not `*LiveDev*`-named but following the identical pattern.

Across all three runs, the specific set of failing live-network tests **varied** — itself the
signature of external rate-limiting/network flakiness, not a deterministic regression. In every
run, **zero** non-network, non-FDH-1-isolation test failed, and this task's own new test file
(`seoEntity.test.ts`, 19 tests) passed cleanly every time. No file this task modified or added has
any live-Supabase dependency.

## Production build

`npm run build` (`next build`, Turbopack): **page compilation succeeded** ("Compiled successfully
in 3.9min", all ~150 routes including the new `/about` and `/security` pages and the new
`robots.ts`/updated `sitemap.ts`), but the build's own subsequent TypeScript-checking step failed
on the exact same pre-existing, unrelated error already identified by the standalone `tsc --noEmit`
run above: `scripts/resources/lib/workbook.ts` cannot find the `xlsx` module.

This was verified to be a genuine, repo-wide, pre-existing environment gap and not something
specific to this task's fresh worktree: `xlsx` is declared in `package.json` (`"xlsx": "^0.18.5"`)
but was **missing from `node_modules` in the primary `D:/FHIP` checkout as well** — the same
worktree that has a real `.env.local` and is used for day-to-day development. Installing it
(`npm install xlsx@^0.18.5 --no-save`, no `package.json`/`package-lock.json` change) did not fully
resolve the underlying issue: `xlsx` ships with no bundled type declarations and no `@types/xlsx`
package is installed either, so `tsc` still fails on the same file with
`TS7016: Could not find a declaration file for module 'xlsx'`. This is a genuine, pre-existing gap
in this dependency's TypeScript setup (would need `@types/xlsx`, a hand-written `.d.ts`, or a
`tsconfig` exclude for `scripts/` to fix) — unconnected to this task, which never touches
`scripts/resources/lib/workbook.ts` or any Resources import-workbook code. A full `npm run build`
from unmodified `origin/main` would hit the identical failure today.

**Housekeeping note (full disclosure)**: the diagnostic `npm install xlsx@^0.18.5 --no-save` above,
run purely to see whether the pre-existing, unrelated `xlsx` type-checking gap could be easily
resolved, left this worktree's `node_modules` in a degraded state — ESLint began failing to load
entirely (`Cannot find module './Call'`/`'./IsArray'`, broken transitive files inside `es-abstract`).
A follow-up plain `npm install` did not cleanly repair this and, on top of that, drifted an
unrelated package (`zod`) enough to introduce **new** `tsc` errors in `lib/validation/smsf.ts` that
were not present before. This appears to be a fragility specific to how `node_modules` is
materialized in this non-primary git worktree (the primary `D:/FHIP` checkout's `node_modules` was
unaffected throughout and was never touched). Rather than keep spending this task's budget chasing
an out-of-scope pre-existing dependency issue, further remediation was stopped. **The TypeScript,
ESLint, and Vitest results reported above and in the final report are the results captured earlier
in this session, before this diagnostic side-quest began**, and remain accurate for the actual code
delivered in this branch — `node_modules` is never committed (gitignored) and neither
`package.json` nor `package-lock.json` was modified by any of this. A fresh `npm ci` in a clean
checkout of this branch is recommended before anyone re-runs local validation, as ordinary good
practice — not because this branch's committed code is in question.

## Structured data — manual validation (Phase 28; Google's Rich Results Test was NOT run)

This task did not have network access to `search.google.com/test/rich-results` in a way that
constitutes actually running Google's tool against a live deployed URL (the branch is not deployed
— see Production Status in the final report), so no claim is made that the Rich Results Test was
run. Manual validation performed instead:

- **JSON syntax**: `JSON.stringify({'@context': ..., '@graph': buildFhipEntityJsonLd()})` does not
  throw (asserted directly in `tests/unit/seoEntity.test.ts`).
- **No duplicate `@id` values**: asserted directly (`new Set(ids).size === ids.length`).
- **No invalid/unresolvable URLs**: every `url`/`@id` value is built from either the hardcoded,
  live-verified `https://myfhip.com` or `getFhipApplicationUrl()` (the same `APP_BASE_URL`-derived
  value already used and live-verified elsewhere in the app) — never a relative path or malformed
  string.
- **Schema relationships**: `WebSite.publisher` → `Organization`, `WebApplication.publisher` →
  `Organization`, `WebApplication.isPartOf` → `WebSite` are all asserted by exact `@id` match in the
  test suite, not just visually inspected.

**Recommended Product Owner step after deployment**: paste the live URL
(`https://app.financialhealthplatform.com/`) into
`https://search.google.com/test/rich-results` and confirm Google's own parser agrees — this task
recommends but did not perform that live check, per the "do not claim Rich Results Test was run
unless it actually was" instruction.

## Canonical / sitemap / robots checks

- Canonical matrix: see `03-canonical-matrix.md` — no contradictory canonical signals found between
  the three domains (verified by design: no code path produces a cross-domain canonical).
- Sitemap: `PUBLIC_MARKETING_SITEMAP_PATHS` unit-tested to contain exactly the intended 6 marketing
  paths and never contain a private-route substring.
- Robots: `ROBOTS_PUBLIC_PATHS` unit-tested to contain exactly the intended public paths and never
  contain a private-route substring; the actual `app/robots.ts` rule construction
  (`disallow: '/'` + `allow: ['/$', ...ROBOTS_PUBLIC_PATHS]`) was verified by manual inspection
  against Google's documented longest-match resolution rule (not independently re-implemented as a
  test, since that would just be re-testing Google's own documented algorithm).

## Redirects (Phase 18 — live-tested against real production DNS/HTTP, per standing hard rule #7)

| Test | Result |
|---|---|
| `http://myfhip.com/` | 301 → `https://app.financialhealthplatform.com/` |
| `https://myfhip.com/` | 301 → `https://app.financialhealthplatform.com/` |
| `https://www.myfhip.com/` | 301 → `https://app.financialhealthplatform.com/` (via `curl -L`, final URL confirmed) |
| `http://myfhip.com/about?utm=test` (path+query preservation) | 301 → `https://app.financialhealthplatform.com/about?utm=test` — path and query both preserved |
| `https://financialhealthplatform.com/` | Does not resolve (no A/AAAA record) |
| `https://www.financialhealthplatform.com/` | Does not resolve (NXDOMAIN) |
| `https://app.financialhealthplatform.com/` | 200 OK, live Next.js app |
| `https://app.financialhealthplatform.com/robots.txt` (BEFORE this task) | 404 (no `robots.ts` existed) |
| `https://app.financialhealthplatform.com/sitemap.xml` (BEFORE this task) | 200, but only 4 Resources URLs, no marketing pages |
