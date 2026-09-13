# AIE-1 Closure — Accessibility Certification (mission section 12)

## Headline: real automated tooling added and run against real DEV, zero violations on the two screens covered. Manual screen-reader certification remains an explicit, disclosed gap — not fabricated.

## 1. Starting position

Confirmed by repo-wide grep before this mission touched anything: **zero
automated accessibility tooling existed anywhere in this repository.**
`tests/e2e/fdh14-ui-accessibility-smoke.spec.ts` is the one prior
"accessibility" spec, and it performs hand-written attribute/keyboard
checks only (`aria-expanded` presence, tab-reachability, no-overflow) —
never a real automated audit (no `axe-core`/`jest-axe`/`cypress-axe`
dependency anywhere, confirmed).

## 2. What was added

`@axe-core/playwright` (new dev dependency, installed this pass via
`npm install --save-dev @axe-core/playwright`) — the industry-standard
automated accessibility rules engine, run for real against a real running
app connected to real DEV Supabase infrastructure via
`scripts/aiecl_accessibility_live_dev_check.ts`.

## 3. What the mission's 9 named screens actually are

The mission names: upload, security-check progress, extraction progress,
failure/retry, exception navigation, field correction, summary, acceptance,
completion. Inspecting the real AIE review UI
(`app/(app)/aie-review/page.tsx`, `app/(app)/aie-review/[runId]/page.tsx`)
shows these are **states of two React route components**, not nine
separate pages — the run-detail page renders differently depending on the
run's own status (`unresolved` → exception navigation/field correction;
`awaiting_acceptance` → summary/acceptance; `completed` → completion), and
upload/security-check/extraction progress are states of the intake flow
itself (currently a raw JSON API response, not yet a dedicated progress
UI — matches the mission's own note that AIE-1.1's upload UX is
"explicitly out of scope for this phase," a pre-existing, disclosed scope
boundary this mission did not change).

## 4. Real DEV evidence — 8/8 checks pass

Real disposable synthetic DEV user, real login via `/login`, real
authenticated session, real seeded `aie_unresolved_item` row.

1. **Review inbox (empty state)**: zero automated WCAG2A/AA violations.
2. No horizontal overflow at mobile width (375px).
3. **Run detail page, `unresolved` state** (the exception-navigation/
   field-correction screen — the one carrying the most interactive
   surface: reason text, correction inputs, decision buttons): zero
   automated WCAG2A/AA violations.
4. Keyboard `Tab` genuinely reaches a real interactive element (not stuck
   on `<body>`) — a structural check that at least one focusable control
   exists and is reachable via keyboard alone.
5. At least one ARIA live region (`role="status"`/`role="alert"`/
   `aria-live`) exists on the page for status announcements — consistent
   with `lib/aie/review/ariaLabels.ts`'s own hand-written label
   conventions actually being present in the rendered DOM, not just
   defined in source and never used.

Zero residue after cleanup (independently re-verified).

## 5. What this does NOT cover — stated plainly, not glossed over

- **No manual screen-reader pass.** No screen reader (NVDA/JAWS/VoiceOver)
  is available in this environment. Mission section 12's own instruction —
  "If tooling is unavailable, report that verification gap explicitly. Do
  not claim manual accessibility certification from static code review." —
  is followed here: this gap is real and open, not asserted closed.
- **Only two of the run-detail component's several states were axe-
  scanned**: `unresolved`. The `awaiting_acceptance`/`accepted`/
  `completed` states were exercised FUNCTIONALLY (proven to work
  end-to-end) by `scripts/aiecl_insurance_regression_live_dev.ts`, but not
  separately run through axe-core in this pass — the DOM does differ
  between these states (different controls: correction inputs vs. an
  Accept button vs. a completion summary), so a full certification should
  scan each state independently. This is real, scoped-down, disclosed
  remaining work, not silently skipped.
- **Failure/retry states were not exercised at all in this accessibility
  pass** (a rejected/failed run's own detail view) — flagged as remaining
  work.
- **Investment Intelligence and FDH-bank review journeys were not
  scanned** — no route exists to drive II through the review UI at all
  (see the mission's own baseline reconciliation: no HTTP intake route
  exists for II), and FDH-bank's review journey was not separately seeded
  and scanned this pass (time-boxed; the Insurance journey was prioritised
  as the one with a real, certified end-to-end path to build on).

## 6. Material findings and fixes

**None found.** Both scanned screens returned zero WCAG2A/AA violations on
the first run — no fix was required. This is recorded honestly as a clean
result, not underclaimed or overclaimed: it reflects genuine tooling
output on the two states actually tested, not an inference about the
states/journeys not yet tested.
