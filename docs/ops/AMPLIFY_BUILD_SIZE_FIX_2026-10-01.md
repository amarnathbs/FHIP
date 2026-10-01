# Amplify build-size failure (build #270) - cause and fix, 2026-10-01

Status: fix committed on `fix/amplify-build-size-20261001`, NOT pushed, NOT verified on a real Amplify
build. Everything below labelled "measured" was measured locally on this machine (Windows, Next 16.2.12
Turbopack, Node 24.18). Everything labelled "inferred" is reasoning, not an observation.

## 1. Incident

Amplify deployment #270 of `origin/main` (merge `cce323f`) failed at packaging:
`The size of the build output (232331902) exceeds the max allowed size of 230686720 bytes` (over by
1,645,182 bytes). #268 (`ab9c8a1`) and #269 (`35956a7`) passed. Production still serves #269.
Same failure class as #246/#247 (2026-09-28, over by ~2.95MB), which was handled by deleting
`pdf.worker.mjs.map` and `.next/cache`. Both earlier fixes bought only a few MB of margin, so the app
stayed within about 1MB of the ceiling.

## 2. Measurement method and calibration

What Amplify measures is not documented in the repo (grep of docs/ for the error text finds only
`amplify.yml` comments) and is not observable from here. `amplify.yml` uses `artifacts.baseDirectory:
.next`, `files: **/*`, and the 2026-09-28 incident proved `.next/cache` counted. So the working model
(inferred) is: size = `.next` (minus the deleted cache) + the node_modules files Next traces for the
server (every `*.nft.json`).

Replicated locally, same as `amplify.yml`: fresh `npm ci` (lockfile), preBuild `rm -f
node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs.map`, `NODE_OPTIONS=--max-old-space-size=5120`,
`npm run build`, then measured with a script that sums `.next` (excluding `cache/`) plus the union of
files named in every `.nft.json`. Build-only differences from Amplify: placeholder
`NEXT_PUBLIC_SUPABASE_*` values (prerender fails without them), the second and third builds skipped the
type-check (a temporary, uncommitted `typescript.ignoreBuildErrors`; the first full build had passed it
at `cce323f`), and the traced native binaries are the Windows ones (`@napi-rs/canvas-win32-x64-msvc`,
`@img/sharp-win32-x64`) rather than Linux ones.

Calibration (honest): the absolute number does NOT reproduce Amplify's 232,331,902.

| Build | `.next` (no cache) | traced node_modules | `.next` + traced |
|---|---|---|---|
| `35956a7` (#269, passed) | 125,531,358 | 58,565,245 | 184,096,603 |
| `cce323f` (#270, failed) | 128,276,973 | 58,565,245 | 186,842,218 |
| delta | +2,745,615 | 0 | +2,745,615 |

About 45MB of Amplify's figure is unexplained (Linux binaries differ, and Amplify's packager may copy
more than I modelled), so the absolute number cannot be trusted. The delta is the signal: Amplify's
growth between #269 and #270 is at least 1,645,182 bytes (it crossed the limit from below), and my
`.next` growth of 2.75MB is consistent with that. Of the 2.75MB, 2.18MB is sourcemaps and 0.51MB is
chunk JS (see section 3); without the sourcemaps the growth would be about 0.56MB, too small to have
crossed the limit. That is the evidence (inferred) that Amplify's figure includes the server sourcemaps.

## 3. Growth attribution (measured)

`cce323f` vs `35956a7`: +39 files in `.next` (7,188 to 7,227), traced node_modules unchanged (0 bytes).

| Component | delta bytes |
|---|---|
| `.next/server/chunks/*.js.map` | +2,184,231 |
| `.next/server/chunks/*.js` | +509,332 |
| `.next/server/app` (3 new route entries etc.) | +39,132 |
| `.next/static` and manifests | ~+13,000 |

The first two merges (aie1-scheduler-closure, AIE journey script) touch only SQL, scripts, docs and an
evidence json, none of which Next bundles. All growth is the Document2 merge: three new routes
(`reconciliation-cases/[id]/resolve-{classification,cross-source,instrument}`), plus
`ambiguousInstrumentResolution.ts` (new) and growth of `documentProcessing.ts` and `reconciliation.ts`.
Not a duplicated shared chunk, not a newly traced dependency: the app was simply within about 1MB of the
limit and each route costs roughly 0.7MB of mostly sourcemap.

Why the sourcemaps dominate (measured): `.next` is 128.3MB, of which 94.9MB (74%) is `.map` files, all
under `.next/server` (1,518 chunk maps, 94.36MB; `.next/build` 0.54MB). Turbopack writes one server
chunk per route and each `.map` carries a full `sourcesContent` copy of every module in it. Across the 984
maps in `server/chunks`, 39.7M chars of embedded source exist and ~28.7M are cross-map duplicates; Next's
own `app-route.js` template alone is embedded in 364 maps (6.75M chars), `@edge-runtime/cookies` in 348
(3.66M). Every route therefore costs a few hundred KB of map for almost no extra real code, and the
cost grows linearly with routes.

## 4. The fix (one change, `amplify.yml`)

After `rm -rf .next/cache`, added in the same build phase (so before Amplify packages `.next`):

```
- find .next -type f -name '*.map' -not -path '.next/static/*' -delete
```

Effect (measured, applying the exact command to the `cce323f` build): `.next` 128,276,973 to 33,351,799
(-94,925,174; zero `.map` files remain outside `static/`). Projected Amplify figure for `cce323f`
(inferred): 232,331,902 - 94,925,174 = about 137.4MB, i.e. about 93MB under the 230,686,720 limit
(target was 8-10MB). Even if only the server maps were counted once, the saving is what was measured.

### Safety proof

- What the files are: debug-only `*.js.map` for server chunks. No `.nft.json` lists any `.map`
  (checked on both PDF routes and `next-server`), so tracing/`outputFileTracingIncludes` is unaffected.
  `serverSourceMaps` is not set in `required-server-files.json`; `productionBrowserSourceMaps` is false
  (no browser maps exist; `.next/static` is excluded from the delete anyway so a future opt-in survives).
- Runtime effect: Node only reads a `//# sourceMappingURL` file under `--enable-source-maps`, to rewrite
  stack traces. Verified (measured) with a minimal script under `node --enable-source-maps` whose
  referenced map is absent: no crash, no warning, throws and catches normally, stack just unmapped.
  Next's own use (`patch-error-inspect`, edge sandbox) goes through `module.findSourceMap`, which
  returns undefined for a missing map.
- Local `next start` smoke test (measured), built at `cce323f`, maps deleted, started with
  `NODE_OPTIONS=--enable-source-maps`, placeholder Supabase env: `/` 200, `/login` 200,
  `/forgot-password` 200, unknown API route 404, and POSTs to
  `/api/investment-intelligence/source-documents/abc/process`, `/api/financial-data-hub/bank-pdf/abc/process`,
  `/api/reports/abc/exports`, `/api/investment-intelligence/reconciliation-cases/abc/resolve-instrument`
  all return the app's own `401 {"error":"unauthenticated"}`; no errors in the server log. Note the
  PDF/CAS and Playwright-PDF routes were only reached up to their auth check (no session available), so
  pdf-parse / pdfjs worker / Playwright rendering were NOT exercised by this test. They are unaffected
  by construction (sourcemap deletion changes no executable file, and their traced dependencies are
  identical, 58,565,245 bytes before and after) but I did not run them end to end.
- Not changed: `next.config.mjs`, `outputFileTracing*`, `serverExternalPackages`, headers, any app code,
  `.next/cache` handling, the pdfjs preBuild delete, the Playwright/yum steps.
- Behaviour trade-off: if someone later runs the production server with `--enable-source-maps`, stack
  traces in CloudWatch will point at minified chunks instead of original TypeScript lines. Nothing in
  this repo sets that flag (grep of `amplify.yml`, `package.json`, `next.config.mjs`); Amplify's own runtime
  flags are not visible to me.

## 5. Verification status

Run: the measurement above (two real `next build`s, `35956a7` and `cce323f`); the delete command and
re-measure; the `next start` smoke test; `tests/unit/m12cServerOnlySecretBoundary.test.ts` (the only
test that reads `amplify.yml`): 11/11 pass with `--testTimeout=300000`; at the default 5s one repo-walking case
("no NEXT_PUBLIC_ twin") timed out under machine load, the known hazard, and passes in isolation). No TypeScript was touched, so no
other vitest suites or eslint apply. NOT verified: a real Amplify build or deploy, the true Amplify
size figure, behaviour on Linux/Amazon Linux, authenticated PDF/Playwright routes end to end.

## 6. Alternative for the PO (not performed)

A revert of the three merges is a poor fix: the first two (SQL/scripts/docs) contribute 0 bytes, so only
reverting `document2-final-closure-20260930` would help, and by about 2.75MB local-metric (Amplify:
at least 1.65MB). That returns to #269's footing, which was itself within roughly 1MB of the limit
(inferred), and drops the Document2 closure routes. The sourcemap delete gives about 93MB of headroom
without reverting anything, so I recommend it, applied via the existing deploy path, with a watch on the
first Amplify build's reported size. If Amplify's real figure does not fall by tens of MB, my
"Amplify counts server maps" inference is wrong, and the next lever would be trimming the traced
`@napi-rs/canvas` / `playwright-core` footprint (about 37MB and 11MB respectively on Windows) which
I did not touch because that needs per-route runtime proof.
