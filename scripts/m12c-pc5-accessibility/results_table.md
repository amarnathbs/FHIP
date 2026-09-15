# M12C §16 — PC5 accessibility (`M5-OPEN-1`)

Ran 2026-09-15T17:54:44.640Z against http://localhost:3958, database `vqycarelcoijzwlpkpcz.supabase.co`.
Tool: `@axe-core/playwright`, tags `wcag2a` + `wcag2aa`, against the real rendered DOM of a real running app.

## Automated axe results, per state

| State | Reached | axe rules passed | Needs review | Violations | critical | serious | moderate | minor | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Resolution centre (listing, blocking items outstanding) | yes | 24 | 1 | 0 | 0 | 0 | 0 | 0 | PASS |
| Owner choice (radio group of household members) | yes | 26 | 1 | 0 | 0 | 0 | 0 | 0 | PASS |
| Blocking-unresolved state (dismissal refused, statement still blocked) | yes | 26 | 1 | 0 | 0 | 0 | 0 | 0 | PASS |
| Joint allocation editor (percentage split across owners) | yes | 26 | 1 | 0 | 0 | 0 | 0 | 0 | PASS |
| Duplicate decision (same event / separate events / wrong statement) | yes | 26 | 1 | 0 | 0 | 0 | 0 | 0 | PASS |
| Correction overlay (what has been decided so far, with masking disclosure) | yes | 26 | 1 | 0 | 0 | 0 | 0 | 0 | PASS |
| Resolved state (history view showing a terminal item, badge "Resolved") | yes | 24 | 1 | 0 | 0 | 0 | 0 | 0 | PASS |

"Needs review" rule ids (axe could not decide these automatically; they are NOT passes): `color-contrast`.

### Harness negative control — why the zeros above are a measurement

A deliberately broken node (an `<img>` with no alt text and an `<input>` with no accessible name) was injected into the live page and re-scanned: axe reported **2 violation(s)** (`image-alt`, `label`). The node was then removed and the same page scanned **clean again**. The scanner demonstrably speaks up when there is something to say.

### Rule ids of every violation found

None. No `wcag2a`/`wcag2aa` violation was reported on any state that was reached.

This zero is only meaningful because every reached state also reports a NON-ZERO "axe rules passed" count above — the scanner genuinely ran against real content, and each state additionally asserted a state-specific element was on screen before scanning. A state with zero passing rules would be recorded as NOT MEASURED, not as a pass.

### States not reached

None — all seven named states were reached and scanned.

## Manual keyboard test

Driven with real `Tab` / `ArrowDown` / `Enter`-equivalent key presses and real assertions on `document.activeElement`, live-region text and label association — not by reading code.

| Item | Exercised | Result | Detail |
| --- | --- | --- | --- |
| Radio groups — arrow keys move focus AND selection within the group | yes | PASS | ArrowDown moved focus from "same_economic_event" to "separate_genuine_events" (checked=true) |
| Focus order — Tab traverses interactive elements in DOM order and reaches the primary action | yes | PASS | 37 tab stops; DOM-order monotonic=true; reached "Save this answer"=true |
| Labels — every form control has a programmatic accessible name | yes | PASS | 3 control(s) inspected; 0 without a name |
| Loading announcements — the load transition is inside a polite live region | yes | PASS | role="status" aria-live="polite" announced: "Loading this resolution…" |
| Error announcements — a real API failure is surfaced in a role="alert" | yes | PASS | role="alert" announced: "resolution item not found" |
| Save announcements — the post-save confirmation is inside a role="status" region | yes | PASS | role="status" announced: "Answer recorded and the statement re-checked — nothing else is outstanding on it." |

## Screen-reader testing

**NOT AVAILABLE.** No screen reader (NVDA / JAWS / VoiceOver / Orca) is installed or drivable in this environment. No manual screen-reader pass was performed and none is claimed. The ARIA live-region behaviour below was verified programmatically (role/aria-live attributes and their rendered text), which is NOT the same as verifying what a screen reader actually announces.

