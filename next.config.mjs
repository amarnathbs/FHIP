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
  // @napi-rs/canvas* family, not just the base package, and applies to
  // every API route (the two known callers today are Investment
  // Intelligence's document processing and Financial Data Hub's bank-PDF
  // processing; scoping this broadly means a future PDF-processing route
  // doesn't silently reintroduce the same gap).
  serverExternalPackages: ['pdf-parse', '@napi-rs/canvas'],
  outputFileTracingIncludes: {
    '/api/**/*': ['./node_modules/@napi-rs/canvas*/**/*'],
  },
};

export default nextConfig;
