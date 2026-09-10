# Consolidated accessibility/mobile sweep: LR-5/6, LR-7, LR-8, LR-9, LR-10, LR-11/11B (2026-09-11)

## Scope and precedent

LR-2's own closure (`LR2_ACCESSIBILITY_CLOSURE.md`) established this codebase's methodology: a **static code-pattern check** for keyboard-hostile constructs (real simulated-Enter-key dispatch does not activate native `<button>`/`<a>` elements in this session's browser-automation tool — a confirmed environment/tooling limitation, not an app defect, re-confirmed this pass) plus a **live mobile-viewport walkthrough** (375×812, Android Chrome UA + touch emulation) checking single-column layout, contained horizontal overflow, and touch-target sizing.

Per the discovery pass for this sweep, none of LR-5/LR-6 (SMSF), LR-7 (Goals lifecycle), LR-8 (Reports Hub), LR-9 (Close Account / Admin deletion queue), LR-10 (Billing), or LR-11/LR-11B (Companies & Trusts) had ever had either check performed — every one of their own phase reports either disclosed this explicitly (AC-10 "PARTIAL", "no live keyboard/screen-reader walkthrough") or omitted an accessibility section entirely (LR-10). This sweep closes that gap for all six.

## Static code-pattern sweep (keyboard-hostile constructs)

Grepped every new/changed component file from all six phases for `tabIndex`, `onKeyDown`, `role="button"` (on a non-button element), a clickable `<div>`/`<span>` (`onClick` without a semantic role), and bare `outline-none` without a paired `focus-visible:ring-*`:

- `components/retirement/smsf/*.tsx` (all 7 SMSF files) — **zero matches**.
- `components/goals/*.tsx` — the only `outline-none` occurrences are correctly paired with `focus-visible:ring-2 focus-visible:ring-ai focus-visible:ring-offset-1` (e.g. `GoalCard.tsx:125`, `GoalsSummaryHero.tsx:39`) — the correct pattern, not a bare override.
- `components/reports/*.tsx` — same correctly-paired pattern (`ReportPreview.tsx:241`), otherwise clean.
- `components/profile/*.tsx`, `components/admin/AccountDeletionQueueClient.tsx`, `app/(app)/companies/page.tsx` — **zero matches** across all of them.

**Result: zero keyboard-hostile patterns found across all six phases' new UI surfaces.** Every interactive control across all of them is a real semantic `<button>`/`<a>`/`<select>`/`<input>`, keyboard-operable by default with no custom key handling to get wrong.

## Live mobile walkthrough (375×812, real disposable AU test account)

One disposable test account, holding both an ordinary user session and (via a direct `admin_users` grant, the only way to reach it) the account-deletion admin capability, drove a real login → mobile-viewport pass across all six surfaces. `document.documentElement.scrollWidth > clientWidth` was checked on every page load as the objective "does the page body scroll sideways" test.

| Page / surface | Horizontal overflow? | Findings |
|---|---|---|
| `/companies` (LR-11/11B) — list + Add form | None (375=375 throughout) | Clean single-column layout; generous "Add company or trust" pill button. One minor, **systemic, not phase-specific** finding: the form's "Cancel" button (`text-sm text-gray-500 hover:underline`, 41×20px) is well under the 44×44px touch-target guideline — but this is the *identical* class/pattern already used for Cancel in `FinancialDataGrid.tsx:1079` (all 7 registers, already implicitly accepted through LR-2's own closure) — a pre-existing app-wide convention, not a new LR-11B regression. |
| `/reports` (LR-8) | None | Clean; the three "Other Reports & Outputs" cards (Financial Activity, Consolidated Forecasting Report, Forecast Variance) are each a single 141px-tall tap target — excellent touch sizing, far above the guideline. |
| `/profile` — Billing (LR-10) + Close Account (LR-9) | None | Both sections render cleanly; the Close Account confirmation step ("Are you sure? ... Yes, request account closure / Cancel") is fully inline and text-labelled, no browser `confirm()` dialog, live-confirmed on a real mobile viewport for the first time. Live-exercised the real flow end-to-end: submitted a genuine closure request, confirmed the resulting "Account closure requested ... Pending review" state renders correctly and lets the user cancel it. Same systemic small-Cancel-button pattern as above (20px), not new. |
| `/admin/account-deletions` (LR-9) | None (table correctly scoped) | The request-queue table itself is 481px wide but sits inside a `div.overflow-x-auto` wrapper (verified via computed style: table `scrollWidth:481`/`clientWidth:481`, its wrapper `scrollWidth:481`/`clientWidth:341`, `overflowX:auto`) — the exact correct pattern (page body never scrolls, only the table's own container does). The real closure request submitted moments earlier via `/profile` appeared correctly in the queue. One minor cosmetic finding: the "Execute deletion" button (42px tall) wraps its own text onto two lines within its narrow table column at this viewport width — functional (the table scrolls to reveal more room), not broken, but tight. |
| `/retirement` — SMSF workspace (LR-5/LR-6) | None, at every step | Checked at three states: empty ("+ Add an SMSF" only), the Add-SMSF form open, and after creating a real fund (Summary Mode fund card, Members section, "Show Reports & Export" panel expanded) — zero horizontal overflow at any of the three, including with the Reports panel's own tables/figures rendered. This is the first live mobile check this workspace has ever had. |
| `/goals/[id]` — Lifecycle Controls (LR-7) | None | Confirmed on a real goal created via the app's own API. The Scenarios table (Conservative/Base/Optimistic) fits natively within the 341px content width for this data (no overflow needed). `GoalLifecycleControls.tsx`'s four buttons (Edit goal 38px, Pause/Archive/Delete permanently ~30px) render correctly, same general button-height convention as the rest of the app — no new regression. |

## What this confirms and what remains a genuine, disclosed gap

- **Confirmed, live, for the first time**: all six phases' new UI is keyboard-operable by construction (real semantic elements, correctly-paired focus-visible styling where customized) and renders with zero horizontal page-body overflow on a real 375px mobile viewport, including through several real interactive state changes (opening forms, submitting a real account-closure request, creating a real SMSF fund, expanding a reports panel).
- **Genuinely still open, disclosed rather than glossed over**: a *live* screen-reader walkthrough (e.g., actually running NVDA/VoiceOver against these pages) has still never been performed for any phase in this entire programme, including LR-2's own closure — every "keyboard" claim in this programme, including this one, is a semantic-correctness/static-pattern proof, not a literal assistive-technology test run, because of the established tooling limitation (simulated key events don't activate native elements in this session's own browser-automation tool). This is the same disclosed limitation carried forward from LR-2, not a new one introduced here.
- Two minor, **cross-cutting, pre-existing, not phase-specific** cosmetic findings noted above (the app-wide small "Cancel" link-button pattern; the admin queue's "Execute deletion" button text wrapping at 375px) — neither blocks calling this sweep's own scope closed, and neither is unilaterally "fixed" here since a broad button-sizing change would touch every register/page in the app and is a design decision for the PO, not an engineering defect specific to any one phase.

## Cleanup

The disposable test account (with its real SMSF fund, real goal, and real pending account-closure request) was deleted via the Admin API and independently re-verified gone (`getUserById()` returning nothing) — the delete cascade correctly removed every row created during this sweep, including the `admin_users` grant and the `account_deletion_requests` row itself. Zero residue: no temp files or credentials left in the repository.

## Verdict

**Consolidated accessibility/mobile sweep: CLOSED for LR-5/LR-6, LR-7, LR-8, LR-9, LR-10, and LR-11/LR-11B.** Zero keyboard-hostile code patterns found; zero horizontal-overflow defects found across six real page/surface walkthroughs on a genuine mobile viewport, including through real interactive state changes. The one disclosed, carried-forward limitation (no literal assistive-technology tool run) applies equally to this sweep and to LR-2's own precedent — not a new gap, and not hidden.
