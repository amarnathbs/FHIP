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
  serverExternalPackages: ['pdf-parse'],
};

export default nextConfig;
