/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse (Investment Intelligence CAS parsing, lib/services/
  // investment-intelligence/pdfExtraction.ts) depends on pdfjs-dist, which
  // dynamically imports its own worker script (pdf.worker.mjs) at runtime.
  // Turbopack's server bundling does not resolve/copy that dynamic import
  // target into .next/dev/server/chunks — a real, live-testing-discovered
  // gap (R2/R3 closure pass) that made every real document-processing API
  // call fail with "Setting up fake worker failed: Cannot find module
  // '.../pdf.worker.mjs'" despite pdf-parse working correctly in a
  // standalone Node process. Marking it external tells Next.js to resolve
  // it via Node's normal module resolution at request time instead of
  // bundling it, which is the standard fix for native/worker-based
  // packages (same pattern Next.js itself recommends for sharp, canvas,
  // etc.).
  //
  // *** That comment above describes the DEV/Turbopack half of this bug
  // only. It turned out NOT to also cover PRODUCTION (Amplify/Lambda) --
  // confirmed live 2026-09-06 when a genuine production upload hit the
  // exact same "Cannot find module '.../pdf.worker.mjs'" error despite
  // this serverExternalPackages entry already being in place. The two
  // environments fail via different mechanisms and need different fixes;
  // see outputFileTracingIncludes below for the production half. ***
  //
  // Second, deeper layer of the same class of bug (found live in
  // production 2026-09-06): pdfjs-dist calls into @napi-rs/canvas (its own
  // optional dependency, used as a DOMMatrix/canvas/Path2D/ImageData
  // polyfill for PDFs with certain structures -- embedded images,
  // complex/Type3 fonts -- that plain text extraction doesn't always need,
  // which is why simpler documents worked while a large real 19-page
  // statement did not) for "ReferenceError: DOMMatrix is not defined".
  // @napi-rs/canvas resolves fine in a normal local Node process and even
  // in `next dev`, so marking it external here (as pdf-parse already is,
  // above) stops the bundler from mis-handling its native binding.
  //
  // That alone is not enough, though: pdfjs-dist reaches @napi-rs/canvas
  // via a *dynamically constructed* require --
  //   const require = process.getBuiltinModule("module").createRequire(...)
  //   canvas = require("@napi-rs/canvas")
  // -- specifically so it can fail soft (warn + skip the polyfill) in
  // environments (browsers, edge runtimes) where the package doesn't
  // exist at all. Next.js's production output-tracer (@vercel/nft, which
  // decides exactly which node_modules files ship in each route's Lambda
  // bundle) only follows statically-visible require()/import calls, so it
  // can't see this one and silently drops the package from the deployed
  // bundle even though `serverExternalPackages` correctly stopped it from
  // being inlined. Confirmed via CloudWatch in production: "Cannot find
  // module '@napi-rs/canvas'" despite the package existing in
  // node_modules at build time.
  //
  // The package also ships its native addon as a *separate*,
  // platform-specific optional dependency (@napi-rs/canvas-linux-x64-gnu
  // for Amplify's runtime, @napi-rs/canvas-win32-x64-msvc locally, etc.)
  // -- same pattern as @next/swc-* -- so the glob below covers the whole
  // @napi-rs/canvas* family, not just the base package.
  //
  // Third layer, same root cause, found within minutes of fixing the
  // second (production, 2026-09-06): pdf.mjs itself sets
  //   GlobalWorkerOptions.workerSrc ||= "./pdf.worker.mjs"
  // -- a plain runtime string, not a static import -- and Node then loads
  // that path directly (pdf-parse runs pdf.js in Node's "fake worker"
  // mode: no real worker_threads, just importing the worker script as a
  // module in-process). Being a computed path, @vercel/nft can't see it
  // either, so the outputFileTracingIncludes fix has to cover pdfjs-dist
  // as a whole -- not just @napi-rs/canvas -- rather than chasing each
  // individual dynamically-loaded file one production incident at a time.
  //
  // First deploy attempt at this fix (2026-09-06, deployments 125/126)
  // used '/api/**/*' as the include key -- every API route, not just the
  // ones that need it -- and both deploys failed with a silent, logless
  // "Deploy cancelled" right after a fully successful `next build`. That
  // pattern (build succeeds, packaging/deploy step aborts with no error
  // text) is the signature of an oversized deployment artifact, not a
  // code defect: pdfjs-dist + @napi-rs/canvas together are ~70MB, and
  // applying that to every one of this app's ~100+ API routes multiplies
  // out fast. Scoped down to just the two routes that actually import
  // pdfExtraction.ts/textExtraction.ts below -- narrower is strictly
  // safer here, and a route that newly needs PDF extraction needs an
  // entry added anyway (the whole point of scoping is that "silently
  // works everywhere" was the thing that broke the deploy).
  // Next.js matches these keys against each route with picomatch, which
  // treats a bare [id]/[documentId] as a glob CHARACTER CLASS (one
  // literal 'i' or 'd'), not the literal dynamic-segment text -- so an
  // unescaped bracket key silently matches nothing at all (confirmed:
  // this exact mistake was tried first and produced zero traced files
  // for either target route, with no error -- just quietly no-op'd).
  // The brackets must be escaped so picomatch treats them as literal
  // characters.
  // That fix (deployment 127) then hit Amplify's own hard build-output
  // size cap: "The size of the build output (246769854) exceeds the max
  // allowed size of 230686720 bytes" -- 246MB vs a ~220MB ceiling, over by
  // ~15MB. `./node_modules/pdfjs-dist/**/*` pulls in the ENTIRE package
  // (~36MB) -- the non-legacy build/ directory (13MB, unused: this app
  // only imports legacy/build/pdf.mjs), types/ (521K, build-time only),
  // cmaps/ (1.4MB, non-Latin font support, irrelevant to plain text
  // extraction) and web/ (1.4MB, browser UI, never runs server-side) --
  // when the actual runtime need is exactly one 2MB file:
  // legacy/build/pdf.worker.mjs (the same path named in the error above).
  // @napi-rs/canvas's own footprint (~26-36MB, almost entirely its native
  // Skia binary) is not similarly trimmable -- that binary IS the
  // dependency -- so the saving has to come from pdfjs-dist, and trimming
  // ~34MB off a ~15MB overage leaves real margin rather than landing
  // exactly on the line.
  // Next.js's tracer pulls a traced file's sibling .map source map in
  // automatically even when only the .mjs itself is named above --
  // pdf.worker.mjs.map adds another 5.1MB, pure debug-symbol weight with
  // no runtime purpose in a Lambda that will never open dev tools against
  // it. An outputFileTracingExcludes entry for it was tried and dropped:
  // it did not visibly take effect in local verification (Windows
  // path-separator handling in the matcher is the suspect, unconfirmed
  // either way against Amplify's actual Linux build), and the ~34MB
  // already saved by trimming the include above leaves ample margin
  // (~29MB net) against the ~15MB overage even carrying this extra 5MB,
  // so shipping an unverified exclude wasn't worth the risk of a fourth
  // failed deploy over an unproven mechanism.
  serverExternalPackages: ['pdf-parse', '@napi-rs/canvas'],
  outputFileTracingIncludes: {
    '/api/investment-intelligence/source-documents/\\[id\\]/process': [
      './node_modules/@napi-rs/canvas*/**/*',
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ],
    '/api/financial-data-hub/bank-pdf/\\[documentId\\]/process': [
      './node_modules/@napi-rs/canvas*/**/*',
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ],
  },
};

export default nextConfig;
