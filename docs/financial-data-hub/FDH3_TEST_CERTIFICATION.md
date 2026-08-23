# FDH-3 — Test Certification

## 1. Unit / domain tests (Vitest)

| File | Tests | Focus |
| --- | --- | --- |
| `tests/unit/fdh3Domain.test.ts` | 35 | File-signature detection, full upload-validation pipeline, upload-session domain rules, derived upload substates, the widened document lifecycle, retention arithmetic, orphan-detection set comparison |
| `tests/unit/fdh3SchemaContract.test.ts` | 18 | Migration 0058 parsed from disk: exact table set, check-constraint vocabularies match TypeScript enums, RLS/policy shape, storage policy shape, FDH1-F1 trigger presence, duplicate-detection widening |
| `tests/unit/fdh3UploadTestPack.test.ts` | 8 | The same validation pipeline exercised against real, committed synthetic fixture FILES (`tests/fixtures/financial-data-hub/`), not only inline buffers |
| `tests/unit/fdh1Isolation.test.ts` (updated) | 25 (22 before FDH-3, +3 net new) | Module-boundary guarantees, consciously updated for FDH-3's legitimate new surface (see below) |

**62 new/updated FDH-3 test cases** (33 + 18 + 8 in new files, +3 net new in
`fdh1Isolation.test.ts`), all passing.

## 2. What changed in `fdh1Isolation.test.ts` and why

Three assertions were FDH-1/FDH-2-era scope gates that FDH-3 legitimately
crosses; each was updated to allow exactly the new surface while preserving
the underlying invariant:

- *"adds no route handler, no page and no component"* → now
  *"adds only the approved FDH-3 document-lifecycle route set — no parser, no
  extraction route"*. Still fails if any FDH route path contains a
  parser/extraction/classification/OCR verb.
- *"is imported by nothing outside itself"* → now allows exactly
  `app/api/financial-data-hub/**`, `app/(app)/financial-data-hub/**` and
  `components/financial-data-hub/**` as consumers; anything else importing
  the module still fails the test.
- *"never uses the service-role client"* → now
  *"uses the service-role client ONLY in the three FDH-3 files documented to
  need it"*, with a positive assertion that it really is used in exactly
  those three (not vacuously passing because nobody uses it).
- *"exposes no admin route, viewer or download path"* → split into two: an
  unmodified admin-route check, and a new
  *"confines storage/signed-URL access to services/storage.ts, and never
  combines it with admin auth"* check, which also directly asserts
  `constants/adminBoundary.ts` itself never gains storage access.

One net-new test was added: *"no admin surface in the whole application
references the FDH module at all"* — greps every file under `app/api/admin`
and `app/(app)/admin` for `financial-data-hub`/`fdh_` and asserts zero
matches (real, not hypothetical — the admin surface genuinely exists and was
searched).

## 3. PGlite RLS + lifecycle certification (`scripts/fdh3_rls_certification.mjs`)

Full 58-migration clean rebuild from empty, real Tenant A / Tenant B rows,
genuine negative controls (isolation deliberately disabled then
re-enabled). **18/18 passed** — see `FDH3_RLS_STORAGE_POLICIES.md` for the
itemised list.

## 4. Live DEV storage certification (`scripts/fdh3_dev_certification.mjs`)

Real Supabase Storage operations against the live `fdh-source-documents`
bucket on DEV project `vqycarelcoijzwlpkpcz`, synthetic bytes only.
**11/11 passed** — see `FDH3_STORAGE_SECURITY.md` and
`FDH3_PURGE_CERTIFICATION.md`.

## 5. Full-suite regression

Run before and after this dispatch's changes:

| Check | Baseline (before FDH-3) | After FDH-3 |
| --- | --- | --- |
| TypeScript (`tsc --noEmit`) | clean | clean |
| Vitest | 753/753 | 814/815 — the one failure (`resourcesAdminR1_2.test.ts`, an exact-draft-count assertion against the shared live-DEV Resources tables) reproduces as flaky: fails intermittently in the full-suite run, passes 26/26 every time when run in isolation. Unrelated to FDH-3 (Resources admin dashboard, no `financial-data-hub` or `fdh_` reference in that file). 753 + 62 new/updated FDH-3 cases = 815, consistent |
| ESLint | 9 errors / 7 warnings (pre-existing, unrelated files) | same 9/7, zero new — verified by exact file-list diff, not just count |
| Migration collision guard | 57 active, next 0058 | 58 active, next 0059, zero collisions |
| Clean-rebuild (PGlite, all migrations) | — | all 58 replay cleanly from empty, verified 3 times during this dispatch |
| Build (`npm run build`) | — | see `FDH3_COMPLETION_REPORT.md` for the result recorded at dispatch time |

## 6. What is not covered by an automated test

- True concurrent-request race conditions (spec section 96) — the domain
  logic that WOULD prevent a double-completion is unit-tested, but no test
  exercises two simultaneous real HTTP requests.
- Live cross-tenant API-route testing with two real authenticated browser
  sessions (spec section 70) — the underlying RLS/trigger enforcement those
  routes depend on IS live-proven (PGlite); the routes' own
  `requireUser()` + `getForUser()` wiring was verified by code review, not a
  live two-session HTTP test.
- End-to-end orphan-detection report against live data (detection logic
  proven; live wiring pending migration application).

All three are named again in `FDH3_COMPLETION_REPORT.md`'s Known Findings.
