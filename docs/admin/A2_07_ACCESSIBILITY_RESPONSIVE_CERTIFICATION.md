# A2.4 — Accessibility and Responsive Certification

## 1. Method and honest scope

This certification is **static/code-review-based plus targeted structural fixes**, not an automated axe/Lighthouse run or a real multi-viewport browser walkthrough — no such tooling was executed in this pass (disclosed gap, carried into `A2_14_TERMINAL_CERTIFICATION_REPORT.md`'s CONDITIONAL PASS condition). The shell was built with Tailwind's standard flex/grid utilities and no fixed-position elements, so the structural claims below are verifiable by inspection of `components/admin/AdminShell.tsx`, but have not been machine- or human-verified in a real rendered browser at each required width in this pass.

## 2. WCAG 2.2 AA checklist — code-level status

| Requirement | Status | Evidence |
|---|---|---|
| Skip link to main content | **Added this pass** | `AdminShell.tsx` — first focusable element, `sr-only focus:not-sr-only` |
| Landmarks | Present | `<nav aria-label="Admin areas">`, `<nav aria-label="Admin navigation">` (desktop aside), `<nav aria-label="Breadcrumb">`, `<main id="admin-main-content">` (added this pass) |
| One correct page-level heading | Delegated to each page | Shell renders no competing `<h1>`; every existing page keeps its own single `<h1>` (dispatch §7 — not mechanically rewritten) |
| Navigation accessible name | Present | Each `<nav>` has a distinct `aria-label` |
| Current-page indication | Present | `aria-current="page"` on the active nav item and the final breadcrumb |
| Keyboard-only operation | Structurally supported | All controls are native `<button>`/`<a>`/`<Link>` elements; no custom widget requiring bespoke key handling except the mobile drawer, which now has Escape support (added this pass) |
| Visible focus | Relies on Tailwind/browser default outlines | No `outline: none` anywhere in the shell; the skip link and drawer trigger use explicit `focus-visible:outline` |
| Escape handling for mobile navigation | **Added this pass** | `document.addEventListener('keydown', ...)` closes the drawer and returns focus to the trigger |
| Focus return after drawer closure | **Added this pass** | Escape → trigger button; link selection → `#admin-main-content` |
| Screen-reader announcement of nav state | Present | `aria-expanded` on the mobile trigger and each area disclosure button |
| Meaningful link names | Present | Every link's visible text is its destination label; no bare icon links in the nav itself |
| Icon accessible names | Present | `Menu`/`X`/`ChevronDown` are `aria-hidden`, with the meaningful label on the parent button (`aria-label`) |
| Sufficient contrast | Not independently re-measured this pass | Reuses the same design tokens (`text-ink`, `text-muted`, `text-trust`, `border-line`) already used and presumably certified elsewhere in the app; no new color was introduced |
| 200% zoom | Not tested live this pass | Layout uses relative units (`text-sm`, `px-*`, `rem`-based Tailwind spacing) and no fixed pixel widths beyond `lg:w-56` sidebar, which itself sits inside a flex row that wraps to a stacked mobile layout below `lg` |
| Reduced-motion compatibility | Not explicitly handled | The only animation is a CSS `transition-transform` on the disclosure chevron — cosmetic, not motion a `prefers-reduced-motion` user would need suppressed; no auto-playing or scrolling content exists |
| No screen-reader-only content causing overflow | Present | `sr-only`/`focus:not-sr-only` is the standard Tailwind pattern already used elsewhere in this codebase |
| No focus movement into hidden navigation | Present | The mobile drawer is only rendered in the DOM (`{mobileNavOpen && (...)}`) while open — a closed drawer has no focusable content to move into |

## 3. Responsive behaviour — structural review

| Width | Structural expectation | Verified how |
|---|---|---|
| 320–390px (mobile) | Desktop `<aside>` is `hidden` below `lg` (1024px); mobile trigger + disclosure drawer take over; breadcrumb row uses `flex-wrap` | Code inspection only — not rendered in a real viewport this pass |
| 768px (tablet) | Same mobile layout persists (breakpoint is `lg`, 1024px, not `md`) | Code inspection only |
| 1024–1440px (desktop) | `<aside>` becomes visible (`lg:block`), content area is `flex-1 min-w-0` so it never overflows its row | Code inspection only |

No page-level horizontal overflow is expected from the shell itself (`min-w-0` on the flex children, no fixed-width elements exceeding viewport at any breakpoint), but this was not confirmed with a real rendered page carrying its own (potentially wide) table/workflow content, which dispatch §19 separately flags as "remain usable within their own containers" — those domain pages are unchanged by A2 and were not re-tested for their own internal overflow behaviour in this pass.

## 4. Disclosed gap

**No live browser-based accessibility or responsive certification (automated axe/Lighthouse pass, or manual keyboard/screen-reader walkthrough at the required widths) was performed in this pass.** This is the primary named condition of the CONDITIONAL PASS verdict — see `A2_14_TERMINAL_CERTIFICATION_REPORT.md` §2.
