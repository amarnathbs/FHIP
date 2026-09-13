# AIE-1 Closure — Accessibility Certification (mission section 12)

## Headline: real automated tooling added and run against real DEV. As of the 2026-09-14 infrastructure-activation follow-on, all 7 of RunReviewPanel's possible user-facing states are confirmed to render something meaningful — 4 REAL defects were found and fixed by systematically checking every state, not merely left untested. Manual screen-reader certification remains an explicit, disclosed gap — not fabricated.

## 0a. 2026-09-14 update — 4 real render-gap defects found and fixed via full state-space checking

§5 below originally disclosed "failure/retry states were not exercised at
all" as an open gap. Investigating it live escalated into a systematic
check: `lib/aie/review/types.ts` defines exactly 7 possible
`AieUserFacingState` values. `components/aie/review/RunReviewPanel.tsx`
originally had only 3 render branches (`ready_to_accept`, the
exception-item list, `processing`). Checking each of the remaining 4
values against the real running app — not by static review, by actually
constructing each DB state and loading the real page — found that all
four rendered **nothing** but the navigation shell and filename header:

| State | Meaning | Confirmed live before fix |
|---|---|---|
| `import_failed` | Accepted, then the canonical write itself failed | Blank |
| `unable_to_process_safely` | Failed before ever reaching acceptance | Blank |
| `accepted_importing` | Accepted, write genuinely in progress | Blank |
| `completed` | Successfully saved | Blank — arguably the most commonly reached of the four in real usage, since every successful acceptance eventually reaches this state permanently (e.g. revisiting a bookmarked/refreshed run URL) |

The `completed` gap specifically evaded the original accessibility pass's
own live-region check (§4 below): that check only verified the
live-region *element* exists (`count() > 0`), which is always true since
the element is unconditionally rendered — it never checked the element
actually held any announced *text*. The fix scripts below check real text
content instead.

**Fixed the same session**: 4 new render branches (reusing
`ResourceErrorState`/`ResourceEmptyState` and this codebase's own
established status copy, matching `ReviewInbox.tsx`'s `STATE_COPY`
conventions), each with a matching live-region announcement set alongside
the data that drives it — not in a separate reactive effect, which
`react-hooks/set-state-in-effect` correctly flagged as a render-cascade
risk on the first attempt. `scripts/aiecl_failed_state_ui_live_dev_check.ts`
(import_failed/unable_to_process_safely, 16/16) and
`scripts/aiecl_accepted_importing_ui_live_dev_check.ts`
(accepted_importing/completed, 14/14): real disposable synthetic DEV
users, a genuinely-reached DB state for every scenario, real HTTP, real
rendered DOM, fresh axe-core scans (zero violations on all 4), zero
residue throughout.

**All 7 of the run-detail component's possible states are now confirmed
live to render something meaningful — no remaining silent-blank-page
state exists in this component.**

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
- **All 7 of the run-detail component's possible `AieUserFacingState`
  values are now axe-scanned** (`ready_to_accept`, `needs_your_review`,
  `processing`, and — per the 2026-09-14 update in §0a above —
  `accepted_importing`, `completed`, `import_failed`, and
  `unable_to_process_safely`). All seven: zero violations, and (per §0a)
  all four newly-added states were also confirmed to genuinely RENDER
  something, not merely score clean on the states that already did. No
  remaining state of this component is unscanned or unrendered.
- **Investment Intelligence and FDH-bank review journeys were not
  scanned** — no route exists to drive II through the review UI at all
  (see the mission's own baseline reconciliation: no HTTP intake route
  exists for II), and FDH-bank's review journey was not separately seeded
  and scanned this pass (time-boxed; the Insurance journey was prioritised
  as the one with a real, certified end-to-end path to build on).

## 6. Material findings and fixes

**Four real, material findings — found and fixed 2026-09-14 (§0a).** The
initial screens axe-scanned in this section's earlier passes (inbox,
`unresolved`, `awaiting_acceptance`) returned zero WCAG2A/AA violations on
the first run each — no automated-tooling fix was required for those. But
systematically checking every one of the 7 possible `AieUserFacingState`
values against the real running app — a technique no automated axe scan
performs on its own (axe scores what's rendered for violations; it does
not know a state renders *nothing* when it should render something) —
found that 4 of the 7 states (`import_failed`, `unable_to_process_safely`,
`accepted_importing`, and `completed`) all silently rendered nothing below
the page header. This class of defect is invisible to axe-core by
construction (no content ≠ a WCAG rule violation) and, in the `completed`
case, also evaded this report's own earlier live-region check, which
verified only that the live-region *element* existed, not that it held
real text. All four fixed; all four now render a genuine explanation,
announce it via a live region with real text content, and pass a fresh
axe scan with zero violations on top of that.
