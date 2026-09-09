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
  // Multi-worktree dev-server disambiguation (found during LR-1's
  // live-autonomy proof, 2026-09-06): any worktree nested under
  // D:\FHIP\.claude\worktrees\... sits alongside D:\FHIP itself (the main
  // checkout, a different branch) — both carry their own package-lock.json.
  // Turbopack's automatic workspace-root inference walks up from cwd and
  // picks the topmost lockfile it finds, so it silently selected D:\FHIP as
  // the project root instead of this worktree, which made `next dev` resolve
  // `app/api/...` against the WRONG checkout (one with no relationship to
  // this branch's actual routes) and return spurious 404s for real, existing
  // routes. Pinning the root explicitly to `import.meta.dirname` is Next.js's
  // own documented fix for exactly this warning. Kept permanently, not
  // reverted: it only affects `next dev`'s workspace-root inference (this
  // repo's `next build` script does not pass `--turbopack`, so production
  // builds are unaffected), and the underlying nested-worktree layout is a
  // standing fact of this project's environment, not specific to LR-1.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
