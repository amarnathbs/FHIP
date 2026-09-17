// M12C §13 (`M2-OPEN-4`) — the server-only boundary marker.
//
// WHAT THIS CLOSES. Before M12C there was no `import 'server-only'` anywhere in
// this repository, no lint rule and no test: the fact that
// `SUPABASE_SERVICE_ROLE_KEY`, `AIE_OPENAI_API_KEY` and
// `AIE_MASK_TOKEN_ENCRYPTION_KEY` never reached the browser rested entirely on
// nobody having yet written the import that would put them there. That held,
// but "nobody has done it yet" is not an enforcement.
//
// WHY THIS MODULE AND NOT THE `server-only` NPM PACKAGE. The canonical package
// works by declaring a `react-server` condition in its own `exports` map, so
// bundling it into a client graph is a BUILD-TIME error — strictly stronger
// than what this file can do, and it is the right destination. It is not used
// here because it is not installed (absent from `package.json`,
// `package-lock.json` and `node_modules`), and adding a dependency is a
// lockfile change this DEV-only phase deliberately did not make. **That upgrade
// is recorded as a named follow-up in the M12C report rather than implied to
// have happened.** Swapping this file's body for `import 'server-only';` is the
// whole of that change; every call site already points here.
//
// WHAT THIS FILE DOES DO, and it is real rather than decorative:
//
//   1. It is a single, greppable, testable marker. `tests/unit/
//      m12cServerOnlySecretBoundary.test.ts` asserts that EVERY module under
//      `lib/aie/` that reads a secret imports it, and — separately and more
//      importantly — walks the value-import graph from every `'use client'`
//      component to prove none of them can reach such a module even
//      transitively. That graph proof is what actually keeps the secrets out of
//      the bundle; this marker is what makes the set of protected modules
//      explicit instead of implicit.
//
//   2. If a protected module ever IS pulled into a client bundle, this throws
//      while that bundle is being evaluated, in the browser, loudly — rather
//      than the module quietly reading `process.env.X` as `undefined` and the
//      feature failing somewhere far away for a reason nobody can see. A
//      silent `undefined` is the failure mode worth preventing here: it looks
//      like a bug in the feature, not like a boundary violation.
//
// It intentionally does NOT try to detect Node's absence, test runners, or SSR.
// The only condition it treats as a violation is a real browser global, because
// that is the only condition that is unambiguously wrong.

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  throw new Error(
    'server-only: a module that reads a server-side secret was imported into a client bundle. ' +
      'This is a boundary violation, not a runtime condition to handle — find the `use client` ' +
      'component whose import graph reaches it and import the type or the pure helper instead. ' +
      'See lib/serverOnly.ts and tests/unit/m12cServerOnlySecretBoundary.test.ts.',
  );
}

export {};
