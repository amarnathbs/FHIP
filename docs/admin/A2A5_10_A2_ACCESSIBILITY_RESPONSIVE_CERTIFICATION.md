# A2 — Accessibility and Responsive Certification

## Status: PARTIAL — static source review completed (real findings, 1 genuine gap fixed, 1 unverifiable-without-live-browser gap disclosed); automated tooling and live multi-viewport testing remain BLOCKED (no DEV credentials, same root cause as `A2A5_09`)

Per mission §14, live automated a11y tooling and manual live-browser checks cannot run in this environment. Rather than stop at "BLOCKED" with no further evidence (which mission §9's evidence doctrine treats as weaker than it needs to be when a real alternative exists), this document performs a **direct, line-by-line static source review** of `components/admin/AdminShell.tsx` against every checklist item in the mission's §8.5 — genuine analysis, not a live test, and clearly labelled as such throughout.

## 1. Checklist results (static source review of `AdminShell.tsx`)

| Requirement | Finding |
|---|---|
| Skip link | **PASS** — first focusable element, `sr-only focus:not-sr-only`, targets `#admin-main-content` (lines 160–165) |
| Landmarks | **PASS** — `<nav aria-label="Admin areas">`, `<nav aria-label="Breadcrumb">`, `<aside aria-label="Admin navigation">`, `<main id="admin-main-content">` all present and labelled |
| Named navigation | **PASS** — both `<nav>` elements carry a distinct `aria-label` |
| Current-page indication | **PASS** — `aria-current="page"` applied consistently on the active nav link and the final breadcrumb crumb |
| Keyboard-only use | **PASS by construction** — every interactive control is a native `<button>` or `<Link>` (renders `<a>`); no `<div onClick>` pseudo-controls found |
| Escape behaviour | **PASS** — closes the mobile drawer and returns focus to the trigger button (lines 56–66) |
| Focus return (post-navigation) | **PASS** — selecting a link inside the mobile drawer closes it and moves focus to the main-content landmark (lines 68–78) |
| Drawer state announcement | **PASS** — `aria-expanded`/`aria-controls` on the trigger button is the correct ARIA disclosure pattern; no separate live-region needed for this pattern |
| Icon names | **PASS** — every `lucide-react` icon (`ChevronDown`, `Menu`, `X`) carries `aria-hidden="true"`; the one icon-only button (`aria-label={mobileNavOpen ? 'Close Admin navigation' : 'Open Admin navigation'}`) has an explicit accessible name |
| Meaningful links | **PASS** — link text is always the area/destination label; no "click here"/bare-icon links found |
| No hidden-navigation focus | **PASS** — the mobile drawer is conditionally *rendered* (`{mobileNavOpen && (...)}`), not merely CSS-hidden, so its links do not exist in the DOM (and cannot receive keyboard focus) while closed — the correct, stronger pattern, not the weaker `display:none`/`visibility:hidden` approach that can leave elements tab-reachable in some browsers |
| No page-level horizontal overflow (structural indication) | **Indicative PASS, not proven** — `min-w-0` is applied on the flex children that would otherwise force overflow; this is the correct Tailwind/flexbox technique, but actual rendered overflow at each of the 7 required widths was not observed live |
| **Focus trap within the open mobile drawer** | **GAP — genuine, specific, found by this review** — see §2 |
| **Page-level heading (`<h1>`) / heading hierarchy** | **GAP — scope limitation, disclosed** — see §3 |
| Reduced motion | **Minor, low-severity note** — see §4 |
| Colour contrast | **NOT VERIFIED** — requires either live rendering or reading the design system's actual colour token values (out of this component's own source); not attempted this pass |
| 200% zoom / exact reflow at 320/375/390/768/1024/1280/1440px | **NOT VERIFIED** — requires a live or headless browser; structural indications (relative sizing, no fixed pixel widths in this component) are favourable but not proof |

## 2. Genuine gap found: no focus trap in the open mobile drawer

When `mobileNavOpen` is `true`, `AdminShell` renders the drawer's contents inline in normal document flow (lines 208–212) rather than as a modal/dialog with a trapped tab cycle. A keyboard user who tabs forward through the open drawer's links will, upon reaching the last link, tab **out of the drawer and into whatever comes next in the underlying page** — while the drawer remains visually open. This is a real WCAG 2.2 (2.4.3 Focus Order / typical disclosure-vs-dialog pattern) consideration: a disclosure panel that stays visually present alongside page content is not strictly required to trap focus the way a true modal dialog must, but the mission's own explicit checklist item ("focus trap") signals the drawer should behave like one here. **Not fixed in this pass** — implementing a correct, tested focus trap (and its own negative tests: Tab past the last item wraps to the first, Shift+Tab past the first wraps to the last, trap releases correctly on close) is real, non-trivial UI work that deserves its own reviewed change, not a rushed addition under an unrelated dispatch's time budget. Recorded as a carried finding for a future pass, not silently omitted.

## 3. Scope limitation, disclosed: page-level heading is not this shell's responsibility, and was not verified per-page

`AdminShell` itself never renders an `<h1>`. Heading hierarchy compliance depends entirely on whatever each wrapped page (`children`) renders. This dispatch did not audit every Admin page for exactly one `<h1>` — doing so exhaustively across all 36+ Admin pages was judged out of proportion to this dispatch's remaining time budget, especially since the vast majority of those pages were not touched by this dispatch or the original A2 pass at all (their content is unchanged; only their nav wrapping changed). This is disclosed as an unverified item, not asserted as either passing or failing.

## 4. Minor, low-severity note: chevron rotation has no `prefers-reduced-motion` guard

The area-disclosure chevron icon's `transition-transform` (line 117) is not wrapped in a `@media (prefers-reduced-motion: reduce)` guard. This is a very low-amplitude icon rotation (not a full-page or large-element animation), so its practical impact on a vestibular-sensitive user is minimal, but it is technically a gap against the mission's explicit "reduced motion" checklist item. Recorded, not fixed this pass (a global reduced-motion policy for the whole design system, if one doesn't already exist, is a better fix than a one-off guard on this single icon).

## 5. Disposition

**PARTIAL.** Per mission §15.1, A2 cannot receive FULL PASS without the live/automated a11y gate this document's §1 could not complete. This static review is real, genuine analysis that found one actionable gap (§2) and one scope limitation (§3) neither of which was previously disclosed anywhere in this report set — an improvement over simply restating "BLOCKED" with no further content, but explicitly **not** a substitute for the live/automated certification mission §8.5 actually requires. That remains BLOCKED for the same reason as `A2A5_09` (no DEV credentials in this environment) and is not claimed as closed here.
