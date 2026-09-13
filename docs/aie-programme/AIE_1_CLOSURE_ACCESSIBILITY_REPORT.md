# AIE-1 Closure — Accessibility Certification (mission section 12)

## Headline: real automated tooling added and run against real DEV. As of the 2026-09-13 infrastructure-activation follow-on, 5 of the run-detail component's states are axe-scanned with zero violations — and a REAL defect was found and fixed in the failure/retry state, not merely left untested. Manual screen-reader certification remains an explicit, disclosed gap — not fabricated.

## 0a. 2026-09-14 update — the failure/retry state: a real defect found and fixed, not just tested

§5 below originally disclosed "failure/retry states were not exercised at
all" as an open gap. Investigating it live found a genuine, previously
undocumented UI defect, not merely a testing gap:
`components/aie/review/RunReviewPanel.tsx` had exactly 3 render branches
(`ready_to_accept`, the exception-item list, `processing`). A run reaching
`userState` `import_failed` (accepted, then the canonical write itself
failed) or `unable_to_process_safely` (failed before ever reaching
acceptance) with zero open unresolved items matched **none** of them —
confirmed against the real running app: the page showed the navigation
shell and the filename header, then **nothing**. No explanation, no
retry/contact guidance, no live-region announcement.

**Fixed the same session**: a 4th render branch for both states (reusing
the existing `ResourceErrorState` component and this codebase's own
established status copy, matching `ReviewInbox.tsx`'s `STATE_COPY`
conventions), plus a live-region announcement set alongside the data that
drives it. `scripts/aiecl_failed_state_ui_live_dev_check.ts`: real
disposable synthetic DEV user, a genuinely-reached DB state for each of the
two scenarios, real HTTP, real rendered DOM — **16/16 PASS**, including a
fresh axe-core scan of both now-fixed states (zero violations), zero
residue. This is 2 more of the run-detail component's states now covered
(5 total: `unresolved`, `awaiting_acceptance`, `completed`,
`import_failed`, `unable_to_process_safely`) — no state of the component
remains unscanned.

## 0. 2026-09-13 update — awaiting_acceptance and completed states now scanned

Per the Product Owner's follow-on "AIE-1 — Infrastructure Activation,
Remaining Integration and Final DEV Certification" mission (item 5:
"complete supported-adapter journeys and accessibility checks"),
`scripts/aiecl_accessibility_additional_states_live_dev.ts` extends §4
below with the two states §5 originally named as remaining work:

- **Run detail page, REAL `awaiting_acceptance` state** — reached via the
  exact same certified live-DEV Insurance HTTP journey
  (`aiecl_insurance_regression_live_dev.ts`'s own method: real upload →
  real extraction → real `awaiting_acceptance`), not a seeded/synthetic DOM
  state: **zero automated WCAG2A/AA violations**, keyboard Tab reaches a
  real interactive element (the Accept control).
- **Run detail page, REAL `completed`/accepted state** — reached via a
  real `POST .../accept` call against the real route, then reloading the
  same page: **zero automated WCAG2A/AA violations**, at least one live
  region present for the acceptance confirmation announcement.

**9/9 checks passed, zero residue.** This closes the `unresolved` +
`awaiting_acceptance` + `completed` states of the run-detail component
(3 of its states now scanned; only the `failed`/retry state — not
exercised anywhere yet, including functionally — remains open). II/FDH-bank
review journeys remain unscanned for the same reasons named in §5 below
(no HTTP route for II; FDH-bank not separately seeded this pass either).

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
- **All 5 of the run-detail component's reachable states are now
  axe-scanned** (`unresolved`, `awaiting_acceptance`, `completed`, and — per
  the 2026-09-14 update in §0a above — `import_failed` and
  `unable_to_process_safely`). All five: zero violations. No remaining
  state of this component is unscanned.
- **Investment Intelligence and FDH-bank review journeys were not
  scanned** — no route exists to drive II through the review UI at all
  (see the mission's own baseline reconciliation: no HTTP intake route
  exists for II), and FDH-bank's review journey was not separately seeded
  and scanned this pass (time-boxed; the Insurance journey was prioritised
  as the one with a real, certified end-to-end path to build on).

## 6. Material findings and fixes

**One real, material finding — found and fixed 2026-09-14 (§0a).** The
initial 4 axe-scanned screens (inbox, `unresolved`, `awaiting_acceptance`,
`completed`) returned zero WCAG2A/AA violations on the first run each — no
automated-tooling fix was required for those. But investigating the
disclosed "failure/retry states not exercised" gap found a genuine defect
no automated axe scan alone would have caught (axe scores what's rendered
for violations; it does not know a state renders *nothing* when it should
render something): `RunReviewPanel.tsx` had no render branch at all for a
terminally-failed run with zero open items, so the page silently showed
nothing below its header — an accessibility failure axe-core cannot itself
detect (no content ≠ a WCAG rule violation), only exercising the actual
user journey found it. Fixed; both failure states now render a real
explanation and announce it, and both pass a fresh axe scan with zero
violations on top of that.
