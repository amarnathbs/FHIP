# Amplify deploy artifact: measurement, slimming, and the headless-Chromium question (2026-10-18)

Branch `perf/amplify-artifact-slim-20261018` (from `origin/main` `e65bea9`). NOT pushed, NOT verified on a real
Amplify build. Evidence labels used throughout:

- **MEASURED** = observed on this machine (Windows 10, Node 24.18, Next 16.2.12 Turbopack, `npm ci` from the lockfile,
  placeholder `NEXT_PUBLIC_SUPABASE_*`, `NODE_OPTIONS=--max-old-space-size=5120`, real `npm run build` including the
  type-check) or read from a registry/CDN header.
- **INFERRED** = reasoning about the Amplify runtime, which cannot be observed from here (no production access).
- No WSL distribution and no Docker exist on this machine, so nothing below was run on Linux. Where Linux differs
  (native binaries) the Linux package size was taken from the npm registry (`dist.unpackedSize`) and is labelled.

## 1. What the artifact is (read from the repo)

`amplify.yml`: `artifacts.baseDirectory: .next`, `files: ['**/*']`. Before packaging, the build phase already deletes
`.next/cache` and every `*.map` outside `.next/static` (the 2026-09-28 and 2026-10-01 fixes; Amplify deployments 271 to 274 and 276 were confirmed
Deployed afterwards, so those deletes work on the real packager). `next.config.mjs` has no `output: 'standalone'`.
What Amplify packs besides `.next` (the files Next traces into `*.nft.json`) is not documented in the repo and not
observable. The working model, calibrated by the 2026-10-01 doc (`AMPLIFY_BUILD_SIZE_FIX_2026-10-01.md`):

    modelled size = bytes of .next surviving the two deletes + union of files named by every .nft.json outside .next

The model under-reported Amplify's real figure by 45,489,684 bytes in build #270 (Amplify 232,331,902; model
186,842,218). That gap is the main uncertainty of everything below. Hypothesis H (INFERRED, not proven) for the gap:
(a) Amplify copies what the two `.next/node_modules/<pkg>-<hash>` links point at (Turbopack writes them for
`serverExternalPackages`): `pdf-parse` 21,255,998 + `playwright` 5,074,702 = 26,330,700 bytes, which the `find .next`
delete does not touch and the tracer does not list; plus (b) on Linux, sharp's `@img/sharp-libvips-linux-x64`
18,207,458 bytes, which the Windows build does not have. (a)+(b) = 44,538,158, within 1 MB of the gap on the Windows
model (about 6.5 MB short on a Linux-normalised model). It is a coherent explanation, nothing more.

`limit` = 230,686,720 bytes (= 220 MiB, from the failure text of builds #127, #246, #270).

## 2. MEASURED breakdown of origin/main `e65bea9`

Totals: `.next` on disk 149,411,169 bytes (8,479 files); of that the two amplify.yml deletes remove 110,026,298 bytes of
server sourcemaps (2,429 files) and 823,711 bytes of cache, leaving 38,561,035 (6,047 files). Traced files outside
`.next`: 58,565,245 bytes (792 files). **Modelled deployable size: 97,126,280 bytes** (without the sourcemap delete it
would be 207,976,289: 22.7 MB from the limit). No project files (`data/`, `docs/`, `supabase/`, tests, fixtures) are
traced at all: every traced path is under `node_modules`. `public/` is 1,386,293 bytes (the model does not count it).

Ranked (bytes; first column is rank):

| # | Item | Bytes | Class | Note |
|---|---|---|---|---|
| 1 | `.next/server/**/*.map` (+`build` maps) | 110,026,298 | source maps | already deleted by amplify.yml |
| 2 | `@napi-rs/canvas-win32-x64-msvc` | 36,741,283 | traced native | Linux x64 build is 31,202,020 (registry); needed by pdfjs |
| 3 | `.next/server/chunks` (JS) | 23,211,165 | server code | about 12.5 MB app code, 7.8 MB Next runtime, 0.9 MB supabase, 0.4 MB xlsx (approx, from sourcemap shares) |
| 4 | `playwright-core` (traced) | 11,473,819 | traced | now excluded, see section 3 |
| 5 | `.next/server/app` | 8,872,519 | server code | 2,674 json (5.6 MB, nft + manifests), 1,206 js |
| 6 | `next` (traced runtime) | 5,477,850 | traced | required |
| 7 | `.next/static/chunks` | 4,784,196 | browser assets | required |
| 8 | `pdfjs-dist` (worker only) | 3,040,921 | traced | required (the includes in next.config.mjs) |
| 9 | `.next` root files | 509,309 | manifests | |
| 10 | `.next/static/media` | 372,616 | fonts | |
| 11 | `.next/types` | 288,309 | type-check output | not needed at runtime, left (0.3 MB) |
| 12 | `react-dom` | 284,175 | traced | |
| 13 | `.next/build` (JS part) | 336,439 | build | |
| 14 | `sharp` | 629,177 | traced | now excluded |
| 15 | `@img/sharp-win32-x64` | 443,918 | traced native | now excluded (Linux adds libvips 18.2 MB, INFERRED) |
| 16 | `react` | 97,350 | traced | |
| 17 | `@napi-rs/canvas` (js) | 86,290 | traced | |
| 18 | `pdf-parse` (traced part) | 84,041 | traced | |
| 19 | `semver` (2 copies, both under sharp) | 69,727 | duplicate | gone with sharp |
| 20 | `@img/colour` | 46,700 | traced | gone with sharp |
| 21 | `.next/diagnostics` | 91,774 | build | |
| 22 | `scheduler`, `styled-jsx`, `@swc/helpers`, `detect-libc`, `@next/env`, `playwright`, `client-only` | 19,583 to 22,630 each | traced | |
| - | `.next/node_modules/pdf-parse-<hash>` link target (if Amplify copies it, hypothesis H) | 21,255,998 | package | 10,736,375 of it is 47 `.map` files |
| - | `.next/node_modules/playwright-<hash>` link target (hypothesis H) | 5,074,702 | package | |

Everything below 20 KB each is the long tail (reproduce with `npm run check:deploy-size -- --top 40`). Specific
questions asked: no docs/tests/fixtures/data dumps are traced (none under the project root); duplicated packages: only
`semver` (2 copies, 70 KB, via sharp); `xlsx` is bundled into one 411 KB server chunk, not traced; no `@aws-sdk` is
installed; no heic, no other fonts, no large JSON/CSV is read by a route through the filesystem. The only large
platform-specific item is the canvas native addon.

Linux normalisation: the Windows model contains the win32 canvas (36.74 MB) where Amplify's Linux build has the x64
gnu build (31.20 MB, registry): subtract 5,539,263 bytes. Line endings and path separators do not matter: the model
sums file bytes (never text), walks without following links, normalises paths to `/`, and the exclusion globs use the
`**/node_modules/` form that Next itself uses.

## 3. What was changed (all in this branch)

1. `next.config.mjs`: `outputFileTracingExcludes: { '*': [sharp, @img, playwright, playwright-core] }` (key `*` is
   matched against every route and the `next-server` entry; the globs are Next's own form).
   - **sharp + `@img/*`**: pulled in only by Next's image optimizer. The app has no `next/image`, no `ImageResponse`
     and no `/_next/image` URL (the proxy matcher merely excludes the path). Next applies the same two ignores itself on
     hosts it manages (`collect-build-traces.js`, `hasNextSupport`). MEASURED: with `sharp` and `@img` physically hidden,
     real `next start` still answered `/`, `/login`, `/signup`, `/terms`, a `public/` image and even
     `/_next/image?...` with 200, and the three PDF routes with their own `401 unauthenticated`.
   - **playwright + playwright-core (11.5 MB)**: imported only by `lib/services/reportPdfRenderer.ts` and
     `forecastReportPdfRenderer.ts`, both loaded by dynamic `import()` behind a try/catch (fix 5883b95). MEASURED
     finding that matters beyond size: the tracer misses `playwright-core/browsers.json` (a computed `require`), in
     baseline and after alike, so on the deployed server `require('playwright')` already threw at load time
     ("Cannot find module .../browsers.json"); the traced copy could never launch anything and no browser binary is
     shipped either. Copying only that one file into a minimal bundle made Playwright launch the local Chromium and
     print a PDF. So the 11.5 MB was dead weight, and removing it changes the runtime outcome in no way: the loader
     turns the module-not-found into the typed 503 `renderer_unavailable` (proved by the existing NC-X2 test).
     **To bring server PDF back: remove this entry and add `outputFileTracingIncludes` for the package and its
     `browsers.json`** (see section 5).
2. `amplify.yml` (one hunk in `preBuild`, next to the existing pdfjs `.map` delete): `find node_modules/pdf-parse -type f
   -name '*.map' -delete`. MEASURED locally: frees 10,736,375 bytes of the package and `pdf-parse` still extracts text
   from a real PDF afterwards. Benefit on Amplify only if hypothesis H(a) holds, otherwise it changes nothing.
3. `scripts/check-deploy-size.mjs` + `scripts/lib/deploySize.mjs` + `npm run check:deploy-size`: the guard. Reads the
   finished build, applies the amplify.yml deletes virtually, sums `.next` + the traced union, prints a ranked
   breakdown and exits 1 over the budget (110,000,000) or over the Amplify limit, 2 without a build. It is not wired
   into amplify.yml on purpose (a model must not be able to fail a production deploy; the PO can add it as a warning).
4. Tests: `tests/unit/deployTraceExcludes.test.ts` (6) and `tests/unit/deploySizeGuard.test.ts` (11).

## 4. Proof and results

Before/after, MEASURED on the same machine and method (modelled bytes):

| | origin/main `e65bea9` | this branch | change |
|---|---|---|---|
| `.next` shipped (after deletes) | 38,561,035 | 38,539,729 | -21,306 |
| traced outside `.next` | 58,565,245 | 45,887,707 | -12,677,538 |
| **modelled deployable size** | **97,126,280** | **84,427,436** | **-12,698,844 (-13.1%)** |
| margin under 230,686,720 | 133,560,440 | 146,259,284 | +12,698,844 |
| same, plus the 45,489,684 calibration gap (INFERRED) | 88,070,756 | 100,769,600 | |
| Linux-normalised, plus the gap (INFERRED) | 93,610,019 | 106,308,863 | |

After merging the newer origin/main `8ba4048` (report print-flow UI changes only) the rebuilt guard reads 84,415,025 bytes
(margin 146,271,695), routes-manifest still byte-identical; the table above is the pre-merge measurement.

Under hypothesis H the real saving on Amplify is larger (libvips 18.2 MB would also disappear, and pdf-parse maps
10.7 MB); under no hypothesis is it smaller than what is measured.

Safety proofs (each is a MEASURED observation unless marked):
- Production build passes (type-check included) with the config. Route manifests: `routes-manifest.json` and
  `app-path-routes-manifest.json` byte-identical to the baseline build; 603 app routes identical; 16 prerendered
  routes identical; of the 603 route traces exactly two changed (the two Playwright routes: playwright files removed,
  nothing added); `next-server.js.nft.json` lost only sharp, `@img`, `detect-libc`, `semver`.
- Minimal-bundle test: a directory holding only `.next` (after the deletes) + the files named by the traces +
  `public/`, with Turbopack's two `.next/node_modules` links recreated, started with `next/dist/server/next-server`:
  `/`, `/login`, `/signup`, `/forgot-password`, `/terms`, `/robots.txt`, `/sitemap.xml` 200; `/reports` 307; unknown
  API 404; the three PDF/CAS routes and the forecast export answered their own `401 unauthenticated` (route modules,
  `pdf-parse` link and externals load). In the same bundle `pdf-parse` extracted the text of a real PDF through the
  traced pdfjs worker and canvas addon. Limits: no authenticated session, so the PDF routes were not driven past auth;
  that harness does not serve `public/` (the real `next start` does, tested above).
- Existing suites: `reportExportPdfFailures.test.ts` and `reportReadExportTypedErrors.test.ts` pass (NC-X2: playwright
  unloadable gives typed 503 `renderer_unavailable`, never a platform 500).
- Negative controls (the tests really bite): adding a `next/image` import or a static/dynamic `playwright` import
  under `components/` or `lib/` fails the two safety tests; an over-budget CLI run exits 1.
- `tsc --noEmit` shows one error, in `tests/unit/canonicalCertResidueAllSql.test.ts` (not touched here; an
  origin/main file). `eslint` on all changed files: clean. `m12cServerOnlySecretBoundary.test.ts` has one failure
  (`ENVIRONMENT_VARIABLES.md` quotes 14 forwarded variables, `amplify.yml` forwards 19): pre-existing, both files are
  byte-identical to `origin/main`, and it is independent of this work.
- NOT proven: a real Amplify build; Linux behaviour; Amplify's packager (so section 1's gap).

## 5. Can the freed room hold a headless Chromium?

Candidates (bytes MEASURED from the npm tarball / registry / HTTP headers; counting rule INFERRED):

| Option | Counted in the artifact | Runtime disk / notes |
|---|---|---|
| `@sparticuz/chromium` 153.0.0 (bundled) | 70,091,665 (`chromium.br` 67,016,039; swiftshader 1,637,479; al2023 libs 1,208,350; fonts 183,738; brotli, incompressible) | extracts to `/tmp`: chromium 209,022,176 + swiftshader 7,485,440 + al2023 3,532,800 + fonts 460,800 = **220,501,216 bytes** (MEASURED by decompressing; decompress alone 2.4 s on this 4-core desktop, CPU only). Node >=22.17 (the repo already needs >=24.18). x64 only in the npm package. |
| `@sparticuz/chromium-min` + hosted pack tar | 46,031 (package) | pack tar about the same 70 MB, downloaded to `/tmp/chromium-pack` then extracted at the first cold request (INFERRED: needs outbound network and eats the 28 s window; needs a host such as S3). Not counted in the artifact. |
| Playwright's own headless shell | zip 120,231,126 (x64, Chrome for Testing 151.0.7922.34) / 116,380,215 (arm64); unpacked 283,892,555 (Windows build, MEASURED) | does not fit, and needs system libraries (nss, atk, gtk...) that amplify.yml installs on the BUILD machine only. **Rejected.** |
| `puppeteer-core` + sparticuz | puppeteer-core package, then as the first row | an alternative to playwright-core; same Chromium cost |

Scenarios (modelled / with the 45.5 MB gap, INFERRED; margin under 230,686,720):

| Scenario | Modelled | Margin (model) | With gap | Margin (gap) |
|---|---|---|---|---|
| this branch | 84,427,436 | 146,259,284 | 129,917,120 | 100,769,600 |
| + sparticuz + playwright-core full (11.5 MB) | 166,005,920 | 64,680,800 | 211,495,604 | **19,191,116** |
| + sparticuz + playwright-core without `lib/vite` (7.9 MB) | 162,432,299 | 68,254,421 | 207,921,983 | 22,764,737 |
| main today + sparticuz (no slimming at all) | 167,230,945 | 63,455,775 | 212,720,629 | 17,966,091 |
| this branch + Playwright's own shell (zip size only) | 216,132,381 | 14,554,339 | 261,622,065 | -30,935,345 |

**Verdict.** The room exists but the margin is thin. Bundling `@sparticuz/chromium` fits under the limit in every
scenario, by 63 to 68 MB on the measured model and about 19 to 25 MB if the unexplained 45.5 MB gap is real and
constant (about 8 to 10% of the limit). Slimming did not create the room (the room already existed after the
2026-10-01 sourcemap fix: 17,966,091 bytes under the gap model without any of this work); it adds 1.2 MB net after
Playwright is brought back, and a guard so the margin cannot silently erode. The 19 MB margin is exactly the size of
one more incident. The honest summary: feasible on paper, not comfortable, and the only uncertainty that matters is
what Amplify's packager counts.

What the Amplify compute would additionally need (all INFERRED, none observable from here; the first deployment must
measure them with a probe, see the proposal):
- Lambda-compatible Chromium: yes. Amplify SSR compute is Lambda-like; a stock Chromium or Playwright browser would
  need shared libraries that are not there. `@sparticuz/chromium` ships its own (al2023 tarball) but only unpacks
  them when `AWS_EXECUTION_ENV` (or similar) contains `20.x`/`22.x`/`24.x` (see its `helper.js`); whether Amplify sets
  that variable is unknown.
- `/tmp`: 220.5 MB for the Chromium files alone plus Chromium's profile/cache. Lambda's default is 512 MB. Amplify's
  figure is not documented.
- Memory: Chromium with `--single-process` typically needs several hundred MB on top of the Next server. Amplify's
  compute memory is not documented; this is the most likely thing to kill the request.
- Time: the request limit is 28 s. The renderer's own deadline is 22 s. A cold request must extract about 220 MB, launch
  Chromium, and the renderer then fetches `APP_BASE_URL/reports/<id>/print?token=...` from the same deployment (a
  second request into the same compute, so it also needs a second concurrent instance or spare capacity).
- Node: `@sparticuz/chromium` 153 requires Node ^22.17 or >=24; confirm Amplify's runtime version.
- `playwright-core/browsers.json` and the whole package must be put back (tracer gap above), with
  `outputFileTracingIncludes` for `@sparticuz/chromium/bin/**` too (its binary directory is computed at runtime from
  `import.meta.url`, which the tracer cannot follow; INFERRED from `paths.js`).

## 6. Proposal (NOT implemented; the PO decides): bundled-Chromium server PDF behind a flag

1. Probe first, no renderer change: an admin-only, flag-gated route that returns `AWS_EXECUTION_ENV`, Node version,
   `os-release`, free `/tmp`, `os.totalmem()/freemem()`, and times `chromium.executablePath()` plus a launch of a blank
   page. One DEV deployment answers every INFERRED item above; if memory or `/tmp` fail, stop here (cost: the 70 MB).
2. Add `@sparticuz/chromium` and re-enable Playwright via `playwright-core` `chromium.launch({ executablePath, args })`
   (keep `reportPdfRenderer.ts`; only the launch changes), remove the exclusion, add `outputFileTracingIncludes`.
   Raise `DEPLOY_BUDGET_BYTES` to about 190,000,000 in the same commit and say so in the PR.
3. Flag `REPORT_PDF_SERVER_RENDER_ENABLED` (default off, only the exact text "true" enables), forwarded by
   `amplify.yml` with a `REPORT_PDF_` prefix (and listed in ENVIRONMENT_VARIABLES.md, which the m12c test cross-checks).
   Off means today's behaviour: typed 503 `renderer_unavailable` and the Print / Save as PDF flow.
4. Guard rails: one render at a time per instance, per-user rate limit, hard `deadlineAt` at 22 s with browser kill in
   `finally`, `/tmp` cleanup of the profile directory per call, no `--disable-web-security` beyond what sparticuz sets.
5. Test plan: unit (flag parsing, loader failure typing, launch-argument builder), the existing NC-X2 suite unchanged,
   the guard (`check:deploy-size`) with the raised budget, a DEV Amplify deployment with the probe, then a real
   export of a 10-page report with timing, peak memory and `/tmp` use recorded, a cold-start run, a concurrent pair,
   and a failure drill (flag on with the binary removed gives the typed 503, never a 500).
6. Risks: memory kill (most likely), cold start near 28 s, the self-fetch of the print page, a 19 to 25 MB margin that
   one more dependency erases, Chromium security patch cadence (a 70 MB binary to refresh).
7. Alternative that adds no bytes: render PDFs outside the SSR bundle (a separate small Lambda/container fed the HTML).
   Not evaluated here.

## 7. Candidates that need a decision (nothing below was changed)

- `@napi-rs/canvas` (31.2 MB Linux, 36.7 MB Windows): pdfjs uses it only to polyfill DOMMatrix/ImageData/Path2D. A pure
  JS polyfill could drop it but needs a per-document proof across real CAS/bank statements. Largest single lever left.
- `amplify.yml` still runs `yum install ... ` and `npx playwright install chromium` on every build. Nothing at runtime
  uses them (the browser lives in the build container). Removing them shortens builds; they are unrelated to size.
- `.next/types` (288 KB), `.next/diagnostics`, `.next/trace` (222 KB): deletable, about 0.6 MB; not worth a hunk.
- `playwright` stays in `dependencies` (the e2e and scripts use it); moving it changes nothing for the tracer.
- Wiring `check:deploy-size` into `amplify.yml` as a warning step.

## 8. Shared files touched (keep hunks small when merging)

`next.config.mjs` (one new property, before the `turbopack` block), `amplify.yml` (one hunk in `preBuild`, far from the
forward list that the Module 11 branch edits), `package.json` (one script line). New files: `scripts/check-deploy-size.mjs`,
`scripts/lib/deploySize.mjs`, `tests/unit/deploySizeGuard.test.ts`, `tests/unit/deployTraceExcludes.test.ts`, this doc.
